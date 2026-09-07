import { execFile } from "node:child_process";
import { promisify } from "node:util";

type ToolCallResult = { block: true; reason: string } | undefined;
type ExtensionAPI = {
  on: (
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) => Promise<ToolCallResult>,
  ) => void;
};

type Edit = { newText?: unknown };
type ToolInput = { path?: unknown; content?: unknown; edits?: unknown };
type ToolCallEvent = { toolName?: unknown; input?: ToolInput };
type ExtensionContext = { cwd: string };

const execFileAsync = promisify(execFile);
const CODE_FILE =
  /\.(?:c|cc|cpp|cs|cxx|go|h|hpp|hxx|java|js|jsx|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx|yaml|yml|zsh)$/i;
const HASH_COMMENT_FILE = /\.(?:php|py|rb|sh|yaml|yml|zsh)$/i;
const ANY_HASH_COMMENT_FILE = /\.(?:php|py|rb)$/i;
const SHELL_HASH_COMMENT_FILE = /\.(?:sh|zsh)$/i;
const SLASH_COMMENT_FILE =
  /\.(?:c|cc|cpp|cs|cxx|go|h|hpp|hxx|java|js|jsx|mjs|php|rs|swift|ts|tsx)$/i;
const BLOCK_COMMENT_FILE =
  /\.(?:c|cc|cpp|cs|cxx|go|h|hpp|hxx|java|js|jsx|mjs|php|rs|sql|swift|ts|tsx)$/i;
