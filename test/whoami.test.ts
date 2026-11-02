import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ext from "../extensions/whoami.ts";
import { encodeProjectPath } from "../packages/claude-memory/memory.ts";

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

test("system prompt is untouched when the project has no whoami file", () =>
  withEnv(async ({ repo, before }) => {
    assert.equal(before({ systemPrompt: "base" }, { cwd: repo }), undefined);
  }));

test("system prompt gets the hint when only the project file exists", () =>
  withEnv(async ({ repo, dir, before, keyFile }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, keyFile), "Client: SWAG");
    const prompt = before({ systemPrompt: "base" }, { cwd: repo }).systemPrompt as string;
    assert.ok(prompt.startsWith("base"));
    assert.ok(prompt.includes("`whoami` tool"));
    assert.ok(!prompt.includes("Client: SWAG"));
  }));

test("system prompt gets the hint when only default.md exists", () =>
  withEnv(async ({ repo, dir, before }) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.md"), "Theo");
    assert.ok(before({}, { cwd: repo }).systemPrompt.includes("`whoami` tool"));
  }));

test("whoami-init creates both private templates, then leaves edited files alone", () =>
  withEnv(async ({ repo, dir, init, keyFile }) => {
    const messages: string[] = [];
    const ctx = { cwd: repo, ui: { notify: (m: string) => messages.push(m) } };
    await init("", ctx);
    assert.ok(messages[0].includes(join(dir, "default.md")) && messages[0].includes(join(dir, keyFile)));
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
