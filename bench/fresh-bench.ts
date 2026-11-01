import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import commentGuard from "../extensions/comment-guard.ts";
import ponytailReview from "../extensions/ponytail-review-on-settle.ts";
import { findGaps } from "../extensions/test-gaps-on-settle.ts";

type Handler = (event: unknown, ctx?: unknown) => any;
const [only] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const lines = (...parts: string[]) => parts.join("\n");
const temps: string[] = [];

let jevCalls = 0;
let jevErrors = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  jevCalls++;
  try {
    const response = await realFetch(url, init);
    if (!response.ok) jevErrors++;
    return response;
  } catch (error) {
    jevErrors++;
    throw error;
  }
}) as typeof fetch;

type CommentCase = { id: string; expect: "APPROVE" | "REJECT" | "NO_REVIEW"; tier: "clear" | "edge"; path: string; content?: string; edit?: [string, string] };
const comment: CommentCase[] = [];
const c = (id: string, expect: CommentCase["expect"], tier: CommentCase["tier"], path: string, content: string) => comment.push({ id, expect, tier, path, content });
const e = (id: string, expect: CommentCase["expect"], tier: CommentCase["tier"], path: string, before: string, after: string) => comment.push({ id, expect, tier, path, edit: [before, after] });

c("why-safari-redirect", "APPROVE", "clear", "src/http.ts", lines("// Safari < 16.4 drops Authorization on cross-origin redirects, so re-attach it by hand", "if (redirected) headers.set('Authorization', token);"));
c("why-sqlite-alter", "APPROVE", "clear", "db/migrate.py", lines("# sqlite cannot ALTER COLUMN, so rebuild the table instead of altering it in place", "rebuild_table(conn, 'orders', new_schema)"));
c("why-middleware-order", "APPROVE", "clear", "src/app.ts", lines("// Auth must run before body parsing, otherwise oversized unauthenticated bodies get buffered (DoS)", "app.use(auth);", "app.use(express.json());"));
c("why-monotonic", "APPROVE", "clear", "worker/timeouts.py", lines("# time.time() jumps on NTP sync, monotonic() keeps the timeout from firing early", "deadline = time.monotonic() + limit"));
c("why-sed-portable", "APPROVE", "clear", "scripts/patch.sh", lines("# macOS sed needs an explicit '' after -i and GNU sed rejects it, so branch on uname", `if [ "$(uname)" = Darwin ]; then sed -i '' "$expr" "$f"; else sed -i "$expr" "$f"; fi`));
c("why-unsafe-safety", "APPROVE", "clear", "src/pool.rs", lines("// SAFETY: ptr came from Box::into_raw above and is reclaimed exactly once here", "drop(unsafe { Box::from_raw(ptr) });"));
c("why-left-join", "APPROVE", "clear", "reports/accounts.sql", lines("-- LEFT JOIN on purpose: accounts without invoices must still show up in the report", "SELECT a.id, SUM(i.total) FROM accounts a LEFT JOIN invoices i ON i.account_id = a.id GROUP BY a.id;"));
c("why-sorted", "APPROVE", "clear", "lib/ranges.py", lines("# Must stay sorted ascending: bisect below assumes it", "BOUNDS = [10, 50, 100, 500]"));
c("why-strictmode", "APPROVE", "clear", "src/useFeed.ts", lines("// onClose fires twice in React 18 StrictMode (dev only), so guard against double unsubscribe", "if (closed) return;", "closed = true;"));
c("why-s3-part", "APPROVE", "clear", "src/upload.ts", lines("// S3 rejects multipart parts under 5 MiB except the last, so batch five 1 MiB chunks per part", "const PART_SIZE = 5 << 20;"));
c("why-suppression-verified", "APPROVE", "clear", "src/client.py", lines("session.mount('https://', adapter)  # type: ignore[attr-defined]  # mypy: \"Session\" has no attribute \"mount\"; types-requests 2.31 omits it, fixed in 2.32"));
c("why-nolint-rule", "APPROVE", "clear", "internal/backoff/jitter.go", lines("// nolint:gosec // G404: jitter for retry backoff is not a secret, math/rand is intended", "delay += time.Duration(rand.Int63n(int64(base)))"));
c("why-idempotent", "APPROVE", "clear", "src/handlers/payment.ts", lines("// The gateway redelivers a webhook for up to 72h after a 5xx, so key the dedupe on event.id and not on arrival time", "if (await seen(event.id)) return res.sendStatus(200);"));
c("why-cents", "APPROVE", "clear", "src/money.ts", lines("// Keep money as integer cents: summing floats drifts by a cent on large carts", "const totalCents = items.reduce((s, i) => s + i.cents * i.qty, 0);"));
c("why-retry-order", "APPROVE", "edge", "src/limiter.go", lines("// The limiter counts attempts, not requests, so take the token before the retry loop and not inside it", "limiter.Wait(ctx)", "for attempt := 0; attempt < 3; attempt++ {"));

