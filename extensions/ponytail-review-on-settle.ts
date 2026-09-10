type ExtensionAPI = {
  on: (
    event: "tool_call" | "agent_settled",
    handler: (event: unknown, ctx: unknown) => unknown,
  ) => void;
  sendUserMessage: (text: string, options?: { deliverAs?: "followUp" }) => void;
};

type ToolCallEvent = { toolName?: unknown; input?: { path?: unknown } };

const CODE_FILE =
  /\.(?:c|cc|cpp|cs|cxx|go|h|hpp|hxx|java|js|jsx|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx)$/i;

export function isReviewableEdit(event: ToolCallEvent): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const path = event.input?.path;
  if (typeof path !== "string" || !CODE_FILE.test(path)) return undefined;
  return path;
}

export default function (pi: ExtensionAPI): void {
  const touchedFiles = new Set<string>();

  pi.on("tool_call", (event) => {
    const path = isReviewableEdit(event as ToolCallEvent);
    if (path) touchedFiles.add(path);
  });

  // ponytail: agent_end can fire mid-retry/before compaction-resume; agent_settled
  // is pi's documented once-per-run "no further automatic continuation" signal.
  pi.on("agent_settled", () => {
    if (touchedFiles.size === 0) return;
    touchedFiles.clear();
    pi.sendUserMessage("/skill:ponytail-review");
  });
}
