import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const module = await import(
  `../extensions/worktree-bootstrap.ts?test=${Date.now()}`
);

test("parses per-repository worktree bootstrap settings", () => {
  assert.deepEqual(
    module.parseSetupArguments('--source "/tmp/main worktree" .env .env.local .bruno'),
    {
      source: "/tmp/main worktree",
      files: [".env", ".env.local", ".bruno"],
    },
  );
});

test("rejects unsafe ignored-file paths", () => {
  for (const value of ["", ".", "../.env", "/tmp/.env", ".git/config"]) {
    assert.throws(() => module.normalizeCopyPath(value), /Unsafe bootstrap path/);
  }
});

test("requires at least one configured ignored file", () => {
  assert.throws(
    () => module.parseSetupArguments('--source /tmp/template'),
    /Provide at least one ignored file/,
  );
});

test("refuses a possibly shared core.hooksPath", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-worktree-hooks-path-"));
  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", "/tmp/shared-hooks"]);
    assert.throws(
      () => module.hookDirectory(repo),
      /Refusing to modify a configured core\.hooksPath/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
