import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  addMemory,
  globalStore,
  listStaleRefs,
  mergeMemory,
  projectStore,
  readIndex,
  readTopic,
  refsStatus,
  searchMemories,
  type MemoryStore,
  type MemoryType,
} from "./memory.ts";

const REF_PATH = Type.Object({
  path: Type.String({ minLength: 1, description: "Project-relative file path this memory depends on" }),
}, { additionalProperties: false });

type Target = "failure" | "global" | "memory" | "project" | "user";

function trusted(ctx: ExtensionContext): boolean {
  return ctx.isProjectTrusted();
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

function storesFor(ctx: ExtensionContext, scope: string): MemoryStore[] {
  if (!trusted(ctx)) throw new Error("Persistent memory is disabled for an untrusted directory.");
  const stores: MemoryStore[] = [];
  if (scope !== "project") stores.push(globalStore());
  if (scope !== "global") stores.push(projectStore(ctx.cwd));
  return stores;
}

function targetStore(ctx: ExtensionContext, target: Target): { store: MemoryStore; type: MemoryType } {
  if (!trusted(ctx)) throw new Error("Persistent memory is disabled for an untrusted directory.");
  if (target === "project") {
    return { store: projectStore(ctx.cwd), type: "project" };
  }
  const types: Record<Exclude<Target, "project">, MemoryType> = {
    failure: "feedback",
    global: "reference",
    memory: "reference",
    user: "user",
  };
  return { store: globalStore(), type: types[target] };
}

function topicManifest(store: MemoryStore): { content: string; truncated: boolean } {
  const index = readIndex(store);
  if (!index) return { content: "> (empty)", truncated: false };
  const files = [...index.content.matchAll(
    /\]\(((?:feedback|project|reference|user)-[a-f0-9]{10}(?:[a-f0-9]{54})?\.md)\)/g,
  )].map((match) => match[1]);
  return {
    content: files.length ? [...new Set(files)].map((file) => `> - ${file}`).join("\n") : "> (empty)",
    truncated: index.truncated,
  };
}