c("restate-increment", "REJECT", "clear", "src/count.py", lines("# increment the counter", "counter += 1"));
c("restate-loop", "REJECT", "clear", "src/users.ts", lines("// loop over users", "for (const user of users) {", "  notify(user);", "}"));
c("restate-return", "REJECT", "clear", "src/calc.py", lines("def total(items):", "    result = sum(i.price for i in items)", "    # return the result", "    return result"));
c("restate-admin", "REJECT", "clear", "src/auth.ts", lines("// check if user is admin", "if (user.isAdmin) {", "  grant();", "}"));
c("restate-vec", "REJECT", "clear", "src/main.rs", lines("// create a vector", "let mut v = Vec::new();"));
c("restate-loading", "REJECT", "clear", "src/Panel.tsx", lines("// set loading to true", "setLoading(true);"));
c("restate-doc", "REJECT", "clear", "src/user.ts", lines("/**", " * Gets the user.", " * @param id the id", " * @returns the user", " */", "function getUser(id: string) { return db.users.get(id); }"));
c("restate-getter", "REJECT", "clear", "src/Person.java", lines("// getter", "public String getName() { return name; }"));
c("narrate-steps", "REJECT", "clear", "src/sync.ts", lines("// Step 1: fetch the user", "const user = await fetchUser(id);", "// Step 2: validate the user", "validate(user);"));
c("history-ticket", "REJECT", "clear", "src/fees.py", lines("# Updated for ticket ABC-123 by dev, changed rate from 2% to 3%", "RATE = 0.03"));
c("supp-ts-ignore-bare", "REJECT", "clear", "src/legacy.ts", lines("// @ts-ignore", "const value = thing.missingProp;"));
c("supp-type-ignore-bare", "REJECT", "clear", "src/legacy.py", lines("result = compute(data)  # type: ignore"));
c("supp-eslint-bare", "REJECT", "clear", "src/legacy.js", lines("// eslint-disable-next-line", "var unused = require('x');"));
c("supp-noqa-bare", "REJECT", "clear", "src/legacy2.py", lines("import os  # noqa"));
c("future-annotations", "REJECT", "clear", "src/models.py", lines("from __future__ import annotations", "", "class A:", "    pass"));
c("hack-no-reason", "REJECT", "clear", "src/boot.ts", lines("// This is a hack", "process.env.X = '1';"));
c("section-divider", "REJECT", "edge", "src/utils.py", lines("# ---------- helpers ----------", "def helper(): ..."));
c("commented-out-code", "REJECT", "edge", "src/cart.py", lines("# old_total = sum(x.price for x in items)", "total = sum(x.price * x.qty for x in items)"));
c("go-doc-restates", "REJECT", "edge", "internal/server.go", lines("// NewServer creates a new Server.", "func NewServer() *Server { return &Server{} }"));
c("todo-bare", "REJECT", "edge", "src/jobs.py", lines("# TODO: handle errors", "run(job)"));
c("unverified-perf", "REJECT", "edge", "src/cache.ts", lines("// We use a Map here because it is faster", "const cache = new Map<string, Row>();"));

