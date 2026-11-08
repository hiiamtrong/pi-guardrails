import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "secret-guard-"));
writeFileSync(
  join(agentDir, "mcp-env.json"),
  JSON.stringify({ SLACK_BOT_TOKEN: "xoxb-mcp-env-value-1234567890", TELEGRAM_API_HASH: "hash-from-mcp-env-abcdef", JIRA_URL: "https://jira.example.com", SHORT_KEY: "abc" }),
);
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({ anthropic: { type: "oauth", access: "auth-access-token-0123456789", refresh: 'auth-refresh-with-"quote"-and-\\slash', expires: 1 } }),
);
const env = {
  CLOUDFLARE_API_KEY: "cf-env-key-value-9876543210",
  SOPS_AGE_KEY_FILE: "/Users/me/.config/sops/age/keys.txt",
  GOOGLE_OAUTH_CLIENT_ID: "123456789-client-id.apps.googleusercontent.com",
  TINY_TOKEN: "short",
  PATH: "/usr/bin:/bin",
};

process.env.TYPESAFE_API_KEY = "test-key";
process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
// The hooks load known values from the process environment and PI_CODING_AGENT_DIR, so point both at the fixtures.
process.env.PI_CODING_AGENT_DIR = agentDir;
Object.assign(process.env, env);
const mod = await import(`../extensions/secret-guard.ts?test=${Date.now()}`);
const { loadKnownSecrets, redact, jevCandidates, describeShape, classifyWithJev, SECRET_PATTERNS, default: secretGuard } = mod;
const known = loadKnownSecrets(env, agentDir);

function mockFetch(answer: (body: { state: unknown; questions: Record<string, unknown> }) => Record<string, number> | Error) {
  const bodies: { state: { candidates: { context: string; key?: string; shape: unknown }[] }; questions: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const result = answer(body);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(result).map(([id, noul]) => [id, { noul }])) }));
  }) as typeof fetch;
  return bodies;
}

function setup() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  secretGuard({ on: (event: string, handler: (event: any, ctx?: any) => any) => (handlers[event] = handler) });
  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };
  return { handlers, notices, ctx };
}

test("empty input stays unchanged at every layer", async () => {
  const bodies = mockFetch(() => ({}));
  const { handlers, notices, ctx } = setup();
  assert.deepEqual(redact("", known), { text: "", count: 0, labels: [] });
  assert.deepEqual(jevCandidates(""), []);
  assert.equal(await handlers.input({ text: "", source: "interactive" }, ctx), undefined);
  assert.equal(handlers.tool_result({ toolName: "read", content: [] }), undefined);
  assert.equal(handlers.before_provider_request({ payload: { messages: [] } }, ctx), undefined);
  assert.equal(bodies.length, 0);
  assert.deepEqual(notices, []);
});

test("known values: env, mcp-env and auth.json are replaced with a labelled placeholder", () => {
  const labels = known.map((k: { label: string }) => k.label);
  assert.deepEqual(
    labels.sort(),
    ["auth.json", "auth.json", "env CLOUDFLARE_API_KEY", "mcp-env SLACK_BOT_TOKEN", "mcp-env TELEGRAM_API_HASH"],
  );
  const text = `key=${env.CLOUDFLARE_API_KEY} slack=xoxb-mcp-env-value-1234567890 auth=auth-access-token-0123456789 file=${env.SOPS_AGE_KEY_FILE}`;
  const out = redact(text, known);
  assert.equal(
    out.text,
    `key=<redacted:env CLOUDFLARE_API_KEY> slack=<redacted:mcp-env SLACK_BOT_TOKEN> auth=<redacted:auth.json> file=${env.SOPS_AGE_KEY_FILE}`,
  );
  assert.equal(out.count, 3);
  assert.deepEqual([...out.labels].sort(), ["auth.json", "env CLOUDFLARE_API_KEY", "mcp-env SLACK_BOT_TOKEN"]);
});

test("known values: short values, _FILE/_ID names and unreadable files are ignored", () => {
  assert.ok(!known.some((k: { value: string }) => k.value === "short" || k.value === "abc" || k.value === env.SOPS_AGE_KEY_FILE || k.value === env.GOOGLE_OAUTH_CLIENT_ID));
  assert.deepEqual(loadKnownSecrets({}, join(agentDir, "missing")), []);
});

