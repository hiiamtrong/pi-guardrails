import assert from "node:assert/strict";
import test from "node:test";
import ext from "../extensions/compact-continue.ts";

function load() {
	const h: Record<string, (e: any) => any> = {};
	ext({ on: (n: string, f: (e: any) => any) => (h[n] = f) } as any);
	return h;
}

type Harness = ReturnType<typeof load>;
const compactThenSettle = (h: Harness, pendingMessages: unknown[] = []) => {
	h.session_compact({ reason: "threshold", willRetry: false });
	return h.agent_before_settle({ outcome: "completed", context: { pendingMessages } });
};

const cases: [string, (h: Harness) => void][] = [
	["resumes once after threshold compaction at run end", (h) => {
		const r = compactThenSettle(h);
		assert.equal(r.continue, true);
		assert.equal(r.entries[0].type, "custom_message");
		assert.equal(h.agent_before_settle({ outcome: "completed", context: { pendingMessages: [] } }), undefined);
	}],
	["a second compaction without new input does not resume again", (h) => {
		assert.equal(compactThenSettle(h).continue, true);
		assert.equal(compactThenSettle(h), undefined);
	}],
	["new user input allows another resume", (h) => {
		compactThenSettle(h);
		h.input({ source: "interactive" });
		assert.equal(compactThenSettle(h).continue, true);
	}],
	["a prompt sent by an extension does not re-arm the guard", (h) => {
		compactThenSettle(h);
		h.input({ source: "extension" });
		assert.equal(compactThenSettle(h), undefined);
	}],
	["no resume when messages are already queued", (h) => {
		assert.equal(compactThenSettle(h, [{ role: "user" }]), undefined);
	}],
	["no resume when a turn started after the compaction", (h) => {
		h.session_compact({ reason: "threshold", willRetry: false });
		h.turn_start({});
		assert.equal(h.agent_before_settle({ outcome: "completed", context: { pendingMessages: [] } }), undefined);
	}],
	["no resume when the run was aborted", (h) => {
		h.session_compact({ reason: "threshold", willRetry: false });
		assert.equal(h.agent_before_settle({ outcome: "aborted", context: { pendingMessages: [] } }), undefined);
	}],
	["no resume after manual /compact", (h) => {
		h.session_compact({ reason: "manual", willRetry: false });
		assert.equal(h.agent_before_settle({ outcome: "completed", context: { pendingMessages: [] } }), undefined);
	}],
	["no resume when overflow recovery already retries", (h) => {
		h.session_compact({ reason: "overflow", willRetry: true });
		assert.equal(h.agent_before_settle({ outcome: "completed", context: { pendingMessages: [] } }), undefined);
	}],
	["no resume without any compaction", (h) => {
		assert.equal(h.agent_before_settle({ outcome: "completed", context: { pendingMessages: [] } }), undefined);
	}],
];

for (const [name, run] of cases) test(name, () => run(load()));
