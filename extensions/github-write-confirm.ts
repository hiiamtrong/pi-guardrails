import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolInput = Record<string, unknown> & {
  command?: unknown;
  code?: unknown;
  commands?: unknown;
  language?: unknown;
};
type ToolCallEvent = { toolName?: unknown; input?: ToolInput };
type ToolCallResult = { block: true; reason: string } | undefined;
type ExtensionContext = {
  hasUI?: boolean;
  ui?: { confirm?: (title: string, message: string) => Promise<boolean> };
};
type ExtensionApi = {
  on: (
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) => Promise<ToolCallResult>,
  ) => void;
};

const CONFIG_PATH =
  process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG ??
  join(homedir(), ".pi", "agent", "github-write-confirm.json");

const READ_ONLY_GH_COMMANDS = new Set([
  "api",
  "auth",
  "cache",
  "config",
  "gist",
  "issue",
  "label",
  "pr",
  "project",
  "release",
  "repo",
  "run",
  "search",
  "secret",
  "status",
  "variable",
  "workflow",
]);
const READ_ONLY_GH_SUBCOMMANDS = new Set([
  "checks",
  "clone",
  "diff",
  "download",
  "get",
  "list",
  "status",
  "token",
  "view",
  "watch",
]);
const READ_ONLY_MCP_WORDS = new Set([
  "check",
  "diff",
  "download",
  "fetch",
  "get",
  "list",
  "read",
  "search",
  "status",
  "view",
]);
const GITHUB_MUTATION_WORDS = new Set([
  "approve",
  "assign",
  "close",
  "comment",
  "create",
  "delete",
  "dismiss",
  "edit",
  "merge",
  "move",
  "open",
  "push",
  "remove",
  "reopen",
  "resolve",
  "send",
  "set",
  "transfer",
  "unassign",
  "update",
  "upload",
  "write",
]);

let configCacheKey = "";
let writeAllowlist = new Set<string>();

function normalizeRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value
    .trim()
    .match(
      /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    );
  return match
    ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}`
    : undefined;
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
    const values =
      config &&
      typeof config === "object" &&
      Array.isArray((config as { writeAllowlist?: unknown }).writeAllowlist)
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
    .replace(
      /((?:GH_TOKEN|GITHUB_TOKEN|Authorization)\s*=\s*)[^\s;&|]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, "$1[REDACTED]");
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (current) words.push(current);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (";&|()<>{}\n".includes(character)) {
      flush();
      let punctuation = character;
      while (
        index + 1 < command.length &&
        ";&|()<>{}\n".includes(command[index + 1])
      ) {
        punctuation += command[index + 1];
        index += 1;
      }
      words.push(punctuation);
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return words;
}

function shellCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];
  for (const token of tokens) {
    if (
      token === "{" ||
      token === "}" ||
      [...token].every((character) => ";&|()\n".includes(character))
    ) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    } else {
      segment.push(token);
    }
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function isRedirection(token: string): boolean {
  return (
    [...token].some((character) => "<>".includes(character)) &&
    [...token].every((character) => "<>&".includes(character))
  );
}

function executableIndex(tokens: string[]): number | undefined {
  const controlPrefixes = new Set([
    "!",
    "do",
    "elif",
    "else",
    "fi",
    "if",
    "then",
    "until",
    "while",
  ]);
  const wrapperValueOptions = new Map<string, Set<string>>([
    ["builtin", new Set()],
    ["command", new Set()],
    [
      "env",
      new Set(["-C", "-S", "-P", "-u", "--chdir", "--split-string", "--unset"]),
    ],
    ["exec", new Set()],
    ["nice", new Set(["-n", "--adjustment"])],
    ["nohup", new Set()],
    [
      "sudo",
      new Set([
        "-C",
        "-g",
        "-h",
        "-p",
        "-r",
        "-t",
        "-u",
        "--chdir",
        "--group",
        "--host",
        "--prompt",
        "--role",
        "--type",
        "--user",
      ]),
    ],
    ["time", new Set(["-f", "-o", "--format", "--output"])],
  ]);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (controlPrefixes.has(token)) {
      index += 1;
      continue;
    }
    if (
      /^\d+$/.test(token) &&
      index + 1 < tokens.length &&
      isRedirection(tokens[index + 1])
    ) {
      index += 1;
      continue;
    }
    if (isRedirection(token)) {
      index += 2;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    const executable = token.split("/").at(-1)?.toLowerCase();
    const valueOptions = executable
      ? wrapperValueOptions.get(executable)
      : undefined;
    if (valueOptions) {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index];
        if (
          executable === "env" &&
          (option.startsWith("--split-string=") ||
            (option.startsWith("-S") && option.length > 2))
        ) {
          const value = option.startsWith("--split-string=")
            ? option.slice("--split-string=".length)
            : option.slice(2);
          tokens.splice(index, 1, ...splitShellWords(value));
          continue;
        }
        index += 1;
        if (executable === "env" && ["-S", "--split-string"].includes(option)) {
          if (index < tokens.length)
            tokens.splice(index, 1, ...splitShellWords(tokens[index]));
          continue;
        }
        if (valueOptions.has(option) && index < tokens.length) index += 1;
      }
      continue;
    }
    return index;
  }
  return undefined;
}

type ShellInvocation = { tokens: string[]; executableIndex: number };

function shellInvocations(
  command: string,
  executable: string,
): ShellInvocation[] {
  return shellCommandSegments(splitShellWords(command)).flatMap((tokens) => {
    const index = executableIndex(tokens);
    if (index === undefined) return [];
    const name = tokens[index].split("/").at(-1)?.toLowerCase();
    return name === executable ? [{ tokens, executableIndex: index }] : [];
  });
}

function hasUnsafeApiArguments(tokens: string[]): boolean {
  let method: string | undefined;
  let hasPayload = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["-X", "--method"].includes(token)) {
      method = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("-X") && token.length > 2) {
      method = token.slice(2);
    } else if (token.startsWith("--method=")) {
      method = token.slice("--method=".length);
    } else if (
      ["-f", "-F", "--raw-field", "--field", "--input"].includes(token) ||
      token.startsWith("-f") ||
      token.startsWith("-F") ||
      token.startsWith("--raw-field=") ||
      token.startsWith("--field=") ||
      token.startsWith("--input=")
    ) {
      hasPayload = true;
    }
  }
  if (method) return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  return hasPayload;
}

type GhCommand = {
  command?: string;
  commandIndex?: number;
  subcommand?: string;
};

function ghCommand(invocation: ShellInvocation): GhCommand {
  const { tokens, executableIndex: executable } = invocation;
  let skipValue = false;
  let command: string | undefined;
  let commandIndex: number | undefined;
  for (let index = executable + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (["-R", "--repo", "--hostname"].includes(token)) {
      skipValue = true;
      continue;
    }
    if (
      token.startsWith("-R") ||
      token.startsWith("--repo=") ||
      token.startsWith("--hostname=") ||
      ["-h", "--help", "--version"].includes(token)
    )
      continue;
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    if (command) {
      return { command, commandIndex, subcommand: token.toLowerCase() };
    } else {
      command = token.toLowerCase();
      commandIndex = index;
    }
  }
  return { command, commandIndex };
}

function ghRequestsHelp(invocation: ShellInvocation): boolean {
  for (
    let index = invocation.executableIndex + 1;
    index < invocation.tokens.length;
    index += 1
  ) {
    const token = invocation.tokens[index];
    if (token === "--") return false;
    if (["-h", "--help", "--version"].includes(token)) {
      const previous = invocation.tokens[index - 1] ?? "";
      if (/^--[^=]+$|^-[A-Za-z]$/.test(previous)) return false;
      return true;
    }
  }
  return false;
}

function isReadOnlyGhInvocation(invocation: ShellInvocation): boolean {
  if (ghRequestsHelp(invocation)) return true;
  const parsed = ghCommand(invocation);
  if (!parsed.command || parsed.commandIndex === undefined) return true;
  if (!READ_ONLY_GH_COMMANDS.has(parsed.command)) return false;
  if (parsed.command === "api")
    return !hasUnsafeApiArguments(
      invocation.tokens.slice(parsed.commandIndex + 1),
    );
  if (["search", "status"].includes(parsed.command)) return true;
  return (
    parsed.subcommand === undefined ||
    READ_ONLY_GH_SUBCOMMANDS.has(parsed.subcommand)
  );
}

function isReadOnlyGhCommand(command: string): boolean {
  const invocations = shellInvocations(command, "gh");
  return invocations.length > 0 && invocations.every(isReadOnlyGhInvocation);
}

function githubHttpInvocations(command: string): ShellInvocation[] {
  return ["curl", "http", "wget"]
    .flatMap((executable) => shellInvocations(command, executable))
    .filter(({ tokens }) =>
      tokens.some((token) =>
        /^(?:https?:\/\/)?(?:(?:api|uploads)\.)?github\.com(?:[/:]|$)/i.test(
          token,
        ),
      ),
    );
}

function isGithubCommand(command: string): boolean {
  return (
    shellInvocations(command, "gh").length > 0 ||
    githubHttpInvocations(command).length > 0
  );
}

function isCtxExecuteTool(toolName: string): boolean {
  return toolName === "ctx_execute" || toolName.endsWith(".ctx_execute");
}

function batchCommands(input: ToolInput | undefined): string[] {
  if (!Array.isArray(input?.commands)) return [];
  return input.commands.flatMap((entry) =>
    entry && typeof entry === "object" && typeof entry.command === "string"
      ? [entry.command]
      : [],
  );
}

function isCtxBatchExecuteTool(toolName: string): boolean {
  return (
    toolName === "ctx_batch_execute" || toolName.endsWith(".ctx_batch_execute")
  );
}

function runtimeShellCommands(code: string): string[] {
  const commands = [
    ...code.matchAll(
      /\b(?:(?:os\.)?system|exec|execSync)\s*\(\s*(["'`])([\s\S]*?)\1/g,
    ),
  ].map((match) => match[2]);
  for (const match of code.matchAll(
    /\bsubprocess\.(?:Popen|call|check_call|check_output|run)\s*\(\s*(["'`])([\s\S]*?)\1[\s\S]{0,240}?\bshell\s*=\s*True\b/g,
  )) {
    commands.push(match[2]);
  }
  return commands;
}

function runtimeExecutables(code: string): string[] {
  return [
    ...code.matchAll(
      /\b(?:Command::new|exec\.Command|execFile|execFileSync|spawn|spawnSync|subprocess\.(?:Popen|call|check_call|check_output|run))\s*\(\s*(?:\[\s*)?(["'])([^"']+)\1/g,
    ),
  ].map((match) => match[2]);
}

function isGithubRuntimeCode(code: string): boolean {
  return (
    runtimeShellCommands(code).some(isGithubCommand) ||
    runtimeExecutables(code).some((executable) =>
      /(?:^|\/)gh(?:\.exe)?$/i.test(executable),
    ) ||
    /https?:\/\/(?:(?:api|uploads)\.)?github\.com(?:[/:]|["'`]|$)/i.test(code)
  );
}

function isGitPushRuntimeCode(code: string): boolean {
  return (
    runtimeShellCommands(code).some(isGitPush) ||
    /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](?:[^"']*\/)?git["'][\s\S]{0,240}["']push["']/i.test(
      code,
    ) ||
    /\bsubprocess\.(?:Popen|call|check_call|check_output|run)\s*\(\s*\[\s*["']git["'][\s\S]{0,240}["']push["']/i.test(
      code,
    )
  );
}

function isGitPush(command: string): boolean {
  return /(?:^|[;&|()]|\s)git(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+push(?:\s|$)/i.test(
    command,
  );
}

function isReadOnlyGithubHttpInvocation(invocation: ShellInvocation): boolean {
  const { tokens, executableIndex: executable } = invocation;
  const client = tokens[executable].split("/").at(-1)?.toLowerCase();
  let method: string | undefined;
  let hasPayload = false;
  for (let index = executable + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["-X", "--method", "--request"].includes(token)) {
      method = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("-X") && token.length > 2) {
      method = token.slice(2);
    } else if (
      token.startsWith("--method=") ||
      token.startsWith("--request=")
    ) {
      method = token.split("=", 2)[1];
    } else if (
      [
        "-d",
        "-F",
        "-T",
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "--form",
        "--form-string",
        "--json",
        "--post-data",
        "--post-file",
        "--upload-file",
      ].includes(token) ||
      /^-(?:d|F|T).+/.test(token) ||
      /^--(?:data(?:-raw|-binary|-urlencode)?|form(?:-string)?|json|post-data|post-file|upload-file)=/.test(
        token,
      )
    ) {
      hasPayload = true;
    } else if (
      client === "http" &&
      /^(?:GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/i.test(token)
    ) {
      method = token;
    } else if (client === "http" && /^[^:=@]+(?::=|=(?!=)|@)/.test(token)) {
      hasPayload = true;
    }
  }
  if (method) return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  return !hasPayload;
}

function isReadOnlyGithubHttpCommand(command: string): boolean {
  const invocations = githubHttpInvocations(command);
  return (
    invocations.length > 0 && invocations.every(isReadOnlyGithubHttpInvocation)
  );
}

function isReadOnlyGithubMcpTool(toolName: string): boolean {
  const words = toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    !words.some((word) => GITHUB_MUTATION_WORDS.has(word)) &&
    words.some((word) => READ_ONLY_MCP_WORDS.has(word))
  );
}

function explicitRepoFromCommand(command: string): string | undefined {
  const urlMatch = command.match(
    /(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s/?#'"\]|]|$)/i,
  );
  if (urlMatch) return normalizeRepo(urlMatch[1]);
  const apiMatch = command.match(
    /(?:^|[\s/])repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i,
  );
  if (apiMatch) return normalizeRepo(`${apiMatch[1]}/${apiMatch[2]}`);
  const tokens = splitShellWords(command);
  for (let index = 0; index < tokens.length; index++) {
    if (["-R", "--repo"].includes(tokens[index]))
      return normalizeRepo(tokens[index + 1]);
    if (tokens[index].startsWith("--repo="))
      return normalizeRepo(tokens[index].slice("--repo=".length));
  }
  const ghIndex = tokens.findIndex((token) =>
    /(?:^|\/)gh(?:\.exe)?$/i.test(token),
  );
  if (ghIndex === -1) return undefined;
  const nouns = new Set(["repo", "pr", "issue", "release", "workflow", "run"]);
  for (let index = ghIndex + 1; index < tokens.length - 2; index++) {
    if (nouns.has(tokens[index].toLowerCase()))
      return normalizeRepo(tokens[index + 2]);
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
  if (toolName.toLowerCase().includes("github"))
    return isReadOnlyGithubMcpTool(toolName)
      ? undefined
      : `GitHub tool: ${toolName}`;

  if (isCtxExecuteTool(toolName)) {
    const code = event.input?.code;
    if (typeof code !== "string") return undefined;
    if (event.input?.language === "shell") {
      if (isGitPush(code)) return "git push may mutate a GitHub remote";
      if (!isGithubCommand(code)) return undefined;
      return isReadOnlyGhCommand(code) || isReadOnlyGithubHttpCommand(code)
        ? undefined
        : "ctx_execute shell code contains a GitHub write or cannot be proven read-only";
    }
    if (isGitPushRuntimeCode(code))
      return "git push may mutate a GitHub remote";
    return isGithubRuntimeCode(code)
      ? "ctx_execute can issue GitHub writes and cannot be proven read-only"
      : undefined;
  }

  if (isCtxBatchExecuteTool(toolName)) {
    const commands = batchCommands(event.input);
    if (commands.some(isGitPush)) return "git push may mutate a GitHub remote";
    return commands.some(
      (command) =>
        isGithubCommand(command) &&
        !isReadOnlyGhCommand(command) &&
        !isReadOnlyGithubHttpCommand(command),
    )
      ? "ctx_batch_execute contains a GitHub write or cannot be proven read-only"
      : undefined;
  }

  if (toolName !== "bash" || typeof event.input?.command !== "string")
    return undefined;
  const command = event.input.command;
  if (isGitPush(command)) return "git push may mutate a GitHub remote";
  if (!isGithubCommand(command)) return undefined;
  return isReadOnlyGhCommand(command) || isReadOnlyGithubHttpCommand(command)
    ? undefined
    : "GitHub command is a write or cannot be proven read-only";
}

export function targetGithubRepo(event: ToolCallEvent): string | undefined {
  if (typeof event.input?.command === "string")
    return explicitRepoFromCommand(event.input.command);
  return (
    batchCommands(event.input)
      .map(explicitRepoFromCommand)
      .find((repo) => repo !== undefined) ?? repoFromInput(event.input)
  );
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", async (event, ctx) => {
    const reason = githubWriteReason(event);
    if (!reason) return undefined;

    const targetRepo = targetGithubRepo(event);
    if (targetRepo && loadWriteAllowlist().has(targetRepo)) return undefined;

    if (!ctx.hasUI || !ctx.ui?.confirm) {
      return {
        block: true,
        reason: `Blocked ${reason}: no interactive confirmation is available.`,
      };
    }

    const request =
      typeof event.input?.command === "string"
        ? { label: "Command", value: redactSecrets(event.input.command) }
        : typeof event.input?.code === "string"
          ? { label: "Code", value: redactSecrets(event.input.code) }
          : batchCommands(event.input).length
            ? {
                label: "Commands",
                value: batchCommands(event.input)
                  .map(redactSecrets)
                  .join("\n\n"),
              }
            : undefined;
    const repoLabel = targetRepo ? `\n\nRepository: ${targetRepo}` : "";
    const allowed = await ctx.ui.confirm(
      "GitHub write confirmation",
      `${reason}.${repoLabel}\n\n${request ? `${request.label}:\n${request.value}\n\n` : ""}Allow this remote write?`,
    );
    return allowed
      ? undefined
      : { block: true, reason: `Blocked ${reason}: user did not confirm.` };
  });
}
