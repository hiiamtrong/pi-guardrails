import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ext from "../extensions/whoami.ts";
import { encodeProjectPath } from "../packages/claude-memory/memory.ts";

const shortKey = (path: string) => path.replace(/\.md$/, ".short.md");

type Files = { default?: string; project?: string };
type Opts = { sub?: string; encodedLength?: number; projectIsDir?: boolean };

async function run(files: Files, { sub = "", encodedLength, projectIsDir }: Opts = {}) {
  // realpath: macOS tmpdir is a symlink and canonicalProjectRoot resolves it
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "whoami-")));
  // an ASCII path encodes 1:1 ("/" becomes "-"), so the repo name length sets the key length
  const repo = join(tmp, encodedLength ? "r".repeat(encodedLength - tmp.length - 1) : "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(repo, sub), { recursive: true });
  const dir = join(tmp, "agent", "whoami");
  mkdirSync(dir, { recursive: true });
  const defaultPath = join(dir, "default.md");
  const projectPath = join(dir, `${encodeProjectPath(repo)}.md`);
  if (files.default) writeFileSync(defaultPath, files.default);
  if (files.project) writeFileSync(projectPath, files.project);
  if (projectIsDir) mkdirSync(projectPath);
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  let tool: any;
  ext({ registerTool: (t: any) => (tool = t), on: () => {}, registerCommand: () => {} } as any);
  try {
    const result = await tool.execute("1", {}, undefined, undefined, { cwd: join(repo, sub) });
    return { text: result.content[0].text as string, details: result.details, defaultPath, projectPath, repo };
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("both files: default first, then project, nothing missing", async () => {
  const r = await run({ default: "# Me\nTheo", project: "# Project\nClient: SWAG" });
  assert.ok(r.text.startsWith(`Project root: ${r.repo}`));
  assert.ok(r.text.indexOf("Theo") < r.text.indexOf("Client: SWAG"));
  assert.ok(!r.text.includes("Missing:"));
  assert.deepEqual(r.details.files, [r.defaultPath, r.projectPath]);
});

test("project file only: reports default.md missing", async () => {
  const r = await run({ project: "Client: SWAG" });
  assert.ok(r.text.includes("Client: SWAG"));
  assert.ok(r.text.includes(`Missing: ${r.defaultPath}`));
  assert.ok(!r.text.includes(`Missing: ${r.projectPath}`));
});

test("default only: reports the project file missing under its encoded key", async () => {
  const r = await run({ default: "Theo" });
  assert.ok(r.text.includes("Theo"));
  assert.ok(r.text.includes(`Missing: ${r.projectPath}`));
});

test("no files: does not throw and names both paths", async () => {
  const r = await run({});
  assert.ok(r.text.includes(`Missing: ${r.defaultPath}`));
  assert.ok(r.text.includes(`Missing: ${r.projectPath}`));
  assert.deepEqual(r.details.files, []);
});

test("a default.md holding only whitespace is present, not Missing", async () => {
  const r = await run({ default: "  \n\t\n" });
  assert.deepEqual(r.details.files, [r.defaultPath]);
  assert.ok(!r.text.includes(`Missing: ${r.defaultPath}`));
  assert.ok(r.text.includes(`Missing: ${r.projectPath}`));
});

test("cwd inside a subdirectory resolves to the repo root's file", async () => {
  const r = await run({ project: "Client: SWAG" }, { sub: "src/deep" });
  assert.equal(r.details.projectRoot, r.repo);
  assert.ok(r.text.includes("Client: SWAG"));
});

// encodeProjectPath keeps names up to 220 bytes and shortens longer ones with a hash
test("a repo path encoding to exactly 220 bytes keeps the plain key", async () => {
  const r = await run({ project: "Client: SWAG" }, { encodedLength: 220 });
  assert.equal(r.projectPath.endsWith(`${r.repo.replaceAll("/", "-")}.md`), true);
  assert.ok(r.text.includes("Client: SWAG"));
});

test("a repo path encoding to 221 bytes uses the shortened key and still reads it", async () => {
  const r = await run({ project: "Client: SWAG" }, { encodedLength: 221 });
  assert.equal(r.projectPath.endsWith(`${r.repo.replaceAll("/", "-")}.md`), false);
  assert.ok(r.text.includes("Client: SWAG"));
  assert.ok(!r.text.includes(`Missing: ${r.projectPath}`));
});

test("a project file that cannot be read fails instead of reporting Missing", async () => {
  await assert.rejects(run({ default: "Theo" }, { projectIsDir: true }), { code: "EISDIR" });
});

async function withEnv(fn: (c: { repo: string; dir: string; before: any; init: any; keyFile: string }) => Promise<void>) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "whoami-")));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
  let before: any;
  let init: any;
  ext({ registerTool: () => {}, on: (_e: string, h: any) => (before = h), registerCommand: (_n: string, o: any) => (init = o.handler) } as any);
  try {
    await fn({ repo, dir: join(tmp, "agent", "whoami"), before, init, keyFile: `${encodeProjectPath(repo)}.md` });
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}

