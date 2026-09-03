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
        path: newText.startsWith("value =") ? "example.py" : "src/handler.ts",
        edits: [{ newText }],
      },
    });
    assert.match(candidate ?? "", /(?:inactive|rationale)/);
  }
});

test("sends SQL comments to the reviewer", () => {
  const candidate = extractReviewCandidate({
    toolName: "edit",
    input: {
      path: "query.sql",
      edits: [{ newText: "SELECT 1; -- Verified compatibility rationale\n" }],
    },
  });
  assert.match(candidate ?? "", /compatibility rationale/);
});

test("detects comments after regular expressions containing quotes", () => {
  const slash = String.fromCharCode(47);
  for (const expression of [
    "/'/",
    `/['"]/`,
    "() => /'/",
    "typeof /'/",
    "if (ok) /'/",
    "for await (const value of values) /'/",
  ]) {
    const candidate = extractReviewCandidate({
      toolName: "edit",
      input: {
        path: "src/handler.ts",
        edits: [
          {
            newText: `const re = ${expression}; ${slash}${slash} it's required\n`,
          },
        ],
      },
    });
    assert.match(candidate ?? "", /required/);
  }
});

test("detects comments after C++ raw strings", () => {
  const slash = String.fromCharCode(47);
  const candidate = extractReviewCandidate({
    toolName: "edit",
    input: {
      path: "sample.cpp",
      edits: [
        {
          newText: `auto text = R"(foo")"; ${slash}${slash} it's required\n`,
        },
      ],
    },
  });
  assert.match(candidate ?? "", /required/);
});

test("detects comments after Rust raw strings", () => {
  const slash = String.fromCharCode(47);
  const candidate = extractReviewCandidate({
    toolName: "edit",
    input: {
      path: "sample.rs",
      edits: [
        {
          newText: `let text = r${String.fromCharCode(35)}"foo""${String.fromCharCode(35)}; ${slash}${slash} it's required\n`,
        },
      ],
    },
  });
  assert.match(candidate ?? "", /required/);
});

test("line comments terminate quote scanning", () => {
  const hash = String.fromCharCode(35);
  for (const [path, content, expected] of [
    ["example.py", `value=1${hash} don't\n${hash} KEEP_PY`, "KEEP_PY"],
    ["query.sql", "SELECT 1; -- don't\n-- KEEP_SQL", "KEEP_SQL"],
    ["script.sh", `echo ok;${hash} KEEP_SHELL`, "KEEP_SHELL"],
  ]) {
    const candidate = extractReviewCandidate({
      toolName: "write",
      input: { path, content },
    });
    assert.match(candidate ?? "", new RegExp(expected));
  }
});

test("detects comments inside template interpolations", () => {
  const slash = String.fromCharCode(47);
  const candidate = extractReviewCandidate({
    toolName: "write",
    input: {
      path: "src/template.ts",
      content: [
        "const value = `${input",
        `${slash}${slash} rationale`,
        "}`;",
      ].join("\n"),
    },
  });
  assert.match(candidate ?? "", /rationale/);
});

test("sends complete multiline block comments to the reviewer", () => {
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const candidate = extractReviewCandidate({
    toolName: "edit",
    input: {
      path: "src/handler.ts",
      edits: [
        {
          newText: `${slash}${star}${star}\n ${star} rationale\n ${star}${slash}\n`,
        },
      ],
    },
  });
  assert.match(candidate ?? "", /rationale/);

  const chained = extractReviewCandidate({
    toolName: "edit",
    input: {
      path: "src/handler.ts",
      edits: [
        {
          newText: `${slash}${star} done ${star}${slash} ${slash}${star}\n ${star} KEEP_SECOND_BLOCK\n ${star}${slash}\n`,
        },
      ],
    },
  });
  assert.match(chained ?? "", /KEEP_SECOND_BLOCK/);

  for (const path of ["sample.rs", "sample.swift"]) {
    const nested = extractReviewCandidate({
      toolName: "edit",
      input: {
        path,
        edits: [
          {
            newText: `${slash}${star} outer\n ${slash}${star} inner ${star}${slash}\n KEEP_NESTED_BLOCK\n ${star}${slash}\n`,
          },
        ],
      },
    });
    assert.match(nested ?? "", /KEEP_NESTED_BLOCK/);
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
  const hash = String.fromCharCode(35);
  const slash = String.fromCharCode(47);
  for (const [path, newText] of [
    ["src/value.ts", "const value = 1;\n"],
    [
      "src/value.ts",
      `export const MAX_INDEX_BYTES = 25 ${String.fromCharCode(42)} 1024;\n`,
    ],
    ["src/value.ts", `const heading = "value ${hash} heading";\n`],
    ["src/value.ts", `const text = "value ${slash}${slash} text";\n`],
    [
      "src/value.ts",
      `const area =\n  width\n  ${String.fromCharCode(42)} height;\n`,
    ],
    ["example.py", `value = 8 ${slash}${slash} 2\n`],
    ["sample.c", `${hash}include <stdio.h>\n`],
    ["sample.cpp", `auto text = R"(value ${slash}${slash} text)";\n`],
    [
      "sample.rs",
      `let text = r${hash}"value ${slash}${slash} text"${hash};\n`,
    ],
    ["script.sh", `printf '%s' 'value ${hash} text'\n`],
    ["query.sql", "SELECT '--not a comment';\n"],
    [
      "src/value.ts",
      ["const text = `", `value ${slash}${slash} text`, "`;"].join("\n"),
    ],
    [
      "example.py",
      [`text = ${'"'.repeat(3)}`, `${hash} text`, '"'.repeat(3)].join("\n"),
    ],
    ["script.sh", ["printf '%s' '", `${hash} text`, "'"].join("\n")],
  ]) {
    assert.equal(
      extractReviewCandidate({
        toolName: "edit",
        input: { path, edits: [{ newText }] },
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

test("preserves comments after oversized context lines", () => {
  const marker = String.fromCharCode(47).repeat(2);
  const candidate = extractReviewCandidate({
    toolName: "write",
    input: {
      path: "src/large.ts",
      content: `${"x".repeat(20_000)}\n${marker} KEEP_FIRST\n${"y".repeat(20_000)}\n${marker} KEEP_SECOND\n`,
    },
  });
  assert.match(candidate ?? "", /KEEP_FIRST/);
  assert.match(candidate ?? "", /KEEP_SECOND/);
  assert.ok((candidate?.length ?? 0) < 6_000);

  const sameLine = extractReviewCandidate({
    toolName: "write",
    input: {
      path: "src/same-line.ts",
      content: `${"z".repeat(6_000)} ${marker} KEEP_LATE_COMMENT\n`,
    },
  });
  assert.match(sameLine ?? "", /KEEP_LATE_COMMENT/);
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
