import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { askNoul, MAX_STATE_CHARS } from "./jev.ts";

type ExtensionAPI = {
  on: (
    event: "tool_call" | "agent_settled",
    handler: (event: unknown, ctx: { cwd: string }) => unknown,
  ) => void;
  sendUserMessage: (
    text: string,
    options?: { deliverAs?: "followUp"; expandPromptTemplates?: boolean },
  ) => void;
};
type ToolCallEvent = { toolName?: unknown; input?: { path?: unknown } };

const TEST_FILE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py)|(?:^|\/)test_[^/]+\.py)$/i;
const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.js"];
const CHECKLIST = [
  "a typical valid input returns the expected result (happy path)",
  "empty input (empty string, list, map, or object)",
  "null, undefined, or None input",
  "a value exactly at a limit or threshold",
  "a value just past a limit or threshold",
  "zero or negative numbers",
  "malformed or wrongly formatted input",
  "a dependency, I/O, or async call fails (rejects, raises, or times out)",
  "duplicate or repeated items",
];

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function sourceFilesFor(testPath: string, testCode: string, cwd: string): string[] {
  const dir = dirname(testPath);
  const candidates: string[] = [];
  if (testPath.endsWith("_test.go")) candidates.push(testPath.replace(/_test\.go$/, ".go"));
  for (const [, spec] of testCode.matchAll(/(?:from\s+|import\s*\(\s*)["'`](\.{1,2}\/[^"'`?$]+)/g))
    candidates.push(...JS_EXTENSIONS.map((ext) => resolve(dir, spec + ext)));
  if (testPath.endsWith(".py"))
    for (const [, module] of testCode.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) {
      const file = module.replaceAll(".", "/");
      candidates.push(join(cwd, `${file}.py`), join(cwd, "src", `${file}.py`));
    }
  return [...new Set(candidates)].filter(
    (file) =>
      !isTestFile(file) && statSync(file, { throwIfNoEntry: false })?.isFile(),
  );
}

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|def|class|func(?:\s*\([^)]*\))?|const|let|var|type|interface|enum)\s+(\w+)|^(\w+)\s*(?::[^=]*)?=(?!=)/;

export function importsDefault(testPath: string, testCode: string, file: string): boolean {
  const specs = [
    ...testCode.matchAll(/import\s+\w+\s*(?:,\s*\{[^}]*\}\s*)?from\s+["'`](\.{1,2}\/[^"'`?$]+)/g),
    ...testCode.matchAll(/\bdefault\s*:[^}]*\}\s*=\s*await\s+import\(\s*["'`](\.{1,2}\/[^"'`?$]+)/g),
  ];
  return specs.some(([, spec]) => JS_EXTENSIONS.some((ext) => resolve(dirname(testPath), spec + ext) === file));
}

export function relevantSource(source: string, tests: string, keepDefault = false): string {
  const chunks: { name?: string; isDefault: boolean; head: string; text: string }[] = [];
  let header: string[] = [];
  for (const line of source.split("\n")) {
    const topLevel = /^\S/.test(line) && !/^[)\]}]/.test(line);
    if ((topLevel && /^(?:@|\/\/|#|\/\*)/.test(line)) || (!topLevel && header.length)) header.push(line);
    else if (topLevel || chunks.length === 0) {
      const declared = line.match(DECLARATION);
      chunks.push({
        name: declared?.[1] ?? declared?.[2],
        isDefault: /^export\s+default\b/.test(line),
        head: [...header.filter((comment) => /^@/.test(comment)), line].join("\n"),
        text: [...header, line].join("\n"),
      });
      header = [];
    } else chunks[chunks.length - 1].text += `\n${line}`;
  }

  const words = (text: string) => new Set(text.match(/\w+/g));
  const testWords = words(tests);
  const named = new Set(chunks.flatMap((chunk) => (chunk.name && testWords.has(chunk.name) ? [chunk.name] : [])));
  // Tests import a default export under any local name, and reach route handlers only through the
  // object they register on (`app.get(...)`, `@app.route`), so also keep chunks whose decorators or
  // declaration line use a named one. Bodies and doc comments that merely mention it stay out.
  const kept = new Set(
    chunks.filter((chunk) => (keepDefault && chunk.isDefault) || [...words(chunk.head)].some((word) => named.has(word))),
  );
  if (kept.size === 0) return source;
  for (let grew = true; grew; ) {
    grew = false;
    const used = words([...kept].map((chunk) => chunk.text).join("\n"));
    for (const chunk of chunks)
      if (chunk.name && !kept.has(chunk) && used.has(chunk.name)) {
        kept.add(chunk);
        grew = true;
      }
  }
  return chunks.filter((chunk) => kept.has(chunk)).map((chunk) => chunk.text).join("\n");
}

export function errorPaths(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/(?:throw new \w+|raise \w+|errors\.New|fmt\.Errorf)\(\s*["'`]([^"'`]+)/g)].map(
        ([, message]) => `the error path that throws or raises "${message}"`,
      ),
    ),
  ];
}

export async function findGaps(sources: Record<string, string>, tests: string): Promise<string[]> {
  if (JSON.stringify({ sources, tests }).length > MAX_STATE_CHARS) return [];
  const ids = (instructions: (c: string) => string, list: string[]) =>
    Object.fromEntries(list.map((c, i) => [`c${i}`, instructions(c)]));

  // Asking whether `tests` exercises a case here makes Jev score coverage
  // instead of relevance, which drops exactly the untested cases.
  const applies = await askNoul(
    { sources, tests },
    ids((c) => `This case is relevant to test for the code in \`sources\`: ${c}`, CHECKLIST),
  );
  const relevant = [
    ...errorPaths(Object.values(sources).join("\n")),
    ...CHECKLIST.filter((_, i) => applies[`c${i}`] >= 0.5),
  ];
  if (relevant.length === 0) return [];

  // Asking only about the assertion, not "calls and asserts" together, keeps
  // Jev from half-crediting tests that call the code but ignore the outcome.
  const asserted = await askNoul(
    { sources, tests },
    ids(
      (c) => `\`tests\` contains an assertion (such as assert, expect, assert.throws, pytest.raises, or t.Fatalf on a wrong value) that checks the outcome of calling the code in \`sources\` with input matching this case: ${c}`,
      relevant,
    ),
  );
  return relevant.filter((_, i) => asserted[`c${i}`] <= 0.4);
}

export default function (pi: ExtensionAPI): void {
  const touched = new Map<string, string>();
  const reported = new Set<string>();

  pi.on("tool_call", (event, ctx) => {
    const { toolName, input } = event as ToolCallEvent;
    if (toolName !== "write" && toolName !== "edit") return;
    if (typeof input?.path !== "string" || !isTestFile(input.path)) return;
    touched.set(resolve(ctx.cwd, input.path), ctx.cwd);
  });

  pi.on("agent_settled", async () => {
    const files = [...touched];
    touched.clear();
    const report: string[] = [];
    for (const [testPath, cwd] of files) {
      if (!existsSync(testPath)) continue;
      const tests = readFileSync(testPath, "utf8");
      const sources = Object.fromEntries(
        sourceFilesFor(testPath, tests, cwd).map((file) => [
          file,
          relevantSource(readFileSync(file, "utf8"), tests, importsDefault(testPath, tests, file)),
        ]),
      );
      if (Object.keys(sources).length === 0) continue;
      let gaps: string[];
      try {
        gaps = await findGaps(sources, tests);
      } catch {
        continue;
      }
      const fresh = gaps.filter((gap) => !reported.has(`${testPath}\n${gap}`));
      fresh.forEach((gap) => reported.add(`${testPath}\n${gap}`));
      if (fresh.length)
        report.push(`${testPath} (source: ${Object.keys(sources).join(", ")}):\n${fresh.map((g) => `- ${g}`).join("\n")}`);
    }
    if (report.length === 0) return;
    pi.sendUserMessage(
      `[test-gaps] Jev found cases the tests do not cover yet:\n\n${report.join("\n\n")}\n\nAdd tests for the cases that apply to this code. For any case that cannot happen here, say why in one line instead of testing it.`,
      { deliverAs: "followUp" },
    );
  });
}
