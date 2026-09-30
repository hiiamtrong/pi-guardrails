import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

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
    assert.match(result?.reason ?? "", /Action: git (?:commit|push)\./);
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
    assert.match(result?.reason ?? "", /Action: gh /);
  }
  rmSync(repo, { recursive: true, force: true });
});

test("names the action when the authenticated GitHub account is wrong", () => {
  const repo = mkdtempSync(join(tmpdir(), "github-identity-action-"));
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const runner = join(repo, "guard");
  writeFileSync(runner, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "identity.guard.user",
    "expected-user",
  ]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "identity.guard.email",
    "expected@example.com",
  ]);
  execFileSync("git", ["-C", repo, "config", "identity.guard.runner", runner]);

  const result = createHandler()(
    { toolName: "bash", input: { command: "gh issue lock 123" } },
    { cwd: repo },
  );
  assert.match(result?.reason ?? "", /Action: gh issue lock\./);
  assert.match(result?.reason ?? "", /authenticated gh account/);
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

test("blocks a git push combined with gh auth switch in the same command", () => {
  const repo = mkdtempSync(
    join(tmpdir(), "github-identity-guard-combined-switch-"),
  );
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const result = createHandler()(
    {
      toolName: "bash",
      input: {
        command: "gh auth switch --user hiiamtrong\ngit push origin main",
      },
    },
    { cwd: repo },
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Run `gh auth switch` as its own command/);
  rmSync(repo, { recursive: true, force: true });
});

test("blocks a GitHub write combined with gh auth switch across ctx_batch_execute commands", () => {
  const repo = mkdtempSync(
    join(tmpdir(), "github-identity-guard-combined-batch-"),
  );
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const result = createHandler()(
    {
      toolName: "ctx_batch_execute",
      input: {
        commands: [
          { command: "gh auth switch --user hiiamtrong" },
          { command: "gh pr comment 1 --body test" },
        ],
      },
    },
    { cwd: repo },
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Run `gh auth switch` as its own command/);
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
      "GitHub MCP write blocked. Action: mcp__github__resolve_review_thread. Git Identity Guard cannot verify the MCP token account. Use a guarded gh command instead.",
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

const tempRepos: string[] = [];
after(() => tempRepos.forEach((repo) => rmSync(repo, { recursive: true, force: true })));

function makeRepo(options: { guarded: boolean; ghMatches?: boolean; parent?: string }): string {
  const repo = options.parent
    ? join(options.parent, "child")
    : mkdtempSync(join(tmpdir(), "github-identity-target-"));
  tempRepos.push(repo);
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  if (!options.guarded) return repo;
  const runner = join(repo, "guard");
  writeFileSync(runner, `#!/bin/sh\nexit ${options.ghMatches === false ? 1 : 0}\n`, {
    mode: 0o755,
  });
  for (const [key, value] of [
    ["identity.guard.user", "expected-user"],
    ["identity.guard.email", "expected@example.com"],
    ["identity.guard.runner", runner],
  ]) {
    execFileSync("git", ["-C", repo, "config", key, value]);
  }
  return repo;
}

function verdict(command: string, cwd: string, toolName = "bash") {
  const input =
    toolName === "ctx_batch_execute"
      ? { commands: [{ command }] }
      : toolName === "ctx_execute"
        ? { language: "shell", code: command }
        : { command };
  return createHandler()({ toolName, input }, { cwd });
}

test("checks the repository a command targets, not just the session directory", () => {
  const guarded = makeRepo({ guarded: true });
  const plain = makeRepo({ guarded: false });
  for (const toolName of ["bash", "ctx_batch_execute", "ctx_execute"]) {
    for (const command of [
      `cd ${guarded} && git push origin main`,
      `git -C ${guarded} commit -m test`,
      `cd ${guarded} && git add -A && git commit -m x && git push origin main`,
    ]) {
      assert.equal(verdict(command, plain, toolName), undefined, `${toolName}: ${command}`);
    }
  }
});

test("blocks a git write aimed at an unguarded repository from a guarded session", () => {
  const guarded = makeRepo({ guarded: true });
  const plain = makeRepo({ guarded: false });
  for (const toolName of ["bash", "ctx_batch_execute", "ctx_execute"]) {
    for (const command of [
      `git -C ${plain} push origin main`,
      `cd ${plain} && git push origin main`,
      `cd ${guarded} && git commit -m x && cd ${plain} && git push origin main`,
    ]) {
      const result = verdict(command, guarded, toolName);
      assert.equal(result?.block, true, `${toolName}: ${command}`);
      assert.match(result?.reason ?? "", /Install Git Identity Guard/);
    }
  }
});

test("a failed cd must not let a later command run unverified in the old directory", () => {
  const guarded = makeRepo({ guarded: true });
  const plain = makeRepo({ guarded: false });
  for (const separator of [";", "\n", "||"]) {
    const result = verdict(`cd ${guarded}${separator} git push origin main`, plain);
    assert.equal(result?.block, true, JSON.stringify(separator));
  }
  assert.equal(verdict(`cd ${guarded} && git push origin main`, plain), undefined);
});

test("refuses targets it cannot resolve statically", () => {
  const guarded = makeRepo({ guarded: true });
  for (const command of [
    "cd $REPO && git push origin main",
    'cd "$(pwd)/x" && git push origin main',
    `cd ${guarded}/* && git push origin main`,
    `git --git-dir=${guarded}/.git push origin main`,
    `GIT_DIR=${guarded}/.git git push origin main`,
    `GIT_WORK_TREE=${guarded} git commit -m x`,
    `(cd ${guarded} && git push origin main)`,
    `{ cd ${guarded}; git push origin main; }`,
    `cd ${guarded} | git push origin main`,
    `pushd ${guarded} && git push origin main`,
    "cd - && git push origin main",
    `env -C ${guarded} git push origin main`,
    "git -C $REPO push origin main",
  ]) {
    const result = verdict(command, guarded);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /Cannot tell which repository/, command);
  }
});

test("resolves relative cd and git -C paths against the session directory", () => {
  const parent = makeRepo({ guarded: false });
  makeRepo({ guarded: true, parent });
  assert.equal(verdict("cd child && git push origin main", parent), undefined);
  assert.equal(verdict("git -C child commit -m x", parent), undefined);
  assert.equal(verdict("git -C child -C .. push origin main", parent)?.block, true);
});

test("verifies the gh account against the pushed repository, not the session directory", () => {
  const good = makeRepo({ guarded: true, ghMatches: true });
  const bad = makeRepo({ guarded: true, ghMatches: false });
  assert.equal(verdict(`git -C ${good} push origin main`, bad), undefined);
  const result = verdict(`git -C ${bad} push origin main`, good);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /authenticated gh account/);
});

test("gh commands are still judged by the session directory", () => {
  const guarded = makeRepo({ guarded: true });
  const plain = makeRepo({ guarded: false });
  const result = verdict(`cd ${guarded} && gh issue lock 123`, plain);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Action: gh issue lock/);
});

test("commands without a guarded git write are not affected by target resolution", () => {
  const plain = makeRepo({ guarded: false });
  assert.equal(verdict("cd $REPO && ls", plain), undefined);
});
