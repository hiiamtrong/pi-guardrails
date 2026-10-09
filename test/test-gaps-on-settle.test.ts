import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { isTestFile, sourceFilesFor, errorPaths, findGaps, relevantSource, importsDefault, default: testGaps } = await import(
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
  assert.deepEqual(sourceFilesFor(join(root, "test/empty.test.ts"), "", root), []);
  assert.deepEqual(sourceFilesFor(join(root, "tests/test_empty.py"), "", root), []);
});

test("keeps only the code a test names plus what that code uses", () => {
  const ts = [
    'import { readFileSync } from "node:fs";',
    "",
    "const LIMIT = 150;",
    "/** Unrelated helper. */",
    "export function slugify(s: string) {",
    '  if (!s) throw new Error("empty title");',
    "  return s.toLowerCase();",
    "}",
    "",
    "/**",
    " * Parses an age.",
    " */",
    "export function parseAge(input: string): number {",
    "  const age = Number(input);",
    '  if (age > LIMIT) throw new Error("age is unrealistic");',
    "  return age;",
    "}",
  ].join("\n");
  const kept = relevantSource(ts, 'import { parseAge } from "../src/age.ts";\nassert.equal(parseAge("3"), 3);');
  assert.equal(
    kept,
    ["const LIMIT = 150;", "/**", " * Parses an age.", " */", ...ts.split("\n").slice(12)].join("\n"),
  );
  assert.deepEqual(errorPaths(kept), ['the error path that throws or raises "age is unrealistic"']);

  const py = ["import re", "", 'EMAIL = re.compile(r"@")', "", "", "def other():", "    return 1", "", "", "@cache", "def check(s):", "    return EMAIL.match(s)"].join("\n");
  assert.equal(relevantSource(py, "from mod import check\nassert check('a@b')"), ['EMAIL = re.compile(r"@")', "", "", "@cache", "def check(s):", "    return EMAIL.match(s)"].join("\n"));

  const go = ["package calc", "", "func helper() int { return 2 }", "", "func (c *Calc) Divide(a, b int) int {", "\treturn a / b", "}"].join("\n");
  assert.equal(relevantSource(go, "c.Divide(4, 2)"), ["func (c *Calc) Divide(a, b int) int {", "\treturn a / b", "}"].join("\n"));
});

test("keeps a default export imported under another name and abstract base classes", () => {
  const age = [
    "export const MAX_AGE = 150;",
    "export const UNUSED = 1;",
    "",
    "export default function parseAge(s: string) {",
    '  if (Number(s) > MAX_AGE) throw new Error("too old");',
    "  return Number(s);",
    "}",
  ].join("\n");
  const tests = 'import parse, { MAX_AGE } from "../src/age.ts";\nassert.throws(() => parse(String(MAX_AGE + 1)));';
  const kept = relevantSource(age, tests, true);
  assert.equal(kept, ["export const MAX_AGE = 150;", ...age.split("\n").slice(3)].join("\n"));

  const exporters = [
    "export abstract class Exporter {",
    '  run(): string { throw new Error("not implemented"); }',
    "}",
    "",
    "export class CsvExporter extends Exporter {}",
  ].join("\n");
  const base = relevantSource(exporters, 'import { CsvExporter } from "../src/export.ts";\nnew CsvExporter().run();');
  assert.equal(base, exporters);
  assert.deepEqual(errorPaths(base), ['the error path that throws or raises "not implemented"']);
});

test("drops a default export the test does not import", () => {
  const source = [
    "export function parseAge(s: string) {",
    "  return Number(s);",
    "}",
    "",
    "export default function (pi: unknown) {",
    '  throw new Error("handler failure");',
    "}",
  ].join("\n");
  const tests = 'import { parseAge } from "../src/age.ts";';
  assert.equal(relevantSource(source, tests), source.split("\n").slice(0, 4).join("\n"));
  assert.equal(relevantSource(source, tests, true), source);
});

test("detects which source file a test imports by default", () => {
  const testPath = "/repo/test/age.test.ts";
  const age = "/repo/src/age.ts";
  assert.equal(importsDefault(testPath, 'import parse from "../src/age.ts";', age), true);
  assert.equal(importsDefault(testPath, 'import parse, { MAX_AGE } from "../src/age";', age), true);
  assert.equal(
    importsDefault(testPath, "const { parseAge, default: plugin } = await import(`../src/age.ts?test=${Date.now()}`);", age),
    true,
  );
  assert.equal(importsDefault(testPath, 'import { parseAge } from "../src/age.ts";', age), false);
  assert.equal(importsDefault(testPath, 'import assert from "node:assert/strict";', age), false);
  assert.equal(importsDefault(testPath, 'import other from "../src/other.ts";', age), false);
  assert.equal(importsDefault(testPath, "", age), false);
});

