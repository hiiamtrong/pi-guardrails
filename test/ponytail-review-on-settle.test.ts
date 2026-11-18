import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { isReviewableEdit, isReviewTarget, default: ponytailReviewOnSettle } =
  await import(
    `../extensions/ponytail-review-on-settle.ts?test=${Date.now()}`
  );
const { MAX_STATE_CHARS } = await import(`../extensions/jev.ts?test=${Date.now()}`);
const { agentRoot } = await import("../packages/claude-memory/memory.ts");

// The gate walks up looking for `.git`, so these fixtures are real directories.
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const bare = mkdtempSync(join(tmpdir(), "ponytail-no-repo-"));
process.on("exit", () => rmSync(bare, { recursive: true, force: true }));
// On Linux tmpdir() is /tmp, which the scratch rule already rejects, so the no-.git
// check can only be told apart where the temp directory is somewhere else (macOS).
const bareProvesNoRepo = !/(?:^|\/)tmp\//.test(`${bare}/`);
const REVIEW = /^\/skill:ponytail-review End your reply .*recap/;

const reviewed = (sent: string[]) => {
  assert.equal(sent.length, 1, "exactly one follow-up");
  assert.match(sent[0], REVIEW);
};

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

test("tolerates events with a missing input, a missing path, or null edit entries", async () => {
  assert.equal(isReviewableEdit({ toolName: "write" }), undefined);
  assert.equal(isReviewableEdit({ toolName: "edit", input: undefined }), undefined);
  assert.equal(isReviewableEdit({ toolName: "edit", input: { path: null } }), undefined);
  assert.equal(isReviewableEdit({ toolName: undefined, input: { path: "a.ts" } }), undefined);

  const { sent, states, handlers } = setup(0.1);
  handlers.tool_call({
    toolName: "edit",
    input: { path: "a.ts", edits: [null, { oldText: "a" }, { newText: "b" }] },
  });
  await handlers.agent_settled({ aborted: false });
  assert.deepEqual(states, [
    {
      edits: [
        { path: "a.ts", before: "a", after: "" },
        { path: "a.ts", before: "", after: "b" },
      ],
    },
  ]);
  reviewed(sent);

  const empty = setup(0.1);
  empty.handlers.tool_call({ toolName: "edit", input: { path: "a.ts" } });
  await empty.handlers.agent_settled({ aborted: false });
  assert.deepEqual(empty.sent, []);
  assert.deepEqual(empty.states, []);
});

