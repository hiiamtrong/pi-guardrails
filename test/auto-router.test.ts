import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "auto-router-"));
process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
const { default: ext, benchFor, classifyTier, loadConfig } = await import("../extensions/auto-router.ts");

type Def = {
  id: string;
  route: (request: unknown, ctx: unknown) => Promise<{ model: { id: string; provider: string }; state: any }>;
};
let def: Def;
const defs: Record<string, Def> = {};
const handlers: Record<string, (event: unknown) => void> = {};
ext({
  registerVirtualModel: (d: Def) => {
    defs[d.id] = d;
    if (d.id === "router") def = d;
  },
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
  const defaults = loadConfig(join(dir, "none.json"));
  assert.deepEqual([...defaults.routers.keys()], ["router", "anthropic"]);
  assert.equal(defaults.routers.get("router")?.tiers.light[0], "claude-bridge/claude-haiku-5-5");
  assert.deepEqual(defaults.routers.get("anthropic")?.tiers, {
    light: ["claude-bridge/claude-haiku-5-5"],
    standard: ["claude-bridge/claude-sonnet-5-5"],
    heavy: ["claude-bridge/claude-opus-5-5"],
  });
  const bad = join(dir, "bad.json");
  const cases: [string, RegExp][] = [
    [JSON.stringify({ tiers: { standard: ["a/b"] } }), /router block/],
    [JSON.stringify({ vision: ["a/b"] }), /router block/],
    [JSON.stringify({ router: { tiers: { standard: "ab" } } }), /router\.tiers\.standard/],
    [JSON.stringify({ router: { tiers: "ab" } }), /router\.tiers must be an object/],
    [JSON.stringify({ router: { vision: "a/b" } }), /router\.vision/],
    [JSON.stringify({ router: { visoin: ["a/b"] } }), /router has unknown key\(s\) visoin/],
    [JSON.stringify({ router: { tiers: { heavy: ["a/b"] }, classifiers: ["c/d"] } }), /unknown key\(s\) classifiers/],
    [JSON.stringify({ classifiers: ["nocolon"] }), /classifiers/],
    [JSON.stringify({ anthropic: "a/b" }), /anthropic must be an object/],
    [JSON.stringify({ anthropic: { tiers: { light: "a/b" } } }), /anthropic\.tiers\.light/],
    [JSON.stringify({ anthropic: { vision: "a/b" } }), /anthropic\.vision/],
    ["null", /JSON object/],
    ["{", /invalid/],
  ];
  for (const [content, pattern] of cases) {
    writeFileSync(bad, content);
    assert.throws(() => loadConfig(bad), pattern);
  }
  const ok = join(dir, "ok.json");
  writeFileSync(ok, JSON.stringify({ router: { tiers: { heavy: ["a/b"] } }, classifiers: ["c/d"] }));
  const config = loadConfig(ok);
  assert.deepEqual(config.classifiers, ["c/d"]);
  assert.deepEqual(config.routers.get("router")?.tiers, { ...defaults.routers.get("router")?.tiers, heavy: ["a/b"] });
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
      router: {
        tiers: {
          standard: ["opencode-go/kimi-k3.1-pro"],
          heavy: ["claude-bridge/claude-opus-5-5", "opencode-go/kimi-k3.1-pro"],
        },
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
  writeFileSync(file, '{"router":{"tiers":{"__proto__":{"light":["x/y"]}}}}');
  assert.equal(loadConfig(file).routers.get("router")?.tiers.light[0], "claude-bridge/claude-haiku-5-5");
  assert.equal(({} as Record<string, unknown>).light, undefined);
});

test("null and undefined: a text block without text, a missing errorMessage and a turn_end without provider are harmless", async () => {
  const made = makeCtx({ configured: ["typesafe"], probabilities: { light: 1 } });
  const blank = req({ reason: "user", messages: [{ role: "user", content: [{ type: "text" }] }] });
  assert.equal(await classifyTier(blank as never, made.ctx, ["typesafe/jev-latest"]), "light");
  assert.equal(made.calls[0][1].state.prompt, "");

  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const retry = await def.route(req({ reason: "retry", state, failed: { model: kimi, message: {} } }), makeCtx().ctx);
  assert.equal(retry.model.id, "kimi-k3.1-pro");

  handlers.turn_end({ message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" } });
  assert.equal((await def.route(req({ reason: "user" }), makeCtx().ctx)).model.id, "claude-sonnet-5-5");
});

test("classifier: a configured provider that lacks the model, or an answer with no probabilities, falls back", async () => {
  const missing = makeCtx({ configured: ["typesafe"] });
  missing.ctx.modelRegistry.findOfType = () => undefined;
  assert.equal(await classifyTier(req({ reason: "user" }) as never, missing.ctx, ["typesafe/jev-latest"]), "standard");
  assert.equal(missing.calls.length, 0);

  const none = makeCtx({ configured: ["typesafe"], probabilities: {} });
  assert.equal(await classifyTier(req({ reason: "user" }) as never, none.ctx, ["typesafe/jev-latest"]), "standard");
  const keep = req({ reason: "user", state: { tier: "heavy", model: "x/y" } });
  assert.equal(await classifyTier(keep as never, none.ctx, ["typesafe/jev-latest"]), "heavy");
});

test("loadConfig: null values mean absent and give the defaults", () => {
  const file = join(dir, "nulls.json");
  writeFileSync(file, '{"router":{"tiers":null,"vision":null},"anthropic":null,"classifiers":null}');
  assert.deepEqual(loadConfig(file), loadConfig(join(dir, "none.json")));
});

test("no classifier: warns once per process, and only when there is a UI", async () => {
  const notes: string[] = [];
  const withUi = (hasUI: boolean) => {
    const made = makeCtx();
    return { ...made.ctx, hasUI, ui: { notify: (message: string) => notes.push(message) } };
  };
  const ask = (ctx: unknown) => classifyTier(req({ reason: "user" }) as never, ctx as never, ["typesafe/jev-latest"]);
  assert.equal(await ask(withUi(false)), "standard");
  assert.equal(notes.length, 0);
  assert.equal(await ask(withUi(true)), "standard");
  assert.equal(await ask(withUi(true)), "standard");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no classifier/);
});

const turnError = (provider: string, model: string, errorMessage: string) =>
  handlers.turn_end({ message: { role: "assistant", stopReason: "error", errorMessage, provider, model } });

test("a spent plan benches every model of its provider, a plain rate limit only the model", async () => {
  const { ctx } = makeCtx();
  turnError("claude-bridge", "claude-haiku-5-5", "429 rate limit");
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "claude-sonnet-5-5");
  now += 60 * 60_000;
  turnError("claude-bridge", "claude-haiku-5-5", '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}');
  assert.equal((await def.route(req({ reason: "user" }), ctx)).model.id, "kimi-k3.1-pro");
});

test("a retry after a spent plan skips the whole provider", async () => {
  const r = await def.route(
    req({
      reason: "retry",
      state: { tier: "standard", model: "opencode-go/kimi-k3.1-pro" },
      failed: { model: kimi, message: { errorMessage: "Go usage limit exceeded" } },
    }),
    makeCtx().ctx,
  );
  assert.equal(r.model.id, "claude-sonnet-5-5");
  const next = await def.route(req({ reason: "user" }), makeCtx().ctx);
  assert.notEqual(next.model.provider, "opencode-go");
});

test("a run that ends on a plan-exhaustion error resumes once on another model", () => {
  const settle = handlers.agent_before_settle as (event: unknown) => { continue: boolean } | undefined;
  turnError("opencode-go", "kimi-k3.1-pro", "429: Go usage limit exceeded");
  assert.equal(settle({ outcome: "error" })?.continue, true);
  assert.equal(settle({ outcome: "error" }), undefined);
  turnError("opencode-go", "kimi-k3.1-pro", "429: Go usage limit exceeded");
  assert.equal(settle({ outcome: "completed" }), undefined);
  turnError("opencode-go", "kimi-k3.1-pro", "400 bad request");
  assert.equal(settle({ outcome: "error" }), undefined);
  turnError("opencode-go", "kimi-k3.1-pro", "Go usage limit exceeded");
  (handlers.turn_start as () => void)();
  assert.equal(settle({ outcome: "error" }), undefined);
});

test("a vision entry outside every tier still takes the image turn", async () => {
  const config = join(dir, "vision-only.json");
  writeFileSync(config, JSON.stringify({ router: { vision: ["opencode-go/kimi-k3.1-pro"] } }));
  process.env.PI_AUTO_ROUTER_CONFIG = config;
  try {
    const image = [{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }];
    const r = await def.route(req({ reason: "user", messages: image }), makeCtx().ctx);
    assert.equal(r.model.id, "kimi-k3.1-pro");
  } finally {
    process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
  }
});

test("every top-level block registers its own auto/<key> router, and an empty one names itself", async () => {
  const config = join(dir, "custom-routers.json");
  writeFileSync(config, JSON.stringify({ openai: { tiers: { heavy: ["openai-codex/gpt-6.1-sol"] } } }));
  process.env.PI_AUTO_ROUTER_CONFIG = config;
  try {
    const registered: string[] = [];
    let openai: Def | undefined;
    ext({
      registerVirtualModel: (d: Def) => {
        registered.push(d.id);
        if (d.id === "openai") openai = d;
      },
      on: () => {},
    } as never);
    assert.deepEqual(registered, ["router", "anthropic", "openai"]);
    assert.deepEqual(loadConfig(config).routers.get("openai")?.tiers.light, []);
    await assert.rejects(openai!.route(req({ reason: "user" }), makeCtx().ctx), /no usable model in .*auto\/openai/);
  } finally {
    process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
  }
});

test("a broken config file does not stop startup: router and anthropic register, the turn reports the error", async () => {
  const config = join(dir, "broken.json");
  writeFileSync(config, "{");
  process.env.PI_AUTO_ROUTER_CONFIG = config;
  try {
    const registered: Def[] = [];
    ext({ registerVirtualModel: (d: Def) => registered.push(d), on: () => {} } as never);
    assert.deepEqual(registered.map((d) => d.id), ["router", "anthropic"]);
    await assert.rejects(registered[0].route(req({ reason: "user" }), makeCtx().ctx), /invalid/);
  } finally {
    process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
  }
});

const anthropic = () => defs.anthropic;
const routeAnth = (o: Record<string, unknown>, made = makeCtx()) => anthropic().route(req(o), made.ctx);

test("anthropic router: each tier picks a Claude model", async () => {
  const cases: [string, string][] = [
    ["light", "claude-haiku-5-5"],
    ["standard", "claude-sonnet-5-5"],
    ["heavy", "claude-opus-5-5"],
  ];
  for (const [tier, id] of cases) {
    const made = makeCtx({ configured: ["typesafe"], probabilities: { [tier]: 1 } });
    const r = await routeAnth({ reason: "user" }, made);
    assert.equal(r.model.id, id);
    assert.equal(r.model.provider, "claude-bridge");
  }
});

test("anthropic router: a continuation on a model of another plan is re-picked inside its own tiers", async () => {
  const state = { tier: "standard", model: "opencode-go/kimi-k3.1-pro" };
  const r = await routeAnth({ reason: "continuation", state });
  assert.equal(r.model.id, "claude-sonnet-5-5");
  assert.notEqual(r.state, state);
});

test("anthropic router: a transient retry never sticks to a model of another plan", async () => {
  const r = await routeAnth({
    reason: "retry",
    state: { tier: "standard", model: "opencode-go/kimi-k3.1-pro" },
    failed: { model: kimi, message: { errorMessage: "fetch failed" } },
  });
  assert.equal(r.model.provider, "claude-bridge");
});

test("anthropic router: an image turn stays on Claude, and the default vision list keeps it off opus", async () => {
  const image = [{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }];
  const r = await routeAnth({ reason: "user", messages: image });
  assert.equal(r.model.provider, "claude-bridge");
  assert.equal(r.model.id, "claude-sonnet-5-5");
});

test("anthropic router: its own tier lists override the shared ones", async () => {
  const config = join(dir, "anthropic-tiers.json");
  writeFileSync(
    config,
    JSON.stringify({ router: { tiers: { heavy: ["opencode-go/glm-5.3"] } }, anthropic: { tiers: { heavy: ["claude-bridge/claude-sonnet-5-5"] } } }),
  );
  process.env.PI_AUTO_ROUTER_CONFIG = config;
  try {
    const made = makeCtx({ configured: ["typesafe"], probabilities: { heavy: 1 } });
    assert.equal((await routeAnth({ reason: "user" }, made)).model.id, "claude-sonnet-5-5");
  } finally {
    process.env.PI_AUTO_ROUTER_CONFIG = join(dir, "none.json");
  }
});

test("anthropic router: throws, naming itself, when the Claude provider has no credentials", async () => {
  const ctx = { modelRegistry: { ...makeCtx().ctx.modelRegistry, hasConfiguredAuth: () => false } };
  await assert.rejects(anthropic().route(req({ reason: "user" }), ctx), /no usable model in .*auto\/anthropic/);
});