test("keeps route handlers registered on an app the test uses", () => {
  const express = [
    'import express from "express";',
    "",
    "export const app = express();",
    "",
    'app.get("/users/:id", (req, res) => {',
    '  if (!/^\\d+$/.test(req.params.id)) throw new Error("invalid id");',
    "  res.json({});",
    "});",
    "",
    "function unrelated() {",
    '  throw new Error("unrelated failure");',
    "}",
  ].join("\n");
  const keptExpress = relevantSource(
    express,
    'import request from "supertest";\nimport { app } from "../src/app.ts";\nawait request(app).get("/users/1").expect(200);',
  );
  assert.deepEqual(errorPaths(keptExpress), ['the error path that throws or raises "invalid id"']);

  const flask = [
    "from flask import Flask",
    "",
    "app = Flask(__name__)",
    "",
    "",
    '@app.route("/users/<id>")',
    "def get_user(id):",
    "    if not id.isdigit():",
    '        raise ValueError("invalid id")',
    "    return {}",
  ].join("\n");
  const keptFlask = relevantSource(flask, "from app import app\n\ndef test_ok():\n    assert app.test_client().get('/users/1').status_code == 200");
  assert.deepEqual(errorPaths(keptFlask), ['the error path that throws or raises "invalid id"']);
});

test("keeps a commented route but not other functions sharing a constant the test names", () => {
  const limits = [
    "export const MAX = 150;",
    "",
    "export function parseAge(s: string) {",
    '  if (Number(s) > MAX) throw new Error("age is unrealistic");',
    "  return Number(s);",
    "}",
    "",
    "export function parseHeight(s: string) {",
    '  if (Number(s) > MAX) throw new Error("height is unrealistic");',
    "  return Number(s);",
    "}",
  ].join("\n");
  const kept = relevantSource(limits, 'import { parseAge, MAX } from "../src/limits.ts";\nassert.throws(() => parseAge(String(MAX + 1)));');
  assert.deepEqual(errorPaths(kept), ['the error path that throws or raises "age is unrealistic"']);

  const documented = limits.replace("export function parseHeight", "/** Same rules as parseAge, but for heights. */\nexport function parseHeight");
  const keptDocumented = relevantSource(documented, 'import { parseAge } from "../src/limits.ts";\nparseAge("3");');
  assert.deepEqual(errorPaths(keptDocumented), ['the error path that throws or raises "age is unrealistic"']);

  const routes = [
    "export const app = express();",
    "",
    "// Look up a user by numeric id.",
    'app.get("/users/:id", (req) => {',
    '  if (!req.params.id) throw new Error("invalid id");',
    "});",
  ].join("\n");
  const keptRoute = relevantSource(routes, 'import { app } from "../src/app.ts";\nawait request(app).get("/users/1");');
  assert.deepEqual(errorPaths(keptRoute), ['the error path that throws or raises "invalid id"']);
});

test("isolates the named function in a half-edited CRLF file", () => {
  const source = [
    "export function broken(s: string) {",
    "  if (s) {",
    "    return 1;",
    "",
    "export function parseAge(input: string) {",
    '  if (!input) throw new Error("age is required");',
    "  return Number(input);",
    "}",
  ].join("\r\n");
  const kept = relevantSource(source, 'import { parseAge } from "../src/age.ts";');
  assert.equal(kept, source.split("\r\n").slice(4).join("\r\n"));
  assert.deepEqual(errorPaths(kept), ['the error path that throws or raises "age is required"']);
});

test("falls back to the whole source when the tests name nothing in it", () => {
  const source = "export default function () {\n  return 1;\n}";
  assert.equal(relevantSource(source, "import run from '../src/run.ts';\nrun();"), source);
  assert.equal(relevantSource("", "anything"), "");
  assert.equal(relevantSource(source, ""), source);
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
  assert.deepEqual(errorPaths(""), []);
});

function mockJev(answer: (instructions: string) => number) {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
  const asked: string[][] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(init.body as string);
    const entries = Object.entries(questions as Record<string, { instructions: string }>);
    asked.push(entries.map(([, { instructions }]) => instructions));
    return new Response(
      JSON.stringify({
        answers: Object.fromEntries(entries.map(([id, { instructions }]) => [id, { type: "noul", noul: answer(instructions) }])),
      }),
    );
  }) as typeof fetch;
  return asked;
}

