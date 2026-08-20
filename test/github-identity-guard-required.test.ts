import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: extension } = await import(
  `../extensions/github-identity-guard-required.ts?test=${Date.now()}`
);

test("blocks commit and push when the repository lacks Git Identity Guard", () => {
  const repo = mkdtempSync(join(tmpdir(), "github-identity-guard-required-"));
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  let handler:
    | ((
        event: { toolName: string; input: { command: string } },
        ctx: { cwd: string },
      ) => { block: boolean; reason: string } | undefined)
    | undefined;
  extension({
    on(event: "tool_call", callback: typeof handler) {
      if (event === "tool_call") handler = callback;
    },
  });
  assert.ok(handler);
  const result = handler(
    { toolName: "bash", input: { command: "git commit -m test" } },
    { cwd: repo },
  );
  assert.equal(result?.block, true);
  rmSync(repo, { recursive: true, force: true });
});
