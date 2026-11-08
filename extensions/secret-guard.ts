import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askNoul } from "./jev.ts";

type ExtensionContext = {
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
};
type ExtensionAPI = {
  on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => void;
};

export type Known = { value: string; label: string };
export type Redaction = { text: string; count: number; labels: string[] };
export type Candidate = { value: string; key?: string; shape: Shape };
export type Shape = { length: number; classes: string; entropy: number };

// GIT_CONFIG_KEY_<n> holds a git config key name such as `url.x.insteadOf`, not a secret.
const NOT_SECRET_NAME = /_(?:FILE|PATH|DIR|URL|ID)$|^GIT_CONFIG_KEY_\d+$/i;

export function isSecretName(name: string, includeHash = false): boolean {
  // PWD is deliberately absent: it is the working directory in every shell, and redacting it breaks every absolute path.
  // COMMIT_HASH and BUILD_HASH are build metadata, so a hash counts only when the name says it protects something.
  const keywords = `KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL${includeHash ? "|API_?HASH|PASSWORD_?HASH|SECRET_?HASH" : ""}`;
  const segment = new RegExp(`(?:^|[^A-Za-z0-9])(?:${keywords})(?:$|[^A-Za-z0-9])`, "i");
  const camel = /(?:^|[a-z0-9])(?:Key|Token|Secret|Password|Passwd|Credential)(?:$|[A-Z0-9])/;
  const joined = new RegExp(`^(?:(?:API|ACCESS|REFRESH|CLIENT|DB|APP|AUTH|SESSION|PRIVATE|SECRET)(?:${keywords})|(?:${keywords}))$`, "i");
  return segment.test(name) || camel.test(name) || joined.test(name);
}
export const JEV_SECRET = 0.4;
const MAX_JEV = 40;
const CONTEXT_CHARS = 60;

