import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "auto-router-"));
process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
const { default: ext, benchFor, classifyTier, loadConfig } = await import("../extensions/auto-router.ts");

type Def = { route: (request: unknown, ctx: unknown) => Promise<{ model: { id: string }; state: any }> };
let def: Def;
const handlers: Record<string, (event: unknown) => void> = {};
ext({
  registerVirtualModel: (d: Def) => (def = d),
  on: (event: string, handler: (event: unknown) => void) => (handlers[event] = handler),
} as never);

const REFS = [
  "claude-bridge/claude-haiku-5-5",
  "opencode-go/glm-5.3-flash",
  "claude-bridge/claude-sonnet-5-5",
  "opencode-go/kimi-k3.1-pro",
  "claude-bridge/claude-opus-5-5",
  "opencode-go/glm-5.3",
];
const models: Record<string, { provider: string; id: string; input: string[] }> = Object.fromEntries(
  REFS.map((ref) => [
    ref,
    {
      provider: ref.split("/")[0],
      id: ref.slice(ref.indexOf("/") + 1),
      input: ref.endsWith("glm-5.3-flash") ? ["text"] : ["text", "image"],
    },
  ]),
);

type Made = { ctx: any; calls: any[][]; result: unknown };
function makeCtx(opts: { configured?: string[]; probabilities?: Record<string, number> } = {}): Made {
  const made: Made = {
    calls: [],
    result: { stopReason: "stop", answers: { tier: { type: "choice", probabilities: opts.probabilities ?? { standard: 1 } } } },
    ctx: undefined,
  };
  made.ctx = {
    modelRegistry: {
      find: (p: string, i: string) => models[`${p}/${i}`],
      hasConfiguredAuth: () => true,
      getProviderAuthStatus: (p: string) => ({ configured: (opts.configured ?? []).includes(p) }),
      findOfType: (_type: string, provider: string, id: string) => ({ type: "classifier", provider, id }),
      classify: async (...args: any[]) => {
        made.calls.push(args);
        return made.result;
      },
    },
  };
  return made;
}
const req = (o: Record<string, unknown>) => ({
  thinkingLevel: "medium",
  messages: [{ role: "user", content: "hi" }],
  ...o,
});
const kimi = models["opencode-go/kimi-k3.1-pro"];
const opus = models["claude-bridge/claude-opus-5-5"];

let now = 1_000_000;
mock.method(Date, "now", () => now);
afterEach(() => {
  now += 60 * 60_000;
});

test("no classifier credentials: standard tier, first candidate", async () => {
  const r = await def.route(req({ reason: "user" }), makeCtx().ctx);
  assert.equal(r.model.id, "claude-sonnet-5-5");
  assert.deepEqual(r.state, { tier: "standard", model: "claude-bridge/claude-sonnet-5-5" });
});

test("continuation keeps the model and returns the same state object", async () => {
  const state = { tier: "heavy", model: "opencode-go/glm-5.3" };
  const r = await def.route(req({ reason: "continuation", state }), makeCtx().ctx);
  assert.equal(r.model.id, "glm-5.3");
  assert.equal(r.state, state);
});

test("retry after a transient error stays on the failed model even when it is not first in its tier", async () => {
  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const r = await def.route(
    req({ reason: "retry", state, failed: { model: kimi, message: { errorMessage: "fetch failed" } } }),
    makeCtx().ctx,
  );
  assert.equal(r.model.id, "kimi-k3.1-pro");
  assert.equal(r.state, state);
});

test("retry after 429 switches model and benches it for 30 minutes", async () => {
  const { ctx } = makeCtx();
  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const r = await def.route(
    req({ reason: "retry", state, failed: { model: kimi, message: { errorMessage: "429 rate limit" } } }),
    ctx,
  );
  assert.equal(r.model.id, "claude-sonnet-5-5");
  const user = async () => (await def.route(req({ reason: "user", previous: { model: kimi } }), ctx)).model.id;
  now += 29 * 60_000;
  assert.equal(await user(), "claude-sonnet-5-5");
  now += 2 * 60_000;
  assert.equal(await user(), "kimi-k3.1-pro");
});