c("code-only", "NO_REVIEW", "clear", "src/a.ts", lines("export const add = (a: number, b: number) => a + b;"));
c("string-has-slashes", "NO_REVIEW", "clear", "src/b.ts", lines("const base = 'https://example.com//v1';", "export const url = `${base}/users`;"));
c("string-has-hash", "NO_REVIEW", "clear", "src/c.py", lines("color = '#ff00aa'", "tag = f'#{name}'"));
c("regex-literal", "NO_REVIEW", "clear", "src/d.ts", lines("export const collapse = (s: string) => s.replace(/\\/\\/+/g, '/');"));
c("use-strict", "NO_REVIEW", "clear", "src/e.js", lines("'use strict';", "module.exports = {};"));
c("shebang", "NO_REVIEW", "clear", "bin/tool.js", lines("#!/usr/bin/env node", "require('../lib/cli').run();"));
c("python-fstring-hash", "NO_REVIEW", "clear", "src/f.py", lines("print(f'item #{n}: {name}')"));
c("sql-no-comment", "NO_REVIEW", "clear", "db/q.sql", lines("SELECT id FROM users WHERE active = 1;"));
c("markdown-slashes", "NO_REVIEW", "clear", "docs/readme.md", lines("See // and # in the text, nothing here is code."));
e("edit-existing-comment-untouched", "NO_REVIEW", "clear", "src/g.ts",
  lines("// Safari drops Authorization on cross-origin redirects", "if (redirected) headers.set('Authorization', token);"),
  lines("// Safari drops Authorization on cross-origin redirects", "if (redirected && token) headers.set('Authorization', token);"));
e("edit-rewrites-existing-comment", "REJECT", "clear", "src/h.ts",
  lines("// Safari drops Authorization on cross-origin redirects", "if (redirected) headers.set('Authorization', token);"),
  lines("// set the header", "if (redirected) headers.set('Authorization', token);"));
e("edit-adds-new-why-comment", "APPROVE", "clear", "src/i.py",
  lines("retries = 3"),
  lines("# The vendor throttles at 3 calls/second per key, so more retries only lengthen the ban", "retries = 3"));

async function benchComments() {
  const temp = mkdtempSync(join(tmpdir(), "fresh-bench-"));
  temps.push(temp);
  const reviewer = join(temp, "reviewer");
  writeFileSync(reviewer, "#!/bin/sh\necho DEFER\n");
  chmodSync(reviewer, 0o755);
  process.env.PI_COMMENT_REVIEWER_EXECUTABLE = reviewer;
  let handler: Handler = () => undefined;
  commentGuard({ on: (_: string, h: Handler) => (handler = h) } as never);
  const cwd = mkdtempSync(join(tmpdir(), "fresh-cwd-"));
  temps.push(cwd);
  const rows = [];
  for (const k of comment) {
    const before = jevCalls;
    const errorsBefore = jevErrors;
    const input = k.edit ? { path: k.path, edits: [{ oldText: k.edit[0], newText: k.edit[1] }] } : { path: k.path, content: k.content };
    const started = performance.now();
    const result = await handler({ toolName: k.edit ? "edit" : "write", input }, { cwd, hasUI: false });
    const ms = performance.now() - started;
    const asked = jevCalls > before;
    const got = !asked ? "NO_REVIEW" : jevErrors > errorsBefore ? "ERROR" : result === undefined ? "APPROVE" : /Jev:/.test(result.reason) ? "REJECT" : "DEFER";
    rows.push({ ...k, got, ms });
  }
  const clear = rows.filter((r) => r.tier === "clear");
  const decided = clear.filter((r) => r.got === "APPROVE" || r.got === "REJECT");
  const wrong = (label: string, got: string) => clear.filter((r) => r.expect === label && r.got === got);
  console.log(`\n=== comment-guard, fresh cases (${rows.length}: ${clear.length} clear, ${rows.length - clear.length} edge), real Jev, Pi reviewer stubbed to DEFER ===`);
  console.log(`bad comment let through (false APPROVE)   ${wrong("REJECT", "APPROVE").length} of ${clear.filter((r) => r.expect === "REJECT").length} bad comments`);
  console.log(`good comment blocked (false REJECT)       ${wrong("APPROVE", "REJECT").length} of ${clear.filter((r) => r.expect === "APPROVE").length} good comments`);
  console.log(`deferred to the Pi reviewer               ${clear.filter((r) => r.got === "DEFER").length} of ${clear.length} (approve-labelled ${wrong("APPROVE", "DEFER").length}, reject-labelled ${wrong("REJECT", "DEFER").length})`);
  console.log(`reviewed although no comment was added    ${clear.filter((r) => r.expect === "NO_REVIEW" && r.got !== "NO_REVIEW").length} of ${clear.filter((r) => r.expect === "NO_REVIEW").length}`);
  console.log(`comment added but never reviewed          ${clear.filter((r) => r.expect !== "NO_REVIEW" && r.got === "NO_REVIEW").length}`);
  console.log(`Jev errors                                ${clear.filter((r) => r.got === "ERROR").length}`);
  console.log(`accuracy when Jev decided                 ${clear.filter((r) => r.got === r.expect && (r.got === "APPROVE" || r.got === "REJECT")).length}/${decided.length}`);
  const ms = rows.filter((r) => r.got !== "NO_REVIEW").map((r) => r.ms).sort((a, b) => a - b);
  console.log(`latency of a reviewed change: p50 ${ms[Math.floor(ms.length * 0.5)]?.toFixed(0)}ms, p95 ${ms[Math.floor(ms.length * 0.95)]?.toFixed(0)}ms`);
  console.log("wrong or undecided (clear tier):");
  for (const r of clear.filter((r) => r.got !== r.expect)) console.log(`  ${r.got.padEnd(9)} expected ${r.expect.padEnd(9)} ${r.id}`);
  console.log("edge tier (not scored):");
  for (const r of rows.filter((r) => r.tier === "edge")) console.log(`  ${r.got.padEnd(9)} expected ${r.expect.padEnd(9)} ${r.id}`);
}

