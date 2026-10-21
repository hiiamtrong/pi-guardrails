import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_INDEX_BYTES,
  MAX_INDEX_LINES,
  addMemory,
  canonicalProjectRoot,
  capIndex,
  checkRefs,
  encodeProjectPath,
  globalStore,
  listStaleRefs,
  projectMemoryDir,
  projectStore,
  readIndex,
  readTopic,
  refsStatus,
  mergeMemory,
  searchMemories,
} from "./memory.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "pi-claude-memory-"));
}

async function addInChildren(root: string, inputs: Array<Record<string, string>>): Promise<void> {
  const modulePath = new URL("./memory.ts", import.meta.url).href;
  await Promise.all(inputs.map((input) => new Promise<void>((resolve, reject) => {
    const script = `import { addMemory, globalStore } from ${JSON.stringify(modulePath)}; addMemory(globalStore(process.env.DEDUP_ROOT), JSON.parse(process.env.DEDUP_INPUT));`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
      env: { ...process.env, DEDUP_INPUT: JSON.stringify(input), DEDUP_ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)));
  })));
}

test("uses the repository root for nested directories", () => {
  const root = temp();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const nested = join(root, "src", "nested");
  mkdirSync(nested, { recursive: true });
  assert.equal(canonicalProjectRoot(nested), realpathSync.native(root));
});

test("linked worktrees resolve to the main repository", () => {
  const base = temp();
  const main = join(base, "main");
  const worktree = join(base, "worktree");
  const gitDir = join(main, ".git", "worktrees", "feature");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  assert.equal(canonicalProjectRoot(worktree), realpathSync.native(main));
  assert.equal(projectMemoryDir(main, base), projectMemoryDir(worktree, base));
});