test("known values: the longest value is replaced first so a nested value is not split", () => {
  const nested = [
    { value: "abcdefgh", label: "inner" },
    { value: "xx-abcdefgh-yy", label: "outer" },
  ];
  assert.equal(redact("xx-abcdefgh-yy and abcdefgh", loadKnownSecretsOrder(nested)).text, "<redacted:outer> and <redacted:inner>");
});
function loadKnownSecretsOrder(list: { value: string; label: string }[]) {
  return [...list].sort((a, b) => b.value.length - a.value.length);
}

test("patterns: prefixed tokens, PEM, JWT, Bearer, URL password and assignments", () => {
  const cases: [string, string][] = [
    ["sk-or-v1-0123456789abcdefghijklmnop", "<redacted:token>"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "<redacted:token>"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "<redacted:token>"],
    ["github_pat_abcdefghijklmnopqrstuvwxyz", "<redacted:token>"],
    ["xoxb-1234567890-abcdefghij", "<redacted:token>"],
    ["AKIAIOSFODNN7EXAMPLE", "<redacted:token>"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "<redacted:token>"],
    ["ya29.a0AfH6SMBabcdefghijklmnop", "<redacted:token>"],
    ["ntn_abcdefghijklmnopqrstuvwxyz0123", "<redacted:token>"],
    ["ATATT3xFfGF0abcdefghijklmnopqrstuv", "<redacted:token>"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "<redacted:token>"],
    ["Authorization: Bearer abcdefghijklmnop.qrstuvwxyz", "Authorization: Bearer <redacted:bearer>"],
    ["postgres://app:s3cr3t-pass@db.internal:5432/app", "postgres://app:<redacted:url-password>@db.internal:5432/app"],
    ["mongodb+srv://u:pw12345678@cluster0.x.mongodb.net", "mongodb+srv://u:<redacted:url-password>@cluster0.x.mongodb.net"],
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=<redacted:assignment>"],
    ['"apiKey": "abcdefghijk1mnop"', '"apiKey": "<redacted:assignment>"'],
    ["password: Tr0ub4dor-3xyz", "password: <redacted:assignment>"],
    ["export STRIPE_SECRET='sk_live_abcdefghijk1mnop'", "export STRIPE_SECRET='<redacted:assignment>'"],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input, []).text, expected, input);
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAQ==\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`before ${pem} after`, []).text, "before <redacted:private-key> after");
  assert.equal(redact("APIKEY=abcdefghijklmnop1", []).text, "APIKEY=<redacted:assignment>");
  // The value, not the identical name, is hidden.
  assert.equal(redact("PASSWORD=PASSWORD1", []).text, "PASSWORD=<redacted:assignment>");
  assert.equal(redact("password=password-value1", []).text, "password=<redacted:assignment>");
});

test("patterns: benign text is left alone", () => {
  for (const text of [
    "commit 3b1f2c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c",
    "/Users/me/Works/Tools/research/src/index.ts",
    "The keyboard shortcut is cmd+k",
    "password: must be 8 characters",
    "KEY=short",
    "https://example.com/path/to/page?x=1",
    "git checkout -b feature/long-branch-name-with-many-words",
    "MONKEY=abcdefghijklmnop",
    "KEYBOARD=abcdefghijklmnop",
    "TOKENIZATION=abcdefghijklmnop",
    "const apiKey = process.env.OPENAI_API_KEY;",
    "const secret = loadSecretValue(path);",
    "type Token = SomeVeryLongUnionType;",
    "self.password = hash_password(raw_password)",
    "client = Client(api_key=settings.OPENAI_API_KEY)",
    "  api_key: ${OPENAI_API_KEY}",
    'export const API_KEY_HEADER = "x-api-key";',
    'if (!password) throw new Error("password: required field missing");',
    "The primary key: constraints are enforced by the database.",
    "| token: validation | checks the user |",
  ])
    assert.equal(redact(text, []).text, text, text);
});

test("input hook: redacts a paste, notifies with the count and transforms the text", async () => {
  mockFetch(() => ({}));
  const { handlers, notices, ctx } = setup();
  const result = await handlers.input({ text: "use sk-abcdefghijklmnopqrstuvwxyz please", source: "interactive" }, ctx);
  assert.deepEqual(result, { action: "transform", text: "use <redacted:token> please" });
  assert.deepEqual(notices, ["secret-guard: đã che 1 chuỗi (token)"]);
  assert.equal(await handlers.input({ text: "hello world", source: "interactive" }, ctx), undefined);
});