test("retry after overload benches the model for only 2 minutes", async () => {
  const { ctx } = makeCtx();
  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  await def.route(
    req({ reason: "retry", state, failed: { model: kimi, message: { errorMessage: "Overloaded" } } }),
    ctx,
  );
  const user = async () => (await def.route(req({ reason: "user", previous: { model: kimi } }), ctx)).model.id;
  assert.equal(await user(), "claude-sonnet-5-5");
  now += 3 * 60_000;
  assert.equal(await user(), "kimi-k3.1-pro");
});

test("retry without state takes the tier of the failed model", async () => {
  const r = await def.route(
    req({ reason: "retry", failed: { model: opus, message: { errorMessage: "Overloaded" } } }),
    makeCtx().ctx,
  );
  assert.equal(r.model.id, "glm-5.3");
  assert.equal(r.state.tier, "heavy");
});

test("a turn that ends with a quota error benches that model without a retry", async () => {
  const { ctx } = makeCtx();
  handlers.turn_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "insufficient_quota", provider: "claude-bridge", model: "claude-sonnet-5-5" },
  });
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "kimi-k3.1-pro");
  handlers.turn_end({
    message: { role: "assistant", stopReason: "stop", errorMessage: "insufficient_quota", provider: "opencode-go", model: "kimi-k3.1-pro" },
  });
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "kimi-k3.1-pro");
});

test("classifier: skips providers without credentials and sends the earlier prompts", async () => {
  const made = makeCtx({ configured: ["openrouter"], probabilities: { heavy: 0.9 } });
  const messages = [
    { role: "user", content: "design a rate limiter" },
    { role: "assistant", content: "..." },
    { role: "user", content: [{ type: "text", text: "ok, summarize" }] },
  ];
  const tier = await classifyTier(
    req({ reason: "user", messages }) as never,
    made.ctx,
    ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"],
  );
  assert.equal(tier, "heavy");
  assert.deepEqual(made.calls[0][0], { type: "classifier", provider: "openrouter", id: "~typesafe/jev-latest" });
  assert.deepEqual(made.calls[0][1].state, {
    prompt: "ok, summarize",
    earlier_prompts: ["design a rate limiter"],
    current_tier: null,
  });
});

test("classifier: weak downgrade keeps the current tier, downgrade at 0.8 and any upgrade apply", async () => {
  const call = (probabilities: Record<string, number>, tier: string) =>
    classifyTier(
      req({ reason: "user", state: { tier, model: "x/y" } }) as never,
      makeCtx({ configured: ["typesafe"], probabilities }).ctx,
      ["typesafe/jev-latest"],
    );
  assert.equal(await call({ light: 0.6, heavy: 0.4 }, "heavy"), "heavy");
  assert.equal(await call({ light: 0.8, heavy: 0.2 }, "heavy"), "light");
  assert.equal(await call({ heavy: 0.55, light: 0.45 }, "light"), "heavy");
});

test("user turn keeps the previous model when it belongs to the new tier", async () => {
  const { ctx } = makeCtx({ configured: ["typesafe"], probabilities: { standard: 1 } });
  const r = await def.route(req({ reason: "user", previous: { model: kimi } }), ctx);
  assert.equal(r.model.id, "kimi-k3.1-pro");
});

test("image turn goes to the first heavy model that accepts images, next text turn moves back", async () => {
  const { ctx } = makeCtx({ configured: ["typesafe"], probabilities: { light: 1 } });
  const image = [
    {
      role: "user",
      content: [
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "what is this" },
      ],
    },
  ];
  const r = await def.route(
    req({ reason: "user", messages: image, state: { tier: "light", model: "opencode-go/glm-5.3-flash" } }),
    ctx,
  );
  assert.equal(r.model.id, "claude-opus-5-5");
  assert.equal(r.state.tier, "light");
  const next = await def.route(req({ reason: "user", state: r.state, previous: { model: r.model } }), ctx);
  assert.equal(next.model.id, "claude-haiku-5-5");
});