test("rejects a spoofed linked-worktree pointer", () => {
  const base = temp();
  const victim = join(base, "victim");
  const attacker = join(base, "attacker");
  const gitDir = join(victim, ".git", "worktrees", "spoof");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(attacker);
  writeFileSync(join(victim, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(attacker, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "gitdir"), `${join(base, "different", ".git")}\n`);
  assert.equal(canonicalProjectRoot(attacker), realpathSync.native(attacker));
});

test("encodes canonical absolute paths like Claude Code", () => {
  assert.equal(
    encodeProjectPath("/Users/example/Work/acme/app"),
    "-Users-example-Work-acme-app",
  );
});

test("separates encoded path collisions with the project identity", () => {
  const base = temp();
  const agent = join(base, "agent");
  const first = join(base, "a-b", "c");
  const second = join(base, "a", "b-c");
  mkdirSync(join(first, ".git"), { recursive: true });
  mkdirSync(join(second, ".git"), { recursive: true });
  writeFileSync(join(first, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(second, ".git", "HEAD"), "ref: refs/heads/main\n");
  const firstStore = projectStore(first, agent);
  addMemory(firstStore, { content: "first project convention", type: "project" });
  assert.notEqual(projectMemoryDir(first, agent), projectMemoryDir(second, agent));
});

test("caps only the injected index, not topic storage", () => {
  const byLines = capIndex(Array.from({ length: MAX_INDEX_LINES + 5 }, (_, index) => `line ${index}`).join("\n"));
  assert.equal(byLines.content.split("\n").length, MAX_INDEX_LINES);
  assert.equal(byLines.truncated, true);

  const byBytes = capIndex("x".repeat(MAX_INDEX_BYTES + 1));
  assert.equal(Buffer.byteLength(byBytes.content), 0);
  assert.equal(byBytes.truncated, true);

  const boundedStore = globalStore(temp());
  mkdirSync(boundedStore.dir, { recursive: true });
  writeFileSync(join(boundedStore.dir, "MEMORY.md"), "line\n".repeat(400_000));
  const bounded = readIndex(boundedStore);
  assert.equal(bounded?.truncated, true);
  assert.ok(Buffer.byteLength(bounded?.content || "") <= MAX_INDEX_BYTES);

  const root = temp();
  const store = globalStore(root);
  const content = `Large durable topic\n${"detail ".repeat(2_000)}`;
  const saved = addMemory(store, { content, type: "reference" });
  assert.match(readFileSync(join(store.dir, saved.file), "utf8"), /detail detail/);
});

test("deduplicates exact content, outer whitespace, and metadata changes", () => {
  const root = temp();
  const store = globalStore(root);
  const first = addMemory(store, {
    content: "Use Poetry for this Python workflow.",
    name: "Original title",
    source: "first import",
    type: "reference",
  });
  const second = addMemory(store, {
    content: "\n  Use Poetry for this Python workflow.  \n",
    name: "Replacement title",
    source: "second import",
    type: "reference",
  });
  assert.equal(first.file, second.file);
  assert.equal(second.duplicate, true);
  const topic = readTopic(store, first.file);
  assert.match(topic, /Original title/);
  assert.doesNotMatch(topic, /Replacement title/);
  const index = readFileSync(join(store.dir, "MEMORY.md"), "utf8");
  assert.equal(index.split(`](${first.file})`).length - 1, 1);
  const results = searchMemories([store], "poetry python");
  assert.equal(results[0].file, first.file);
});

test("keeps meaningful content, type, and scope differences", () => {
  const base = temp();
  const global = globalStore(join(base, "agent"));
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const scoped = projectStore(project, join(base, "agent"));

  const original = addMemory(global, { content: "Case Sensitive  value", type: "reference" });
  const internalWhitespace = addMemory(global, { content: "Case Sensitive value", type: "reference" });
  const changedCase = addMemory(global, { content: "case Sensitive  value", type: "reference" });
  const changedType = addMemory(global, { content: "Case Sensitive  value", type: "user" });
  const changedScope = addMemory(scoped, { content: "Case Sensitive  value", type: "reference" });

  assert.equal(new Set([original.file, internalWhitespace.file, changedCase.file, changedType.file]).size, 4);
  assert.equal(changedScope.file, original.file);
  assert.equal(changedScope.duplicate, false);
  assert.deepEqual(changedType.similar, []);
});

test("detects an 80% similar memory and lets the agent merge it", () => {
  const store = globalStore(temp());
  const original = addMemory(store, {
    content: "Deploy script requires the STAGING_TOKEN environment variable to be set before running "
      + "the release pipeline, otherwise the build silently falls back to the sandbox credentials "
      + "and pushes to the wrong bucket.",
    source: "claude-code:project/deploy-original.md",
    type: "reference",
  });
  const similar = addMemory(store, {
    content: "Deploy script requires the STAGING_TOKEN environment variable to be exported before running "
      + "the deploy pipeline, otherwise the job silently falls back to the sandbox credentials "
      + "and uploads to the wrong region.",
    source: "claude-code:project/deploy-update.md",
    type: "reference",
  });

  assert.equal(similar.similar[0].file, original.file);
  assert.ok(similar.similar[0].score >= 0.8);
  const merged = mergeMemory(store, {
    keepFile: original.file,
    removeFile: similar.file,
    content: "Before deployment, export STAGING_TOKEN. Without it, the pipeline uses sandbox credentials; "
      + "verify the destination bucket and region before release.",
    name: "Staging deployment credentials",
  });
  assert.equal(merged.file, original.file);
  assert.equal(merged.removed, similar.file);
  assert.equal(readdirSync(store.dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").length, 1);
  assert.match(readTopic(store, original.file), /verify the destination bucket and region/);
  assert.match(readTopic(store, original.file), /deploy-original\.md/);
  assert.match(readTopic(store, original.file), /deploy-update\.md/);
  for (const source of ["claude-code:project/deploy-original.md", "claude-code:project/deploy-update.md"]) {
    const rerun = addMemory(store, { content: `Migration rerun for ${source}`, source, type: "reference" });
    assert.equal(rerun.file, original.file);
    assert.equal(rerun.duplicate, true);
  }
  const index = readFileSync(join(store.dir, "MEMORY.md"), "utf8");
  assert.equal(index.split(`](${original.file})`).length - 1, 1);
  assert.doesNotMatch(index, new RegExp(similar.file));
});

test("reports 80% overlap for five-word memories", () => {
  const store = globalStore(temp());
  const original = addMemory(store, { content: "alpha beta gamma delta epsilon", type: "reference" });
  const similar = addMemory(store, { content: "alpha beta gamma delta zeta", type: "reference" });
  assert.equal(similar.similar[0].file, original.file);
  assert.equal(similar.similar[0].score, 0.8);
});

test("rejects unsafe or cross-type merges without deleting either topic", () => {
  const root = temp();
  const store = globalStore(root);
  const reference = addMemory(store, { content: "Reference merge candidate", type: "reference" });
  const user = addMemory(store, { content: "User merge candidate", type: "user" });
  assert.throws(() => mergeMemory(store, {
    keepFile: reference.file, removeFile: user.file, content: "Merged content",
  }), /same valid type/);
  assert.throws(() => mergeMemory(store, {
    keepFile: reference.file, removeFile: reference.file, content: "Merged content",
  }), /must be different/);
  assert.throws(() => mergeMemory(store, {
    keepFile: reference.file, removeFile: user.file, content: "password=abcdefghijklmnopqrstuv",
  }), /credential/);
  assert.match(readTopic(store, reference.file), /Reference merge candidate/);
  assert.match(readTopic(store, user.file), /User merge candidate/);

  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside");
  const linked = "reference-aaaaaaaaaa.md";
  symlinkSync(outside, join(store.dir, linked));
  assert.throws(() => mergeMemory(store, {
    keepFile: reference.file, removeFile: linked, content: "Merged content",
  }), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "outside");
});

test("rejects oversized accumulated provenance before mutating a merge", () => {
  const store = globalStore(temp());
  const first = addMemory(store, {
    content: "First provenance topic", source: `source-a-${"a".repeat(3_500)}`, type: "reference",
  });
  const second = addMemory(store, {
    content: "Second provenance topic", source: `source-b-${"b".repeat(3_500)}`, type: "reference",
  });
  mergeMemory(store, {
    keepFile: first.file, removeFile: second.file, content: "First two provenance topics merged",
  });
  const third = addMemory(store, {
    content: "Third provenance topic", source: `source-c-${"c".repeat(3_500)}`, type: "reference",
  });
  assert.throws(() => mergeMemory(store, {
    keepFile: first.file, removeFile: third.file, content: "All provenance topics merged",
  }), /metadata exceeds/);
  assert.match(readTopic(store, first.file), /First two provenance topics merged/);
  assert.match(readTopic(store, third.file), /Third provenance topic/);
});

test("fails closed for hardlinked or oversized indexes and excessive source scans", () => {
  const base = temp();
  const hardlinked = globalStore(join(base, "hardlinked"));
  mkdirSync(hardlinked.dir, { recursive: true });
  const outside = join(base, "outside-index.md");
  writeFileSync(outside, "# External index\n");
  linkSync(outside, join(hardlinked.dir, "MEMORY.md"));
  assert.throws(() => addMemory(hardlinked, {
    content: "Must not mutate a hardlinked index", type: "reference",
  }), /single-link/);
  assert.equal(readFileSync(outside, "utf8"), "# External index\n");

  const oversized = globalStore(join(base, "oversized"));
  mkdirSync(oversized.dir, { recursive: true });
  writeFileSync(join(oversized.dir, "MEMORY.md"), "x".repeat(1024 * 1024 + 1));
  assert.throws(() => addMemory(oversized, {
    content: "Must not append to an oversized index", type: "reference",
  }), /mutation limit/);

  const mergeBoundary = globalStore(join(base, "merge-boundary"));
  const keep = addMemory(mergeBoundary, { content: "Keep before boundary merge", type: "reference" });
  const remove = addMemory(mergeBoundary, { content: "Remove before boundary merge", type: "reference" });
  writeFileSync(join(mergeBoundary.dir, "MEMORY.md"), "x".repeat(1024 * 1024 - 500));
  assert.throws(() => mergeMemory(mergeBoundary, {
    keepFile: keep.file, removeFile: remove.file, content: "Must not cross the index boundary",
  }), /mutation limit/);
  assert.match(readTopic(mergeBoundary, keep.file), /Keep before boundary merge/);
  assert.match(readTopic(mergeBoundary, remove.file), /Remove before boundary merge/);

  const crowded = globalStore(join(base, "crowded"));
  mkdirSync(crowded.dir, { recursive: true });
  for (let index = 0; index <= 1_000; index++) {
    writeFileSync(join(crowded.dir, `reference-${index.toString(16).padStart(10, "0")}.md`), "---\ntype: reference\n---\nitem\n");
  }
  assert.throws(() => addMemory(crowded, {
    content: "Must not run an unbounded source scan", source: "new-source", type: "reference",
  }), /exceeds 1000 topic files/);
});

test("deduplicates repeated source identities even when their content changes", () => {
  const store = globalStore(temp());
  const first = addMemory(store, {
    content: "Original imported content.",
    source: "claude-code:project/topic.md",
    type: "reference",
  });
  const repeated = addMemory(store, {
    content: "Updated source content that should not fork the imported identity.",
    source: "claude-code:project/topic.md",
    type: "reference",
  });

  assert.equal(repeated.file, first.file);
  assert.equal(repeated.duplicate, true);
  assert.match(readTopic(store, first.file), /Original imported content/);
  assert.doesNotMatch(readTopic(store, first.file), /Updated source content/);
});

test("keeps type and exact whitespace as part of source identity", () => {
  const store = globalStore(temp());
  const reference = addMemory(store, {
    content: "Reference content.", source: "path/a b.md", type: "reference",
  });
  const user = addMemory(store, {
    content: "User content.", source: "path/a b.md", type: "user",
  });
  const spaced = addMemory(store, {
    content: "Distinct whitespace source.", source: "path/a  b.md", type: "reference",
  });

  assert.equal(new Set([reference.file, user.file, spaced.file]).size, 3);
  assert.equal(user.duplicate, false);
  assert.equal(spaced.duplicate, false);
});

test("keeps legacy short-hash topics as the canonical copy", () => {
  const store = globalStore(temp());
  const first = addMemory(store, { content: "Original legacy identity.", type: "reference" });
  const path = join(store.dir, first.file);
  const legacy = readFileSync(path, "utf8")
    .replace(/^content_hash: .*\n/m, "")
    .replace("Original legacy identity.", "Evolved legacy content.");
  writeFileSync(path, legacy);

  const repeated = addMemory(store, { content: "Original legacy identity.", type: "reference" });
  assert.equal(repeated.file, first.file);
  assert.equal(repeated.duplicate, true);
  assert.match(readTopic(store, first.file), /Evolved legacy content/);
  assert.equal(readdirSync(store.dir).filter((file) => /^reference-[a-f0-9]{64}\.md$/.test(file)).length, 0);
});

test("does not truncate source identity during deduplication", () => {
  const store = globalStore(temp());
  const prefix = `claude-code:${"a".repeat(260)}`;
  const first = addMemory(store, { content: "First long source.", source: `${prefix}/one.md`, type: "reference" });
  const second = addMemory(store, { content: "Second long source.", source: `${prefix}/two.md`, type: "reference" });
  assert.notEqual(first.file, second.file);
  assert.equal(second.duplicate, false);
});

test("repairs a missing index entry without duplicating the topic", () => {
  const store = globalStore(temp());
  const first = addMemory(store, { content: "Repair this durable index entry.", type: "reference" });
  writeFileSync(join(store.dir, "MEMORY.md"), "# Memory Index\n\n");
  const repeated = addMemory(store, { content: "Repair this durable index entry.", type: "reference" });
  const index = readFileSync(join(store.dir, "MEMORY.md"), "utf8");
  assert.equal(repeated.duplicate, true);
  assert.equal(index.split(`](${first.file})`).length - 1, 1);
});

test("preserves both topics when their short hashes collide", () => {
  const store = globalStore(temp());
  const firstContent = "dedup collision candidate 480858";
  const secondContent = "dedup collision candidate 489375";
  const first = addMemory(store, { content: firstContent, type: "reference" });
  const second = addMemory(store, { content: secondContent, type: "reference" });
  const repeated = addMemory(store, { content: secondContent, type: "reference" });

  assert.equal(first.file, "reference-971c736842.md");
  assert.match(second.file, /^reference-[a-f0-9]{64}\.md$/);
  assert.notEqual(second.file, first.file);
  assert.equal(second.duplicate, false);
  assert.equal(repeated.file, second.file);
  assert.equal(repeated.duplicate, true);
  assert.match(readTopic(store, first.file), /480858/);
  assert.match(readTopic(store, second.file), /489375/);
});

test("deduplicates concurrent writes atomically", async () => {
  const root = temp();
  await addInChildren(root, Array.from({ length: 12 }, () => ({
    content: "Concurrent durable memory", type: "reference",
  })));

  const store = globalStore(root);
  const topics = readdirSync(store.dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md");
  assert.equal(topics.length, 1);
  const index = readFileSync(join(store.dir, "MEMORY.md"), "utf8");
  assert.equal(index.split(`](${topics[0]})`).length - 1, 1);
});

test("serializes concurrent source dedup and index repair", async () => {
  const root = temp();
  await addInChildren(root, Array.from({ length: 12 }, (_, index) => ({
    content: `Concurrent source version ${index}`,
    source: "claude-code:project/concurrent.md",
    type: "reference",
  })));

  const store = globalStore(root);
  const topics = readdirSync(store.dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md");
  assert.equal(topics.length, 1);
  writeFileSync(join(store.dir, "MEMORY.md"), "# Memory Index\n\n");
  await addInChildren(root, Array.from({ length: 12 }, () => ({
    content: "A later source body.",
    source: "claude-code:project/concurrent.md",
    type: "reference",
  })));
  const index = readFileSync(join(store.dir, "MEMORY.md"), "utf8");
  assert.equal(index.split(`](${topics[0]})`).length - 1, 1);
  assert.equal(readdirSync(store.dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").length, 1);
});

test("captures a ref hash and detects drift lazily on read/search", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, "formula.ts"), "export const rate = 0.15;\n");
  const store = projectStore(project, join(base, "agent"));

  const added = addMemory(store, {
    content: "The payout formula uses a 15% rate.",
    refs: [{ path: "formula.ts" }],
    type: "project",
  });
  assert.deepEqual(refsStatus(store, added.file), [
    { hash: refsStatus(store, added.file)[0].hash, path: "formula.ts", stale: false },
  ]);
  assert.equal(searchMemories([store], "payout formula rate")[0].stale, false);

  writeFileSync(join(project, "formula.ts"), "export const rate = 0.2;\n");
  const afterEdit = refsStatus(store, added.file);
  assert.equal(afterEdit[0].stale, true);
  assert.equal(afterEdit[0].reason, "changed");
  assert.equal(searchMemories([store], "payout formula rate")[0].stale, true);
  assert.equal(listStaleRefs(store).length, 1);
});

test("reports a missing ref file distinctly from a changed one", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const configPath = join(project, "config.json");
  writeFileSync(configPath, "{}\n");
  const store = projectStore(project, join(base, "agent"));

  const added = addMemory(store, { content: "Config defaults to an empty object.", refs: [{ path: "config.json" }], type: "project" });
  unlinkSync(configPath);
  const status = refsStatus(store, added.file);
  assert.equal(status[0].stale, true);
  assert.equal(status[0].reason, "missing");
});

test("rejects ref paths that escape the project and caps ref count", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(base, "outside.txt"), "outside\n");
  const store = projectStore(project, join(base, "agent"));

  assert.throws(
    () => addMemory(store, { content: "Escaping ref", refs: [{ path: "../outside.txt" }], type: "project" }),
    /escapes the project/,
  );
  assert.throws(
    () => addMemory(store, {
      content: "Too many refs", refs: Array.from({ length: 21 }, (_, index) => ({ path: `f${index}.ts` })), type: "project",
    }),
    /exceed the 20-entry limit/,
  );
});

test("rejects refs on global-scope memory", () => {
  const store = globalStore(temp());
  assert.throws(
    () => addMemory(store, { content: "Global memory with a ref", refs: [{ path: "file.ts" }], type: "reference" }),
    /project-scoped store/,
  );
});

test("merge carries refs forward re-hashed unless explicitly replaced", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "b.ts"), "export const b = 2;\n");
  const store = projectStore(project, join(base, "agent"));

  const keep = addMemory(store, { content: "A is one.", refs: [{ path: "a.ts" }], type: "project" });
  const remove = addMemory(store, { content: "B is two.", refs: [{ path: "b.ts" }], type: "project" });
  writeFileSync(join(project, "a.ts"), "export const a = 100;\n");

  const merged = mergeMemory(store, { content: "A is now 100; B is two.", keepFile: keep.file, removeFile: remove.file });
  const status = refsStatus(store, merged.file);
  assert.equal(status.length, 2);
  assert.ok(status.every((ref) => !ref.stale));
  assert.deepEqual(new Set(status.map((ref) => ref.path)), new Set(["a.ts", "b.ts"]));

  writeFileSync(join(project, "c.ts"), "export const c = 3;\n");
  const third = addMemory(store, { content: "C is three.", type: "project" });
  const replaced = mergeMemory(store, {
    content: "Only C now.", keepFile: keep.file, refs: [{ path: "c.ts" }], removeFile: third.file,
  }).file;
  const replacedStatus = refsStatus(store, replaced);
  assert.deepEqual(replacedStatus.map((ref) => ref.path), ["c.ts"]);

  assert.throws(() => mergeMemory(store, {
    content: "noop", keepFile: keep.file, removeFile: keep.file,
  }), /must be different/);
});

