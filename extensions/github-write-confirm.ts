import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolInput = Record<string, unknown> & { command?: unknown };
type ToolCallEvent = { toolName?: unknown; input?: ToolInput };
type ToolCallResult = { block: true; reason: string } | undefined;
type ExtensionContext = { hasUI?: boolean; ui?: { confirm?: (title: string, message: string) => Promise<boolean> } };
type ExtensionApi = { on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallResult>) => void };

const CONFIG_PATH = process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG
  ?? join(homedir(), ".pi", "agent", "github-write-confirm.json");

const READ_ONLY_GH_COMMANDS = new Set(["api", "auth", "cache", "config", "gist", "issue", "label", "pr", "project", "release", "repo", "run", "search", "secret", "status", "variable", "workflow"]);
const READ_ONLY_GH_SUBCOMMANDS = new Set(["checks", "clone", "diff", "download", "get", "list", "status", "token", "view", "watch"]);
const READ_ONLY_MCP_WORDS = new Set(["check", "diff", "download", "fetch", "get", "list", "read", "search", "status", "view"]);
const GITHUB_MUTATION_WORDS = new Set(["approve", "assign", "close", "comment", "create", "delete", "dismiss", "edit", "merge", "move", "open", "push", "remove", "reopen", "resolve", "send", "set", "transfer", "unassign", "update", "upload", "write"]);

let configCacheKey = "";
let writeAllowlist = new Set<string>();

function normalizeRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : undefined;
}

function isRepo(value: string | undefined): value is string {
  return value !== undefined;
}

function loadWriteAllowlist(): Set<string> {
  try {
    const stat = statSync(CONFIG_PATH);
    const cacheKey = `${stat.mtimeMs}:${stat.size}`;
    if (cacheKey === configCacheKey) return writeAllowlist;
    const config: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const values = config && typeof config === "object" && Array.isArray((config as { writeAllowlist?: unknown }).writeAllowlist)
      ? (config as { writeAllowlist: unknown[] }).writeAllowlist
      : [];
    writeAllowlist = new Set(values.map(normalizeRepo).filter(isRepo));
    configCacheKey = cacheKey;
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      configCacheKey = "missing";
      writeAllowlist = new Set();
      return writeAllowlist;
    }
    configCacheKey = "invalid";
    writeAllowlist = new Set();
  }
  return writeAllowlist;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(gh[opsu]_[A-Za-z0-9_-]{8,})/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|Authorization)\s*=\s*)[^\s;&|]+/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, "$1[REDACTED]");
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = undefined; else current += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) { if (current) words.push(current); current = ""; continue; }
    current += character;
  }
  if (current) words.push(current);
  return words;
}

function hasUnsafeApiArguments(tokens: string[]): boolean {
  return tokens.some((token, index) => {
    const next = tokens[index + 1] ?? "";
    if (["-f", "-F", "--raw-field", "--field", "--input", "--template", "--jq"].includes(token)) return true;
    if (token.startsWith("-f") || token.startsWith("-F") || token.startsWith("--raw-field=") || token.startsWith("--field=") || token.startsWith("--input=")) return true;
    if (["-X", "--method"].includes(token)) return next.toUpperCase() !== "GET";
    if (token.startsWith("-X") && token.length > 2) return token.slice(2).toUpperCase() !== "GET";
    return token.startsWith("--method=") && token.slice("--method=".length).toUpperCase() !== "GET";
  });
}

function isReadOnlyGhCommand(command: string): boolean {
  const tokens = splitShellWords(command);
  const ghIndex = tokens.findIndex((token) => /(?:^|\/)gh(?:\.exe)?$/i.test(token));
  if (ghIndex === -1) return false;
  const tail = tokens.slice(ghIndex + 1);
  const commandIndex = tail.findIndex((token) => READ_ONLY_GH_COMMANDS.has(token.toLowerCase()));
  if (commandIndex === -1) return false;
  const ghCommand = tail[commandIndex].toLowerCase();
  const subcommand = tail.slice(commandIndex + 1).find((token) => !token.startsWith("-"))?.toLowerCase();
  if (ghCommand === "api") return !hasUnsafeApiArguments(tail.slice(commandIndex + 1));
  if (["search", "status"].includes(ghCommand)) return true;
  return Boolean(subcommand && READ_ONLY_GH_SUBCOMMANDS.has(subcommand));
}