type PonyCase = { id: string; expect: "skip" | "review"; tier: "clear" | "edge"; edits: { path: string; before?: string; after: string }[] };
const pony: PonyCase[] = [];
const p = (id: string, expect: PonyCase["expect"], tier: PonyCase["tier"], path: string, before: string, after: string) => pony.push({ id, expect, tier, edits: [{ path, before, after }] });

p("rename-local", "skip", "clear", "src/cart.ts", "let cnt = items.length;\nreturn cnt * price;", "let count = items.length;\nreturn count * price;");
p("typo-message", "skip", "clear", "src/validate.py", "raise ValueError('Invalid emial')", "raise ValueError('Invalid email')");
p("timeout-literal", "skip", "clear", "src/client.ts", "const TIMEOUT_MS = 30_000;", "const TIMEOUT_MS = 60_000;");
p("whitespace-only", "skip", "clear", "src/fmt.go", "func  add(a,b int) int {return a+b}", "func add(a, b int) int {\n\treturn a + b\n}");
p("log-text", "skip", "clear", "src/job.py", "logger.info('job started')", "logger.info('job started for %s', name)");
p("page-size-default", "skip", "clear", "src/list.ts", "const PAGE_SIZE = 20;", "const PAGE_SIZE = 50;");
p("route-string", "skip", "clear", "src/routes.ts", "router.get('/users', listUsers);", "router.get('/members', listUsers);");
p("import-order", "skip", "clear", "src/imp.py", "import sys\nimport os\nimport json", "import json\nimport os\nimport sys");
p("comment-only", "skip", "clear", "src/note.ts", "// old explanation\nconst a = 1;", "// clearer explanation\nconst a = 1;");
p("enum-value", "skip", "clear", "src/status.ts", "PENDING = 'pending',", "PENDING = 'waiting',");
p("css-class", "skip", "clear", "src/Btn.tsx", "<button className=\"btn-primary\">", "<button className=\"btn-main\">");
p("rename-function", "skip", "clear", "src/util.py", "def calc_tot(items):\n    return sum(items)", "def calculate_total(items):\n    return sum(items)");
p("version-string", "skip", "clear", "src/version.ts", "export const VERSION = '1.2.0';", "export const VERSION = '1.3.0';");
p("color-hex", "skip", "clear", "src/theme.ts", "const accent = '#1a73e8';", "const accent = '#0b57d0';");
p("retry-count", "skip", "clear", "src/retry.ts", "const MAX_RETRIES = 3;", "const MAX_RETRIES = 5;");
p("key-reorder", "skip", "clear", "src/cfg.ts", "const cfg = { b: 2, a: 1 };", "const cfg = { a: 1, b: 2 };");
p("tls-verify-off", "review", "clear", "src/http.py", "requests.get(url, verify=True)", "requests.get(url, verify=False)");
p("allow-all-on", "review", "clear", "src/cors.ts", "const ALLOW_ALL_ORIGINS = false;", "const ALLOW_ALL_ORIGINS = true;");
p("token-expiry", "review", "clear", "src/session.ts", "const TOKEN_TTL_SECONDS = 900;", "const TOKEN_TTL_SECONDS = 31536000;");
p("boundary-flip", "review", "clear", "src/range.ts", "if (age < 18) deny();", "if (age <= 18) deny();");
p("early-return", "review", "clear", "src/handler.py", "def handle(req):\n    return process(req)", "def handle(req):\n    if req is None:\n        return None\n    return process(req)");
p("new-function", "review", "clear", "src/math.ts", "export const a = 1;", "export const a = 1;\nexport function clamp(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }");
p("add-try-catch", "review", "clear", "src/io.ts", "const data = JSON.parse(raw);", "let data;\ntry { data = JSON.parse(raw); } catch { data = {}; }");
p("and-to-or", "review", "clear", "src/perm.py", "if user.active and user.verified:", "if user.active or user.verified:");
p("add-await", "review", "clear", "src/save.ts", "db.save(order);\nreturn ok();", "await db.save(order);\nreturn ok();");
p("drop-validation", "review", "clear", "src/api.py", "if not token:\n    raise Unauthorized()\nreturn serve()", "return serve()");
p("sql-concat", "review", "clear", "src/q.py", "cur.execute('SELECT * FROM t WHERE id = %s', (uid,))", "cur.execute('SELECT * FROM t WHERE id = ' + uid)");
p("loop-bound", "review", "clear", "src/scan.go", "for i := 0; i < len(xs); i++ {", "for i := 0; i <= len(xs); i++ {");
p("swap-args", "review", "clear", "src/xfer.ts", "transfer(from, to, amount);", "transfer(to, from, amount);");
p("add-retry", "review", "clear", "src/fetch.ts", "return await get(url);", "for (let i = 0; i < 3; i++) { try { return await get(url); } catch {} }\nthrow new Error('failed');");
p("new-condition", "review", "clear", "src/ship.ts", "if (order.paid) ship(order);", "if (order.paid && !order.hold) ship(order);");
p("remove-auth-check", "review", "clear", "src/admin.ts", "if (!req.user?.isAdmin) return res.sendStatus(403);\nrunAdmin();", "runAdmin();");
p("null-guard-removed", "review", "clear", "src/name.ts", "return user?.name ?? 'anon';", "return user.name;");
p("default-flag", "review", "clear", "src/cfg.py", "def run(dry_run=True):", "def run(dry_run=False):");
p("bcrypt-rounds", "review", "clear", "src/hash.ts", "const ROUNDS = 12;", "const ROUNDS = 4;");
p("strict-equality", "review", "edge", "src/eq.js", "if (a == b) return true;", "if (a === b) return true;");
pony.push({ id: "five-trivial-plus-one-logic", expect: "review", tier: "clear", edits: [
  { path: "src/m.ts", before: "const a = 1;", after: "const first = 1;" }, { path: "src/m.ts", before: "const b = 2;", after: "const second = 2;" },
  { path: "src/m.ts", before: "// x", after: "// explanation" }, { path: "src/m.ts", before: "'a'", after: "'b'" },
  { path: "src/m.ts", before: "limit = 5", after: "limit = 10" }, { path: "src/m.ts", before: "if (ok) go();", after: "if (ok || force) go();" } ] });