// Every class excludes `"` and `\` so a match inside JSON.stringify output cannot split an escape.
export const SECRET_PATTERNS: { label: string; pattern: RegExp; group?: number; nameGroup?: number; valueOk?: (value: string, name: string, before: string) => boolean }[] = [
  // A PEM body is base64 and never holds `-----`, so each BEGIN stops scanning at the next marker: many BEGINs without an END stay linear.
  { label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----)(?:[^"\\]|\\[nrt]))*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    label: "token",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{32,}|ATATT3[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  },
  { label: "bearer", pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  {
    label: "url-password",
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/"\\<>]+:([^\s@/"\\<>]+)@/gi,
    group: 1,
  },
  {
    label: "assignment",
    // Optional `\` before quotes keeps the pattern working on JSON.stringify output (`\"apiKey\": \"…\"`);
    // `<>` are excluded so a placeholder written by an earlier layer is not matched as a value.
    // The lookbehind lets a name start only at the beginning of a run, and every repeat is bounded, so the scan stays linear;
    // shortcut: a name with more than 64 characters before its keyword is not matched, raise the bound if one shows up.
    pattern: /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]{0,40})\s{0,4}(?:\\?["'])?\s{0,4}[=:]\s{0,4}(?:\\?["'])?([^\s"'\\,;&|<>]{8,})/gi,
    group: 2,
    nameGroup: 1,
    // A real credential has a digit, while `process.env.X_API_KEY`, `hash(raw)` and `${X}` are references in code or prose.
    // An unquoted ENV_STYLE_NAME=value with a lowercase letter is config, so `DB_PASSWORD=correcthorse` is also hidden.
    // shortcut: `password: correcthorse` (lowercase name, no digit) is kept, because the same shape is ordinary code and prose.
    valueOk: (value, name, before) =>
      !/[(){}[\]$]/.test(value) && (/\d/.test(value) || (/^[A-Z][A-Z0-9_]*$/.test(name) && /[a-z]/.test(value) && !/["']$/.test(before))),
  },
];

function secretEntries(record: Record<string, unknown>, source: string, min: number): Known[] {
  return Object.entries(record)
    .filter(([name, value]) => isSecretName(name, true) && !NOT_SECRET_NAME.test(name) && typeof value === "string" && value.length >= min)
    .map(([name, value]) => ({ value: value as string, label: `${source} ${name}` }));
}

function stringLeaves(value: unknown, min: number, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length >= min) out.push(value);
  } else if (value && typeof value === "object") for (const child of Object.values(value)) stringLeaves(child, min, out);
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadKnownSecrets(
  env: Record<string, unknown> = process.env,
  agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi/agent"),
): Known[] {
  const mcpEnv = readJson(join(agentDir, "mcp-env.json"));
  const auth = readJson(join(agentDir, "auth.json"));
  const known = [
    ...secretEntries(env, "env", 8),
    ...(mcpEnv && typeof mcpEnv === "object" ? secretEntries(mcpEnv as Record<string, unknown>, "mcp-env", 8) : []),
    ...stringLeaves(auth, 16).map((value) => ({ value, label: "auth.json" })),
  ];
  return known.sort((a, b) => b.value.length - a.value.length);
}

function redactKnown(text: string, known: Known[], escaped: boolean, hit: (label: string) => void): string {
  for (const { value, label } of known) {
    const needle = escaped ? JSON.stringify(value).slice(1, -1) : value;
    const parts = text.split(needle);
    if (parts.length === 1) continue;
    for (let i = 1; i < parts.length; i++) hit(label);
    text = parts.join(`<redacted:${label}>`);
  }
  return text;
}

export function redact(text: string, known: Known[], escaped = false): Redaction {
  let count = 0;
  const labels: string[] = [];
  const hit = (label: string) => {
    count += 1;
    if (!labels.includes(label)) labels.push(label);
  };
  text = redactKnown(text, known, escaped, hit);
  for (const { label, pattern, group, nameGroup, valueOk } of SECRET_PATTERNS) {
    text = text.replace(pattern, (match: string, ...rest: unknown[]) => {
      if (nameGroup !== undefined && !isSecretName(rest[nameGroup - 1] as string)) return match;
      if (group === undefined) {
        hit(label);
        return `<redacted:${label}>`;
      }
      const captured = rest[group - 1] as string;
      // The value is the last occurrence: `PASSWORD=PASSWORD` must keep the name and hide the value.
      const at = match.lastIndexOf(captured);
      if (valueOk && !valueOk(captured, rest[(nameGroup ?? 0) - 1] as string, match.slice(0, at))) return match;
      hit(label);
      return `${match.slice(0, at)}<redacted:${label}>${match.slice(at + captured.length)}`;
    });
  }
  return { text, count, labels };
}

export function describeShape(value: string): Shape {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  const classes = [
    /[a-z]/.test(value) && "lower",
    /[A-Z]/.test(value) && "upper",
    /[0-9]/.test(value) && "digit",
    /[^A-Za-z0-9]/.test(value) && "symbol",
  ]
    .filter(Boolean)
    .join("+");
  return { length: value.length, classes, entropy: Number(entropy.toFixed(2)) };
}

export function jevCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_\-+]{24,256}={0,2}/g)) {
    const value = match[0];
    const before = text[match.index - 1];
    const after = text[match.index + value.length];
    if (seen.has(value) || before === "/" || after === "/") continue;
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) continue;
    if ((value.length === 40 || value.length === 64) && /^[0-9a-f]+$/i.test(value)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) continue;
    const shape = describeShape(value);
    if (shape.entropy < 3.5) continue;
    const key = text.slice(Math.max(0, match.index - 80), match.index).match(/([A-Za-z0-9_.-]+)\s*["']?\s*[=:]\s*["']?$/)?.[1];
    seen.add(value);
    out.push({ value, key, shape });
  }
  return out;
}

// Keeps plain words (`session`, `Build`, `SUPABASE_SERVICE_ROLE`) and short numbers; mixed-case runs and anything else could be a secret.
// shortcut: a plain word of up to 11 letters, such as a dictionary-word password, still reaches Jev.
function maskContext(text: string, candidates: Candidate[]): string {
  for (const { value } of candidates) text = text.split(value).join("<OTHER>");
  return text.replace(/[A-Za-z0-9_.+-]+/g, (token) =>
    token.split(/[_.+-]/).every((part) => /^(?:[a-z]{0,11}|[A-Z]{1,11}|[A-Z][a-z]{0,10})$/.test(part) || /^\d{1,5}$/.test(part)) ? token : "<OTHER>",
  );
}

// Jev sees the shape and the surroundings of each candidate, never the value itself.
export async function classifyWithJev(text: string, candidates: Candidate[]): Promise<Record<string, number>> {
  const state = candidates.map(({ value, key, shape }, i) => {
    const at = text.indexOf(value);
    const before = text.slice(Math.max(0, at - CONTEXT_CHARS), at);
    const after = text.slice(at + value.length, at + value.length + CONTEXT_CHARS);
    const mask = (part: string) => maskContext(part, candidates);
    return { id: `c${i}`, key: key && mask(key), shape, context: `${mask(before)}<VALUE>${mask(after)}` };
  });
  const questions = Object.fromEntries(
    state.map((c) => [
      c.id,
      `In candidate ${c.id}, is <VALUE> a secret used to authenticate or sign requests, such as a credential, API key, token, password, session cookie, signing secret, or private key? Answer no for public identifiers, content hashes, checksums, nonces, paths, and other random data.`,
    ]),
  );
  return askNoul({ candidates: state }, questions);
}

