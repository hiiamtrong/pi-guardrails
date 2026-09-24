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

  const covered = await askNoul(
    { sources, tests },
    ids(
      (c) => `A test in \`tests\` calls the code in \`sources\` for this case and asserts the result or the thrown error: ${c}`,
      relevant,
    ),
  );
  return relevant.filter((_, i) => covered[`c${i}`] <= 0.2);
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
        sourceFilesFor(testPath, tests, cwd).map((file) => [file, readFileSync(file, "utf8")]),
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