test("reports a case when its assertion score is at most 0.4", async () => {
  const asked = mockJev((instructions) =>
    instructions.startsWith("This case is relevant")
      ? /empty input|malformed/.test(instructions) ? 0.9 : 0.1
      : /empty input/.test(instructions) ? 0.4 : /malformed/.test(instructions) ? 0.41 : 0.95,
  );

  const gaps = await findGaps({ "a.ts": "export const f = (s: string) => s;" }, "test");

  assert.deepEqual(gaps, ["empty input (empty string, list, map, or object)"]);
  assert.ok(asked[1].every((q) => q.includes("contains an assertion")), "coverage asks about assertions");
});

test("skips the coverage request when no case is relevant", async () => {
  const asked = mockJev(() => 0.1);
  assert.deepEqual(await findGaps({ "a.ts": "export const f = () => 1;" }, "test"), []);
  assert.equal(asked.length, 1);
});

function setup(files: Record<string, string>, fetchImpl?: typeof fetch) {
  const asked = mockJev((i) =>
    /happy path/.test(i) ? 0.95 : i.startsWith("This case is relevant") ? (/empty input/.test(i) ? 0.9 : 0.1) : 0.05,
  );
  if (fetchImpl) globalThis.fetch = fetchImpl;
  process.env.HOME = mkdtempSync(join(tmpdir(), "test-gaps-home-"));
  const root = project(files);
  const load = () => {
    const sent: [string, unknown][] = [];
    const handlers: Record<string, (event?: unknown, ctx?: unknown) => unknown> = {};
    testGaps({
      on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
        handlers[event] = handler;
      },
      sendUserMessage: (text: string, options: unknown) => sent.push([text, options]),
    });
    const touch = (path: string, toolName = "write") => handlers.tool_call({ toolName, input: { path } }, { cwd: root });
    return { sent, handlers, touch };
  };
  const reportedFile = join(process.env.HOME, ".pi/agent/test-gaps-reported.json");
  return { root, ...load(), reload: load, reportedFile, calls: () => asked.length };
}

const files = {
  "src/age.ts": 'export function parseAge(s: string) { if (!s) throw new Error("age is required"); return Number(s); }',
  "test/age.test.ts": 'import { parseAge } from "../src/age.ts";\ntest("ok", () => assert.equal(parseAge("3"), 3));',
};

test("ignores error paths of functions the test does not use", async () => {
  const { sent, handlers, touch } = setup({
    ...files,
    "src/age.ts": `export function unrelated() {\n  throw new Error("unrelated failure");\n}\n\n${files["src/age.ts"]}`,
  });

  touch("test/age.test.ts");
  await handlers.agent_settled();

  assert.ok(sent[0][0].includes('"age is required"'));
  assert.ok(!sent[0][0].includes("unrelated failure"));
});

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

test("remembers reported gaps across a reload", async () => {
  const first = setup(files);
  first.touch("test/age.test.ts");
  await first.handlers.agent_settled();
  assert.equal(first.sent.length, 1);

  const reloaded = first.reload();
  reloaded.touch("test/age.test.ts");
  await reloaded.handlers.agent_settled();
  assert.deepEqual(reloaded.sent, []);
});

test("reports again after 30 days and survives a corrupt state file", async () => {
  const state = setup(files);
  mkdirSync(join(state.reportedFile, ".."), { recursive: true });
  writeFileSync(state.reportedFile, "{not json");
  state.touch("test/age.test.ts");
  await state.handlers.agent_settled();
  assert.equal(state.sent.length, 1);

  const stamps = JSON.parse(readFileSync(state.reportedFile, "utf8"));
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  writeFileSync(state.reportedFile, JSON.stringify(Object.fromEntries(Object.keys(stamps).map((key) => [key, old]))));
  const reloaded = state.reload();
  reloaded.touch("test/age.test.ts");
  await reloaded.handlers.agent_settled();
  assert.equal(reloaded.sent.length, 1, "gaps reported over 30 days ago are reported again");
  assert.ok(Object.values(JSON.parse(readFileSync(state.reportedFile, "utf8"))).every((at) => (at as number) > old));
});

test("ignores non-test edits and stays silent when Jev fails", async () => {
  const quiet = setup(files);
  quiet.touch("src/age.ts");
  quiet.handlers.tool_call({ toolName: "read", input: { path: "test/age.test.ts" } }, { cwd: quiet.root });
  for (const input of [undefined, {}, { path: null }, { path: 42 }])
    quiet.handlers.tool_call({ toolName: "write", input }, { cwd: quiet.root });
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
