import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import commentGuard from "../extensions/comment-guard.ts";
import ponytailReview from "../extensions/ponytail-review-on-settle.ts";
import { errorPaths, findGaps, relevantSource } from "../extensions/test-gaps-on-settle.ts";

type Lines = string | string[];
type Call = { ms: number; ok: boolean; cost: number; provider?: string; answers?: Record<string, { noul: number }> };
type Handler = (event: unknown, ctx?: unknown) => any;

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const [only, dataset = "."] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const model = flag("model");
const state = flag("state") ?? "small";
const load = (name: string) => JSON.parse(readFileSync(join(here, dataset, name), "utf8"));
const text = (value: Lines) => (Array.isArray(value) ? value.join("\n") : value);
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const summary: Record<string, unknown> = { model: model ?? "default", dataset, state };

const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const start = performance.now();
  if (model) init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body as string), model }) };
  try {
    const response = await realFetch(url, init);
    const body = await response.clone().json().catch(() => ({}));
    calls.push({ ms: performance.now() - start, ok: response.ok, cost: body.usage?.cost ?? 0, provider: body.provider, answers: body.answers });
    return response;
  } catch (error) {
    calls.push({ ms: performance.now() - start, ok: false, cost: 0 });
    throw error;
  }
}) as typeof fetch;

async function tracked<T>(run: () => Promise<T>) {
  const from = calls.length;
  const result = await run();
  return { result, made: calls.slice(from) };
}

const scores = (made: Call[]) =>
  made.flatMap((call) => Object.entries(call.answers ?? {}).map(([id, a]) => `${id}=${a.noul.toFixed(2)}`)).join(" ");
const scoreIn = (detail: string, question: string) => Number(detail.match(new RegExp(`${question}=([\\d.]+)`))?.[1]);

function auc(positives: number[], negatives: number[]) {
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return positives.length && negatives.length ? wins / (positives.length * negatives.length) : NaN;
}

function stats(made: Call[]) {
  const ms = made.map((call) => call.ms).sort((a, b) => a - b);
  const at = (q: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0);
  const cost = made.reduce((sum, call) => sum + call.cost, 0);
  const providers = [...new Set(made.map((call) => call.provider).filter(Boolean))].join("+");
  return `${made.length} calls, ${made.filter((call) => !call.ok).length} errors, p50 ${at(0.5)}ms, p95 ${at(0.95)}ms, max ${at(1)}ms, cost $${cost.toFixed(5)}, provider ${providers || "-"}`;
}