test("loadConfig: missing file gives defaults, bad shapes throw", () => {
  assert.equal(loadConfig(join(dir, "none.json")).tiers.light[0], "claude-bridge/claude-haiku-5-5");
  const bad = join(dir, "bad.json");
  const cases: [string, RegExp][] = [
    [JSON.stringify({ tiers: { standard: "ab" } }), /tiers\.standard/],
    [JSON.stringify({ classifiers: ["nocolon"] }), /classifiers/],
    [JSON.stringify({ vision: "a/b" }), /vision/],
    ["null", /JSON object/],
    ["{", /invalid/],
  ];
  for (const [content, pattern] of cases) {
    writeFileSync(bad, content);
    assert.throws(() => loadConfig(bad), pattern);
  }
  const ok = join(dir, "ok.json");
  writeFileSync(ok, JSON.stringify({ tiers: { heavy: ["a/b"] }, classifiers: ["c/d"] }));
  assert.deepEqual(loadConfig(ok), {
    tiers: { ...loadConfig(join(dir, "none.json")).tiers, heavy: ["a/b"] },
    classifiers: ["c/d"],
    vision: [],
  });
});

test("no usable model: throws when no candidate has credentials, for user and direct requests", async () => {
  const ctx = { modelRegistry: { ...makeCtx().ctx.modelRegistry, hasConfiguredAuth: () => false } };
  await assert.rejects(def.route(req({ reason: "user" }), ctx), /no usable model/);
  await assert.rejects(def.route(req({ reason: "direct" }), ctx), /no usable model/);
});

test("no usable model: throws when every candidate is missing from the catalog", async () => {
  const ctx = { modelRegistry: { ...makeCtx().ctx.modelRegistry, find: () => undefined } };
  await assert.rejects(def.route(req({ reason: "user" }), ctx), /check \/login/);
});

test("a tier whose candidates are all benched falls back to the nearest tier", async () => {
  for (const [provider, model] of [
    ["claude-bridge", "claude-haiku-5-5"],
    ["opencode-go", "glm-5.3-flash"],
  ]) {
    handlers.turn_end({ message: { role: "assistant", stopReason: "error", errorMessage: "429", provider, model } });
  }
  const r = await def.route(
    req({ reason: "user" }),
    makeCtx({ configured: ["typesafe"], probabilities: { light: 1 } }).ctx,
  );
  assert.equal(r.model.id, "claude-sonnet-5-5");
  assert.equal(r.state.tier, "light");
});

test("classifier errors or empty answers fall back to the current tier, or standard when there is none", async () => {
  const failing = (state?: unknown) => {
    const made = makeCtx({ configured: ["typesafe"] });
    made.result = { stopReason: "error", errorMessage: "boom", answers: {} };
    return classifyTier(req({ reason: "user", state }) as never, made.ctx, ["typesafe/jev-latest"]);
  };
  assert.equal(await failing(), "standard");
  assert.equal(await failing({ tier: "heavy", model: "x/y" }), "heavy");
  const made = makeCtx({ configured: ["typesafe"] });
  made.result = { stopReason: "stop", answers: {} };
  assert.equal(await classifyTier(req({ reason: "user" }) as never, made.ctx, ["typesafe/jev-latest"]), "standard");
});

test("classifier: empty prompt text and a retry without `failed` do not crash", async () => {
  const made = makeCtx({ configured: ["typesafe"], probabilities: { light: 1 } });
  const empty = req({ reason: "user", messages: [{ role: "user", content: "" }] });
  assert.equal(await classifyTier(empty as never, made.ctx, ["typesafe/jev-latest"]), "light");
  assert.equal((await def.route(req({ reason: "retry" }), makeCtx().ctx)).model.id, "claude-sonnet-5-5");
});

