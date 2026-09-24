import assert from "node:assert/strict";
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

test("rejects missing, non-numeric, or out-of-range answers instead of trusting them", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  for (const a of [undefined, { noul: null }, { noul: "0.1" }, { noul: 1.5 }, { noul: Number.NaN }]) {
    mockFetch(200, { answers: { a } });
    await assert.rejects(askNoul("s", { a: "Is A" }), /invalid answer for a/);
  }
  mockFetch(200, {});
  await assert.rejects(askNoul("s", { a: "Is A" }), /invalid answer for a/);
});

test("throws on HTTP errors and on a blank API key", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  mockFetch(529, { error: "overloaded" });
  await assert.rejects(askNoul("s", { a: "Is A" }), /Jev returned 529/);

  process.env.TYPESAFE_API_KEY = "";
  await assert.rejects(askNoul("s", { a: "Is A" }), /TYPESAFE_API_KEY is not set/);
});
