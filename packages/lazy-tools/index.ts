import { findMatchingTools, type SearchableTool } from "./match";

export { findMatchingTools } from "./match";

type ToolSearchParams = {
  query?: string;
  names?: string[];
  limit?: number;
};

type ExtensionContext = {
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
};

type ExtensionAPI = {
  getActiveTools: () => string[];
  getAllTools: () => SearchableTool[];
  setActiveTools: (names: string[]) => void;
  registerTool: (definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: ToolSearchParams,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { matches: string[]; added: string[] };
    }>;
  }) => void;
  registerCommand: (
    name: string,
    command: {
      description: string;
      handler: (
        args: string,
        ctx: {
          ui: {
            notify: (
              message: string,
              level: "info" | "warning",
            ) => void;
          };
        },
      ) => Promise<void>;
    },
  ) => void;
  on: (
    event: "session_start" | "before_agent_start",
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ) => void;
};

export function shouldUseLazyTools(ctx: ExtensionContext): boolean {
  const runtime = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return (
    ctx.mode === "tui" || runtime.process?.env?.PI_LAZY_TOOLS_FORCE === "1"
  );
}

export const LOADER_TOOL = "lazy_tool_search";
export const DEFAULT_ACTIVE_TOOLS = [LOADER_TOOL];
export const TOOL_LOADING_GUIDELINES = [
  "Use lazy_tool_search with English capability keywords or exact tool names when the active tools cannot perform the task.",
  "After lazy_tool_search succeeds, call the matching tool directly. Do not search again or report it unavailable unless its actual tool result reports an error.",
  "Skills are not registered tools. Never use a filesystem search to locate a skill; if a required skill is not loaded by Pi, state that it is unavailable.",
];

export function formatSearchResult(matches: string[], added: string[]): string {
  if (matches.length === 0) {
    return "No matching registered tools found. Try a specific English capability or exact tool name.";
  }

  const prefix = added.length === 0
    ? "Matching tools already active"
    : "Loaded tools";
  return `${prefix}: ${added.length === 0 ? matches.join(", ") : added.join(", ")}. Call the required tool directly now; do not search again or report it unavailable unless its actual tool result reports an error.`;
}

export default function lazyTools(pi: ExtensionAPI): void {
  let initialPrunePending = true;

  const reset = (): void => {
    const registered = new Set(pi.getAllTools().map(({ name }) => name));
    pi.setActiveTools(DEFAULT_ACTIVE_TOOLS.filter((name) => registered.has(name)));
  };

  pi.registerTool({
    name: LOADER_TOOL,
    label: "Lazy Tool Search",
    description:
      "Find and activate registered Pi tools for a capability. Use English capability keywords or exact tool names.",
    promptSnippet: "Search for and activate tools that are not currently available",
    promptGuidelines: TOOL_LOADING_GUIDELINES,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Capability to search for, preferably in English",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Exact registered tool names to activate",
          maxItems: 10,
        },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const all = pi.getAllTools().filter(({ name }) => name !== LOADER_TOOL);
      const registered = new Set(all.map(({ name }) => name));
      const exact = (params.names ?? []).filter((name) => registered.has(name));
      const searched = params.query
        ? findMatchingTools(params.query, all, params.limit ?? 5)
        : [];
      const matches = [...new Set([...exact, ...searched])];
      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));

      if (added.length > 0) {
        pi.setActiveTools([...new Set([...active, ...added])]);
      }

      const text = formatSearchResult(matches, added);

      return {
        content: [{ type: "text" as const, text }],
        details: { matches, added },
      };
    },
  });

  pi.registerCommand("lazy-tools", {
    description: "Show, reset, or disable lazy tool loading for this session",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "reset") reset();
      else if (action === "all") {
        pi.setActiveTools(pi.getAllTools().map(({ name }) => name));
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /lazy-tools [status|reset|all]", "warning");
        return;
      }
      ctx.ui.notify(
        `Lazy tools: ${pi.getActiveTools().length}/${pi.getAllTools().length} active`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    initialPrunePending = shouldUseLazyTools(ctx);
    if (initialPrunePending) reset();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!initialPrunePending || !shouldUseLazyTools(ctx)) return;
    reset();
    initialPrunePending = false;
  });
}