test("turn_end ignores messages without an error message and non-assistant messages", async () => {
  handlers.turn_end({ message: { role: "assistant", stopReason: "error", provider: "claude-bridge", model: "claude-sonnet-5-5" } });
  handlers.turn_end({ message: { role: "user", content: "429" } });
  assert.equal((await def.route(req({ reason: "user" }), makeCtx().ctx)).model.id, "claude-sonnet-5-5");
});

test("loadConfig: a config path that cannot be read throws instead of silently using defaults", () => {
  assert.throws(() => loadConfig(dir));
});

test("account refusals (plan or region) bench the model for hours, quota errors only for minutes", async () => {
  const hours = (ms: number) => ms / 3_600_000;
  assert.equal(hours(benchFor("Codex error: The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.")), 6);
  assert.equal(hours(benchFor("400: This Go model is hosted outside Europe and the United States.")), 6);
  assert.equal(hours(benchFor("429 rate limit")), 0.5);
  assert.equal(benchFor("400 bad request: context too long"), 0);
  const { ctx } = makeCtx();
  handlers.turn_end({
    message: { role: "assistant", stopReason: "error", errorMessage: "model is not supported when using Codex", provider: "claude-bridge", model: "claude-sonnet-5-5" },
  });
  now += 3 * 60 * 60_000;
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "kimi-k3.1-pro");
  now += 4 * 60 * 60_000;
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "claude-sonnet-5-5");
});

test("benchFor: 429 inside a longer number is not a rate limit", () => {
  assert.equal(benchFor("400: context is 14290 tokens, limit 8192"), 0);
  assert.equal(benchFor("HTTP 429: too many requests"), 30 * 60_000);
});

test("an image as the first message does not mark the session heavy", async () => {
  const image = [{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }];
  const r = await def.route(req({ reason: "user", messages: image }), makeCtx().ctx);
  assert.equal(r.state.tier, "standard");
});

test("a tier change re-picks even when the previous model is listed in both tiers", async () => {
  const { ctx } = makeCtx({ configured: ["typesafe"], probabilities: { heavy: 1 } });
  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const config = join(dir, "shared.json");
  writeFileSync(
    config,
    JSON.stringify({
      tiers: {
        standard: ["opencode-go/kimi-k3.1-pro"],
        heavy: ["claude-bridge/claude-opus-5-5", "opencode-go/kimi-k3.1-pro"],
      },
    }),
  );
  process.env.PI_AUTO_ROUTER_CONFIG = config;
  try {
    const r = await def.route(req({ reason: "user", state, previous: { model: kimi } }), ctx);
    assert.equal(r.model.id, "claude-opus-5-5");
    const same = await def.route(
      req({ reason: "user", state: { tier: "heavy", model: state.model }, previous: { model: kimi } }),
      ctx,
    );
    assert.equal(same.model.id, "kimi-k3.1-pro");
  } finally {
    process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
  }
});

test("state object is reused only when both tier and model are unchanged", async () => {
  const state = { tier: "standard", model: "claude-bridge/claude-sonnet-5-5" };
  const same = await def.route(req({ reason: "user", state }), makeCtx().ctx);
  assert.equal(same.state, state);
  const other = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const changed = await def.route(req({ reason: "user", state: other }), makeCtx().ctx);
  assert.notEqual(changed.state, other);
  assert.equal(changed.state.model, "claude-bridge/claude-sonnet-5-5");
});

test("classifier: no user message returns the fallback instead of crashing", async () => {
  const made = makeCtx({ configured: ["typesafe"] });
  const empty = req({ reason: "continuation", messages: [] });
  assert.equal(await classifyTier(empty as never, made.ctx, ["typesafe/jev-latest"]), "standard");
  assert.equal(made.calls.length, 0);
});

test("loadConfig: a __proto__ key in tiers does not leak into other objects", () => {
  const file = join(dir, "proto.json");
  writeFileSync(file, '{"tiers":{"__proto__":{"light":["x/y"]}}}');
  assert.equal(loadConfig(file).tiers.light[0], "claude-bridge/claude-haiku-5-5");
  assert.equal(({} as Record<string, unknown>).light, undefined);
});
