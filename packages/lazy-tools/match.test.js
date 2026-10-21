import { describe, expect, test } from "bun:test";
import lazyTools, {
  formatSearchResult,
  shouldUseLazyTools,
  TOOL_LOADING_GUIDELINES,
} from "./index";
import { findMatchingTools } from "./match";

const tools = [
  {
    name: "ctx_batch_execute",
    description: "Run multiple commands and summarize large output",
  },
  { name: "web_search", description: "Search the web for current information" },
  {
    name: "memory_search",
    description: "Search persistent memory from previous sessions",
  },
  { name: "subagent", description: "Delegate work to a focused child agent" },
];

describe("shouldUseLazyTools", () => {
  test("prunes interactive TUI sessions but preserves headless tool profiles", () => {
    const previous = process.env.PI_LAZY_TOOLS_FORCE;
    delete process.env.PI_LAZY_TOOLS_FORCE;
    try {
      expect(shouldUseLazyTools({ mode: "tui", hasUI: true })).toBe(true);
      expect(shouldUseLazyTools({ mode: "json", hasUI: false })).toBe(false);
      expect(shouldUseLazyTools({ mode: "print", hasUI: false })).toBe(false);
      expect(shouldUseLazyTools({ mode: "rpc", hasUI: true })).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PI_LAZY_TOOLS_FORCE;
      else process.env.PI_LAZY_TOOLS_FORCE = previous;
    }
  });
});

describe("findMatchingTools", () => {
  test("prioritizes an exact normalized tool name", () => {
    expect(findMatchingTools("ctx batch execute", tools, 2)[0]).toBe(
      "ctx_batch_execute",
    );
  });

  test("finds tools by capability description", () => {
    expect(findMatchingTools("persistent memory", tools, 2)[0]).toBe(
      "memory_search",
    );
  });

  test("limits results and ignores generic words", () => {
    expect(findMatchingTools("use tools for search", tools, 2)).toHaveLength(2);
    expect(findMatchingTools("use the tools", tools)).toEqual([]);
  });
});


describe("tool loading guard", () => {
  test("returns direct-invocation instructions from the registered tool", async () => {
    let active = ["lazy_tool_search"];
    let definition;
    lazyTools({
      getActiveTools: () => active,
      getAllTools: () => [{ name: "ctx_execute", description: "Execute code" }],
      setActiveTools: (names) => { active = names; },
      registerTool: (tool) => { definition = tool; },
      registerCommand: () => {},
      on: () => {},
    });

    const result = await definition.execute("test", { names: ["ctx_execute"] });
    expect(active).toEqual(["lazy_tool_search", "ctx_execute"]);
    expect(result.content[0].text).toBe(formatSearchResult(["ctx_execute"], ["ctx_execute"]));
  });

  test("does not direct the agent to search the filesystem for skills", () => {
    expect(TOOL_LOADING_GUIDELINES).toContain(
      "Skills are not registered tools. Never use a filesystem search to locate a skill; if a required skill is not loaded by Pi, state that it is unavailable.",
    );
  });
});

describe("formatSearchResult", () => {
  test("directs the agent to invoke a newly loaded tool", () => {
    expect(formatSearchResult(["ctx_execute"], ["ctx_execute"])).toBe(
      "Loaded tools: ctx_execute. Call the required tool directly now; do not search again or report it unavailable unless its actual tool result reports an error.",
    );
  });

  test("keeps the same guard when the tool is already active", () => {
    expect(formatSearchResult(["ctx_execute"], [])).toBe(
      "Matching tools already active: ctx_execute. Call the required tool directly now; do not search again or report it unavailable unless its actual tool result reports an error.",
    );
  });
});
