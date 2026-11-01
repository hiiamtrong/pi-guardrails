import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { extractReviewCandidate, reviewerVerdict } = await import(`../extensions/comment-guard.ts?edit=${Date.now()}`);
const { default: ponytail } = await import(`../extensions/ponytail-review-on-settle.ts?edit=${Date.now()}`);

const dir = mkdtempSync(join(tmpdir(), "edit-handling-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const edit = (path: string, oldText: string, newText: string, cwd?: string) =>
  extractReviewCandidate({ toolName: "edit", input: { path, edits: [{ oldText, newText }] } }, cwd);

test("an edit next to a comment that did not change sends nothing for review", () => {
    const why = "// Safari drops Authorization on cross-origin redirects";
    assert.equal(edit("a.ts", `${why}\nif (r) h.set('A', t);`, `${why}\nif (r && t) h.set('A', t);`), undefined);
    assert.equal(edit("a.py", "x = 1  # header + 2 children", "x = 2  # header + 2 children"), undefined);
    assert.equal(edit("a.ts", "/* one\n * two */\nrun();", "/* one\n * two */\nrun(1);"), undefined);
});

test("a new or rewritten comment is still sent for review", () => {
    const why = "// Safari drops Authorization on cross-origin redirects";
    assert.match(edit("a.ts", `${why}\nrun();`, `// set the header\nrun();`) ?? "", /set the header/);
    assert.match(edit("a.ts", "run();", `${why}\nrun();`) ?? "", /Safari/);
    assert.match(edit("a.py", "x = 1  # old reason", "x = 1  # new reason") ?? "", /new reason/);
});

test("a suppression on a new line is reviewed even when an old line has the same text", () => {
    const candidate = edit("a.py", "a = f()  # type: ignore\nb = 1", "a = f()  # type: ignore\nb = g()  # type: ignore");
    assert.match(candidate ?? "", /b = g\(\)/);
    assert.equal(edit("a.py", "a = f()  # type: ignore", "a = f()  # type: ignore"), undefined);
});

test("a write that keeps the comments already on disk sends only the new ones", () => {
    writeFileSync(join(dir, "kept.ts"), "// keep this reason, it is long enough to matter\nconst a = 1;\n");
    const write = (content: string) => extractReviewCandidate({ toolName: "write", input: { path: "kept.ts", content } }, dir);
    assert.equal(write("// keep this reason, it is long enough to matter\nconst a = 2;\n"), undefined);
    assert.match(write("// keep this reason, it is long enough to matter\nconst a = 2;\n// brand new note\n") ?? "", /brand new note/);
    assert.match(extractReviewCandidate({ toolName: "write", input: { path: "missing.ts", content: "// fresh\nconst a = 1;\n" } }, dir) ?? "", /fresh/);
});

test("edits sent as a JSON string are reviewed like an array", () => {
    const edits = JSON.stringify([{ oldText: "run();", newText: "// set the flag\nrun();" }]);
    assert.match(extractReviewCandidate({ toolName: "edit", input: { path: "a.ts", edits } }) ?? "", /set the flag/);
    assert.equal(extractReviewCandidate({ toolName: "edit", input: { path: "a.ts", edits: "not json" } }), undefined);
});

test("takes the verdict from the first line that holds one", () => {
    assert.equal(reviewerVerdict("APPROVE\nreason"), "APPROVE");
    assert.equal(reviewerVerdict("reject: why"), "REJECT");
    assert.equal(reviewerVerdict("Verified: the TTL is 1 day.\n\nAPPROVE\nWHY is not obvious."), "APPROVE");
    assert.equal(reviewerVerdict("I checked the path.\n**REJECT**\nIt restates the code."), "REJECT");
    assert.equal(reviewerVerdict("Looked at it.\nAPPROVE/REJECT:\n\nREJECT\nfabricated path"), "REJECT");
    assert.equal(reviewerVerdict("APPROVED by nobody"), undefined);
    assert.equal(reviewerVerdict("Approve only when it documents a why."), undefined);
    assert.equal(reviewerVerdict(""), undefined);
    assert.equal(reviewerVerdict("Rules:\n- APPROVE only when it documents a why\n- REJECT otherwise\n\nREJECT\nrestates the code"), "REJECT");
    assert.equal(reviewerVerdict("APPROVE only if it is a WHY.\nREJECT\nrestates"), "REJECT");
    assert.equal(reviewerVerdict("Rules:\n- APPROVE only when it documents a why\n\nNo clear answer."), undefined);
    assert.equal(reviewerVerdict("Verdict: APPROVE\nbecause the TTL is real"), "APPROVE");
    assert.equal(reviewerVerdict("Checked the file.\n**Verdict:** REJECT\nrestates the code"), "REJECT");
    assert.equal(reviewerVerdict("Checked.\nverdict - APPROVE."), "APPROVE");
    assert.equal(reviewerVerdict("Checked.\nVerdict: APPROVE only when it documents a why"), undefined);
});

test("a failure while reading the change blocks the write instead of skipping the review", async () => {
    let handler: ((event: unknown, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>) | undefined;
    const { default: commentGuard } = await import(`../extensions/comment-guard.ts?fail=${Date.now()}`);
    commentGuard({ on: (_name: string, callback: typeof handler) => (handler = callback) });
    assert.ok(handler);
    const input = { path: "a.ts", get content(): string { throw new Error("unreadable input"); } };
    const result = await handler({ toolName: "write", input }, { cwd: dir, hasUI: false });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /refusing to add unreviewed comments: unreadable input/);
    assert.equal(await handler({ toolName: "read", input: { path: "a.ts" } }, { cwd: dir }), undefined);
});

test("ponytail tracks an edit whose edits arrive as a JSON string", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
    globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { trivial: { type: "noul", noul: 0.1 } } }))) as typeof fetch;
    const sent: string[] = [];
    const handlers: Record<string, (event?: unknown) => unknown> = {};
    ponytail({
        on: (name: string, handler: (event?: unknown) => unknown) => (handlers[name] = handler),
        sendUserMessage: (text: string) => sent.push(text),
    });
    handlers.tool_call({ toolName: "edit", input: { path: "src/a.ts", edits: JSON.stringify([{ oldText: "if (a) go();", newText: "if (a || b) go();" }]) } });
    await handlers.agent_settled({ aborted: false });
    assert.deepEqual(sent, ["/skill:ponytail-review"]);
});