function isGithubCommand(command: string): boolean {
  return splitShellWords(command).some((token) => /(?:^|\/)gh(?:\.exe)?$/i.test(token)) || /(?:api\.)?github\.com/i.test(command);
}

function isGitPush(command: string): boolean {
  return /(?:^|[;&|()]|\s)git(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+push(?:\s|$)/i.test(command);
}

function isReadOnlyGithubHttpCommand(command: string): boolean {
  if (!/(?:api\.)?github\.com/i.test(command) || !/\b(curl|wget|http)\b/i.test(command)) return false;
  return !/\s(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)|(?:-X|--request)=(?:POST|PUT|PATCH|DELETE)|\s(?:-d|--data|--data-raw|--data-binary|--form)\b/i.test(command);
}

function isReadOnlyGithubMcpTool(toolName: string): boolean {
  const words = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return !words.some((word) => GITHUB_MUTATION_WORDS.has(word)) && words.some((word) => READ_ONLY_MCP_WORDS.has(word));
}

function explicitRepoFromCommand(command: string): string | undefined {
  const urlMatch = command.match(/(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s/?#'"\]|]|$)/i);
  if (urlMatch) return normalizeRepo(urlMatch[1]);
  const apiMatch = command.match(/(?:^|[\s/])repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (apiMatch) return normalizeRepo(`${apiMatch[1]}/${apiMatch[2]}`);
  const tokens = splitShellWords(command);
  for (let index = 0; index < tokens.length; index++) {
    if (["-R", "--repo"].includes(tokens[index])) return normalizeRepo(tokens[index + 1]);
    if (tokens[index].startsWith("--repo=")) return normalizeRepo(tokens[index].slice("--repo=".length));
  }
  const ghIndex = tokens.findIndex((token) => /(?:^|\/)gh(?:\.exe)?$/i.test(token));
  if (ghIndex === -1) return undefined;
  const nouns = new Set(["repo", "pr", "issue", "release", "workflow", "run"]);
  for (let index = ghIndex + 1; index < tokens.length - 2; index++) {
    if (nouns.has(tokens[index].toLowerCase())) return normalizeRepo(tokens[index + 2]);
  }
  return undefined;
}

function repoFromInput(input: ToolInput | undefined): string | undefined {
  if (!input) return undefined;
  const owner = typeof input.owner === "string" ? input.owner : undefined;
  let name;
  if (typeof input.repo === "string") name = input.repo;
  else if (typeof input.repository === "string") name = input.repository;
  if (owner && name) return normalizeRepo(`${owner}/${name}`);
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && /(repo|repository|url)/i.test(key)) {
      const repo = normalizeRepo(value) ?? explicitRepoFromCommand(value);
      if (repo) return repo;
    }
  }
  return undefined;
}

export function githubWriteReason(event: ToolCallEvent): string | undefined {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  if (toolName.toLowerCase().includes("github")) return isReadOnlyGithubMcpTool(toolName) ? undefined : `GitHub tool: ${toolName}`;
  if (toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
  const command = event.input.command;
  if (isGitPush(command)) return "git push may mutate a GitHub remote";
  if (!isGithubCommand(command)) return undefined;
  return isReadOnlyGhCommand(command) || isReadOnlyGithubHttpCommand(command) ? undefined : "GitHub command is a write or cannot be proven read-only";
}

export function targetGithubRepo(event: ToolCallEvent): string | undefined {
  if (typeof event.input?.command === "string") return explicitRepoFromCommand(event.input.command);
  return repoFromInput(event.input);
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", async (event, ctx) => {
    const reason = githubWriteReason(event);
    if (!reason) return undefined;

    const targetRepo = targetGithubRepo(event);
    if (targetRepo && loadWriteAllowlist().has(targetRepo)) return undefined;

    if (!ctx.hasUI || !ctx.ui?.confirm) {
      return { block: true, reason: `Blocked ${reason}: no interactive confirmation is available.` };
    }

    const command = typeof event.input?.command === "string" ? redactSecrets(event.input.command) : undefined;
    const repoLabel = targetRepo ? `\n\nRepository: ${targetRepo}` : "";
    const allowed = await ctx.ui.confirm(
      "GitHub write confirmation",
      `${reason}.${repoLabel}\n\n${command ? `Command:\n${command}\n\n` : ""}Allow this remote write?`,
    );
    return allowed ? undefined : { block: true, reason: `Blocked ${reason}: user did not confirm.` };
  });
}
