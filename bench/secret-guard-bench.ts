import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seed = 8675309;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// A real credential has a digit; guarantee one so a letters-only random value cannot make a scored secret unfair.
const value = (n: number) => {
  const text = Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  return /\d/.test(text) ? text : `${text.slice(0, -1)}7`;
};
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const upper = (n: number) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(rnd() * 36)]).join("");
const agentDir = mkdtempSync(join(tmpdir(), "secret-guard-offline-"));
const fakeEnv = "bench-env-value-0123456789abcdef";
const fakeMcp = "bench-mcp-value-0123456789abcdef";
const fakeAuth = "bench-auth-value-0123456789abcdef";
writeFileSync(join(agentDir, "mcp-env.json"), JSON.stringify({ BENCH_MCP_TOKEN: fakeMcp }));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ test: { access: fakeAuth } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.BENCH_ENV_TOKEN = fakeEnv;
process.env.TYPESAFE_API_KEY = "";
const { loadKnownSecrets, redact, default: secretGuard } = await import("../extensions/secret-guard.ts");
const fakeCwd = "/Users/example/Works/project-with-a-long-name";
// PWD is in every real shell: it must never be treated as a credential.
const known = loadKnownSecrets({ BENCH_ENV_TOKEN: fakeEnv, PWD: fakeCwd, OLDPWD: "/tmp/previous-directory" }, agentDir);
type Case = { id: string; text: string; expect: "secret" | "benign"; tier: "clear" | "edge" };
const cases: Case[] = [];
const add = (id: string, expect: Case["expect"], text: string, tier: Case["tier"] = "clear") => cases.push({ id, expect, text, tier });
const tokenBuilders = [
  () => `sk-${value(28)}`,
  () => `ghp_${value(30)}`,
  () => `github_pat_${value(30)}`,
  () => `xoxb-${value(24)}`,
  () => `AKIA${upper(16)}`,
  () => `AIza${value(35)}`,
  () => `ya29.${value(30)}`,
  () => `ntn_${value(30)}`,
  () => `ATATT3${value(30)}`,
  () => `secret_${value(40)}`,
];
for (let i = 0; i < 4; i++) {
  tokenBuilders.forEach((build, j) => add(`token-${j}-${i}`, "secret", `prefix ${build()} suffix`));
  add(`pem-${i}`, "secret", `-----BEGIN PRIVATE KEY-----\n${value(40)}\n-----END PRIVATE KEY-----`);
  add(`jwt-${i}`, "secret", `eyJ${value(20)}.${value(20)}.${value(20)}`);
  add(`bearer-${i}`, "secret", `Authorization: Bearer ${value(32)}`);
  for (const protocol of ["https", "postgres", "mysql", "redis"]) add(`url-${protocol}-${i}`, "secret", `${protocol}://user:${value(20)}@host.internal/db`);
  add(`assign-env-${i}`, "secret", `DB_PASSWORD=${value(24)}`);
  add(`assign-json-${i}`, "secret", `{"apiKey": "${value(24)}"}`);
  add(`assign-yaml-${i}`, "secret", `client_secret: ${value(24)}`);
  add(`assign-quote-${i}`, "secret", `export GITHUB_TOKEN='${value(24)}'`);
  add(`assign-refresh-${i}`, "secret", `refreshToken = "${value(24)}"`);
  add(`assign-cred-${i}`, "secret", `awsCredential=${value(24)}`);
  add(`assign-letters-${i}`, "secret", `DB_PASSWORD=correcthorsebattery${"staple".repeat(i)}`);
  add(`known-env-${i}`, "secret", `before ${fakeEnv} after`);
  add(`known-mcp-${i}`, "secret", `before ${fakeMcp} after`);
  add(`known-auth-${i}`, "secret", `before ${fakeAuth} after`);
}
const benignBuilders = [
  () => `commit ${hex(40)}`,
  () => `sha256 ${hex(64)}`,
  () => `request ${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`,
  () => "/Users/example/Works/project/src/index.ts",
  () => "https://example.com/docs/getting-started?lang=vi",
  () => "The keyboard shortcut opens the command palette",
  () => "KEY=short",
  () => "password: must be 8 characters",
  () => `MONKEY=${value(20)}`,
  () => `KEYBOARD=${value(20)}`,
  () => 'apiKey: "example"',
  () => "Authorization: Bearer short",
  () => "https://user@example.com/path",
  () => "postgres://localhost:5432/app",
  () => `data:image/png;base64,${value(48)}`,
  () => `release ${value(24)} completed`,
  () => `integrity sha512-${value(60)}`,
  () => `order ORD-2026-${value(24)}`,
  () => `trace_id=${hex(32)} span_id=${hex(16)}`,
  () => `invoice INV-${value(24)}`,
  () => `cache entry ${value(40)} evicted`,
  () => "tokenization splits text into smaller units",
  () => "MONKEY around with the codebase",
  () => "PRIVATE=true",
  () => "const apiKey = process.env.OPENAI_API_KEY;",
  () => "const secret = loadSecretValue(path);",
  () => "type Token = SomeVeryLongUnionType;",
  () => "self.password = hash_password(raw_password)",
  () => "client = Client(api_key=settings.OPENAI_API_KEY)",
  () => "  api_key: ${OPENAI_API_KEY}",
  () => 'export const API_KEY_HEADER = "x-api-key";',
  () => 'if (!password) throw new Error("password: required field missing");',
  () => "The primary key: constraints are enforced by the database.",
  () => "PASSWORD=PASSWORD",
  () => "API_KEY=SOME_CONSTANT",
  () => "COMMIT_HASH is printed in the build log",
  () => `Current working directory: ${fakeCwd}\nopen ${fakeCwd}/src/index.ts`,
  () => "",
];
for (let i = 0; i < 4; i++) benignBuilders.forEach((build, j) => add(`benign-${j}-${i}`, "benign", build()));
add("edge-bare-secret", "secret", `sig=${value(32)}`, "edge");
add("edge-db-pass", "secret", `DB_PASS=${value(32)}`, "edge");
add("edge-tokenization-name", "benign", `TOKENIZATION=${value(24)}`, "edge");
const leaked = cases.filter((c) => c.tier === "clear" && c.expect === "secret" && redact(c.text, known).count === 0);
const overRedacted = cases.filter((c) => c.tier === "clear" && c.expect === "benign" && redact(c.text, known).count > 0);
const clearSecrets = cases.filter((c) => c.tier === "clear" && c.expect === "secret").length;
const clearBenign = cases.filter((c) => c.tier === "clear" && c.expect === "benign").length;
console.log(`cases ${cases.length}: ${clearSecrets} scored secrets, ${clearBenign} scored benign, ${cases.filter((c) => c.tier === "edge").length} edge`);
console.log(`secret leaked ${leaked.length}: ${leaked.map((c) => c.id).join(", ") || "-"}`);
console.log(`benign over-redacted ${overRedacted.length}/${clearBenign}: ${overRedacted.map((c) => c.id).join(", ") || "-"}`);
for (const c of cases.filter((c) => c.tier === "edge")) console.log(`edge ${c.id} expect=${c.expect} redactions=${redact(c.text, known).count}`);
const handlers: Record<string, (event: any, ctx?: any) => any> = {};
secretGuard({ on: (event: string, handler: (event: any, ctx?: any) => any) => (handlers[event] = handler) });
const ctx = { ui: { notify: () => undefined } };
const quantiles = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
};
const measure = (run: () => unknown) => {
  const samples: number[] = [];
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    run();
    if (i >= 5) samples.push(performance.now() - start);
  }
  return quantiles(samples);
};
const chunk = `ordinary text ${value(80)} token sk-${value(28)} known ${fakeEnv} `;
const timings: Record<string, ReturnType<typeof quantiles>> = {};
for (const size of [1_000_000, 5_000_000]) {
  const payload = { model: "bench", messages: [{ role: "user", content: chunk.repeat(Math.ceil(size / chunk.length)) }] };
  timings[`redact-${size}`] = measure(() => redact(JSON.stringify(payload), known, true));
  timings[`provider-${size}`] = measure(() => handlers.before_provider_request({ payload }, ctx));
}
const paste = `ordinary text ${value(200)} `.repeat(Math.ceil(10_000 / 220));
timings["input-10000"] = measure(() => handlers.input({ text: paste, source: "interactive" }, ctx));
for (const [name, timing] of Object.entries(timings)) console.log(`${name} p50 ${timing.p50.toFixed(2)}ms p95 ${timing.p95.toFixed(2)}ms max ${timing.max.toFixed(2)}ms`);
const adversarial: [string, string][] = [
  ["hyphen-run-200KB", "a-".repeat(100_000)],
  ["dot-run-200KB", "a.".repeat(100_000)],
  ["base64url-240KB", "Ab3-_x".repeat(40_000)],
  ["spaces-after-keyword-200KB", `TOKEN${" ".repeat(200_000)}x`],
  ["begin-markers-540KB", "-----BEGIN PRIVATE KEY-----\n".repeat(20_000)],
];
let slowest = 0;
for (const [name, text] of adversarial) {
  const timing = measure(() => redact(text, known));
  slowest = Math.max(slowest, timing.p95);
  timings[`adversarial-${name}`] = timing;
  console.log(`adversarial ${name} p95 ${timing.p95.toFixed(2)}ms`);
}
const overRate = overRedacted.length / clearBenign;
const passed = leaked.length === 0 && overRate <= 0.02 && timings["provider-1000000"].p95 < 50 && timings["provider-5000000"].p95 < 250 && timings["input-10000"].p95 < 5 && slowest < 100;
console.log(`acceptance ${passed ? "PASS" : "FAIL"}: zero leaks, benign over-redaction <=2%, provider p95 <50ms at 1MB and <250ms at 5MB, input p95 <5ms, adversarial p95 <100ms`);
console.log(`SUMMARY ${JSON.stringify({ cases: cases.length, leaked: leaked.length, overRedacted: overRedacted.length, overRate, timings, passed })}`);
rmSync(agentDir, { recursive: true, force: true });
if (!passed) process.exitCode = 1;