test("checkRefs bounds hashing to files that still exist inside the project", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, "present.ts"), "export const x = 1;\n");
  const store = projectStore(project, join(base, "agent"));
  const results = checkRefs(store, [
    { hash: "deadbeef", path: "present.ts" },
    { hash: "deadbeef", path: "absent.ts" },
  ]);
  assert.equal(results[0].reason, "changed");
  assert.equal(results[1].reason, "missing");
});

test("rejects a symlinked ref target instead of hashing through it", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const outside = join(base, "outside-secret.txt");
  writeFileSync(outside, "outside secret content\n");
  symlinkSync(outside, join(project, "linked.ts"));
  const store = projectStore(project, join(base, "agent"));

  assert.throws(
    () => addMemory(store, { content: "Symlinked ref", refs: [{ path: "linked.ts" }], type: "project" }),
    /must not be a symlink/,
  );
});

test("degrades a corrupted or unreadable ref to stale instead of throwing", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const store = projectStore(project, join(base, "agent"));

  const traversal = checkRefs(store, [{ hash: "deadbeef", path: "../../../etc/passwd" }]);
  assert.equal(traversal[0].stale, true);
  assert.equal(traversal[0].reason, "unreadable");

  const added = addMemory(store, { content: "Config with a healthy ref.", type: "project" });
  assert.doesNotThrow(() => refsStatus(store, added.file));
});

