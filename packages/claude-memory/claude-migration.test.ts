import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { encodeProjectPath, projectMemoryDir } from "./memory.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "migrate-claude.mjs");

function run(root: string, claudeProjects: string, searchRoot: string, apply: boolean) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECTS_DIR: claudeProjects,
      CLAUDE_PROJECT_SEARCH_ROOTS: searchRoot,
      PI_CODING_AGENT_DIR: root,
    },
  });
  const start = result.stdout.indexOf("{");
  return { result, report: JSON.parse(result.stdout.slice(start)) };
}

function topicBodies(store: string): string[] {
  return readdirSync(store)
    .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
    .map((file) => {
      const text = readFileSync(join(store, file), "utf8");
      const end = text.indexOf("\n---\n", 4);
      return (end >= 0 ? text.slice(end + 5) : text).trim();
    });
}

test("migrates Claude index and topics to a canonical project idempotently", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-source-migration-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const project = join(base, "work", "example-project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const key = encodeProjectPath(project);
  const source = join(claudeProjects, key, "memory");
  mkdirSync(source, { recursive: true });
  const sourceIndex = "# Memory Index\n\n- [Project rule](project_rule.md) — Use the verified command\n";
  const sourceTopic = "# Project rule\n\nUse the verified command before reporting done.\n";
  writeFileSync(join(source, "MEMORY.md"), sourceIndex);
  writeFileSync(join(source, "project_rule.md"), sourceTopic);

  const dry = run(root, claudeProjects, join(base, "work"), false);
  assert.equal(dry.result.status, 0, dry.result.stderr);
  assert.equal(dry.report.projects[key].mapping, "exact");
  assert.equal(dry.report.projects[key].topics, 2);
  assert.equal(existsSync(join(root, "memory")), false);

  const applied = run(root, claudeProjects, join(base, "work"), true);
  assert.equal(applied.result.status, 0, applied.result.stderr);
  assert.equal(applied.report.projects[key].added, 2);
  const destination = projectMemoryDir(project, root);
  assert.deepEqual(new Set(topicBodies(destination)), new Set([sourceIndex.trim(), sourceTopic.trim()]));
  assert.equal(readFileSync(join(source, "project_rule.md"), "utf8"), sourceTopic);

  const rerun = run(root, claudeProjects, join(base, "work"), true);
  assert.equal(rerun.result.status, 0, rerun.result.stderr);
  assert.equal(rerun.report.projects[key].added, 0);
});

test("archives an unresolved Claude project without activating a guessed identity", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-unresolved-migration-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const key = "-Users-missing-Works-example";
  const source = join(claudeProjects, key, "memory");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "MEMORY.md"), "# Orphan memory\n\nHistorical detail.\n");

  const applied = run(root, claudeProjects, join(base, "empty-search"), true);
  assert.equal(applied.result.status, 0, applied.result.stderr);
  assert.equal(applied.report.projects[key].mapping, "unresolved");
  assert.equal(applied.report.warnings.length, 1);
  assert.equal(existsSync(join(root, "memory", "unresolved-claude-projects", key, "MEMORY.md")), true);
});

test("archives encoded path collisions instead of guessing", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-path-collision-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const first = join(base, "work", "a-b", "c");
  const second = join(base, "work", "a", "b-c");
  for (const project of [first, second]) {
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  const key = encodeProjectPath(first);
  const source = join(claudeProjects, key, "memory");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "MEMORY.md"), "# Ambiguous memory\n");

  const dry = run(root, claudeProjects, join(base, "work"), false);
  assert.equal(dry.result.status, 0, dry.result.stderr);
  assert.equal(dry.report.projects[key].mapping, "unresolved");
  assert.equal(dry.report.projects[key].canonicalRoots.length, 2);
});

test("refuses a symlinked active-project destination", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-project-link-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const project = join(base, "work", "example");
  const outside = join(base, "outside");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const key = encodeProjectPath(project);
  const source = join(claudeProjects, key, "memory");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(source, "MEMORY.md"), "# Must stay inside\n");
  symlinkSync(outside, join(root, "memory", "projects"));

  const applied = run(root, claudeProjects, join(base, "work"), true);
  assert.equal(applied.result.status, 1);
  assert.match(applied.report.errors.join("\n"), /regular directories/);
  assert.equal(existsSync(join(outside, key, "MEMORY.md")), false);
});

test("refuses a symlinked unresolved destination", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-destination-link-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const key = "-Users-missing-Works-destination";
  const source = join(claudeProjects, key, "memory");
  const outside = join(base, "outside");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(source, "MEMORY.md"), "# Must stay inside\n");
  symlinkSync(outside, join(root, "memory", "unresolved-claude-projects"));

  const applied = run(root, claudeProjects, join(base, "empty-search"), true);
  assert.equal(applied.result.status, 1);
  assert.match(applied.report.errors.join("\n"), /regular directories/);
  assert.equal(existsSync(join(outside, key, "MEMORY.md")), false);
});

test("refuses a symlinked migration-report destination", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-report-link-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const outside = join(base, "outside");
  mkdirSync(claudeProjects, { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(root, "memory", "migrations"));

  const applied = run(root, claudeProjects, join(base, "empty-search"), true);
  assert.equal(applied.result.status, 1);
  assert.match(applied.report.errors.join("\n"), /Migration report path must be a regular directory/);
  assert.equal(readdirSync(outside).length, 0);
});

test("caps aggregate Claude session discovery", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-session-cap-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const key = "-Users-missing-Works-session-cap";
  const projectDir = join(claudeProjects, key);
  mkdirSync(join(projectDir, "memory"), { recursive: true });
  writeFileSync(join(projectDir, "memory", "MEMORY.md"), "# Capped sessions\n");
  for (let index = 0; index <= 1_000; index++) {
    writeFileSync(join(projectDir, `${index}.jsonl`), "{}\n");
  }

  const dry = run(root, claudeProjects, join(base, "empty-search"), false);
  assert.equal(dry.result.status, 0, dry.result.stderr);
  assert.match(dry.report.warnings.join("\n"), /session scan stopped after 1000 files/);
});

test("refuses a symlinked Claude topic source", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-claude-source-link-"));
  const root = join(base, "agent");
  const claudeProjects = join(base, "claude-projects");
  const key = "-Users-missing-Works-linked";
  const source = join(claudeProjects, key, "memory");
  const outside = join(base, "outside.md");
  mkdirSync(source, { recursive: true });
  writeFileSync(outside, "sensitive outside content\n");
  symlinkSync(outside, join(source, "linked.md"));

  const dry = run(root, claudeProjects, join(base, "empty-search"), false);
  assert.equal(dry.result.status, 1);
  assert.match(dry.report.errors.join("\n"), /symlink sources are not allowed/);
  assert.equal(existsSync(join(root, "memory")), false);
});