pony.push({ id: "new-file-with-logic", expect: "review", tier: "clear", edits: [{ path: "src/new.ts", after: "export function pay(a: number) { if (a < 0) throw new Error('neg'); return a * 1.2; }" }] });

async function benchPonytail() {
  const handlers: Record<string, Handler> = {};
  let sent = 0;
  ponytailReview({ on: (name: string, h: Handler) => (handlers[name] = h), sendUserMessage: () => sent++ } as never);
  const rows = [];
  for (const k of pony) {
    for (const edit of k.edits)
      handlers.tool_call(edit.before === undefined
        ? { toolName: "write", input: { path: edit.path, content: edit.after } }
        : { toolName: "edit", input: { path: edit.path, edits: [{ oldText: edit.before, newText: edit.after }] } });
    const before = sent;
    const started = performance.now();
    await handlers.agent_settled({}, {});
    rows.push({ ...k, got: sent > before ? "review" : "skip", ms: performance.now() - started });
  }
  const clear = rows.filter((r) => r.tier === "clear");
  const missed = clear.filter((r) => r.expect === "review" && r.got === "skip");
  const noisy = clear.filter((r) => r.expect === "skip" && r.got === "review");
  console.log(`\n=== ponytail-review-on-settle, fresh cases (${rows.length}: ${clear.length} clear), real Jev ===`);
  console.log(`logic change not reviewed (miss)     ${missed.length} of ${clear.filter((r) => r.expect === "review").length}`);
  console.log(`trivial change reviewed (noise)      ${noisy.length} of ${clear.filter((r) => r.expect === "skip").length}`);
  console.log(`accuracy                             ${clear.filter((r) => r.got === r.expect).length}/${clear.length} (${pct(clear.filter((r) => r.got === r.expect).length, clear.length)})`);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`settle latency (one Jev call): p50 ${ms[Math.floor(ms.length * 0.5)].toFixed(0)}ms, p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(0)}ms`);
  for (const r of clear.filter((r) => r.got !== r.expect)) console.log(`  ${r.got.padEnd(6)} expected ${r.expect.padEnd(6)} ${r.id}`);
  console.log("edge tier (not scored):");
  for (const r of rows.filter((r) => r.tier === "edge")) console.log(`  ${r.got.padEnd(6)} (a reviewer might want: ${r.expect}) ${r.id}`);
}

