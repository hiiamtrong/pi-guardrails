import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const configPath = join(mkdtempSync(join(tmpdir(), "san-")), "session-auto-name.json");
const goodConfig = JSON.stringify({ endpoint: "http://endpoint.test/v1", secret: "test-secret" });
writeFileSync(configPath, goodConfig);
process.env.SESSION_AUTO_NAME_CONFIG = configPath;
const { default: ext } = await import("../extensions/session-auto-name.ts");
process.env.ORCA_TERMINAL_HANDLE = "term_x";
const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const reply = (text: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });
const historyOf = (branch: any[]) => branch.filter((e) => e.customType === "session-auto-name").map((e) => e.data.name);

function setup(opts: { name?: string; fetch?: (body: any) => any; complete?: () => any; branch?: any[]; hasUI?: boolean } = {}) {
	let name = opts.name;
	let notified = "";
	const branch: any[] = opts.branch ?? [msg("user", "Review PR 123")];
	const exec: string[][] = [];
	const prompts: string[] = [];
	let handler: any, command: any;
	const pi: any = {
		on: (_: string, h: any) => (handler = h),
		registerCommand: (_: string, c: any) => (command = c),
		getSessionName: () => name,
		setSessionName: (n: string) => (name = n),
		appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
		exec: async (_c: string, a: string[]) => exec.push(a),
	};
	globalThis.fetch = (async (_u: string, init: any) => {
		const body = JSON.parse(init.body);
		prompts.push(body.messages[1].content);
		return (opts.fetch ?? (() => reply("Review PR 123")))(body);
	}) as any;
	ext(pi);
	const ctx: any = {
		hasUI: opts.hasUI ?? true,
		model: { id: "current" },
		sessionManager: { getBranch: () => branch },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true, complete: async () => (opts.complete ? opts.complete() : { content: [{ type: "text", text: "From model" }] }) },
		ui: { notify: (m: string) => (notified = m) },
	};
	return {
		turn: async (userText?: string) => {
			if (userText) branch.push(msg("user", userText));
			handler({}, ctx);
			await sleep();
		},
		name: () => name,
		rename: (n: string) => (name = n),
		exec,
		prompts,
		branch,
		listNames: async () => (await command.handler("", ctx), notified),
	};
}

test("first turn sets the name, records it and renames the Orca tab", async () => {
	const t = setup();
	await t.turn();
	assert.equal(t.name(), "Review PR 123");
	assert.deepEqual(historyOf(t.branch), ["Review PR 123"]);
	assert.deepEqual(t.exec[0], ["terminal", "rename", "--terminal", "term_x", "--title=Review PR 123"]);
});

test("a new request that widens the work renames the session and keeps history", async () => {
	const t = setup({ fetch: (b) => reply(b.messages[1].content.includes("PR 245") ? "Review PRs 123 và 245" : "Review PR 123") });
	await t.turn();
	await t.turn("Giờ review PR 245 nhé");
	assert.equal(t.name(), "Review PRs 123 và 245");
	assert.ok(t.prompts.at(-1)!.includes("Current title: Review PR 123"));
	assert.ok(t.prompts.at(-1)!.includes("Giờ review PR 245"));
	assert.equal(t.exec.length, 2);
	assert.equal(await t.listNames(), "1. Review PR 123\n2. Review PRs 123 và 245");
});

test("KEEP leaves the name, history and tab untouched", async () => {
	const t = setup({ fetch: () => reply("KEEP") });
	await t.turn();
	assert.equal(t.name(), undefined);
	assert.deepEqual(historyOf(t.branch), []);
	assert.equal(t.exec.length, 0);
});

test("a hand-set name is never reviewed or replaced", async () => {
	const t = setup({ name: "My own name" });
	await t.turn();
	assert.equal(t.name(), "My own name");
	assert.equal(t.prompts.length, 0);
});

test("endpoint failure falls back to the in-session model", async () => {
	const t = setup({ fetch: () => ({ ok: false }) });
	await t.turn();
	assert.equal(t.name(), "From model");
});

test("endpoint and model both failing leave the session unnamed without throwing", async () => {
	const t = setup({
		fetch: () => ({ ok: false }),
		complete: () => {
			throw new Error("boom");
		},
	});
	await t.turn();
	assert.equal(t.name(), undefined);
});

test("agent_end while a review is running does not start a second call", async () => {
	let release!: () => void;
	const t = setup({ fetch: () => new Promise((r) => (release = () => r(reply("Slow name")))) });
	await t.turn();
	await t.turn();
	assert.equal(t.prompts.length, 1);
	release();
	await sleep();
	assert.equal(t.name(), "Slow name");
});

