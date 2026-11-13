import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIERS = ["light", "standard", "heavy"] as const;
type Tier = (typeof TIERS)[number];

type Model = { provider: string; id: string; input: string[] };
type ContentBlock = { type: string; text?: string };
type Message = { role: string; content: string | ContentBlock[] };
type RouterState = { tier: Tier; model: string };
type Request = {
  thinkingLevel: string;
  reason: "user" | "continuation" | "retry" | "direct";
  previous?: { model: Model };
  failed?: { model: Model; message: { errorMessage?: string } };
  state?: RouterState;
  messages: readonly Message[];
  signal?: AbortSignal;
};
type Route = { model: Model; thinkingLevel: string; state?: RouterState };
type ClassifierResult = {
  stopReason: string;
  answers: Record<string, { type: string; probabilities: Record<string, number> }>;
};
type Ctx = {
  hasUI?: boolean;
  ui?: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  modelRegistry: {
    find: (provider: string, id: string) => Model | undefined;
    hasConfiguredAuth: (model: Model) => boolean;
    getProviderAuthStatus: (provider: string) => { configured: boolean };
    findOfType: (type: "classifier", provider: string, id: string) => object | undefined;
    classify: (model: object, context: unknown, options?: { signal?: AbortSignal }) => Promise<ClassifierResult>;
  };
};
type TurnEnd = {
  message: { role: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string };
};
type BeforeSettle = { outcome: string };
type ExtensionAPI = {
  on: {
    (event: "turn_end", handler: (event: TurnEnd) => void): void;
    (event: "turn_start", handler: () => void): void;
    (event: "agent_before_settle", handler: (event: BeforeSettle) => unknown): void;
  };
  registerVirtualModel: (definition: {
    provider: string;
    id: string;
    name: string;
    thinkingLevels: string[];
    route: (request: Request, ctx: Ctx) => Promise<Route>;
  }) => void;
};

const configPath = () =>
  process.env.PI_AUTO_ROUTER_CONFIG ?? join(homedir(), ".pi", "agent", "auto-router.json");
const DEFAULT_TIERS: Record<Tier, string[]> = {
  light: ["claude-bridge/claude-haiku-5-5", "opencode-go/glm-5.3-flash"],
  standard: ["claude-bridge/claude-sonnet-5-5", "opencode-go/kimi-k3.1-pro"],
  heavy: ["claude-bridge/claude-opus-5-5", "opencode-go/glm-5.3"],
};
// The Anthropic-only router keeps its own tiers, so a Claude plan never falls back to a model of another subscription.
const DEFAULT_ANTHROPIC_TIERS: Record<Tier, string[]> = {
  light: ["claude-bridge/claude-haiku-5-5"],
  standard: ["claude-bridge/claude-sonnet-5-5"],
  heavy: ["claude-bridge/claude-opus-5-5"],
};
const DEFAULT_CLASSIFIERS = ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest", "opencode/jev-1.13-free"];

type Plan = { tiers: Record<Tier, string[]>; vision: string[] };
type Config = { classifiers: string[]; routers: Map<string, Plan> };
const EMPTY_TIERS: Record<Tier, string[]> = { light: [], standard: [], heavy: [] };
// Every top-level block except classifiers is a router, auto/<key>; router and anthropic exist even when the file omits them.
const DEFAULT_ROUTERS = new Map<string, Plan>([
  ["router", { tiers: DEFAULT_TIERS, vision: [] }],
  ["anthropic", { tiers: DEFAULT_ANTHROPIC_TIERS, vision: ["claude-bridge/claude-sonnet-5-5"] }],
]);

// Pi retries only transient errors; plan-exhaustion errors end the turn, so both lists are also checked at turn_end.
const QUOTA_ERROR =
  /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|quota|usage.?limit|insufficient_quota|out of budget|billing|"code"\s*:\s*"?1308(?![0-9])/i;
const OVERLOAD_ERROR = /overload|capacity|server_busy|high demand/i;
// The plan behind the provider is spent, so its other models fail the same way; Pi never retries these (Go, Free, billing).
const PLAN_EXHAUSTED =
  /usage.?limit|insufficient_quota|out of budget|billing|available balance|quota exceeded|"code"\s*:\s*"?1308(?![0-9])/i;
// Plan or region refusals do not clear on their own, so the model stays out for hours.
const REFUSED_ERROR = /not supported when using|hosted outside|model_not_found/i;
const REFUSED_BENCH_MS = 6 * 60 * 60_000;
const QUOTA_BENCH_MS = 30 * 60_000;
const OVERLOAD_BENCH_MS = 2 * 60_000;
const DOWNGRADE_MIN_PROBABILITY = 0.8;
const CONTEXT_USER_MESSAGES = 3;
const benched = new Map<string, number>();
let warnedNoClassifier = false;

export function benchFor(error: string): number {
  if (REFUSED_ERROR.test(error)) return REFUSED_BENCH_MS;
  return QUOTA_ERROR.test(error) ? QUOTA_BENCH_MS : OVERLOAD_ERROR.test(error) ? OVERLOAD_BENCH_MS : 0;
}