test("counts code in any git tree and skips scratch, dependency and report directories", () => {
  const source = join(project, "extensions", "whoami.ts");
  assert.equal(isReviewTarget(source, project), true);
  assert.equal(isReviewTarget("extensions/whoami.ts", project), true);
  // Same file, session opened elsewhere: another repo's code is still reviewed.
  assert.equal(isReviewTarget(source, bare), true);
  assert.equal(isReviewTarget("/tmp/rv/19528/probe.py", project), false);
  assert.equal(isReviewTarget("/Users/x/proj/reports/reviews/evidence/19528/probe.py", project), false);
  assert.equal(isReviewTarget("/Users/x/proj/node_modules/x/index.js", project), false);
  assert.equal(isReviewTarget(join(project, "reports", "Report.ts"), project), true);
  assert.equal(isReviewTarget(join(project, "reports", "reviews", "probe.py"), project), false);
  assert.equal(isReviewTarget(join(project, "dist", "build.js"), project), true);
  // The home directory can itself be a git repo (dotfiles); scratch files under it do not count.
  assert.equal(isReviewTarget(join(homedir(), "ponytail-no-such-dir", "x.ts"), project), false);
  // ...except the pi config, which is edited by hand but is not a repository.
  assert.equal(isReviewTarget(join(agentRoot(), "extensions", "limits.ts"), project), true);
  assert.equal(isReviewTarget(join(agentRoot(), "npm", "node_modules", "x", "index.js"), project), false);
  assert.equal(isReviewTarget(`${agentRoot()}x/limits.ts`, project), false);
  const configured = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(homedir(), "ponytail-other-agent");
  try {
    assert.equal(isReviewTarget(join(homedir(), "ponytail-other-agent", "extensions", "x.ts"), project), true);
    assert.equal(isReviewTarget(join(homedir(), ".pi", "agent", "extensions", "x.ts"), project), false);
  } finally {
    if (configured === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = configured;
  }
  if (bareProvesNoRepo) assert.equal(isReviewTarget(join(bare, "src", "foo.ts"), project), false);

  assert.equal(
    isReviewableEdit({ toolName: "write", input: { path: "/tmp/rv/probe.py" } }, project),
    undefined,
  );
  assert.equal(
    isReviewableEdit({ toolName: "edit", input: { path: "extensions/whoami.ts" } }, project),
    "extensions/whoami.ts",
  );
});

test("does not review a turn whose code edits were all scratch or outside any repo", async () => {
  const { sent, handlers } = setup(0.1);
  const cwd = project;
  handlers.tool_call(
    { toolName: "write", input: { path: "/tmp/rv/19528/probe.py", content: "x" } },
    { cwd },
  );
  handlers.tool_call(
    {
      toolName: "edit",
      input: {
        path: "/repo/project/reports/reviews/evidence/19528/run.sh",
        edits: [{ oldText: "a", newText: "b" }],
      },
    },
    { cwd },
  );
  await handlers.agent_settled({ aborted: false });
  assert.deepEqual(sent, []);
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
  const handlers: Record<
    string,
    (event?: unknown, ctx?: unknown) => unknown
  > = {};
  ponytailReviewOnSettle({
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
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

  await handlers.agent_settled({ aborted: false });
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
  await handlers.agent_settled({ aborted: false });
  reviewed(sent);
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

  await handlers.agent_settled({ aborted: false });
  reviewed(sent);
});
test("skips ponytail-review when Jev is confident the change is trivial", async () => {
  const { sent, handlers } = setup(0.95);
  handlers.tool_call({
    toolName: "write",
    input: { path: "src/foo.ts", content: "const x = 1;" },
  });
  await handlers.agent_settled({ aborted: false });
  assert.deepEqual(sent, []);
});

test("still reviews when Jev fails or the change is too large to send", async () => {
  const failing = setup(new Error("network down"));
  failing.handlers.tool_call({ toolName: "write", input: { path: "a.ts", content: "x" } });
  await failing.handlers.agent_settled({ aborted: false });
  reviewed(failing.sent);

  const large = setup(0.99);
  large.handlers.tool_call({
    toolName: "write",
    input: { path: "a.ts", content: "x".repeat(70_000) },
  });
  await large.handlers.agent_settled({ aborted: false });
  reviewed(large.sent);
  assert.deepEqual(large.states, []);
});

test("skips the review at exactly the Jev threshold and still asks Jev at exactly the size limit", async () => {
  const atThreshold = setup(0.8);
  atThreshold.handlers.tool_call({
    toolName: "write",
    input: { path: "a.ts", content: "const x = 1;" },
  });
  await atThreshold.handlers.agent_settled({ aborted: false });
  assert.deepEqual(atThreshold.sent, []);
  assert.equal(atThreshold.states.length, 1);

  // JSON.stringify of the edit adds `[{"path":"a.ts","after":""}]`, so the padding lands exactly on the limit.
  const padding = MAX_STATE_CHARS - JSON.stringify([{ path: "a.ts", after: "" }]).length;
  const atLimit = setup(0.1);
  atLimit.handlers.tool_call({
    toolName: "write",
    input: { path: "a.ts", content: "x".repeat(padding) },
  });
  await atLimit.handlers.agent_settled({ aborted: false });
  assert.equal(atLimit.states.length, 1, "exactly at the limit still goes to Jev");
  reviewed(atLimit.sent);

  const overLimit = setup(0.1);
  overLimit.handlers.tool_call({
    toolName: "write",
    input: { path: "a.ts", content: "x".repeat(padding + 1) },
  });
  await overLimit.handlers.agent_settled({ aborted: false });
  assert.deepEqual(overLimit.states, [], "one character over the limit skips Jev");
  reviewed(overLimit.sent);
});

test("does not review after an aborted run, then reviews the queued edits on the next settle", async () => {
  const { sent, handlers } = setup(0.1);
  handlers.tool_call({ toolName: "write", input: { path: "a.ts", content: "x" } });
  await handlers.agent_settled({ aborted: true });
  assert.deepEqual(sent, []);
  await handlers.agent_settled({ aborted: false });
  reviewed(sent);
});
