import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { projectMemoryDir } from "./memory.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "migrate-hermes.mjs");

function run(root: string, apply: boolean) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
  });
  const start = result.stdout.indexOf("{");
  return { result, report: JSON.parse(result.stdout.slice(start)) };
}

test("migrates Hermes entries and skills without deleting source data", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-memory-migration-"));
  const project = join(root, "work", "example");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "pi-hermes-memory", "skills", "global-skill"), { recursive: true });
  writeFileSync(join(root, "pi-hermes-memory", "MEMORY.md"), "global one\n§\nglobal two\n");
  writeFileSync(join(root, "pi-hermes-memory", "USER.md"), "user preference\n");
  writeFileSync(join(root, "pi-hermes-memory", "failures.md"), "failure lesson\n");
  writeFileSync(join(root, "pi-hermes-memory", "skills", "global-skill", "SKILL.md"), "# Global skill\n");
  mkdirSync(join(root, "projects-memory", "example", "skills", "project-skill"), { recursive: true });
  writeFileSync(join(root, "projects-memory", "example", "MEMORY.md"), "project convention\n");
  writeFileSync(join(root, "projects-memory", "example", "skills", "project-skill", "SKILL.md"), "# Project skill\n");
  mkdirSync(join(root, "sessions", "example"), { recursive: true });
  writeFileSync(join(root, "sessions", "example", "session.jsonl"), `${JSON.stringify({ cwd: project })}\n`);

  const dry = run(root, false);
  assert.equal(dry.result.status, 0);
  assert.equal(dry.report.global["MEMORY.md"].entries, 2);
  assert.equal(existsSync(join(root, "memory")), false);

  const applied = run(root, true);
  assert.equal(applied.result.status, 0, applied.result.stderr);
  assert.deepEqual(applied.report.errors, []);
  assert.equal(applied.report.global["MEMORY.md"].added, 2);
  const projectDir = projectMemoryDir(project, root);
  assert.match(readFileSync(join(projectDir, "MEMORY.md"), "utf8"), /project convention/);
  assert.equal(existsSync(join(projectDir, "skills", "project-skill", "SKILL.md")), true);
  const globalSkill = join(root, "memory", "global", "skills", "global-skill", "SKILL.md");
  assert.equal(existsSync(globalSkill), true);
  assert.equal(statSync(globalSkill).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(globalSkill)).mode & 0o777, 0o700);
  assert.equal(existsSync(join(root, "pi-hermes-memory", "MEMORY.md")), true);

  const rerun = run(root, true);
  assert.equal(rerun.result.status, 0, rerun.result.stderr);
  assert.equal(rerun.report.global["MEMORY.md"].added, 0);
  assert.equal(rerun.report.projects.example.memory.added, 0);
});

test("refuses a symlinked skill destination", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-memory-migration-link-"));
  const source = join(root, "pi-hermes-memory", "skills", "example");
  const outside = join(root, "outside");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(root, "memory", "global"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(source, "SKILL.md"), "# Must stay inside\n");
  symlinkSync(outside, join(root, "memory", "global", "skills"));

  const applied = run(root, true);
  assert.equal(applied.result.status, 1);
  assert.match(applied.report.errors.join("\n"), /regular directory/);
  assert.equal(existsSync(join(outside, "example", "SKILL.md")), false);
});

test("refuses a symlinked legacy memory source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-claude-memory-source-link-"));
  const outside = join(root, "outside.md");
  mkdirSync(join(root, "pi-hermes-memory"), { recursive: true });
  writeFileSync(outside, "sensitive outside content\n");
  symlinkSync(outside, join(root, "pi-hermes-memory", "MEMORY.md"));

  const dry = run(root, false);
  assert.equal(dry.result.status, 1);
  assert.match(dry.report.errors.join("\n"), /MEMORY\.md/);
  assert.equal(existsSync(join(root, "memory")), false);
});
