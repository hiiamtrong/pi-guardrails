import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: extension } = await import(
  `../extensions/github-identity-guard-required.ts?test=${Date.now()}`
);

type Handler = (
  event: {
    toolName: string;
    input: {
      command?: string;
      code?: string;
      commands?: { command: string }[];
      cwd?: string;
      language?: string;
    };
  },
  ctx: { cwd: string },
) => { block: boolean; reason: string } | undefined;

function createHandler(): Handler {
  let handler: Handler | undefined;
  extension({
    on(event: "tool_call", callback: Handler) {
      if (event === "tool_call") handler = callback;
    },
  });
  assert.ok(handler);
  return handler;
}

test("blocks commit and push when the repository lacks Git Identity Guard", () => {
  const repo = mkdtempSync(join(tmpdir(), "github-identity-guard-required-"));
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const handler = createHandler();
  for (const event of [
    { toolName: "bash", input: { command: "git commit -m test" } },
    { toolName: "bash", input: { command: "/usr/bin/git push origin main" } },
    {
      toolName: "ctx_execute",
      input: {
        code: "execFileSync('/usr/bin/git', ['commit', '-m', 'test'])",
      },
    },
    {
      toolName: "ctx_execute",
      input: { language: "shell", code: "git push origin main" },
    },
  ]) {
    const result = handler(event, { cwd: repo });
    assert.equal(result?.block, true);
  }
  rmSync(repo, { recursive: true, force: true });
});

test("blocks GitHub writes without Git Identity Guard", () => {
  const repo = mkdtempSync(join(tmpdir(), "github-identity-guard-batch-"));
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const handler = createHandler();
  for (const event of [
    {
      toolName: "ctx_batch_execute",
      input: { commands: [{ command: "gh pr comment 18459 --body test" }] },
    },
    { toolName: "bash", input: { command: "gh issue lock 123" } },
    { toolName: "bash", input: { command: "gh pr ready 123" } },
    { toolName: "bash", input: { command: "gh repo archive" } },
    {
      toolName: "ctx_execute",
      input: { code: "execFileSync('/usr/bin/gh', ['issue', 'lock', '123'])" },
    },
  ]) {
    const result = handler(event, { cwd: repo });
    assert.equal(result?.block, true);
  }
  rmSync(repo, { recursive: true, force: true });
});

test("permits gh auth switch so the correct account can be selected", () => {
  const repo = mkdtempSync(
    join(tmpdir(), "github-identity-guard-auth-switch-"),
  );
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const result = createHandler()(
    {
      toolName: "bash",
      input: { command: "gh auth switch --user Sotatek-DavidVu" },
    },
    { cwd: repo },
  );
  assert.equal(result, undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("blocks GitHub MCP review-thread resolution because its token identity is unverifiable", () => {
  const result = createHandler()(
    { toolName: "mcp__github__resolve_review_thread", input: {} },
    { cwd: process.cwd() },
  );
  assert.deepEqual(result, {
    block: true,
    reason:
      "GitHub MCP write blocked: Git Identity Guard cannot verify the MCP token account. Use a guarded gh command instead.",
  });
});

test("permits a guarded linked worktree", () => {
  const repo = mkdtempSync(join(tmpdir(), "github-identity-guard-worktree-"));
  const worktree = `${repo}-linked`;
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "README"), "test\n");
  execFileSync("git", ["-C", repo, "add", "README"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-C", repo, "worktree", "add", "-b", "linked", worktree],
    { stdio: "ignore" },
  );
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "identity.guard.user",
    "test-user",
  ]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "identity.guard.email",
    "test@example.com",
  ]);
  const worktreeGitDir = execFileSync(
    "git",
    ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir"],
    { encoding: "utf8" },
  ).trim();
  const runner = join(worktreeGitDir, "identity-guard", "guard");
  mkdirSync(join(worktreeGitDir, "identity-guard"));
  writeFileSync(runner, "#!/bin/sh\n");
  execFileSync("git", ["-C", repo, "config", "identity.guard.runner", runner]);

  const result = createHandler()(
    { toolName: "bash", input: { command: "git commit -m test" } },
    { cwd: worktree },
  );
  assert.equal(result, undefined);

  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
  rmSync(repo, { recursive: true, force: true });
});
