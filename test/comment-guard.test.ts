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
  for (const newText of [
    "const value = 1;\n",
    `export const MAX_INDEX_BYTES = 25 ${String.fromCharCode(42)} 1024;\n`,
  ]) {
    assert.equal(
      extractReviewCandidate({
        toolName: "edit",
        input: { path: "src/value.ts", edits: [{ newText }] },
      }),
      undefined,
    );
  }
  assert.equal(
    extractReviewCandidate({
      toolName: "write",
      input: {
        path: "script.sh",
        content: `${String.fromCharCode(42)}'/files?'${String.fromCharCode(42)}) echo ok ;;\n`,
      },
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

test("sends only nearby context from large files", () => {
  const candidate = extractReviewCandidate({
    toolName: "write",
    input: {
      path: "src/large.ts",
      content: `${"const value = 1;\n".repeat(5_000)}// Verified compatibility rationale\nreturn value;\n`,
    },
  });
  assert.match(candidate ?? "", /compatibility rationale/);
  assert.ok((candidate?.length ?? 0) < 1_000);
});
