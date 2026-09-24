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

function setup(trivial: number | Error) {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
  const states: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (trivial instanceof Error) throw trivial;
    states.push(JSON.parse(init.body as string).state);
    return new Response(
      JSON.stringify({ answers: { trivial: { type: "noul", noul: trivial } } }),
    );
  }) as typeof fetch;

  const sent: string[] = [];
  const options: unknown[] = [];
  const handlers: Record<string, (event?: unknown) => unknown> = {};
  ponytailReviewOnSettle({
    on: (event: string, handler: (event?: unknown) => unknown) => {
      handlers[event] = handler;
    },
    sendUserMessage: (text: string, option: unknown) => {
      sent.push(text);
      options.push(option);
    },
  });
  return { sent, options, states, handlers };
}

test("sends ponytail-review exactly once on settle after a non-trivial code edit, and stays silent when nothing was touched", async () => {
  const { sent, options, states, handlers } = setup(0.1);

  await handlers.agent_settled();
  assert.deepEqual(sent, []);

  handlers.tool_call({
    toolName: "edit",
    input: {
      path: "src/foo.ts",
      edits: [{ oldText: "new Foo()", newText: "class Factory {}" }],
    },
  });
  handlers.tool_call({
    toolName: "write",
    input: { path: "src/bar.ts", content: "export {}" },
  });
  await handlers.agent_settled();
  assert.deepEqual(sent, ["/skill:ponytail-review"]);
  assert.deepEqual(options, [
    { deliverAs: "followUp", expandPromptTemplates: true },
  ]);
  assert.deepEqual(states, [
    {
      edits: [
        { path: "src/foo.ts", before: "new Foo()", after: "class Factory {}" },
        { path: "src/bar.ts", after: "export {}" },
      ],
    },
  ]);

  await handlers.agent_settled();
  assert.deepEqual(sent, ["/skill:ponytail-review"]);
});

test("skips ponytail-review when Jev is confident the change is trivial", async () => {
  const { sent, handlers } = setup(0.95);
  handlers.tool_call({
    toolName: "write",
    input: { path: "src/foo.ts", content: "const x = 1;" },
  });
  await handlers.agent_settled();
  assert.deepEqual(sent, []);
});

test("still reviews when Jev fails or the change is too large to send", async () => {
  const failing = setup(new Error("network down"));
  failing.handlers.tool_call({ toolName: "write", input: { path: "a.ts", content: "x" } });
  await failing.handlers.agent_settled();
  assert.deepEqual(failing.sent, ["/skill:ponytail-review"]);

  const large = setup(0.99);
  large.handlers.tool_call({
    toolName: "write",
    input: { path: "a.ts", content: "x".repeat(70_000) },
  });
  await large.handlers.agent_settled();
  assert.deepEqual(large.sent, ["/skill:ponytail-review"]);
  assert.deepEqual(large.states, []);
});