type GapCase = { id: string; file: string; source: string; tests: string; report: string[]; silent: string[] };
const gaps: GapCase[] = [
  { id: "slugify-happy-only", file: "src/slug.ts",
    source: lines("export function slugify(title: string): string {", "  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');", "}"),
    tests: lines("import { slugify } from './slug';", "test('slugifies a title', () => { expect(slugify('Hello World')).toBe('hello-world'); });"),
    report: ["empty input"], silent: ["null, undefined, or None input", "a dependency, I/O, or async call fails", "a value exactly at a limit or threshold"] },
  { id: "slugify-well-covered", file: "src/slug.ts",
    source: lines("export function slugify(title: string): string {", "  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');", "}"),
    tests: lines("import { slugify } from './slug';",
      "test('happy', () => { expect(slugify('Hello World')).toBe('hello-world'); });",
      "test('empty', () => { expect(slugify('')).toBe(''); });",
      "test('malformed symbols', () => { expect(slugify('!!!')).toBe(''); expect(slugify('  a  b ')).toBe('a-b'); });"),
    report: [], silent: ["null, undefined, or None input", "empty input", "malformed or wrongly formatted input", "a dependency, I/O, or async call fails"] },
  { id: "fetchuser-success-only", file: "src/users.ts",
    source: lines("export async function fetchUser(client: { get(url: string): Promise<{ name: string }> }, id: string) {", "  const res = await client.get(`/users/${id}`);", "  return res.name;", "}"),
    tests: lines("import { fetchUser } from './users';", "test('returns the name', async () => {", "  const client = { get: async () => ({ name: 'Ann' }) };", "  expect(await fetchUser(client, '1')).toBe('Ann');", "});"),
    report: ["a dependency, I/O, or async call fails"], silent: ["null, undefined, or None input", "duplicate or repeated items"] },
  { id: "paginate-limits", file: "src/page.ts",
    source: lines("export function paginate<T>(items: T[], page: number, size: number): T[] {",
      "  if (size > 100) throw new Error('size too large');", "  if (page < 1) throw new Error('page must be positive');", "  return items.slice((page - 1) * size, page * size);", "}"),
    tests: lines("import { paginate } from './page';",
      "test('first page', () => { expect(paginate([1, 2, 3, 4], 1, 2)).toEqual([1, 2]); });",
      "test('max size ok', () => { expect(paginate(Array(200).fill(0), 1, 100)).toHaveLength(100); });"),
    report: ["a value just past a limit or threshold", "zero or negative numbers"], silent: ["null, undefined, or None input", "a dependency, I/O, or async call fails", "duplicate or repeated items"] },
  { id: "discount-edges-covered", file: "src/discount.ts",
    source: lines("export function applyDiscount(price: number, pct: number): number {", "  if (pct < 0 || pct > 100) throw new RangeError('pct out of range');", "  return price * (1 - pct / 100);", "}"),
    tests: lines("import { applyDiscount } from './discount';",
      "test('typical', () => { expect(applyDiscount(200, 10)).toBe(180); });",
      "test('zero percent', () => { expect(applyDiscount(200, 0)).toBe(200); });",
      "test('hundred percent', () => { expect(applyDiscount(200, 100)).toBe(0); });",
      "test('over 100', () => { expect(() => applyDiscount(200, 101)).toThrow(RangeError); });",
      "test('negative', () => { expect(() => applyDiscount(200, -1)).toThrow(RangeError); });"),
    report: [], silent: ["null, undefined, or None input", "a value exactly at a limit or threshold", "a value just past a limit or threshold", "zero or negative numbers"] },
  { id: "parse-duration-py", file: "durations.py",
    source: lines("import re", "", "def parse_duration(text):", "    m = re.fullmatch(r'(?:(\\d+)h)?(?:(\\d+)m)?', text)", "    if not text or not m:", "        raise ValueError('bad duration')", "    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)"),
    tests: lines("from durations import parse_duration", "", "def test_hours_and_minutes():", "    assert parse_duration('1h30m') == 90"),
    report: ["empty input", "malformed or wrongly formatted input"], silent: ["a dependency, I/O, or async call fails"] },
  { id: "divide-go", file: "calc.go",
    source: lines("package calc", "", "import \"errors\"", "", "var ErrDivZero = errors.New(\"division by zero\")", "", "func Divide(a, b int) (int, error) {", "\tif b == 0 {", "\t\treturn 0, ErrDivZero", "\t}", "\treturn a / b, nil", "}"),
    tests: lines("package calc", "", "import \"testing\"", "", "func TestDivide(t *testing.T) {", "\tgot, _ := Divide(6, 3)", "\tif got != 2 {", "\t\tt.Fatalf(\"got %d\", got)", "\t}", "}"),
    report: ["zero or negative numbers"], silent: ["null, undefined, or None input", "a dependency, I/O, or async call fails", "duplicate or repeated items"] },
  { id: "sum-all-covered", file: "src/sum.ts",
    source: lines("export function sum(xs: number[]): number {", "  return xs.reduce((a, b) => a + b, 0);", "}"),
    tests: lines("import { sum } from './sum';",
      "test('adds', () => { expect(sum([1, 2, 3])).toBe(6); });",
      "test('empty', () => { expect(sum([])).toBe(0); });",
      "test('negatives', () => { expect(sum([-1, -2])).toBe(-3); });"),
    report: [], silent: ["null, undefined, or None input", "a dependency, I/O, or async call fails", "malformed or wrongly formatted input", "a value just past a limit or threshold"] },
];