function log(entry: Record<string, unknown>) {
  const path = process.env.SECRET_GUARD_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    // A handler that throws leaves the unredacted text in place, so a bad log path must not stop the redaction.
  }
}

export default function (pi: ExtensionAPI) {
  let known = loadKnownSecrets();
  let parseFailureReported = false;
  const reload = () => (known = loadKnownSecrets());
  pi.on("session_start", reload);
  pi.on("agent_start", reload);

  pi.on("input", async (event, ctx) => {
    const start = performance.now();
    let { text, count, labels } = redact(event.text, known);
    let jevMs: number | undefined;
    let jevError: string | undefined;
    let jevCandidateCount = 0;
    const redactCandidates = (list: Candidate[], label: string) => {
      for (const { value } of list) {
        text = text.split(value).join(`<redacted:${label}>`);
        count += 1;
        if (!labels.includes(label)) labels.push(label);
      }
    };
    if (event.source !== "extension" && process.env.TYPESAFE_API_KEY !== "") {
      const all = jevCandidates(text);
      const candidates = all.slice(0, MAX_JEV);
      jevCandidateCount = all.length;
      if (all.length > MAX_JEV) redactCandidates(all.slice(MAX_JEV), "unverified");
      if (candidates.length) {
        const jevStart = performance.now();
        let flagged: Candidate[];
        let label: string;
        try {
          const scores = await classifyWithJev(text, candidates);
          flagged = candidates.filter((_c, i) => scores[`c${i}`] >= JEV_SECRET);
          label = "jev";
        } catch (error) {
          // askNoul appends up to 200 bytes of the response body after the status: keep the status only, since this reaches the log and the UI.
          jevError = (error instanceof Error ? error.message : String(error)).replace(/^(Jev returned \d+):[\s\S]*$/, "$1");
          flagged = candidates;
          label = "unverified";
        }
        jevMs = performance.now() - jevStart;
        redactCandidates(flagged, label);
      }
    }
    log({ layer: "input", count, labels, ms: performance.now() - start, jevMs, jevCandidates: jevCandidateCount, jevError });
    if (count === 0) return undefined;
    if (event.source !== "extension") {
      ctx.ui?.notify?.(
        jevError ? `secret-guard: Jev không trả lời (${jevError}), đã che ${count} chuỗi (${labels.join(", ")})` : `secret-guard: đã che ${count} chuỗi (${labels.join(", ")})`,
        "warning",
      );
    }
    return { action: "transform", text };
  });

  pi.on("tool_result", (event) => {
    const start = performance.now();
    if (!Array.isArray(event.content)) return undefined;
    let count = 0;
    const labels: string[] = [];
    const note = (result: Redaction) => {
      count += result.count;
      for (const label of result.labels) if (!labels.includes(label)) labels.push(label);
    };
    const next = event.content.map((item: { type: string; text?: string }) => {
      if (item.type !== "text" || typeof item.text !== "string") return item;
      const result = redact(item.text, known);
      note(result);
      return result.count ? { ...item, text: result.text } : item;
    });
    // Pi drops structuredContent when a handler replaces only `content`, so redact it and hand it back.
    let structuredContent = event.structuredContent;
    if (structuredContent !== undefined) {
      const result = redact(JSON.stringify(structuredContent), known, true);
      note(result);
      if (result.count) {
        try {
          structuredContent = JSON.parse(result.text);
        } catch {
          // An unparseable result must not abort the handler: Pi would then keep the unredacted content.
          structuredContent = undefined;
        }
      }
    }
    log({ layer: "tool_result", count, labels, ms: performance.now() - start });
    return count ? { content: next, ...(structuredContent !== undefined && { structuredContent }) } : undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const start = performance.now();
    if (event.payload === undefined) return undefined;
    const json = JSON.stringify(event.payload);
    const { text, count, labels } = redact(json, known, true);
    log({ layer: "provider", count, labels, ms: performance.now() - start });
    if (count === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      if (!parseFailureReported) {
        parseFailureReported = true;
        ctx.ui?.notify?.("secret-guard: không parse được payload sau khi che, chỉ che giá trị đã biết cho request này", "error");
      }
      // A known value is matched in its full JSON-escaped form, so replacing it cannot split an escape.
      return JSON.parse(redactKnown(json, known, true, () => {}));
    }
  });
}