test("input hook: extension messages are redacted without Jev or a notice", async () => {
  const bodies = mockFetch(() => ({ c0: 0.99 }));
  const { handlers, notices, ctx } = setup();
  const result = await handlers.input({ text: "token ghp_abcdefghijklmnopqrstuvwxyz0123 and Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0", source: "extension" }, ctx);
  assert.equal(result.text, "token <redacted:token> and Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0");
  assert.equal(bodies.length, 0);
  assert.deepEqual(notices, []);
});

test("jev candidates: high-entropy mixed strings only, never SHAs, URLs or words", () => {
  const sha = "3b1f2c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c";
  const text = `id ${sha} uuid 123e4567-e89b-42d3-a456-426614174000 url https://x.io/Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0a val=Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0 word=abcdefghijabcdefghijabcdefghij nums=123456789012345678901234567890`;
  const got = jevCandidates(text);
  assert.deepEqual(got.map((c: { value: string; key?: string }) => [c.value, c.key]), [["Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0", "val"]]);
  assert.equal(describeShape("aaaa").entropy, 0);
  assert.deepEqual(describeShape("aB3-"), { length: 4, classes: "lower+upper+digit+symbol", entropy: 2 });
});

test("jev: the request carries shape and context but never the value; scores decide the label", async () => {
  const secret = "Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0";
  const other = "Qm2cX7vB4nM9kL1pZ6rT3yW8sE5dF0";
  const bodies = mockFetch(() => ({ c0: 0.9, c1: 0.2 }));
  const { handlers, notices, ctx } = setup();
  const result = await handlers.input({ text: `sig=${secret} build=${other}`, source: "interactive" }, ctx);
  assert.equal(result.text, `sig=<redacted:jev> build=${other}`);
  assert.equal(bodies.length, 1);
  const sent = JSON.stringify(bodies[0]);
  assert.ok(!sent.includes(secret) && !sent.includes(other));
  const [c0, c1] = bodies[0].state.candidates;
  assert.equal(c0.key, "sig");
  assert.equal(c0.context, "sig=<VALUE> build=<OTHER>");
  assert.deepEqual(c0.shape, describeShape(secret));
  assert.equal(c1.context, "sig=<OTHER> build=<VALUE>");
  assert.match((bodies[0].questions.c0 as { instructions: string }).instructions, /session cookie, signing secret/);
  assert.match((bodies[0].questions.c0 as { instructions: string }).instructions, /content hashes, checksums/);
  assert.deepEqual(notices, ["secret-guard: đã che 1 chuỗi (jev)"]);
});

test("jev: a failure fails closed and TYPESAFE_API_KEY='' skips Jev", async () => {
  const secret = "Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0";
  process.env.TYPESAFE_API_KEY = "test-key";
  mockFetch(() => new Error("connect ECONNREFUSED"));
  let { handlers, notices, ctx } = setup();
  let result = await handlers.input({ text: `x=${secret}`, source: "interactive" }, ctx);
  assert.equal(result.text, "x=<redacted:unverified>");
  assert.match(notices[0], /Jev không trả lời \(connect ECONNREFUSED\), đã che 1 chuỗi \(unverified\)/);

  process.env.TYPESAFE_API_KEY = "";
  const bodies = mockFetch(() => ({ c0: 1 }));
  ({ handlers, notices, ctx } = setup());
  result = await handlers.input({ text: `x=${secret}`, source: "interactive" }, ctx);
  assert.equal(result, undefined);
  assert.equal(bodies.length, 0);
  process.env.TYPESAFE_API_KEY = "test-key";
});

test("tool_result hook: text is redacted, images untouched, structuredContent redacted too, no-op when clean", () => {
  const { handlers } = setup();
  const image = { type: "image", data: "sk-abcdefghijklmnopqrstuvwxyz", mimeType: "image/png" };
  const result = handlers.tool_result({
    toolName: "bash",
    content: [{ type: "text", text: `CLOUDFLARE_API_KEY=${env.CLOUDFLARE_API_KEY}` }, image, { type: "text", text: "clean" }],
    structuredContent: { raw: env.CLOUDFLARE_API_KEY },
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "CLOUDFLARE_API_KEY=<redacted:env CLOUDFLARE_API_KEY>" }, image, { type: "text", text: "clean" }],
    structuredContent: { raw: "<redacted:env CLOUDFLARE_API_KEY>" },
  });
  assert.equal(handlers.tool_result({ toolName: "read", content: [{ type: "text", text: "nothing here" }] }), undefined);
  assert.equal(handlers.tool_result({ toolName: "custom", content: "not an array" }), undefined);
});