async function benchGaps() {
  const rows = [];
  for (const k of gaps) {
    const started = performance.now();
    let got: string[] = [];
    let error = "";
    try { got = await findGaps({ [k.file]: k.source }, k.tests); } catch (err) { error = (err as Error).message; }
    const has = (list: string[], wanted: string) => list.some((g) => g.startsWith(wanted));
    rows.push({ k, got, error, ms: performance.now() - started,
      missed: k.report.filter((w) => !has(got, w)), noise: k.silent.filter((s) => has(got, s)) });
  }
  const expected = rows.reduce((s, r) => s + r.k.report.length, 0);
  const found = rows.reduce((s, r) => s + r.k.report.length - r.missed.length, 0);
  const noise = rows.reduce((s, r) => s + r.noise.length, 0);
  const silentTotal = rows.reduce((s, r) => s + r.k.silent.length, 0);
  console.log(`\n=== test-gaps-on-settle, fresh cases (${rows.length}), real Jev ===`);
  console.log(`real gaps reported (recall)          ${found}/${expected} (${pct(found, expected)})`);
  console.log(`irrelevant or covered gaps reported  ${noise}/${silentTotal} (${pct(noise, silentTotal)}) of the cases that must stay silent`);
  console.log(`fully covered tests flagged anyway   ${rows.filter((r) => r.k.report.length === 0 && r.got.length > 0).length} of ${rows.filter((r) => r.k.report.length === 0).length}`);
  console.log(`Jev errors                           ${rows.filter((r) => r.error).length}`);
  for (const r of rows) console.log(`  ${r.k.id.padEnd(24)} ${r.ms.toFixed(0).padStart(5)}ms  reported: ${r.got.map((g) => g.replace(/^the error path that throws or raises/, "error-path").slice(0, 38)).join(" | ") || "(none)"}${r.missed.length ? `   MISSED: ${r.missed.join(", ")}` : ""}${r.noise.length ? `   NOISE: ${r.noise.join(", ")}` : ""}${r.error ? `   ERROR ${r.error}` : ""}`);
}

if (!only || only === "comment-guard") await benchComments();
if (!only || only === "ponytail") await benchPonytail();
if (!only || only === "test-gaps") await benchGaps();
console.log(`\nJev calls ${jevCalls}, errors ${jevErrors}`);
for (const temp of temps) rmSync(temp, { recursive: true, force: true });
