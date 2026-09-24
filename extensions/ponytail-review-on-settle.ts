import { askNoul, MAX_STATE_CHARS } from "./jev.ts";

type ExtensionAPI = {
  on: (
    event: "tool_call" | "agent_settled",
    handler: (event: unknown, ctx: unknown) => unknown,
  ) => void;
  sendUserMessage: (
    text: string,
    options?: { deliverAs?: "followUp"; expandPromptTemplates?: boolean },
  ) => void;
};

type ToolCallEvent = {
  toolName?: unknown;
  input?: { path?: unknown; content?: unknown; edits?: unknown };
};
type Edit = { path: string; before?: string; after: string };

const CODE_FILE =
  /\.(?:c|cc|cpp|cs|cxx|go|h|hpp|hxx|java|js|jsx|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx)$/i;
const TRIVIAL =
  "Each edit in `edits` only changes wording, names, formatting, or literal values between `before` and `after`, without adding new logic";

export function isReviewableEdit(event: ToolCallEvent): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const path = event.input?.path;
  if (typeof path !== "string" || !CODE_FILE.test(path)) return undefined;
  return path;
}

function toEdits(path: string, event: ToolCallEvent): Edit[] {
  const { content, edits } = event.input ?? {};
  if (typeof content === "string") return [{ path, after: content }];
  if (!Array.isArray(edits)) return [];
  return edits.map((edit: { oldText?: unknown; newText?: unknown }) => ({
    path,
    before: String(edit.oldText ?? ""),
    after: String(edit.newText ?? ""),
  }));
}

export async function isTrivial(edits: Edit[]): Promise<boolean> {
  if (JSON.stringify(edits).length > MAX_STATE_CHARS) return false;
  try {
    const { trivial } = await askNoul({ edits }, { trivial: TRIVIAL });
    return trivial >= 0.8;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI): void {
  const edits: Edit[] = [];

  pi.on("tool_call", (event) => {
    const path = isReviewableEdit(event as ToolCallEvent);
    if (path) edits.push(...toEdits(path, event as ToolCallEvent));
  });

  // ponytail: agent_end can fire mid-retry/before compaction-resume; agent_settled
  // is pi's documented once-per-run "no further automatic continuation" signal.
  pi.on("agent_settled", async () => {
    if (edits.length === 0) return;
    // The Jev call can outlast idle time, so a new user turn may already be streaming.
    if (!(await isTrivial(edits.splice(0))))
      pi.sendUserMessage("/skill:ponytail-review", {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
  });
}