test("fails loud with a clear message when merge carries forward a deleted ref", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  const store = projectStore(project, join(base, "agent"));

  const keep = addMemory(store, { content: "A is one.", refs: [{ path: "a.ts" }], type: "project" });
  const remove = addMemory(store, { content: "B mentions a too.", type: "project" });
  unlinkSync(join(project, "a.ts"));

  assert.throws(
    () => mergeMemory(store, { content: "A merged.", keepFile: keep.file, removeFile: remove.file }),
    /Memory ref path does not exist/,
  );
});

test("only re-hashes stale-check candidates within the returned search slice", () => {
  const base = temp();
  const project = join(base, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(project, "tracked.ts"), "export const rate = 1;\n");
  const store = projectStore(project, join(base, "agent"));

  for (let index = 0; index < 5; index++) {
    addMemory(store, {
      content: `Tracked formula candidate number ${index}.`, refs: [{ path: "tracked.ts" }], type: "project",
    });
  }
  const results = searchMemories([store], "tracked formula candidate", 2);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.stale === false));
});

test("rejects secrets and traversal", () => {
  const store = globalStore(temp());
  assert.throws(
    () => addMemory(store, { content: "api_key=abcdefghijklmnopqrstuv", type: "reference" }),
    /credential/,
  );
  assert.throws(
    () => addMemory(store, { content: "safe", name: "secret=abcdefghijklmnopqrstuv", type: "reference" }),
    /credential/,
  );
  assert.throws(
    () => addMemory(store, { content: "safe", description: "password=abcdefghijklmnopqrstuv", type: "reference" }),
    /credential/,
  );
  assert.throws(
    () => addMemory(store, { content: "safe", source: "access_token=abcdefghijklmnopqrstuv", type: "reference" }),
    /credential/,
  );
  addMemory(store, { content: "safe memory", type: "reference" });
  assert.throws(() => readTopic(store, "../MEMORY.md"), /Invalid memory topic filename/);
});

test("refuses a symlinked topic", () => {
  const root = temp();
  const store = globalStore(root);
  mkdirSync(store.dir, { recursive: true });
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(store.dir, "linked.md"));
  assert.throws(() => readTopic(store, "linked.md"), /regular file/);
});