async function benchCommentGuard() {
  const cases = load("comment-guard.json");
  const reviewer = join(mkdtempSync(join(tmpdir(), "jev-bench-")), "reviewer");
  writeFileSync(reviewer, "#!/bin/sh\necho DEFER\n");
  chmodSync(reviewer, 0o755);
  process.env.PI_COMMENT_REVIEWER_EXECUTABLE = reviewer;
  let handler: Handler = () => undefined;
  commentGuard({ on: (_event: string, h: Handler) => (handler = h) } as never);

  const from = calls.length;
  const rows = [];
  for (const c of cases) {
    const { result, made } = await tracked(() =>
      handler({ toolName: "write", input: { path: c.path, content: text(c.change) } }, { cwd: here }),
    );
    const got =
      made.length === 0 ? "NO_REVIEW"
      : made.some((call) => !call.ok) ? "ERROR"
      : result === undefined ? "APPROVE"
      : /\nJev:/.test(result.reason) ? "REJECT"
      : "DEFER";
    rows.push({ ...c, got, detail: scores(made) });
  }

  const decided = rows.filter((r) => r.got === "APPROVE" || r.got === "REJECT");
  const correct = decided.filter((r) => r.got === r.expected);
  const falseApprove = rows.filter((r) => r.expected === "REJECT" && r.got === "APPROVE");
  const falseReject = rows.filter((r) => r.expected === "APPROVE" && r.got === "REJECT");
  const deferred = rows.filter((r) => r.got === "DEFER");
  const values = (label: string, question: string) =>
    rows.filter((r) => r.expected === label).map((r) => scoreIn(r.detail, question)).filter((v) => !Number.isNaN(v));
  const badness = (label: string) =>
    rows.filter((r) => r.expected === label).map((r) => Math.max(scoreIn(r.detail, "restatesCode"), scoreIn(r.detail, "unverifiedSuppression")));
  const aucWhy = auc(values("APPROVE", "documentsWhy"), values("REJECT", "documentsWhy"));
  const aucBad = auc(badness("REJECT"), badness("APPROVE"));
  console.log(`\n=== comment-guard (${rows.length} cases) ===`);
  console.log(`model decided         ${decided.length}/${rows.length} (${pct(decided.length, rows.length)}), rest deferred to the Pi reviewer`);
  console.log(`accuracy when decided ${correct.length}/${decided.length} (${pct(correct.length, decided.length)})`);
  console.log(`false APPROVE         ${falseApprove.length}  (bad comment let through: the dangerous error)`);
  console.log(`false REJECT          ${falseReject.length}  (good comment blocked)`);
  console.log(`deferred              ${deferred.length}  (expected APPROVE: ${deferred.filter((r) => r.expected === "APPROVE").length}, expected REJECT: ${deferred.filter((r) => r.expected === "REJECT").length})`);
  console.log(`not reviewed / errors ${rows.filter((r) => r.got === "NO_REVIEW").length} / ${rows.filter((r) => r.got === "ERROR").length}`);
  console.log(`AUC documentsWhy ${aucWhy.toFixed(3)}, AUC max(restatesCode, unverifiedSuppression) ${aucBad.toFixed(3)}`);
  const categories = [...new Set(rows.map((r) => r.category))];
  console.log("by category (correct / deferred / wrong):");
  for (const category of categories) {
    const group = rows.filter((r) => r.category === category);
    const right = group.filter((r) => r.got === r.expected).length;
    const defer = group.filter((r) => r.got === "DEFER").length;
    console.log(`  ${category.padEnd(20)} ${right} / ${defer} / ${group.length - right - defer}   of ${group.length}`);
  }
  console.log("score range by expected label (min..max):");
  for (const question of ["documentsWhy", "restatesCode", "unverifiedSuppression"]) {
    const range = (label: string) => `${Math.min(...values(label, question)).toFixed(2)}..${Math.max(...values(label, question)).toFixed(2)}`;
    console.log(`  ${question.padEnd(22)} APPROVE ${range("APPROVE")}   REJECT ${range("REJECT")}`);
  }
  console.log("not decided correctly:");
  for (const r of rows.filter((r) => r.got !== r.expected))
    console.log(`  ${r.got.padEnd(9)} exp=${r.expected.padEnd(7)} ${r.id.padEnd(22)} ${r.detail}`);
  console.log(`latency: ${stats(calls.slice(from))}`);
  summary.commentGuard = {
    n: rows.length, decided: decided.length, correct: correct.length,
    falseApprove: falseApprove.length, falseReject: falseReject.length,
    errors: rows.filter((r) => r.got === "ERROR").length, aucWhy, aucBad,
  };
}

async function benchPonytail() {
  const cases = load("ponytail.json");
  const handlers: Record<string, Handler> = {};
  let sent = 0;
  ponytailReview({ on: (event: string, h: Handler) => (handlers[event] = h), sendUserMessage: () => sent++ } as never);

  const from = calls.length;
  const rows = [];
  for (const c of cases) {
    for (const edit of c.edits)
      handlers.tool_call(
        edit.before === undefined
          ? { toolName: "write", input: { path: edit.path, content: text(edit.after) } }
          : { toolName: "edit", input: { path: edit.path, edits: [{ oldText: text(edit.before), newText: text(edit.after) }] } },
      );
    const before = sent;
    const { made } = await tracked(() => handlers.agent_settled({}));
    const got = made.some((call) => !call.ok) ? "ERROR" : sent > before ? "review" : "skip";
    rows.push({ ...c, got, detail: scores(made) });
  }

  const correct = rows.filter((r) => r.got === r.expected);
  const falseSkip = rows.filter((r) => r.expected === "review" && r.got === "skip");
  const falseReview = rows.filter((r) => r.expected === "skip" && r.got === "review");
  const trivial = (label: string) => rows.filter((r) => r.expected === label).map((r) => scoreIn(r.detail, "trivial"));
  const aucTrivial = auc(trivial("skip"), trivial("review"));
  console.log(`\n=== ponytail-review-on-settle (${rows.length} cases) ===`);
  console.log(`accuracy       ${correct.length}/${rows.length} (${pct(correct.length, rows.length)})`);
  console.log(`false skip     ${falseSkip.length}  (non-trivial change not reviewed: the dangerous error)`);
  console.log(`false review   ${falseReview.length}  (trivial change reviewed anyway: wasted turn)`);
  console.log(`errors         ${rows.filter((r) => r.got === "ERROR").length}`);
  console.log(`skip recall    ${pct(rows.filter((r) => r.expected === "skip" && r.got === "skip").length, rows.filter((r) => r.expected === "skip").length)} of trivial changes skipped`);
  console.log(`AUC trivial    ${aucTrivial.toFixed(3)}`);
  console.log("wrong:");
  for (const r of rows.filter((r) => r.got !== r.expected))
    console.log(`  ${r.got.padEnd(6)} exp=${r.expected.padEnd(6)} ${r.id.padEnd(26)} ${r.detail}`);
  console.log(`latency: ${stats(calls.slice(from))}`);
  summary.ponytail = {
    n: rows.length, correct: correct.length, falseSkip: falseSkip.length, falseReview: falseReview.length,
    errors: rows.filter((r) => r.got === "ERROR").length, auc: aucTrivial,
  };
}

