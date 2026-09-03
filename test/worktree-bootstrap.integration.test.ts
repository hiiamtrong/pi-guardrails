import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";

const { default: extension } = await import(
  `../extensions/worktree-bootstrap.ts?integration=${Date.now()}`
);

test("copies configured ignored files into a new linked worktree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-worktree-bootstrap-"));
  const worktree = `${repo}-linked`;
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
    writeFileSync(join(repo, ".env"), "PRIVATE_VALUE=kept-local\n");
    const hookPath = join(repo, ".git", "hooks", "post-checkout");
    const originalHook = "#!/bin/sh\nexit 0\n";
    writeFileSync(hookPath, originalHook, { mode: 0o755 });
    execFileSync("git", ["-C", repo, "add", ".gitignore", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"], {
      stdio: "ignore",
    });

    let handler:
      | ((
          args: string,
          ctx: {
            cwd: string;
            hasUI?: boolean;
            ui?: {
              confirm?: () => Promise<boolean>;
              notify?: () => void;
            };
          },
        ) => Promise<void>)
      | undefined;
    extension({
      registerCommand(
        name: string,
        command: {
          handler: (
            args: string,
            ctx: { cwd: string; hasUI?: boolean },
          ) => Promise<void>;
        },
      ) {
        if (name === "worktree-bootstrap") handler = command.handler;
      },
    });
    assert.ok(handler);

    await handler("setup .env", {
      cwd: repo,
      hasUI: true,
      ui: { confirm: async () => true, notify: () => {} },
    });
    execFileSync(
      "git",
      ["-C", repo, "worktree", "add", "-b", "linked", worktree],
      {
        stdio: "ignore",
      },
    );

    assert.equal(
      readFileSync(join(worktree, ".env"), "utf8"),
      "PRIVATE_VALUE=kept-local\n",
    );
    assert.match(
      readFileSync(hookPath, "utf8"),
      /pi-guardrails-worktree-bootstrap/,
    );
    assert.equal(
      readFileSync(`${hookPath}.pi-guardrails-original`, "utf8"),
      originalHook,
    );

    await handler("disable", {
      cwd: repo,
      hasUI: true,
      ui: { notify: () => {} },
    });
    assert.equal(readFileSync(hookPath, "utf8"), originalHook);
    assert.equal(existsSync(`${hookPath}.pi-guardrails-original`), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});
