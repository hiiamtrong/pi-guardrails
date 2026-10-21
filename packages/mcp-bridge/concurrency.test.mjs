import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrency.ts";

test("mapWithConcurrency never exceeds its concurrency limit and preserves order", async () => {
  let active = 0;
  let peak = 0;

  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});
