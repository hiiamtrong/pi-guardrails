import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ToolCallEvent = { toolName?: unknown; input?: Record<string, unknown> & { command?: unknown } };
type ToolCallResult = { block: true; reason: string } | undefined;
type ToolHandler = (event: ToolCallEvent, ctx: { hasUI: boolean; ui: { confirm: () => Promise<boolean> } }) => Promise<ToolCallResult>;
type GateOptions = { hasUI?: boolean; confirmed?: boolean };

const configDir = mkdtempSync(join(tmpdir(), "pi-github-write-confirm-"));
const configPath = join(configDir, "config.json");
writeFileSync(configPath, JSON.stringify({ writeAllowlist: ["hiiamtrong/allowed-repo"] }));
process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG = configPath;
const { default: extension } = await import(`../extensions/github-write-confirm.ts?test=${Date.now()}`);

test.after(() => rmSync(configDir, { recursive: true, force: true }));

function createGate({ hasUI = true, confirmed = true }: GateOptions = {}) {
  let handler: ToolHandler | undefined;
  let confirms = 0;
  extension({ on(event: "tool_call", callback: ToolHandler) { if (event === "tool_call") handler = callback; } });
  return {
    async run(event: ToolCallEvent) {
      assert.ok(handler, "extension must register a tool_call handler");
      const result = await handler(event, {
        hasUI,
        ui: { async confirm() { confirms += 1; return confirmed; } },
      });
      return { result, confirms };
    },
  };
}

test("permits GitHub reads without confirmation", async () => {
  const gate = createGate();
  const { result, confirms } = await gate.run({ toolName: "bash", input: { command: "gh repo view hiiamtrong/demo --json name" } });
  assert.equal(result, undefined);
  assert.equal(confirms, 0);
});

test("confirms GitHub writes and blocks them without UI", async () => {
  const interactive = createGate({ confirmed: false });
  const rejected = await interactive.run({ toolName: "bash", input: { command: "gh pr merge 12 --merge" } });
  assert.equal(rejected.confirms, 1);
  assert.ok(rejected.result);
  assert.equal(rejected.result.block, true);

  const nonInteractive = createGate({ hasUI: false });
  const blocked = await nonInteractive.run({ toolName: "bash", input: { command: "gh api graphql -f query=mutation" } });
  assert.equal(blocked.confirms, 0);
  assert.ok(blocked.result);
  assert.equal(blocked.result.block, true);
});

test("confirms GitHub MCP review-thread resolution", async () => {
  const gate = createGate();
  const { result, confirms } = await gate.run({ toolName: "mcp__github__resolve_review_thread", input: {} });
  assert.equal(result, undefined);
  assert.equal(confirms, 1);
});

test("allows a configured repository to bypass confirmation", async () => {
  const gate = createGate();
  const { result, confirms } = await gate.run({ toolName: "bash", input: { command: "gh repo edit hiiamtrong/allowed-repo --visibility private" } });
  assert.equal(result, undefined);
  assert.equal(confirms, 0);
});