const SQL_COMMENT_FILE = /\.sql$/i;
const REGEX_LITERAL_FILE = /\.(?:js|jsx|mjs|ts|tsx)$/i;
const CXX_RAW_STRING_FILE = /\.(?:cc|cpp|cxx|h|hpp|hxx)$/i;
const RUST_RAW_STRING_FILE = /\.rs$/i;
const NESTED_BLOCK_COMMENT_FILE = /\.(?:rs|swift)$/i;
const SUPPRESSION_COMMENT =
  /(?:#\s*(?:type:\s*ignore|noqa|pylint:\s*disable|pragma:\s*no\s*cover)|\/\/\s*@ts-(?:ignore|expect-error)|\/\/\s*eslint-disable)\b/i;
const FUTURE_ANNOTATIONS = /^\s*from\s+__future__\s+import\s+annotations\s*$/m;

function startsRegexLiteral(prefix: string): boolean {
  const trimmed = prefix.trimEnd();
  return (
    !trimmed ||
    /(?:=>|[=(:,[\]!&|?{};+*%^~<>-])$/.test(trimmed) ||
    /\b(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(
      trimmed,
    ) ||
    /\b(?:for(?:\s+await)?|if|while|with)\s*\([\s\S]*\)\s*$/.test(trimmed)
  );
}

type Quote = "'" | '"' | "`" | "'''" | '"""';
function startsHashComment(path: string, line: string, index: number): boolean {
  return (
    HASH_COMMENT_FILE.test(path) &&
    (ANY_HASH_COMMENT_FILE.test(path) ||
      index === 0 ||
      /\s/.test(line[index - 1]) ||
      (SHELL_HASH_COMMENT_FILE.test(path) && /[;&|()]/.test(line[index - 1])))
  );
}

type LexicalState = {
  blockCommentDepth?: number;
  quote?: Quote;
  rawStringEnd?: string;
  templateExpressionDepth?: number;
};

function withoutQuotedStrings(
  path: string,
  line: string,
  state: LexicalState = {},
): string {
  let masked = "";
  let quote = state.quote;
  let regex = false;
  let regexClass = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (state.blockCommentDepth) {
      masked += character;
      if (
        character === "/" &&
        line[index + 1] === "*" &&
        NESTED_BLOCK_COMMENT_FILE.test(path)
      ) {
        masked += "*";
        index += 1;
        state.blockCommentDepth += 1;
      } else if (character === "*" && line[index + 1] === "/") {
        masked += "/";
        index += 1;
        state.blockCommentDepth -= 1;
      }
      continue;
    }
    if (state.rawStringEnd) {
      const closing = line.indexOf(state.rawStringEnd, index);
      if (closing < 0) {
        masked += " ".repeat(line.length - index);
        break;
      }
      const end = closing + state.rawStringEnd.length;
      masked += " ".repeat(end - index);
      index = end - 1;
      state.rawStringEnd = undefined;
      continue;
    }
    if (escaped) {
      masked += " ";
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote.length === 3 && line.startsWith(quote, index)) {
        masked += "   ";
        index += 2;
        quote = undefined;
        continue;
      }
      if (
        quote === "`" &&
        REGEX_LITERAL_FILE.test(path) &&
        character === "$" &&
        line[index + 1] === "{"
      ) {
        masked += "  ";
        index += 1;
        quote = undefined;
        state.templateExpressionDepth = 1;
        continue;
      }
      masked += " ";
      if (character === "\\") escaped = true;
      else if (quote.length === 1 && character === quote) quote = undefined;
      continue;
    }
    if (regex) {
      masked += " ";
      if (character === "\\") escaped = true;
      else if (character === "[") regexClass = true;
      else if (character === "]") regexClass = false;
      else if (character === "/" && !regexClass) regex = false;
      continue;
    }
    if (state.templateExpressionDepth) {
      if (character === "{") state.templateExpressionDepth += 1;
      else if (character === "}") {
        state.templateExpressionDepth -= 1;
        if (!state.templateExpressionDepth) {
          quote = "`";
          masked += " ";
          continue;
        }
      }
    }
    if (character === "r" && RUST_RAW_STRING_FILE.test(path)) {
      let opening = index + 1;
      while (line[opening] === "#") opening += 1;
      if (line[opening] === '"') {
        const hashes = line.slice(index + 1, opening);
        state.rawStringEnd = `"${hashes}`;
        masked += " ".repeat(opening - index + 1);
        index = opening;
        continue;
      }
    }
    if (
      character === "R" &&
      line[index + 1] === '"' &&
      CXX_RAW_STRING_FILE.test(path)
    ) {
      const opening = line.indexOf("(", index + 2);
      const delimiter = opening < 0 ? "" : line.slice(index + 2, opening);
      if (
        opening >= 0 &&
        delimiter.length <= 16 &&
        !/[\s()\\]/.test(delimiter)
      ) {
        state.rawStringEnd = `)${delimiter}"`;
        masked += " ".repeat(opening - index + 1);
        index = opening;
        continue;
      }
    }
    if (character === "#" && startsHashComment(path, line, index)) {
      state.quote = quote;
      return masked + line.slice(index);
    }
    if (
      character === "-" &&
      line[index + 1] === "-" &&
      SQL_COMMENT_FILE.test(path)
    ) {
      state.quote = quote;
      return masked + line.slice(index);
    }
    if (character === "'" || character === '"' || character === "`") {
      const triple =
        /\.py$/i.test(path) && line.startsWith(character.repeat(3), index);
      quote = triple ? (character.repeat(3) as Quote) : character;
      masked += triple ? "   " : " ";
      if (triple) index += 2;
      continue;
    }
    if (
      character === "/" &&
      line[index + 1] === "/" &&
      SLASH_COMMENT_FILE.test(path)
    ) {
      state.quote = quote;
      return masked + line.slice(index);
    }
    if (
      character === "/" &&
      line[index + 1] === "*" &&
      BLOCK_COMMENT_FILE.test(path)
    ) {
      masked += "/*";
      index += 1;
      state.blockCommentDepth = 1;
      continue;
    }
    if (
      character === "/" &&
      REGEX_LITERAL_FILE.test(path) &&
      startsRegexLiteral(masked)
    ) {
      regex = true;
      masked += " ";
      continue;
    }
    masked += character;
  }
  state.quote = quote;
  return masked;
}

function hasReviewableComment(
  path: string,
  line: string,
  code = withoutQuotedStrings(path, line),
): boolean {
  if (FUTURE_ANNOTATIONS.test(line)) return true;
  return (
    (ANY_HASH_COMMENT_FILE.test(path) && /#/.test(code)) ||
    (SHELL_HASH_COMMENT_FILE.test(path) && /(?:^|[\s;&|()])#/.test(code)) ||
    (HASH_COMMENT_FILE.test(path) && /(?:^|\s)#/.test(code)) ||
    (SLASH_COMMENT_FILE.test(path) && /\/\//.test(code)) ||
    (BLOCK_COMMENT_FILE.test(path) && /\/\*/.test(code)) ||
    (SQL_COMMENT_FILE.test(path) && /--/.test(code)) ||
    SUPPRESSION_COMMENT.test(code)
  );
}

function reviewableContext(path: string, text: string): string[] {
  const lines = text.split("\n");
  const selected = new Set<number>();
  const reviewableLines = new Set<number>();
  const lexicalState: LexicalState = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startedInBlockComment = Boolean(lexicalState.blockCommentDepth);
    const code = withoutQuotedStrings(path, line, lexicalState);
    const reviewable =
      startedInBlockComment || hasReviewableComment(path, line, code);
    if (reviewable) {
      reviewableLines.add(index);
      for (const candidate of [index - 1, index, index + 1]) {
        if (candidate >= 0 && candidate < lines.length) selected.add(candidate);
      }
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => {
      const line = lines[index];
      if (reviewableLines.has(index)) return line;
      return line.length > 500 ? `${line.slice(0, 500)}…` : line;
    });
}

export function extractReviewCandidate(
  event: ToolCallEvent,
): string | undefined {
  const path = event.input?.path;
  if (typeof path !== "string" || !CODE_FILE.test(path)) return undefined;

  const additions =
    event.toolName === "write" && typeof event.input?.content === "string"
      ? [event.input.content]
      : event.toolName === "edit" && Array.isArray(event.input?.edits)
        ? event.input.edits.flatMap((edit: Edit) =>
            typeof edit.newText === "string" ? [edit.newText] : [],
          )
        : [];
  const candidate = additions
    .flatMap((text) => reviewableContext(path, text))
    .join("\n");
  return candidate || undefined;
}

function reviewPrompt(path: string, proposedText: string): string {
  return `You are the sole comment reviewer. Review only the proposed code change below for ${path}.

Approve a comment only when it documents a verified non-obvious WHY (constraint, compatibility, security, or operational reason) that cannot be clear from the code. Reject comments that restate code, narrate implementation, add speculative type/linter suppressions, or add \`from __future__ import annotations\` without a demonstrated runtime need. Suppression comments require a concrete verified tool error and must normally be rejected in favor of fixing the code/config.

Return exactly one first line: APPROVE or REJECT. On later lines, give a concise reason. Do not modify files.

Proposed change:
\`\`\`
${proposedText}
\`\`\``;
}

async function review(
  path: string,
  proposedText: string,
  cwd: string,
): Promise<string> {
  const executable = process.env.PI_COMMENT_REVIEWER_EXECUTABLE ?? "pi";
  const { stdout } = await execFileAsync(
    executable,
    ["--tools", "read,grep,find,ls", "-p", reviewPrompt(path, proposedText)],
    { cwd, timeout: 120_000, maxBuffer: 64 * 1024 },
  );
  return stdout.trim();
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const proposedText = extractReviewCandidate(event);
    const path = event.input?.path;
    if (!proposedText || typeof path !== "string") return;

    try {
      const verdict = await review(path, proposedText, ctx.cwd);
      if (/^APPROVE\b/i.test(verdict)) return;
      return {
        block: true,
        reason: `Comment reviewer rejected this change: ${verdict || "no verdict returned"}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `Comment reviewer could not run; refusing to add unreviewed comments: ${message}`,
      };
    }
  });
}