test("before_provider_request hook: payload is redacted as valid JSON, including escaped known values", () => {
  const { handlers, ctx } = setup();
  const refresh = 'auth-refresh-with-"quote"-and-\\slash';
  const payload = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: `token sk-abcdefghijklmnopqrstuvwxyz refresh ${refresh} key ${env.CLOUDFLARE_API_KEY}` },
      { role: "user", content: [{ type: "text", text: '{"apiKey": "abcdefghijk1mnop"}' }] },
    ],
  };
  const result = handlers.before_provider_request({ payload }, ctx);
  assert.deepEqual(result.messages[1], { role: "user", content: "token <redacted:token> refresh <redacted:auth.json> key <redacted:env CLOUDFLARE_API_KEY>" });
  assert.deepEqual(result.messages[2].content, [{ type: "text", text: '{"apiKey": "<redacted:assignment>"}' }]);
  assert.equal(handlers.before_provider_request({ payload: { messages: [{ role: "user", content: "clean" }] } }, ctx), undefined);
  assert.equal(handlers.before_provider_request({ payload: undefined }, ctx), undefined);
});

test("before_provider_request hook: every pattern keeps JSON valid when applied to a stringified payload", () => {
  const samples = [
    "sk-abcdefghijklmnopqrstuvwxyz",
    "Bearer abcdefghijklmnop.qrstuvwxyz\" next",
    "redis://u:p4ssw0rd-xyz@host:6379",
    "DB_PASSWORD=\"hunter2hunter2\"",
    "-----BEGIN PRIVATE KEY-----\nabc\n\"quoted\"\n-----END PRIVATE KEY-----",
    "secret: 'abcdefghi1\\n'",
  ];
  for (const sample of samples) {
    const json = JSON.stringify({ messages: [{ content: sample }], note: 'a "quoted" \\ value' });
    const { text } = redact(json, known, true);
    assert.doesNotThrow(() => JSON.parse(text), sample);
  }
  assert.equal(SECRET_PATTERNS.length, 5);
});

test("SECRET_GUARD_LOG: one line per decision without any value; nothing without the variable", async () => {
  const log = join(agentDir, "guard.log");
  process.env.SECRET_GUARD_LOG = log;
  mockFetch(() => ({ c0: 0.9 }));
  const { handlers, ctx } = setup();
  await handlers.input({ text: "x=Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0", source: "interactive" }, ctx);
  handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: `k=${env.CLOUDFLARE_API_KEY}` }] });
  handlers.before_provider_request({ payload: { messages: [] } }, ctx);
  delete process.env.SECRET_GUARD_LOG;
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => [l.layer, l.count, l.labels]), [
    ["input", 1, ["jev"]],
    ["tool_result", 1, ["env CLOUDFLARE_API_KEY"]],
    ["provider", 0, []],
  ]);
  assert.equal(typeof lines[0].jevMs, "number");
  assert.equal(lines[0].jevCandidates, 1);
  assert.ok(!readFileSync(log, "utf8").includes("Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0"));
  assert.ok(!readFileSync(log, "utf8").includes(env.CLOUDFLARE_API_KEY));

  handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: `k=${env.CLOUDFLARE_API_KEY}` }] });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});

test("classifyWithJev: a candidate with no key still gets a context window", async () => {
  const bodies = mockFetch(() => ({ c0: 0.1 }));
  const text = "alpha ".repeat(20) + "Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0 " + "beta ".repeat(20);
  await classifyWithJev(text, jevCandidates(text));
  const [c0] = bodies[0].state.candidates;
  assert.equal(c0.key, undefined);
  assert.equal(c0.context, `${"alpha ".repeat(20).slice(-60)}<VALUE> ${"beta ".repeat(20).slice(0, 59)}`);
});