const KEYS: Record<string, RegExp> = {
  happy: /happy path/,
  empty: /^empty input/,
  null: /^null, undefined/,
  limit: /exactly at a limit/,
  past_limit: /just past a limit/,
  negative: /zero or negative/,
  malformed: /malformed/,
  dependency: /dependency, I\/O/,
  duplicates: /duplicate/,
};
const keyOf = (gap: string) =>
  gap.startsWith("the error path") ? `err:${gap.match(/"(.*)"$/)?.[1]}` : Object.keys(KEYS).find((k) => KEYS[k].test(gap)) ?? gap;
function scoreOf(key: string, made: Call[], sent: string): { applies?: number; covered?: number } {
  const checklist = Object.keys(KEYS);
  const applies = made[0]?.answers ?? {};
  const relevant = [
    ...errorPaths(sent).map(keyOf),
    ...checklist.filter((_, i) => (applies[`c${i}`]?.noul ?? 0) >= 0.5),
  ];
  const index = checklist.indexOf(key);
  if (index >= 0 && (applies[`c${index}`]?.noul ?? 0) < 0.5) return { applies: applies[`c${index}`]?.noul };
  return { covered: made[1]?.answers?.[`c${relevant.indexOf(key)}`]?.noul };
}

const listed = (list: string[] = [], key: string) =>
  list.some((entry) => entry === key || (entry.startsWith("err:") && key.startsWith("err:") && key.includes(entry.slice(4))));

// Public code only: --state=full|trimmed sends these files to third-party decision models.
const fillers: Record<string, string> = {};
function filler(file: string): string {
  const language = file.endsWith(".py") ? "py" : file.endsWith(".go") ? "go" : "ts";
  if (fillers[language]) return fillers[language];
  const read = (...paths: string[]) => paths.map((path) => readFileSync(path, "utf8")).join("\n\n");
  if (language === "py") {
    const modules = execFileSync("python3", ["-c", "import shlex, textwrap; print(shlex.__file__); print(textwrap.__file__)"], { encoding: "utf8" });
    fillers.py = read(...modules.trim().split("\n"));
  } else if (language === "go") {
    const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
    fillers.go = read(join(goroot, "src/strings/replace.go"));
  } else fillers.ts = read(join(here, "../extensions/worktree-bootstrap.ts"), join(here, "../extensions/pr-review-archive.ts"));
  return fillers[language];
}

function bury(file: string, source: string): string {
  const lines = filler(file).split("\n");
  let at = Math.floor(lines.length / 2);
  while (at < lines.length && !/^(?:export |async )*(?:function|def|class|func|const|type)\b/.test(lines[at])) at += 1;
  const target = file.endsWith(".go") ? source.replace(/^package \w+\n/, "") : source;
  return [...lines.slice(0, at), target, "", ...lines.slice(at)].join("\n");
}

