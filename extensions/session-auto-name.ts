import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SessionEntry = { type: string; customType?: string; data?: unknown; message?: { role: string; content?: unknown } };
type Model = { id: string };
type ExtensionContext = {
  hasUI: boolean;
  model?: Model;
  sessionManager: { getBranch: () => SessionEntry[] };
  modelRegistry: {
    find: (provider: string, id: string) => Model | undefined;
    hasConfiguredAuth: (model: Model) => boolean;
    complete: (model: Model, context: unknown, options?: unknown) => Promise<{ content?: unknown }>;
  };
  ui: { notify: (message: string, level: "info") => void };
};
type ExtensionAPI = {
  on: (event: "agent_end", handler: (event: unknown, ctx: ExtensionContext) => void) => void;
  registerCommand: (
    name: string,
    command: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
  ) => void;
  appendEntry: (customType: string, data: unknown) => void;
  getSessionName: () => string | undefined;
  setSessionName: (name: string) => void;
  exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<unknown>;
};

// Why: Orca shows the pi session name (via the titlebar extension) and ranks its own first-prompt title
// above it, so the name is pushed to the tab too. Re-checked every turn so the title follows the work.
// Only names this extension set are touched; /session-name or /name wins for good.
const ENTRY = "session-auto-name";
const CONFIG = process.env.SESSION_AUTO_NAME_CONFIG ?? join(homedir(), ".pi", "agent", "session-auto-name.json");
const FAST_MODEL = ["claude-bridge", "claude-haiku-5-5"] as const;
const MAX_NAME_LENGTH = 48;
const SYSTEM_PROMPT = `You keep the title of a coding-agent session accurate.
You get the current title (or "none"), earlier titles, the user's first request and the latest requests.
If the current title still describes the session's work, output exactly KEEP.
Otherwise output a new title (max ${MAX_NAME_LENGTH} characters) naming the overall task. If the work widened (for example another PR), cover both. Do not reuse an earlier title unless it truly fits.
Use the language of the user's requests. Output only KEEP or the title: no quotes, no explanation.`;

function textOf(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" ? part.text : "")).join(" ");
}

function historyOf(entries: SessionEntry[]): string[] {
	return entries.flatMap((e) => (e.type === "custom" && e.customType === ENTRY ? [String((e.data as { name?: string })?.name)] : []));
}

async function askEndpoint(prompt: string): Promise<string | undefined> {
	try {
		const { endpoint, secret } = JSON.parse(readFileSync(CONFIG, "utf8"));
		if (!endpoint || !secret) return undefined;
		const res = await fetch(`${endpoint}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: "haiku", max_tokens: 80, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }] }),
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return undefined;
		return (await res.json()).choices?.[0]?.message?.content;
	} catch {
		return undefined;
	}
}

async function askModel(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
	const model = [ctx.modelRegistry.find(...FAST_MODEL), ctx.model].find((m) => m && ctx.modelRegistry.hasConfiguredAuth(m));
	if (!model) return undefined;
	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ cacheRetention: "none" },
	);
	return textOf(response);
}

export default function (pi: ExtensionAPI) {
	let inFlight = false;

	async function review(ctx: ExtensionContext, prompt: string, current: string | undefined) {
		try {
			const answer = (await askEndpoint(prompt)) ?? (await askModel(ctx, prompt));
			const name = (answer ?? "")
				.split("\n")[0]
				.replace(/^["'`#*\s]+|["'`*\s]+$/g, "")
				.slice(0, MAX_NAME_LENGTH);
			if (!name || /^keep\W*$/i.test(name) || name === current) return;
			pi.appendEntry(ENTRY, { name });
			pi.setSessionName(name);
			// Why: Orca ranks its own first-prompt generatedTitle above the terminal title, so only a tab customTitle wins.
			const handle = process.env.ORCA_TERMINAL_HANDLE;
			if (handle) await pi.exec("orca", ["terminal", "rename", "--terminal", handle, "--title", name], { timeout: 5000 });
		} catch {
			// Why: naming is cosmetic; a failed call must not surface as a session error.
		}
	}

	// Why: not awaited, a multi-second model call here would delay Orca's "done" status every turn.
	pi.on("agent_end", (_event, ctx) => {
		if (inFlight || !ctx.hasUI) return;
		const entries = ctx.sessionManager.getBranch();
		const names = historyOf(entries);
		const current = pi.getSessionName();
		if (current && current !== names.at(-1)) return; // named by hand
		// Why: read the whole branch, not event.messages, which only holds this run after a resume.
		const requests = entries
			.flatMap((e) => (e.type === "message" && e.message?.role === "user" ? [textOf(e.message).trim()] : []))
			.filter((t) => t && !t.startsWith("<skill") && !t.startsWith("["));
		if (requests.length === 0) return;
		const latest = [...new Set(requests.slice(-2))].filter((t) => t !== requests[0]);
		const prompt = [
			`Current title: ${current ?? "none"}`,
			`Earlier titles: ${names.length ? names.join(" | ") : "none"}`,
			`First request:\n${requests[0].slice(0, 600)}`,
			`Latest requests:\n${latest.map((t) => t.slice(0, 600)).join("\n---\n") || "(same as first)"}`,
		].join("\n\n");
		inFlight = true;
		void review(ctx, prompt, current).finally(() => (inFlight = false));
	});

	pi.registerCommand("session-names", {
		description: "List the names this session has had",
		handler: async (_args, ctx) => {
			const names = historyOf(ctx.sessionManager.getBranch());
			ctx.ui.notify(names.length ? names.map((n, i) => `${i + 1}. ${n}`).join("\n") : "No automatic names yet", "info");
		},
	});
}