test("known values: PWD, OLDPWD and GIT_CONFIG_KEY_<n> are not credentials, so the working directory survives", () => {
  const cwd = "/Users/me/Works/project-with-a-long-name";
  const got = loadKnownSecrets({ PWD: cwd, OLDPWD: "/tmp/previous-directory", GIT_CONFIG_KEY_0: "url.git@github.com.insteadOf", MY_PASSWD: "passwd-value-1234" }, agentDir);
  assert.ok(!got.some((k: { value: string }) => k.value === cwd || k.value.startsWith("/tmp/") || k.value.startsWith("url.")));
  assert.ok(got.some((k: { label: string }) => k.label === "env MY_PASSWD"));
  assert.equal(redact(`Current working directory: ${cwd}`, got).count, 0);
});

test("patterns stay linear on adversarial input: long hyphen/dot runs, spaces after a keyword, many BEGIN markers", () => {
  const inputs: [string, string][] = [
    ["hyphen run", "a-".repeat(100_000)],
    ["dot run", "a.".repeat(100_000)],
    ["base64url-like", "Ab3-_x".repeat(40_000)],
    ["spaces after keyword", `TOKEN${" ".repeat(200_000)}x`],
    ["keyword then colon spaces", `apiKey:${" ".repeat(200_000)}`],
    ["BEGIN markers without END", "-----BEGIN PRIVATE KEY-----\n".repeat(20_000)],
  ];
  for (const [name, text] of inputs) {
    const start = performance.now();
    redact(text, []);
    assert.ok(performance.now() - start < 1000, `${name} took ${Math.round(performance.now() - start)}ms`);
  }
});

test("patterns: a long name before the keyword and a name right after a run boundary still match", () => {
  assert.equal(redact("config.service.apiKey = abcdefghijk1", []).text, "config.service.apiKey = <redacted:assignment>");
  assert.equal(redact("x-auth-token: abcdefghijk1", []).text, "x-auth-token: <redacted:assignment>");
  assert.equal(redact("AWS_SECRET_ACCESS_KEY=abcdefghijk1mnop", []).text, "AWS_SECRET_ACCESS_KEY=<redacted:assignment>");
});

test("jev: words next to a candidate that look like secrets are masked before the request leaves", async () => {
  const secret = "Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0";
  const bodies = mockFetch(() => ({ c0: 0.1 }));
  const { handlers, ctx } = setup();
  await handlers.input({ text: `mật khẩu là hunter2 còn session SUPABASE_SERVICE_ROLE=${secret} build 502 correcthorse9batterystaple`, source: "interactive" }, ctx);
  const sent = JSON.stringify(bodies[0]);
  assert.ok(!sent.includes("hunter2") && !sent.includes("correcthorse9batterystaple") && !sent.includes(secret));
  const [c0] = bodies[0].state.candidates;
  assert.equal(c0.key, "SUPABASE_SERVICE_ROLE");
  assert.equal(c0.context, "mật khẩu là <OTHER> còn session SUPABASE_SERVICE_ROLE=<VALUE> build 502 <OTHER>");
});

test("tool_result hook: structuredContent is redacted and returned, never dropped silently", () => {
  const { handlers } = setup();
  const result = handlers.tool_result({
    toolName: "mcp__x__y",
    content: [{ type: "text", text: `key ${env.CLOUDFLARE_API_KEY}` }],
    structuredContent: { raw: env.CLOUDFLARE_API_KEY, list: [1, "ok"], quote: 'a "q" \\ b' },
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "key <redacted:env CLOUDFLARE_API_KEY>" }],
    structuredContent: { raw: "<redacted:env CLOUDFLARE_API_KEY>", list: [1, "ok"], quote: 'a "q" \\ b' },
  });
  const onlyStructured = handlers.tool_result({
    toolName: "mcp__x__y",
    content: [{ type: "text", text: "clean" }],
    structuredContent: { raw: env.CLOUDFLARE_API_KEY },
  });
  assert.deepEqual(onlyStructured.structuredContent, { raw: "<redacted:env CLOUDFLARE_API_KEY>" });
});