async function benchTestGaps() {
  const functions = load("test-gaps.json");
  const from = calls.length;
  const totals = { fpCovered: 0, fpIrrelevant: 0, foreign: 0, exact: 0, cases: 0, errors: 0, chars: 0 };
  const missed: Record<string, number> = {};
  const noisy: Record<string, number> = {};
  const byVariant: Record<string, { exact: number; total: number }> = {};
  const records: { expectGap: boolean; expectOk: boolean; covered?: number }[] = [];
  const lines: string[] = [];

  for (const f of functions) {
    const source = text(f.source);
    const items = [
      ...Object.entries(f.relevance as Record<string, string>).map(([key, relevance]) => ({ key, relevance })),
      ...errorPaths(source).map((gap) => ({ key: keyOf(gap), relevance: "yes" })),
    ];
    for (const s of f.suites) {
      totals.cases += 1;
      const variant = (byVariant[s.variant] ??= { exact: 0, total: 0 });
      variant.total += 1;
      const tests = text(s.tests);
      const sent = state === "small" ? source : state === "full" ? bury(f.file, source) : relevantSource(bury(f.file, source), tests);
      totals.chars += sent.length;
      let reported: Set<string>;
      let made: Call[];
      try {
        const run = await tracked(() => findGaps({ [f.file]: sent }, tests));
        reported = new Set(run.result.map(keyOf));
        made = run.made;
      } catch (error) {
        totals.errors += 1;
        lines.push(`  ERROR ${f.id}/${s.variant}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      const fn: string[] = [];
      const fp: string[] = [];
      for (const { key, relevance } of items) {
        if (listed(s.either, key)) continue;
        const covered = listed(s.covers, key);
        const expectGap = relevance === "yes" && !covered;
        const expectOk = covered || relevance === "no";
        const score = scoreOf(key, made, sent);
        const type = key.startsWith("err:") ? "error path" : key;
        records.push({ expectGap, expectOk, covered: score.covered });
        if (expectGap && !reported.has(key)) {
          fn.push(`${key}(${score.applies === undefined ? `asserted ${score.covered?.toFixed(2)}` : `irrelevant ${score.applies.toFixed(2)}`})`);
          missed[type] = (missed[type] ?? 0) + 1;
        }
        if (expectOk && reported.has(key)) {
          fp.push(`${key}(${covered ? "covered" : "irrelevant"})`);
          if (covered) totals.fpCovered += 1;
          else totals.fpIrrelevant += 1;
          noisy[type] = (noisy[type] ?? 0) + 1;
        }
      }
      const known = new Set(items.map(({ key }) => key));
      for (const key of errorPaths(sent).map(keyOf))
        if (!known.has(key)) records.push({ expectGap: false, expectOk: true, covered: scoreOf(key, made, sent).covered });
      const foreign = [...reported].filter((key) => !known.has(key));
      totals.foreign += foreign.length;
      if (foreign.length) fp.push(`${foreign.length} error paths of other functions`);
      if (fn.length === 0 && fp.length === 0) {
        totals.exact += 1;
        variant.exact += 1;
      } else lines.push(`  ${`${f.id}/${s.variant}`.padEnd(24)} missed: ${fn.join(", ") || "-"} | extra: ${fp.join(", ") || "-"}`);
    }
  }

  const gaps = records.filter((r) => r.expectGap).length;
  const at = (t: number) => {
    const hit = (r: (typeof records)[number]) => r.covered !== undefined && r.covered <= t;
    const tp = records.filter((r) => r.expectGap && hit(r)).length;
    return { tp, fp: records.filter((r) => r.expectOk && hit(r)).length };
  };
  const asserted = (gap: boolean) =>
    records.filter((r) => (gap ? r.expectGap : r.expectOk) && r.covered !== undefined).map((r) => 1 - (r.covered as number));
  const aucAsserted = auc(asserted(true), asserted(false));
  const current = at(0.4);
  console.log(`\n=== test-gaps-on-settle (${totals.cases} cases, state=${state}, avg ${Math.round(totals.chars / totals.cases)} chars) ===`);
  console.log(`exact cases   ${totals.exact}/${totals.cases} (${pct(totals.exact, totals.cases)})`);
  console.log(`false gaps    ${totals.fpCovered + totals.fpIrrelevant + totals.foreign}  (already covered: ${totals.fpCovered}, not relevant: ${totals.fpIrrelevant}, other functions' error paths: ${totals.foreign})`);
  console.log(`errors        ${totals.errors}`);
  console.log(`AUC asserted  ${aucAsserted.toFixed(3)} (relevant cases only)`);
  console.log(`missed by case type: ${JSON.stringify(missed)}`);
  console.log(`extra by case type:  ${JSON.stringify(noisy)}`);
  console.log(`exact by suite variant: ${Object.entries(byVariant).map(([v, x]) => `${v} ${x.exact}/${x.total}`).join(", ")}`);
  console.log("recall/precision when a gap is reported at assertion score <= t (current t = 0.4):");
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    const { tp, fp } = at(t);
    console.log(`  t=${t.toFixed(1)}  recall ${pct(tp, gaps)} (${tp}/${gaps})  precision ${pct(tp, tp + fp)} (false gaps ${fp})`);
  }
  console.log("inexact:");
  for (const line of lines) console.log(line);
  console.log(`latency: ${stats(calls.slice(from))}`);
  summary.testGaps = {
    n: totals.cases, exact: totals.exact, recall: current.tp / gaps,
    precision: current.tp / (current.tp + current.fp),
    foreign: totals.foreign, errors: totals.errors, auc: aucAsserted,
  };
}

const benches: Record<string, () => Promise<void>> = {
  "comment-guard": benchCommentGuard,
  ponytail: benchPonytail,
  "test-gaps": benchTestGaps,
};
for (const [name, run] of Object.entries(benches)) if (!only || only === name) await run();
console.log(`\ntotal: ${stats(calls)}`);
summary.cost = calls.reduce((sum, call) => sum + call.cost, 0);
summary.p50 = calls.map((call) => call.ms).sort((a, b) => a - b)[calls.length >> 1];
console.log(`SUMMARY ${JSON.stringify(summary)}`);
