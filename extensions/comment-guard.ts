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
  /\.(?:c|cc|cpp|cs|go|h|java|js|jsx|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx|yaml|yml|zsh)$/i;
const COMMENT_LINE = /(?:^|\s)(?:#|\/\/|\/\*)|^\s*\*(?:\s|\/)/;
const SUPPRESSION_COMMENT =
  /(?:#\s*(?:type:\s*ignore|noqa|pylint:\s*disable|pragma:\s*no\s*cover)|\/\/\s*@ts-(?:ignore|expect-error)|\/\/\s*eslint-disable)\b/i;
const FUTURE_ANNOTATIONS = /^\s*from\s+__future__\s+import\s+annotations\s*$/m;

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
  const lines = additions.join("\n").split("\n");
  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      !COMMENT_LINE.test(line) &&
      !SUPPRESSION_COMMENT.test(line) &&
      !FUTURE_ANNOTATIONS.test(line)
    ) {
      continue;
    }
    for (const candidate of [index - 1, index, index + 1]) {
      if (candidate >= 0 && candidate < lines.length) selected.add(candidate);
    }
  }
  if (!selected.size) return undefined;
  const candidate = [...selected]
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n");
  return candidate.length > 12_000
    ? `${candidate.slice(0, 12_000)}\n[truncated]`
    : candidate;
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
    [
      "--no-extensions",
      "--tools",
      "read,grep,find,ls",
      "-p",
      reviewPrompt(path, proposedText),
    ],
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