function start(before: any, cwd: string) {
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  return { forced: before(event, { cwd }), sections: event.systemPromptOptions.sections };
}

test("system prompt is untouched when the project has no whoami file", () =>
  withEnv(async ({ repo, before }) => {
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.deepEqual(sections, {});
  }));

test("the hint goes into a section when only the project file exists, and the file text stays out", () =>
  withEnv(async ({ repo, dir, before, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, keyFile), "Client: SWAG");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.ok(sections.whoami.includes("`whoami` tool"));
    assert.equal(sections.whoami_short, undefined);
    assert.ok(!JSON.stringify(sections).includes("Client: SWAG"));
  }));

test("the hint goes into a section when only default.md exists", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.md"), "Theo");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.ok(sections.whoami.includes("`whoami` tool"));
  }));

test("the default short becomes the whoami_short section, never the full default.md", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.short.md"), "Short: SWAG backend");
    writeFileSync(join(dir, "default.md"), "Long: FULL DETAILS");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.equal(sections.whoami_short, "Short: SWAG backend");
    assert.ok(!JSON.stringify(sections).includes("FULL DETAILS"));
  }));

test("an empty default.short.md is treated as absent", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.short.md"), "\n");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.deepEqual(sections, {});
  }));

test("a short file holding only a BOM counts as absent", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.short.md"), "\uFEFF");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.deepEqual(sections, {});
  }));

test("a short file with a BOM and CRLF line endings keeps its text and drops the BOM", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.short.md"), "\uFEFF# Me\r\n- reviewer\r\n");
    const { sections } = start(before, repo);
    assert.equal(sections.whoami_short, "# Me\r\n- reviewer");
  }));

test("invalid UTF-8 in a short file still gives a section instead of failing the run", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    // 0x80 is a stray continuation byte, which is not valid UTF-8 on its own
    writeFileSync(join(dir, "default.short.md"), Buffer.from([0x80, ...Buffer.from("NoFormatter")]));
    const { sections } = start(before, repo);
    assert.ok(sections.whoami_short.includes("NoFormatter"));
  }));

test("a short file that cannot be read is skipped instead of failing the run", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    // a directory named like the summary file makes readFileSync throw EISDIR
    mkdirSync(join(dir, "default.short.md"));
    writeFileSync(join(dir, "default.md"), "Theo");
    const { forced, sections } = start(before, repo);
    assert.equal(forced, undefined);
    assert.ok(sections.whoami.includes("`whoami` tool"));
    assert.equal(sections.whoami_short, undefined);
  }));

test("the project short file lands after the default short in one section", () =>
  withEnv(async ({ repo, dir, before, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.short.md"), "Short: me");
    writeFileSync(join(dir, shortKey(keyFile)), "Project: review only");
    const { sections } = start(before, repo);
    assert.equal(sections.whoami_short, "Short: me\n\nProject: review only");
  }));

test("a project short file alone is enough to inject the section", () =>
  withEnv(async ({ repo, dir, before, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, shortKey(keyFile)), "Project: review only");
    const { sections } = start(before, repo);
    assert.equal(sections.whoami_short, "Project: review only");
  }));

test("another project's short file stays out", () =>
  withEnv(async ({ repo, dir, before, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, shortKey(keyFile)), "current only");
    writeFileSync(join(dir, shortKey("-Users-someone-else-other-repo.md")), "other project");
    const { sections } = start(before, repo);
    assert.equal(sections.whoami_short, "current only");
  }));

test("whoami-init creates both private templates, then leaves edited files alone", () =>
  withEnv(async ({ repo, dir, init, keyFile }) => {
    const messages: string[] = [];
    const ctx = { cwd: repo, ui: { notify: (m: string) => messages.push(m) } };
    await init("", ctx);
    assert.ok(messages[0].includes(join(dir, "default.md")) && messages[0].includes(join(dir, keyFile)));
    assert.ok(messages[0].includes(join(dir, "default.short.md")));
    assert.equal(statSync(join(dir, keyFile)).mode & 0o777, 0o600);
    writeFileSync(join(dir, keyFile), "Client: SWAG");
    await init("", ctx);
    assert.equal(readFileSync(join(dir, keyFile), "utf8"), "Client: SWAG");
    assert.ok(messages[1].startsWith("Nothing to create"));
  }));

test("whoami-init creates only the file that is absent", () =>
  withEnv(async ({ repo, dir, init, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.md"), "Theo");
    await init("", { cwd: repo });
    assert.equal(readFileSync(join(dir, "default.md"), "utf8"), "Theo");
    assert.ok(existsSync(join(dir, keyFile)));
  }));
