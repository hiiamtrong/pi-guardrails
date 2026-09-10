import assert from "node:assert/strict";
import test from "node:test";

const { isReviewableEdit, default: ponytailReviewOnSettle } = await import(
  `../extensions/ponytail-review-on-settle.ts?test=${Date.now()}`
);

test("flags write/edit calls on code files", () => {
  assert.equal(
    isReviewableEdit({ toolName: "write", input: { path: "src/foo.ts" } }),
    "src/foo.ts",
  );
  assert.equal(
    isReviewableEdit({ toolName: "edit", input: { path: "swag/foo.py" } }),
    "swag/foo.py",
  );
});

test("ignores non-code files and non-write/edit tools", () => {
  assert.equal(
    isReviewableEdit({ toolName: "write", input: { path: "README.md" } }),
    undefined,
  );
  assert.equal(
    isReviewableEdit({ toolName: "read", input: { path: "src/foo.ts" } }),
    undefined,
  );
  assert.equal(isReviewableEdit({ toolName: "write", input: {} }), undefined);
});

test("sends ponytail-review exactly once on settle after a code edit, and stays silent when nothing was touched", () => {
  const sent: string[] = [];
  const handlers: Record<string, (event?: unknown) => void> = {};
  const pi = {
    on: (event: string, handler: (event?: unknown) => void) => {
      handlers[event] = handler;
    },
    sendUserMessage: (text: string) => sent.push(text),
  };

  ponytailReviewOnSettle(pi);

  handlers.agent_settled();
  assert.deepEqual(sent, []);

  handlers.tool_call({ toolName: "write", input: { path: "src/foo.ts" } });
  handlers.agent_settled();
  assert.deepEqual(sent, ["/skill:ponytail-review"]);

  handlers.agent_settled();
  assert.deepEqual(sent, ["/skill:ponytail-review"]);
});
