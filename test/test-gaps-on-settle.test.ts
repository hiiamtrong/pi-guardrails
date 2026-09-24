import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { isTestFile, sourceFilesFor, errorPaths, default: testGaps } = await import(
  `../extensions/test-gaps-on-settle.ts?test=${Date.now()}`
);

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "test-gaps-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("recognizes test files across languages", () => {
  for (const path of ["a.test.ts", "src/a.spec.tsx", "a.test.mjs", "x_test.go", "tests/test_api.py", "api_test.py"])
    assert.equal(isTestFile(path), true, path);
  for (const path of ["src/a.ts", "testing.py", "contest.go", "test/helpers.ts"])
    assert.equal(isTestFile(path), false, path);
});

test("resolves the source files a test imports", () => {
  const root = project({
    "src/a.ts": "",
    "src/b/index.ts": "",
    "extensions/c.ts": "",
    "pkg/mod.py": "",
    "src/svc/api.py": "",
    "go/sum.go": "",
  });
  const js = sourceFilesFor(
    join(root, "test/a.test.ts"),
    `import { a } from "../src/a";\nimport b from "../src/b";\nimport x from "node:fs";\nawait import(\`../extensions/c.ts?test=\${Date.now()}\`);\nimport { gone } from "../src/missing";`,
    root,
  );
  assert.deepEqual(js, [join(root, "src/a.ts"), join(root, "src/b/index.ts"), join(root, "extensions/c.ts")]);

  const py = sourceFilesFor(join(root, "tests/test_mod.py"), "import os\nfrom pkg.mod import f\nfrom svc.api import g\n", root);
  assert.deepEqual(py, [join(root, "pkg/mod.py"), join(root, "src/svc/api.py")]);

  assert.deepEqual(sourceFilesFor(join(root, "go/sum_test.go"), "package sum", root), [join(root, "go/sum.go")]);
});

test("extracts each distinct error path once", () => {
  assert.deepEqual(
    errorPaths(`throw new Error("age is required");\nthrow new RangeError('too big');\nraise ValueError("bad id")\nreturn errors.New("not found")\nthrow new Error("age is required");`),
    [
      'the error path that throws or raises "age is required"',
      'the error path that throws or raises "too big"',
      'the error path that throws or raises "bad id"',
      'the error path that throws or raises "not found"',
    ],
  );
});

function setup(files: Record<string, string>, fetchImpl?: typeof fetch) {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
  let calls = 0;
  globalThis.fetch =
    fetchImpl ??
    ((async (_url: string, init: RequestInit) => {
      calls += 1;
      const { questions } = JSON.parse(init.body as string);
      const answers = Object.fromEntries(
        Object.entries(questions as Record<string, { instructions: string }>).map(([id, { instructions }]) => {
          const relevance = instructions.startsWith("This case is relevant");
          const noul = /happy path/.test(instructions)
            ? 0.95
            : relevance
              ? /empty input/.test(instructions) ? 0.9 : 0.1
              : 0.05;
          return [id, { type: "noul", noul }];
        }),
      );
      return new Response(JSON.stringify({ answers }));
    }) as typeof fetch);
  const root = project(files);
  const sent: [string, unknown][] = [];
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
  testGaps({
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
    sendUserMessage: (text: string, options: unknown) => sent.push([text, options]),
  });
  const touch = (path: string, toolName = "write") => handlers.tool_call({ toolName, input: { path } }, { cwd: root });
  return { root, sent, handlers, touch, calls: () => calls };
}

const files = {
  "src/age.ts": 'export function parseAge(s: string) { if (!s) throw new Error("age is required"); return Number(s); }',
  "test/age.test.ts": 'import { parseAge } from "../src/age.ts";\ntest("ok", () => assert.equal(parseAge("3"), 3));',
};

test("reports untested relevant cases once after a test file is written", async () => {
  const { sent, handlers, touch, root } = setup(files);

  touch("test/age.test.ts");
  await handlers.agent_settled();

  assert.equal(sent.length, 1);
  const [text, options] = sent[0];
  assert.deepEqual(options, { deliverAs: "followUp" });
  assert.match(text, /^\[test-gaps\]/);
  assert.ok(text.includes(join(root, "test/age.test.ts")));
  assert.ok(text.includes(`source: ${join(root, "src/age.ts")}`));
  assert.ok(text.includes('- the error path that throws or raises "age is required"'));
  assert.ok(text.includes("- empty input"));
  assert.ok(!text.includes("happy path"), "covered case must not be reported");
  assert.ok(!text.includes("negative numbers"), "irrelevant case must not be reported");

  touch("test/age.test.ts", "edit");
  await handlers.agent_settled();
  assert.equal(sent.length, 1, "the same gaps are never reported twice");
});

test("ignores non-test edits and stays silent when Jev fails", async () => {
  const quiet = setup(files);
  quiet.touch("src/age.ts");
  quiet.handlers.tool_call({ toolName: "read", input: { path: "test/age.test.ts" } }, { cwd: quiet.root });
  await quiet.handlers.agent_settled();
  assert.deepEqual(quiet.sent, []);
  assert.equal(quiet.calls(), 0);

  const failing = setup(files, (async () => {
    throw new Error("network down");
  }) as typeof fetch);
  failing.touch("test/age.test.ts");
  await failing.handlers.agent_settled();
  assert.deepEqual(failing.sent, []);
});
