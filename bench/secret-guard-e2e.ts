import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const random = (n: number) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(n);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};
const records = (raw: string) => raw.split("\n").filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const messages = (raw: string, role: string) => records(raw)
  .filter((entry) => entry.type === "message" && entry.message?.role === role)
  .map((entry) => JSON.stringify(entry.message));
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2)) : 0;
  return { p50: at(0.5), p95: at(0.95) };
};
const existing = flag("session");
if (existing) {
  const raw = readFileSync(existing, "utf8");
  const user = messages(raw, "user").join("\n");
  const token = flag("token");
  const opaque = flag("opaque");
  const uuid = flag("uuid");
  const checks = {
    tokenRedacted: !token || user.includes("<redacted:token>"),
    opaqueRedacted: !opaque || user.includes("<redacted:jev>") || user.includes("<redacted:unverified>"),
    tokenAbsent: !token || !raw.includes(token),
    opaqueAbsent: !opaque || !raw.includes(opaque),
    uuidPreserved: !uuid || user.includes(uuid),
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(`SUBAGENT_SESSION ${JSON.stringify({ passed, checks })}`);
  process.exit(passed ? 0 : 1);
}
const globalAgent = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi/agent");
const jevConfig = JSON.parse(readFileSync(join(globalAgent, "mcp-env.json"), "utf8"));
const jevKey = process.env.TYPESAFE_API_KEY || jevConfig.TYPESAFE_API_KEY;
if (!jevKey) throw new Error("TYPESAFE_API_KEY is required for the real e2e benchmark");
const apiModel = flag("model") ?? "deepseek/deepseek-chat";
const only = positional[0];
const pi = process.env.PI_BIN ?? "pi";
type CaseResult = { name: string; passed: boolean; ms: number; reason?: string; providerRequests: number; layers: Record<string, unknown>; jevMs?: unknown };
const results: CaseResult[] = [];
function runCase(name: string): CaseResult {
  const started = performance.now();
  const root = mkdtempSync(join(tmpdir(), "sg-e2e-"));
  const agent = join(root, "agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(agent, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const opaque = random(32);
  const token = `sk-${random(32)}`;
  const uuid = randomUUID();
  const envSecret = random(36);
  const authSecret = random(40);
  const authRefresh = random(40);
  const logPath = join(root, "guard.jsonl");
  const tapPath = join(root, "payload.jsonl");
  const authPath = join(agent, "auth.json");
  writeFileSync(authPath, JSON.stringify({ bench: { access: authSecret, refresh: authRefresh } }));
  writeFileSync(join(agent, "mcp-env.json"), JSON.stringify({ BENCH_MCP_TOKEN: random(32) }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      "bench-openrouter": {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        apiKey: "$OPENROUTER_API_KEY",
        models: [{
          id: apiModel,
          name: "Secret guard e2e",
          reasoning: false,
          input: ["text"],
          cost: { input: 0.32, output: 0.89, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 163840,
          maxTokens: 4096,
        }],
      },
    },
  }));
  const jevDown = name === "jev-down";
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    OPENROUTER_API_KEY: jevKey,
    TYPESAFE_API_KEY: jevDown ? "bench-jev-key-0123456789" : jevKey,
    TYPESAFE_BASE_URL: jevDown ? "http://127.0.0.1:9" : (process.env.TYPESAFE_BASE_URL || jevConfig.TYPESAFE_BASE_URL),
    TYPESAFE_MODEL: process.env.TYPESAFE_MODEL || jevConfig.TYPESAFE_MODEL,
    SECRET_GUARD_LOG: logPath,
    SECRET_GUARD_PAYLOAD_TAP: tapPath,
    CLOUDFLARE_API_KEY: envSecret,
  };
  const prompt = name === "env-output"
    ? "Run exactly this bash command, then reply DONE: env | grep CLOUDFLARE_API_KEY"
    : name === "auth-file"
      ? `Use the read tool on ${authPath}, then reply DONE.`
      : `Reply only OK. DB_PASS=${opaque} token ${token} request ${uuid}`;
  const args = [
    "--mode", "json", "--print", "--session-dir", sessionDir,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
    "--tools", "read,bash", "--model", `bench-openrouter/${apiModel}`,
    "-e", join(here, "../extensions/secret-guard.ts"),
  ];
  if (["payload", "env-output", "auth-file"].includes(name)) args.push("-e", join(here, "payload-tap.ts"));
  args.push(prompt);
  let passed = false;
  let reason = "";
  let log: any[] = [];
  try {
    const child = spawnSync(pi, args, { cwd: root, env, encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024 });
    const files = existsSync(sessionDir) ? readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".jsonl")) : [];
    const raw = files.length ? readFileSync(join(sessionDir, files[0]), "utf8") : "";
    const user = messages(raw, "user").join("\n");
    const tools = messages(raw, "toolResult").join("\n");
    log = existsSync(logPath) ? records(readFileSync(logPath, "utf8")) : [];
    const tap = existsSync(tapPath) ? readFileSync(tapPath, "utf8") : "";
    const artifacts = { session: raw, tap };
    const leaks = Object.entries(artifacts).flatMap(([artifact, content]) =>
      [opaque, token, envSecret, authSecret, authRefresh, jevKey].some((value) => value && content.includes(value)) ? [artifact] : [],
    );
    const checks: Record<string, boolean> = {
      exited: child.status === 0,
      session: Boolean(raw),
      noLeaks: leaks.length === 0,
    };
    if (name === "paste" || name === "payload") Object.assign(checks, {
      tokenRedacted: user.includes("<redacted:token>"),
      jevRedacted: user.includes("<redacted:jev>"),
      uuidPreserved: user.includes(uuid),
      jevLatency: log.some((entry) => entry.layer === "input" && typeof entry.jevMs === "number" && !entry.jevError),
    });
    if (name === "payload") Object.assign(checks, {
      tapped: Boolean(tap),
      tapTokenRedacted: tap.includes("<redacted:token>"),
      tapJevRedacted: tap.includes("<redacted:jev>"),
    });
    if (name === "env-output") Object.assign(checks, {
      envRedacted: tools.includes("CLOUDFLARE_API_KEY=<redacted:env CLOUDFLARE_API_KEY>"),
    });
    if (name === "auth-file") Object.assign(checks, {
      authRedacted: tools.includes("<redacted:auth.json>"),
    });
    if (name === "jev-down") Object.assign(checks, {
      tokenRedacted: user.includes("<redacted:token>"),
      unverifiedRedacted: user.includes("<redacted:unverified>"),
      jevError: log.some((entry) => entry.layer === "input" && entry.jevError),
    });
    passed = Object.values(checks).every(Boolean);
    if (!passed) reason = `${Object.entries(checks).filter(([, ok]) => !ok).map(([check]) => check).join(",")}${leaks.length ? `(${leaks.join(",")})` : ""}`;
  } catch (error) {
    reason = error instanceof Error ? error.name : "error";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const layers = Object.fromEntries(["input", "tool_result", "provider"].map((layer) => [layer, quantiles(log.filter((entry) => entry.layer === layer).map((entry) => entry.ms).filter(Number.isFinite))]));
  const jevValues = log.map((entry) => entry.jevMs).filter(Number.isFinite);
  return {
    name, passed, ms: Math.round(performance.now() - started), reason: reason || undefined,
    providerRequests: log.filter((entry) => entry.layer === "provider").length,
    layers, jevMs: jevValues.length ? quantiles(jevValues) : undefined,
  };
}
for (const name of ["paste", "env-output", "auth-file", "payload", "jev-down"]) {
  if (only && only !== name) continue;
  const result = runCase(name);
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name} ${result.ms}ms provider=${result.providerRequests} layers=${JSON.stringify(result.layers)} jev=${JSON.stringify(result.jevMs)}${result.reason ? ` failed=${result.reason}` : ""}`);
}
const passed = results.length > 0 && results.every((result) => result.passed);
console.log(`E2E_SUMMARY ${JSON.stringify({ model: apiModel, passed, results })}`);
if (!passed) process.exitCode = 1;
