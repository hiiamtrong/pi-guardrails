import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mapWithConcurrency } from "./concurrency.ts";

type ServerConfig = {
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

type McpConfig = {
  servers?: Record<string, ServerConfig>;
};

type EnvironmentConfig = Record<string, string>;

type ConnectedServer = {
  name: string;
  config: ServerConfig;
  client: Client;
  tools: Tool[];
  toolNames: string[];
};

const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_CONCURRENCY = 2;
const CALL_TIMEOUT_MS = 120_000;
const TOOL_PREFIX = "mcp_";

function configPaths(cwd: string): string[] {
  const globalConfigDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [join(globalConfigDir, "mcp.json"), join(cwd, ".pi", "mcp.json")];
}

function secretsPath(): string {
  const globalConfigDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(globalConfigDir, "mcp-env.json");
}

function environmentPaths(cwd: string): string[] {
  const globalConfigDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [join(globalConfigDir, "env.json"), join(cwd, ".pi", "env.json")];
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function mergeConfigs(configs: McpConfig[]): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = {};
  for (const config of configs) {
    for (const [name, server] of Object.entries(config.servers ?? {})) {
      merged[name] = {
        ...merged[name],
        ...server,
        env: { ...merged[name]?.env, ...server.env },
        headers: { ...merged[name]?.headers, ...server.headers },
      };
    }
  }
  return merged;
}

function resolveValue(value: string, secrets: Record<string, string>): string {
  const match = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!match) return value;
  return secrets[match[1]] ?? process.env[match[1]] ?? value;
}

function resolveRecord(record: Record<string, string> | undefined, secrets: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => {
      const resolved = resolveValue(value, secrets);
      if (resolved === value && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) {
        throw new Error(`Missing environment variable for ${key}`);
      }
      return [key, resolved];
    }),
  );
}

function toolName(serverName: string, name: string): string {
  const safeServer = serverName.replace(/[^A-Za-z0-9_]/g, "_");
  const safeTool = name.replace(/[^A-Za-z0-9_]/g, "_");
  return `${TOOL_PREFIX}${safeServer}_${safeTool}`;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        return String("text" in block ? block.text : "");
      }
      return JSON.stringify(block, null, 2);
    })
    .filter(Boolean)
    .join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildTransport(name: string, config: ServerConfig, cwd: string, secrets: Record<string, string>) {
  if (config.url) {
    const url = new URL(config.url);
    if (url.protocol !== "https:") {
      throw new Error(`${name}: only HTTPS MCP URLs are allowed`);
    }
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: resolveRecord(config.headers, secrets) },
    });
  }

  if (!config.command) throw new Error(`${name}: expected either "command" or "url"`);

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...resolveRecord(config.env, secrets),
  };

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd ? resolve(cwd, config.cwd) : cwd,
    env,
  });
}

async function connectServer(
  name: string,
  config: ServerConfig,
  cwd: string,
  secrets: Record<string, string>,
): Promise<ConnectedServer> {
  const client = new Client({ name: "pi-mcp-bridge", version: "1.0.0" });
  try {
    const transport = buildTransport(name, config, cwd, secrets);
    await withTimeout(client.connect(transport), STARTUP_TIMEOUT_MS, `${name} connection`);

    const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), STARTUP_TIMEOUT_MS, `${name} tools/list`);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

    return {
      name,
      config,
      client,
      tools,
      toolNames: tools.map((tool) => toolName(name, tool.name)),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  const servers = new Map<string, ConnectedServer>();
  const registeredTools = new Set<string>();

  pi.registerCommand("mcp-status", {
    description: "Show connected MCP servers and imported tools",
    handler: async (_args, ctx) => {
      if (servers.size === 0) {
        ctx.ui.notify("No MCP servers are connected.", "warning");
        return;
      }
      const status = [...servers.values()]
        .map((server) => `${server.name}: ${server.tools.length} tool(s)`)
        .join("\n");
      ctx.ui.notify(status, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const paths = configPaths(ctx.cwd);
    const envPaths = environmentPaths(ctx.cwd);
    const projectConfigExists = paths[1] && existsSync(paths[1]);
    const projectEnvironmentExists = envPaths[1] && existsSync(envPaths[1]);
    const projectResourcesTrusted = ctx.isProjectTrusted();

    if ((projectConfigExists || projectEnvironmentExists) && !projectResourcesTrusted) {
      ctx.ui.notify("Project MCP configuration/environment skipped because this project is not trusted.", "warning");
    } else if (projectEnvironmentExists) {
      const environment = (await readJson<EnvironmentConfig>(envPaths[1])) ?? {};
      for (const [key, value] of Object.entries(environment)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }

    const loadedConfigs = await Promise.all(paths.map((path) => readJson<McpConfig>(path)));
    const configs = loadedConfigs.filter((config): config is McpConfig => config !== undefined);
    if (configs.length === 0) return;

    const trustedConfigs = projectResourcesTrusted
      ? configs
      : loadedConfigs[0]
        ? [loadedConfigs[0]]
        : [];
    const secrets = (await readJson<Record<string, string>>(secretsPath())) ?? {};
    const configured = mergeConfigs(trustedConfigs);
    const entries = Object.entries(configured).filter(([, config]) => config.enabled !== false);

    const results = await mapWithConcurrency(entries, STARTUP_CONCURRENCY, async ([name, config]) => {
      try {
        return { status: "fulfilled" as const, value: await connectServer(name, config, ctx.cwd, secrets) };
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    });

    const failures: string[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const [name] = entries[index];
      const result = results[index];
      if (result.status === "fulfilled") {
        const server = result.value;
        servers.set(name, server);
        for (const tool of server.tools) {
          const importedName = toolName(name, tool.name);
          registeredTools.add(importedName);
          pi.registerTool({
            name: importedName,
            label: `${name}/${tool.name}`,
            description: `${tool.description ?? `MCP tool ${tool.name}`}\n\nMCP server: ${name}; original tool: ${tool.name}`,
            parameters: Type.Unsafe(tool.inputSchema as any),
            async execute(_toolCallId, params) {
              const active = servers.get(name);
              if (!active) throw new Error(`MCP server ${name} is not connected`);
              const result = await withTimeout(
                active.client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }),
                CALL_TIMEOUT_MS,
                `${name}/${tool.name}`,
              );
              const text = contentText(result.content);
              if (result.isError) throw new Error(text || `${name}/${tool.name} failed`);
              return { content: [{ type: "text", text: text || "MCP tool completed without output" }], details: result };
            },
          });
        }
      } else {
        failures.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    if (registeredTools.size > 0) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...registeredTools])]);
    }
    if (failures.length > 0) {
      ctx.ui.notify(`MCP startup failures:\n${failures.join("\n")}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...servers.values()].map((server) => server.client.close()));
    servers.clear();
    registeredTools.clear();
  });
}