function memoryPrompt(ctx: ExtensionContext): string {
  if (!trusted(ctx)) {
    return "<auto-memory>Persistent memory is disabled because this directory is not trusted.</auto-memory>";
  }
  const global = globalStore();
  const project = projectStore(ctx.cwd);
  const sections: string[] = [
    "<auto-memory>",
    "Persistent memory uses a small always-loaded topic manifest plus detailed files loaded on demand.",
    "The manifest exposes only opaque type/hash filenames; model-authored descriptions remain retrieval-only.",
    "Index processing is limited to 200 lines / 25 KiB per scope; topic storage has no 5,000-character cap.",
    "Use memory_search and memory_read for details. Before saving, check for related topics; memory_add reports lexical near-duplicates, and the agent should read both then use memory_merge only when they are semantically redundant. Project-scope memories may set refs to specific files; memory_read/memory_search flag when a ref's hash no longer matches the file, and /memory check-refs scans the whole project store. Never save secrets or transient task state.",
    `Global store: ${global.dir}`,
    `Project store: ${project.dir}`,
  ];
  const globalIndex = topicManifest(global);
  sections.push("", "Global topic manifest:", globalIndex.content);
  if (globalIndex.truncated) sections.push("> [index truncated at 200 lines / 25 KiB; use memory_search]");
  sections.push("", "Project topic manifest:");
  const projectIndex = topicManifest(project);
  sections.push(projectIndex.content);
  if (projectIndex.truncated) sections.push("> [index truncated at 200 lines / 25 KiB; use memory_search]");
  sections.push("</auto-memory>");
  return sections.join("\n");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function claudeMemory(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => ({
    systemPrompt: `${String(event.systemPrompt || "")}\n\n${memoryPrompt(ctx)}`,
  }));

  pi.on("resources_discover", (event, ctx) => {
    if (!trusted(ctx)) return { skillPaths: [] };
    const cwd = typeof event.cwd === "string" ? event.cwd : ctx.cwd;
    const paths = [join(globalStore().dir, "skills"), join(projectStore(cwd).dir, "skills")];
    return { skillPaths: paths.filter(realDirectory) };
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description: "Save a durable memory in a global or canonical-repository topic file and update its MEMORY.md index.",
    promptSnippet: "Save durable global or project knowledge in topic files",
    promptGuidelines: [
      "Use memory_add for stable preferences, corrections, project conventions, and reusable learnings.",
      "When similar candidates are returned, read both topics and use memory_merge only if they are semantically redundant.",
      "Optionally set refs (target: project only) to project-relative files this memory depends on; a hash is captured now and checked for drift when the memory is later read or searched.",
      "Never store credentials, secrets, or transient task state.",
    ],
    parameters: Type.Object({
      target: Type.Union([
        Type.Literal("memory"), Type.Literal("user"), Type.Literal("failure"),
        Type.Literal("project"), Type.Literal("global"),
      ], { description: "project for the current canonical repository; user/memory/failure/global for global memory" }),
      content: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String({ description: "Short topic title; derived from content when omitted" })),
      description: Type.Optional(Type.String({ description: "One-line index summary; derived when omitted" })),
      refs: Type.Optional(Type.Array(REF_PATH, {
        description: "Files this memory depends on (target: project only); staleness is checked against these on future reads",
      })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, type } = targetStore(ctx, params.target);
      if (params.refs?.length && store.scope !== "project") {
        throw new Error("refs are only supported for target: project.");
      }
      const result = addMemory(store, {
        content: params.content,
        description: params.description,
        name: params.name,
        refs: params.refs,
        type,
      });
      const similar = result.similar.length
        ? `\nPotential duplicates: ${result.similar.map((item) => `${store.scope}/${item.file} (${Math.round(item.score * 100)}%)`).join(", ")}. Read both topics and call memory_merge only if they are semantically redundant.`
        : "";
      return textResult(
        `${result.duplicate ? "Memory already exists" : "Saved memory"}: ${join(store.dir, result.file)}${similar}`,
        { ...result, scope: store.scope, store: store.dir },
      );
    },
  });

  pi.registerTool({
    name: "memory_merge",
    label: "Memory Merge",
    description: "Atomically replace one canonical topic with agent-merged content and remove one redundant topic from the same scope.",
    promptSnippet: "Merge two semantically redundant memory topics after reading both",
    promptGuidelines: [
      "Use only after reading both topics and confirming they describe the same durable fact.",
      "Preserve every still-valid detail in the merged content; do not merge merely related topics.",
      "Omit refs to carry both topics' existing refs forward with freshly re-verified hashes; pass refs to replace them outright.",
    ],
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
      keepFile: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$" }),
      removeFile: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$" }),
      content: Type.String({ minLength: 1, description: "Agent-synthesized content preserving valid details from both topics" }),
      name: Type.Optional(Type.String({ description: "Merged topic title; derived from content when omitted" })),
      description: Type.Optional(Type.String({ description: "Merged one-line index summary; derived when omitted" })),
      refs: Type.Optional(Type.Array(REF_PATH, {
        description: "Replace the merged topic's refs with exactly this set (project scope only); omit to carry both topics' refs forward re-hashed",
      })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!trusted(ctx)) throw new Error("Persistent memory is disabled for an untrusted directory.");
      const store = params.scope === "project" ? projectStore(ctx.cwd) : globalStore();
      if (params.refs?.length && store.scope !== "project") {
        throw new Error("refs are only supported for scope: project.");
      }
      const result = mergeMemory(store, params);
      return textResult(
        `Merged memory: ${store.scope}/${result.file}; removed ${store.scope}/${result.removed}`,
        { ...result, scope: store.scope, store: store.dir },
      );
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search global and current canonical-repository memory topic files.",
    promptSnippet: "Search detailed memory topics on demand",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      scope: Type.Optional(Type.Union([
        Type.Literal("all"), Type.Literal("global"), Type.Literal("project"),
      ], { default: "all" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const results = searchMemories(
        storesFor(ctx, params.scope || "all"),
        params.query,
        params.limit || 10,
      );
      if (!results.length) return textResult("No matching memory topics found.", { results });
      const text = results.map((result) =>
        `- ${result.scope}/${result.file} [${result.type || "memory"}, score ${result.score}]\n  ${result.description}\n  ${result.snippet}`,
      ).join("\n");
      return textResult(text, { results });
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read one memory topic returned by memory_search or linked from MEMORY.md.",
    promptSnippet: "Read one detailed memory topic",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
      file: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$" }),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!trusted(ctx)) throw new Error("Persistent memory is disabled for an untrusted directory.");
      const store = params.scope === "project" ? projectStore(ctx.cwd) : globalStore();
      const text = readTopic(store, params.file);
      const staleRefs = refsStatus(store, params.file).filter((ref) => ref.stale);
      const note = staleRefs.length
        ? `\n\n[stale refs] ${staleRefs.map((ref) => `${ref.path} (${ref.reason})`).join(", ")} — verify current file content before trusting this memory.`
        : "";
      return textResult(`${text}${note}`, {
        file: params.file, scope: params.scope, staleRefs, store: store.dir,
      });
    },
  });

  pi.registerCommand("memory", {
    description: "Show Claude-style memory paths and index limits, or scan project refs for drift",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "check-refs") {
        if (!trusted(ctx)) {
          ctx.ui.notify("Persistent memory is disabled for an untrusted directory.", "warning");
          return;
        }
        const stale = listStaleRefs(projectStore(ctx.cwd));
        if (!stale.length) {
          ctx.ui.notify("No stale refs found in the current project store.", "info");
          return;
        }
        const lines = stale.map(({ file, stale: refs }) =>
          `${file}: ${refs.map((ref) => `${ref.path} (${ref.reason})`).join(", ")}`);
        ctx.ui.notify(`Stale refs found:\n${lines.join("\n")}`, "warning");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /memory [status|check-refs]", "warning");
        return;
      }
      const global = globalStore();
      const project = projectStore(ctx.cwd);
      ctx.ui.notify(
        `Memory index limit: 200 lines / 25 KiB\nGlobal: ${global.dir}\nProject: ${project.dir}`,
        "info",
      );
    },
  });
}