test("jev: a candidate that appears twice is masked in the context of the other occurrence", async () => {
  const dup = "AbCdEfGhIj-KlMnOpQrSt-UvWxYzAaBb-123-CcDdEeFfGg";
  const bodies = mockFetch(() => ({ c0: 0.1 }));
  const { handlers, ctx } = setup();
  await handlers.input({ text: `x ${dup} ${dup}`, source: "interactive" }, ctx);
  assert.equal(JSON.stringify(bodies[0]).includes(dup), false);
  assert.equal(bodies[0].state.candidates[0].context, "x <VALUE> <OTHER>");
});

test("jev: candidates past the 40 sent to Jev are redacted as unverified instead of passing through", async () => {
  const values = Array.from({ length: 45 }, (_, i) => `Zq8vT3bN9xK2mL5pW7rY4s${String(i).padStart(2, "0")}Q`);
  const bodies = mockFetch(() => Object.fromEntries(values.map((_v, i) => [`c${i}`, 0.1])));
  const { handlers, ctx } = setup();
  const result = await handlers.input({ text: values.map((v, i) => `k${i}=${v}`).join(" "), source: "interactive" }, ctx);
  assert.equal(bodies[0].state.candidates.length, 40);
  assert.equal(values.some((v) => result.text.includes(v.slice(0, 22) + String(41).padStart(2, "0"))), false);
  assert.equal((result.text.match(/<redacted:unverified>/g) ?? []).length, 5);
});

test("jev errors: only the status reaches the log and the notice, never the response body", async () => {
  const log = join(agentDir, "error.log");
  process.env.SECRET_GUARD_LOG = log;
  globalThis.fetch = (async () => new Response("upstream echo: Abcdefgh12345678", { status: 500 })) as typeof fetch;
  const { handlers, notices, ctx } = setup();
  const result = await handlers.input({ text: "x=Zq8vT3bN9xK2mL5pW7rY4sD6fG1hJ0", source: "interactive" }, ctx);
  delete process.env.SECRET_GUARD_LOG;
  assert.equal(result.text, "x=<redacted:unverified>");
  assert.match(notices[0], /Jev không trả lời \(Jev returned 500\)/);
  assert.equal(readFileSync(log, "utf8").includes("Abcdefgh12345678"), false);
  assert.equal(notices[0].includes("Abcdefgh12345678"), false);
});

test("SECRET_GUARD_LOG pointing at a directory does not stop the redaction", async () => {
  const dir = join(agentDir, "log-dir");
  mkdirSync(dir);
  process.env.SECRET_GUARD_LOG = dir;
  mockFetch(() => ({}));
  const { handlers, ctx } = setup();
  const input = await handlers.input({ text: "use sk-abcdefghijklmnopqrstuvwxyz", source: "interactive" }, ctx);
  const tool = handlers.tool_result({ toolName: "bash", content: [{ type: "text", text: "sk-abcdefghijklmnopqrstuvwxyz" }] });
  const provider = handlers.before_provider_request({ payload: { m: "sk-abcdefghijklmnopqrstuvwxyz" } }, ctx);
  delete process.env.SECRET_GUARD_LOG;
  assert.equal(input.text, "use <redacted:token>");
  assert.equal(tool.content[0].text, "<redacted:token>");
  assert.deepEqual(provider, { m: "<redacted:token>" });
});

test("assignment: ENV_STYLE_NAME=letters is hidden, while code, prose and a lowercase name stay readable", () => {
  assert.equal(redact("DB_PASSWORD=correcthorse", []).text, "DB_PASSWORD=<redacted:assignment>");
  assert.equal(redact("OPENAI_API_KEY=your_api_key_here", []).text, "OPENAI_API_KEY=<redacted:assignment>");
  for (const kept of ["const API_KEY = SOME_CONSTANT;", "API_KEY=SOME_CONSTANT", 'API_KEY_HEADER = "x-api-key"', "password: correcthorse", "PASSWORD=PASSWORD"])
    assert.equal(redact(kept, []).text, kept, kept);
});

test("known values: *_HASH counts only for credential names, so COMMIT_HASH stays readable", () => {
  const got = loadKnownSecrets({ COMMIT_HASH: "3b1f2c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c", BUILD_HASH: "abcdef0123456789", TELEGRAM_API_HASH: "tg-api-hash-value-1234", PASSWORD_HASH: "pw-hash-value-123456" }, join(agentDir, "missing"));
  assert.deepEqual(got.map((k: { label: string }) => k.label).sort(), ["env PASSWORD_HASH", "env TELEGRAM_API_HASH"]);
});
