import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hookRunner = join(
  process.cwd(),
  "extensions",
  "worktree-bootstrap-hook.mjs",
);

function runHook(cwd: string, ...args: string[]): Record<string, unknown> {
  const output = execFileSync("node", [hookRunner, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output ? (JSON.parse(output) as Record<string, unknown>) : {};
}

test("rejects symlinked sync-back paths", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-worktree-symlink-"));
  const worktree = `${repo}-linked`;
  const outside = `${repo}-outside`;
  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    writeFileSync(join(repo, ".gitignore"), "secrets/\n");
    writeFileSync(join(repo, "README.md"), "tracked\n");
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "token"), "primary\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"], {
      stdio: "ignore",
    });
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "--local",
      "piGuardrails.worktreeBootstrap.source",
      repo,
    ]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "--local",
      "--add",
      "piGuardrails.worktreeBootstrap.file",
      "secrets/token",
    ]);
    execFileSync(
      "git",
      ["-C", repo, "worktree", "add", "-b", "linked", worktree],
      {
        stdio: "ignore",
      },
    );
    runHook(worktree);
    writeFileSync(join(worktree, "secrets", "token"), "linked\n");

    renameSync(join(repo, "secrets"), join(repo, "secrets-original"));
    mkdirSync(outside);
    writeFileSync(join(outside, "token"), "outside\n");
    symlinkSync(outside, join(repo, "secrets"), "dir");

    assert.throws(() => runHook(worktree, "--sync-back"), /symlink/i);
    assert.equal(readFileSync(join(outside, "token"), "utf8"), "outside\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("serializes sync-back and rejects a stale worktree conflict", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-worktree-sync-back-"));
  const first = `${repo}-first`;
  const second = `${repo}-second`;
  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, "README.md"), "tracked\n");
    writeFileSync(join(repo, ".env"), "VALUE=primary-a\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"], {
      stdio: "ignore",
    });
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "--local",
      "piGuardrails.worktreeBootstrap.source",
      repo,
    ]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "--local",
      "--add",
      "piGuardrails.worktreeBootstrap.file",
      ".env",
    ]);

    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "first", first], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-C", repo, "worktree", "add", "-b", "second", second],
      { stdio: "ignore" },
    );
    runHook(first);
    runHook(second);

    writeFileSync(join(first, ".env"), "VALUE=first-b\n");
    const firstPlan = runHook(first, "--sync-back", "--dry-run");
    assert.deepEqual(firstPlan.updates, [".env"]);
    assert.deepEqual(firstPlan.conflicts, []);
    runHook(first, "--sync-back");
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "VALUE=first-b\n");

    writeFileSync(join(second, ".env"), "VALUE=second-c\n");
    const secondPlan = runHook(second, "--sync-back", "--dry-run");
    assert.deepEqual(secondPlan.updates, []);
    assert.deepEqual(secondPlan.conflicts, [
      {
        file: ".env",
        reason: "changed in both primary and worktree",
      },
    ]);
    assert.throws(() => runHook(second, "--sync-back"));
    assert.equal(readFileSync(join(repo, ".env"), "utf8"), "VALUE=first-b\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