function ponytailWith(trivial: number) {
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
    const run = { fetches: 0, sent: [] as string[] };
    globalThis.fetch = (async () => {
        run.fetches += 1;
        return new Response(JSON.stringify({ answers: { trivial: { type: "noul", noul: trivial } } }));
    }) as typeof fetch;
    const handlers: Record<string, (event?: unknown) => unknown> = {};
    ponytail({
        on: (name: string, handler: (event?: unknown) => unknown) => (handlers[name] = handler),
        sendUserMessage: (text: string) => run.sent.push(text),
    });
    return { run, handlers };
}

test("null, empty and odd edit entries are ignored instead of throwing", async () => {
    for (const input of [
        undefined,
        {},
        { path: "a.ts" },
        { path: 5, content: "// x" },
        { path: "a.ts", edits: [null] },
        { path: "a.ts", edits: [1, "x", []] },
        { path: "a.ts", edits: [{}] },
        { path: "a.ts", edits: [{ newText: 5 }] },
    ])
        assert.equal(extractReviewCandidate({ toolName: "edit", input } as never), undefined, JSON.stringify(input));
    const kept = [null, { oldText: "run();", newText: "// set the flag\nrun();" }];
    assert.match(extractReviewCandidate({ toolName: "edit", input: { path: "a.ts", edits: kept } }) ?? "", /set the flag/);

    const { run, handlers } = ponytailWith(0.1);
    handlers.tool_call({ toolName: "edit", input: { path: "src/a.ts", edits: [null, { oldText: "if (a) go();", newText: "if (a || b) go();" }] } });
    await handlers.agent_settled({ aborted: false });
    assert.deepEqual(run.sent, ["/skill:ponytail-review"]);
});

test("a file of exactly 1,000,000 bytes is compared, one byte more is not", () => {
    const note = "// kept note\n";
    writeFileSync(join(dir, "exact.ts"), note + "x".repeat(1_000_000 - note.length));
    writeFileSync(join(dir, "over.ts"), note + "x".repeat(1_000_001 - note.length));
    const write = (path: string) => extractReviewCandidate({ toolName: "write", input: { path, content: `${note}const a = 1;` } }, dir);
    assert.equal(write("exact.ts"), undefined);
    assert.match(write("over.ts") ?? "", /kept note/);
});

test("a path that cannot be read as a file counts as having no comments yet", () => {
    mkdirSync(join(dir, "isdir.ts"));
    const candidate = extractReviewCandidate({ toolName: "write", input: { path: "isdir.ts", content: "// fresh\nconst a = 1;" } }, dir);
    assert.match(candidate ?? "", /fresh/);
});

test("ponytail asks Jev for edits of exactly 60,000 characters and skips Jev for one more", async () => {
    const { MAX_STATE_CHARS } = await import("../extensions/jev.ts");
    const overhead = JSON.stringify([{ path: "p.ts", before: "b", after: "" }]).length;
    for (const [extra, fetches, reviews] of [[0, 1, 0], [1, 0, 1]]) {
        const { run, handlers } = ponytailWith(0.95);
        const after = "x".repeat(MAX_STATE_CHARS - overhead + extra);
        handlers.tool_call({ toolName: "edit", input: { path: "p.ts", edits: [{ oldText: "b", newText: after }] } });
        await handlers.agent_settled({ aborted: false });
        assert.deepEqual([run.fetches, run.sent.length], [fetches, reviews], `extra ${extra}`);
    }
});
