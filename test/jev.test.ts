import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { askNoul } = await import(`../extensions/jev.ts?test=${Date.now()}`);

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test("posts noul questions to the configured System One endpoint", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = "https://jev.test/api";
  delete process.env.TYPESAFE_MODEL;
  const calls = mockFetch(200, {
    answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.1 } },
  });

  const answers = await askNoul({ x: 1 }, { a: "Is A", b: "Is B" });

  assert.deepEqual(answers, { a: 0.9, b: 0.1 });
  assert.equal(calls[0].url, "https://jev.test/api/v1/systemone");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer test-key",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    model: "jev-latest",
    state: { x: 1 },
    questions: {
      a: { type: "noul", instructions: "Is A" },
      b: { type: "noul", instructions: "Is B" },
    },
  });
});

test("sends the pinned TYPESAFE_MODEL and falls back to jev-latest when it is blank", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const answer = { answers: { a: { type: "noul", noul: 0.5 } } };
  const model = async () => {
    const calls = mockFetch(200, answer);
    await askNoul("s", { a: "Is A" });
    return JSON.parse(calls[0].init.body as string).model;
  };

  process.env.TYPESAFE_MODEL = "typesafe/jev-1.13-20260917";
  assert.equal(await model(), "typesafe/jev-1.13-20260917");
  process.env.TYPESAFE_MODEL = "";
  assert.equal(await model(), "jev-latest");
  delete process.env.TYPESAFE_MODEL;
});

test("rejects missing, non-numeric, or out-of-range answers instead of trusting them", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  for (const a of [undefined, { noul: null }, { noul: "0.1" }, { noul: 1.5 }, { noul: -0.01 }, { noul: Number.NaN }]) {
    mockFetch(200, { answers: { a } });
    await assert.rejects(askNoul("s", { a: "Is A" }), /invalid answer for a/);
  }
  mockFetch(200, {});
  await assert.rejects(askNoul("s", { a: "Is A" }), /invalid answer for a/);
});

test("accepts the probability bounds 0 and 1", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  mockFetch(200, { answers: { a: { noul: 0 }, b: { noul: 1 } } });
  assert.deepEqual(await askNoul("s", { a: "Is A", b: "Is B" }), { a: 0, b: 1 });
});

test("reads mcp-env.json without leaking its contents when it is broken", async (t) => {
  const home = process.env.HOME;
  const key = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    process.env.HOME = home;
    process.env.TYPESAFE_API_KEY = key;
  });
  delete process.env.TYPESAFE_API_KEY;
  process.env.HOME = mkdtempSync(join(tmpdir(), "jev-home-"));
  const file = join(process.env.HOME, ".pi/agent/mcp-env.json");

  await assert.rejects(askNoul("s", { a: "Is A" }), { message: `Cannot read ${file}` });

  mkdirSync(join(process.env.HOME, ".pi/agent"), { recursive: true });
  writeFileSync(file, '{"TYPESAFE_API_KEY": "sk-secret-value",');
  await assert.rejects(askNoul("s", { a: "Is A" }), (error: Error) => {
    assert.equal(error.message, `Cannot read ${file}`);
    assert.ok(!error.message.includes("sk-secret-value"));
    return true;
  });

  writeFileSync(file, JSON.stringify({ TYPESAFE_API_KEY: "file-key", TYPESAFE_BASE_URL: "https://jev.test/file" }));
  const calls = mockFetch(200, { answers: { a: { noul: 0.5 } } });
  assert.deepEqual(await askNoul("s", { a: "Is A" }), { a: 0.5 });
  assert.equal(calls[0].url, "https://jev.test/file/v1/systemone");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer file-key");
});

test("throws on HTTP errors and on a blank API key", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  mockFetch(529, { error: "overloaded" });
  await assert.rejects(askNoul("s", { a: "Is A" }), /Jev returned 529/);

  process.env.TYPESAFE_API_KEY = "";
  await assert.rejects(askNoul("s", { a: "Is A" }), /TYPESAFE_API_KEY is not set/);
});