test("a session with no real user request makes no call", async () => {
	for (const branch of [[], [msg("user", "<skill name=x>"), msg("user", "[test-gaps] x"), msg("user", "   "), msg("assistant", "hi")]]) {
		const t = setup({ branch });
		await t.turn();
		assert.equal(t.prompts.length, 0);
		assert.equal(t.name(), undefined);
	}
});

test("without a UI (print mode, child agents) no call is made", async () => {
	const t = setup({ hasUI: false });
	await t.turn();
	assert.equal(t.prompts.length, 0);
});

test("an empty or whitespace-only answer leaves the session unnamed", async () => {
	for (const answer of ["", "  \n ", "**", '""']) {
		const t = setup({ fetch: () => reply(answer) });
		await t.turn();
		assert.equal(t.name(), undefined, JSON.stringify(answer));
		assert.equal(t.exec.length, 0);
	}
});

test("a response without usable choices falls back to the in-session model", async () => {
	for (const response of [{ ok: true, json: async () => ({}) }, { ok: true, json: async () => ({ choices: [] }) }, { ok: true, json: async () => { throw new SyntaxError("bad json"); } }]) {
		const t = setup({ fetch: () => response });
		await t.turn();
		assert.equal(t.name(), "From model");
	}
});

test("a malformed or incomplete config file falls back to the in-session model", async () => {
	for (const content of ["{not json", "{}", '{"endpoint":"http://endpoint.test/v1"}', "null"]) {
		writeFileSync(configPath, content);
		const t = setup();
		await t.turn();
		assert.equal(t.name(), "From model", content);
		assert.equal(t.prompts.length, 0, content);
	}
	writeFileSync(configPath, goodConfig);
});

test("a title of exactly 48 characters is kept whole", async () => {
	const t = setup({ fetch: () => reply("a".repeat(48)) });
	await t.turn();
	assert.equal(t.name(), "a".repeat(48));
});

test("a title of 49 characters is cut to 48", async () => {
	const t = setup({ fetch: () => reply("a".repeat(49)) });
	await t.turn();
	assert.equal(t.name(), "a".repeat(48));
});

test("a markdown-wrapped, multi-line answer is cleaned to its first line", async () => {
	const t = setup({ fetch: () => reply('**"Fix login bug"**\nbecause the user asked about it') });
	await t.turn();
	assert.equal(t.name(), "Fix login bug");
});

test("KEEP is recognised in any case and with trailing punctuation", async () => {
	for (const answer of ["keep", "Keep.", "KEEP!"]) {
		const t = setup({ fetch: () => reply(answer) });
		await t.turn();
		assert.equal(t.name(), undefined, answer);
	}
});

test("an answer equal to the current title adds no entry and no rename", async () => {
	const t = setup();
	await t.turn();
	await t.turn("another request");
	assert.deepEqual(historyOf(t.branch), ["Review PR 123"]);
	assert.equal(t.exec.length, 1);
});

test("a request of exactly 600 characters is sent whole, one more character is cut", async () => {
	const whole = setup({ branch: [msg("user", "a".repeat(597) + "ZZZ")] });
	await whole.turn();
	assert.ok(whole.prompts[0].includes("a".repeat(597) + "ZZZ"));
	const cut = setup({ branch: [msg("user", "a".repeat(600) + "ZZZ")] });
	await cut.turn();
	assert.ok(cut.prompts[0].includes("a".repeat(600)));
	assert.ok(!cut.prompts[0].includes("ZZZ"));
});

test("only the first and the last two requests are sent", async () => {
	const t = setup({ branch: ["first one", "second one", "third one", "fourth one"].map((x) => msg("user", x)) });
	await t.turn();
	const prompt = t.prompts[0];
	assert.ok(prompt.includes("first one") && prompt.includes("third one") && prompt.includes("fourth one"));
	assert.ok(!prompt.includes("second one"));
});

test("a single request is not repeated as a latest request", async () => {
	const t = setup();
	await t.turn();
	assert.ok(t.prompts[0].includes("(same as first)"));
});

test("a name typed by hand while the model is answering is not overwritten", async () => {
	let release!: () => void;
	const t = setup({ fetch: () => new Promise((r) => (release = () => r(reply("Auto name")))) });
	await t.turn();
	t.rename("Typed by hand");
	release();
	await sleep();
	assert.equal(t.name(), "Typed by hand");
	assert.deepEqual(historyOf(t.branch), []);
	assert.equal(t.exec.length, 0);
});

test("a title starting with -- reaches the Orca rename as a single --title= argument", async () => {
	const t = setup({ fetch: () => reply("--flag-like title") });
	await t.turn();
	assert.equal(t.name(), "--flag-like title");
	assert.deepEqual(t.exec[0], ["terminal", "rename", "--terminal", "term_x", "--title=--flag-like title"]);
});
