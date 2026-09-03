import assert from "node:assert/strict";
import test from "node:test";

const { extractReviewCandidate } = await import(
  `../extensions/comment-guard.ts?test=${Date.now()}`
);

test("sends new code comments to the reviewer", () => {
  for (const newText of [
    "// Return early when the user is inactive\nreturn;\n",
    "const value = 1; // Verified compatibility rationale\n",
    "value = 1  # Verified compatibility rationale\n",
  ]) {
    const candidate = extractReviewCandidate({
      toolName: "edit",
      input: {
        path: "src/handler.ts",
        edits: [{ newText }],
      },
    });
    assert.match(candidate ?? "", /(?:inactive|rationale)/);
  }
});

test("sends type suppressions and future annotations to the reviewer", () => {
  for (const newText of [
    "from __future__ import annotations\n",
    "from package import dependency  # type: ignore[import-not-found]\n",
    "// eslint-disable-next-line no-explicit-any\n",
  ]) {
    assert.ok(
      extractReviewCandidate({
        toolName: "edit",
        input: { path: "swag/example.py", edits: [{ newText }] },
      }),
    );
  }
});

test("ignores changes without comments and documentation files", () => {
  assert.equal(
    extractReviewCandidate({
      toolName: "edit",
      input: { path: "src/value.ts", edits: [{ newText: "const value = 1;\n" }] },
    }),
    undefined,
  );
  assert.equal(
    extractReviewCandidate({
      toolName: "write",
      input: { path: "README.md", content: "# Heading\n" },
    }),
    undefined,
  );
});