// A provider-wide bench is keyed by the bare provider name, which never contains "/" like a model ref does.
function bench(provider: string | undefined, model: string | undefined, error: string): boolean {
  const ms = benchFor(error);
  if (!ms) return false;
  benched.set(`${provider}/${model}`, Date.now() + ms);
  if (provider && PLAN_EXHAUSTED.test(error)) benched.set(provider, Date.now() + ms);
  return true;
}

const refOf = (model: Model) => `${model.provider}/${model.id}`;
const splitRef = (ref: string): [string, string] => {
  const [provider, ...id] = ref.split("/");
  return [provider, id.join("/")];
};

export function loadConfig(path = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = "{}";
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`auto-router: invalid ${path}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`auto-router: ${path} must be a JSON object`);
  if (parsed.tiers !== undefined || parsed.vision !== undefined)
    throw new Error(`auto-router: ${path} tiers and vision now go in a router block, e.g. "router": { "tiers": {...} }`);
  const refList = (key: string, value: unknown): string[] => {
    if (!Array.isArray(value) || !value.every((ref) => typeof ref === "string" && ref.includes("/"))) {
      throw new Error(`auto-router: ${path} ${key} must be a list of "provider/model" strings`);
    }
    return value;
  };
  const routers = new Map(DEFAULT_ROUTERS);
  for (const [id, block] of Object.entries(parsed)) {
    if (id === "classifiers" || block == null) continue;
    if (typeof block !== "object" || Array.isArray(block)) throw new Error(`auto-router: ${path} ${id} must be an object`);
    const { tiers, vision } = block as { tiers?: Partial<Record<Tier, unknown>>; vision?: unknown };
    const extra = Object.keys(block).filter((key) => key !== "tiers" && key !== "vision");
    if (extra.length)
      throw new Error(
        `auto-router: ${path} ${id} has unknown key(s) ${extra.join(", ")}; a block holds tiers and vision only`,
      );
    if (tiers != null && (typeof tiers !== "object" || Array.isArray(tiers)))
      throw new Error(`auto-router: ${path} ${id}.tiers must be an object`);
    const merged = { ...(DEFAULT_ROUTERS.get(id)?.tiers ?? EMPTY_TIERS), ...tiers } as Record<Tier, string[]>;
    for (const tier of TIERS) refList(`${id}.tiers.${tier}`, merged[tier]);
    routers.set(id, { tiers: merged, vision: refList(`${id}.vision`, vision ?? []) });
  }
  return { classifiers: refList("classifiers", parsed.classifiers ?? DEFAULT_CLASSIFIERS), routers };
}

function textOf(message: Message): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

function lastUserHasImage(messages: readonly Message[]): boolean {
  const content = messages.filter((message) => message.role === "user").at(-1)?.content;
  return Array.isArray(content) && content.some((block) => block.type === "image");
}

export async function classifyTier(request: Request, ctx: Ctx, classifiers: string[]): Promise<Tier> {
  const current = request.state?.tier;
  const fallback = current ?? "standard";
  const jev = classifiers
    .map((ref) => {
      const [provider, id] = splitRef(ref);
      return ctx.modelRegistry.getProviderAuthStatus(provider).configured
        ? ctx.modelRegistry.findOfType("classifier", provider, id)
        : undefined;
    })
    .find((model) => model);
  if (!jev) {
    if (!warnedNoClassifier && ctx.hasUI && ctx.ui) {
      warnedNoClassifier = true;
      ctx.ui.notify(
        "auto-router: no classifier has credentials in Pi (mcp-env.json is not read), so every turn keeps the current tier",
        "warning",
      );
    }
    return fallback;
  }
  const users = request.messages.filter((message) => message.role === "user").slice(-CONTEXT_USER_MESSAGES);
  if (!users.length) return fallback;
  const result = await ctx.modelRegistry.classify(
    jev,
    {
      state: {
        prompt: textOf(users.at(-1)!).slice(0, 16_000),
        earlier_prompts: users.slice(0, -1).map((message) => textOf(message).slice(0, 4_000)),
        current_tier: current ?? null,
      },
      questions: {
        tier: {
          type: "choice",
          instructions:
            "How much model capability does the software engineering work requested in `prompt` need? " +
            "`earlier_prompts` is the conversation so far: a follow-up that continues that work needs the same tier as the work itself.",
          criteria: {
            light: "Trivial edits, lookups, formatting, commit messages, simple questions, one-line summaries",
            standard: "Ordinary features, fixes, reviews, tests",
            heavy: "Subtle design, cross-cutting changes, hard debugging, security-sensitive work",
          },
        },
      },
    },
    { signal: request.signal },
  );
  const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
  if (answer?.type !== "choice") return fallback;
  const p = (tier: Tier) => answer.probabilities[tier] ?? 0;
  if (!TIERS.some((tier) => p(tier) > 0)) return fallback;
  const best = TIERS.reduce((a, b) => (p(b) > p(a) ? b : a));
  // A short follow-up in a heavy session must not pull it down to a cheap model and lose the cache.
  if (current && TIERS.indexOf(best) < TIERS.indexOf(current) && p(best) < DOWNGRADE_MIN_PROBABILITY) return current;
  return best;
}

export default function (pi: ExtensionAPI) {
  let benchedThisRun = false;
  pi.on("turn_start", () => {
    benchedThisRun = false;
  });
  pi.on("turn_end", ({ message }) => {
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    benchedThisRun = bench(message.provider, message.model, message.errorMessage ?? "");
  });
  // Pi does not retry plan-exhaustion errors, so the run would end here; resume it once the model is benched and route() picks another.
  // Each resume needs a fresh bench, so the number of resumes is bounded by the models in the config.
  pi.on("agent_before_settle", ({ outcome }) => {
    if (outcome !== "error" || !benchedThisRun) return;
    benchedThisRun = false;
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "auto-router-switch",
          display: true,
          content: "The previous model hit its usage limit and is now skipped. Answer the user's last request.",
        },
      ],
    };
  });

  const registerRouter = (id: string) =>
    pi.registerVirtualModel({
      provider: "auto",
      id,
      name: id === "router" ? "Auto router" : `Auto router (${id})`,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      async route(request, ctx): Promise<Route> {
        const config = loadConfig();
        const { tiers, vision } = config.routers.get(id) ?? { tiers: EMPTY_TIERS, vision: [] };
        const { classifiers } = config;
        // A router only reaches models of its own plan; a state or failed model of another plan is re-picked.
        const belongs = (ref: string) => vision.includes(ref) || TIERS.some((tier) => tiers[tier].includes(ref));
        const usable = (ref: string) => {
          const model = belongs(ref) ? ctx.modelRegistry.find(...splitRef(ref)) : undefined;
          return model &&
            ctx.modelRegistry.hasConfiguredAuth(model) &&
            (benched.get(ref) ?? 0) < Date.now() &&
            (benched.get(model.provider) ?? 0) < Date.now()
            ? model
            : undefined;
        };
        const pick = (tier: Tier, skip?: string): Model => {
          const near = [...TIERS].sort(
            (a, b) =>
              Math.abs(TIERS.indexOf(a) - TIERS.indexOf(tier)) - Math.abs(TIERS.indexOf(b) - TIERS.indexOf(tier)),
          );
          for (const name of near) {
            for (const ref of tiers[name]) {
              const model = ref !== skip ? usable(ref) : undefined;
              if (model) return model;
            }
          }
          throw new Error(
            `auto-router: no usable model in ${configPath()} auto/${id}; check /login, the model ids, and whether every model is benched after errors`,
          );
        };
        const pickVision = (): Model | undefined =>
          [...vision, ...tiers.heavy, ...tiers.standard, ...tiers.light]
            .map(usable)
            .find((model) => model?.input.includes("image"));
        const tierOf = (ref: string): Tier | undefined => TIERS.find((tier) => tiers[tier].includes(ref));
        const state = request.state;
        const route = (model: Model, tier: Tier): Route => {
          const ref = refOf(model);
          // Pi appends a session entry for every new state object, so reuse the current one when nothing changed.
          const next = state?.tier === tier && state.model === ref ? state : { tier, model: ref };
          return { model, thinkingLevel: request.thinkingLevel, state: next };
        };

        if (request.reason === "direct") return { model: pick("light"), thinkingLevel: request.thinkingLevel };

        if (request.reason === "retry" && request.failed) {
          const failed = refOf(request.failed.model);
          const tier = state?.tier ?? tierOf(failed) ?? "standard";
          const transient = !bench(
            request.failed.model.provider,
            request.failed.model.id,
            request.failed.message.errorMessage ?? "",
          );
          // Transient errors retry on the same model so the prompt cache and thinking signatures stay valid.
          if (transient && belongs(failed)) return route(request.failed.model, tier);
          return route(pick(tier, failed), tier);
        }

        // Tool follow-ups keep the model of the turn so the prompt cache stays valid.
        if (request.reason === "continuation" && state) {
          return route(usable(state.model) ?? pick(state.tier), state.tier);
        }

        if (lastUserHasImage(request.messages)) {
          const model = pickVision();
          if (model) return route(model, state?.tier ?? "standard");
        }
        const tier = await classifyTier(request, ctx, classifiers);
        const previous = request.previous?.model;
        const keep =
          previous && (!state || state.tier === tier) && tiers[tier].includes(refOf(previous))
            ? usable(refOf(previous))
            : undefined;
        return route(keep ?? pick(tier), tier);
      },
    });

  let ids: string[];
  // A broken file is reported on the next turn; startup must not fail on it.
  try {
    ids = [...loadConfig().routers.keys()];
  } catch {
    ids = [...DEFAULT_ROUTERS.keys()];
  }
  for (const id of ids) registerRouter(id);
}
