import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  "agent-task",
  "alias",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "codespace",
  "completion",
  "config",
  "discussion",
  "extension",
  "gist",
  "gpg-key",
  "issue",
  "label",
  "licenses",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "skill",
  "ssh-key",
  "status",
  "variable",
  "workflow",
]);
const READ_ONLY_GH_SUBCOMMANDS = new Set([
  "check",
  "checks",
  "checkout",
  "clone",
  "diff",
  "download",
  "get",
  "list",
  "logs",
  "ports",
  "preview",
  "search",
  "status",
  "token",
  "trusted-root",
  "verify",
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
    // A `#` that starts a word comments out the rest of the line, so `echo ok # git push` runs no git.
    if (character === "#" && current === "" && (index === 0 || /[\s;&|(]/.test(command[index - 1]))) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
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
      (token !== "{}" &&
        [...token].every((character) => ";&|(){}\n".includes(character))) ||
      /^[<>]\(+$/.test(token)
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
    ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
    ["stdbuf", new Set(["-i", "-o", "-e"])],
    ["setsid", new Set()],
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
      if (executable === "timeout") index += 1;
      continue;
    }
    return index;
  }
  return undefined;
}

type ShellInvocation = { tokens: string[]; executableIndex: number };

const commandName = (token: string) => token.split("/").at(-1)?.toLowerCase();

function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const character = command[i];
    if (character === "\\") i += 1;
    else if (quote === "'") {
      if (character === "'") quote = undefined;
    } else if (character === "'" && !quote) quote = "'";
    else if (character === '"') quote = quote ? undefined : '"';
    else if (character === "$" && command[i + 1] === "(") {
      let depth = 1;
      let end = i + 2;
      for (; end < command.length && depth > 0; end += 1) {
        if (command[end] === "(") depth += 1;
        else if (command[end] === ")") depth -= 1;
      }
      bodies.push(command.slice(i + 2, depth === 0 ? end - 1 : end));
    } else if (character === "`") {
      const close = command.indexOf("`", i + 1);
      const body = command.slice(i + 1, close === -1 ? undefined : close);
      bodies.push(body);
      if (close === -1) break;
      i = close;
    }
  }
  return bodies;
}

/** The script string of each `sh|bash|zsh -c '<script>'` in the command. */
function shellScriptBodies(command: string): string[] {
  return shellCommandSegments(splitShellWords(command)).flatMap((tokens) => {
    const index = executableIndex(tokens);
    if (index === undefined) return [];
    if (!["sh", "bash", "zsh", "dash", "ksh"].includes(commandName(tokens[index]) ?? "")) return [];
    const flag = tokens.findIndex((t, i) => i > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
    return flag === -1 || flag + 1 >= tokens.length ? [] : [tokens[flag + 1]];
  });
}

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RUNTIME_CODE_FLAGS = new Map<string, Set<string>>([
  ["python", new Set(["-c"])],
  ["node", new Set(["-e", "-p", "--eval", "--print"])],
  ["bun", new Set(["-e", "--eval"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e", "-E"])],
  ["php", new Set(["-r"])],
]);

// `python3.12` and `node18` run code like `python` and `node`.
const runtimeName = (name: string) => name.replace(/[\d.]+$/, "");

type Heredoc = { body: string; consumers: Set<string>; expands: boolean };

function consumerNames(line: string): Set<string> {
  return new Set(
    shellCommandSegments(splitShellWords(line)).flatMap((tokens) => {
      const index = executableIndex(tokens);
      return index === undefined ? [] : [commandName(tokens[index]) ?? ""];
    }),
  );
}

/** Heredoc bodies are data unless a shell or interpreter reads them, so they are cut out of the text that gets analysed. */
function parseHeredocs(command: string): { text: string; heredocs: Heredoc[] } {
  const lines = command.split("\n");
  const kept: string[] = [];
  const heredocs: Heredoc[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    kept.push(line);
    let next = i + 1;
    for (const match of line.matchAll(/(?<!<)<<(-?)\s*(?:(["'])(\w+)\2|(\\?)(\w+))/g)) {
      const delimiter = match[3] ?? match[5];
      let end = next;
      while (end < lines.length && (match[1] ? lines[end].trim() : lines[end]) !== delimiter) end += 1;
      // An arithmetic `1<<4` or a quoted `<<` has no closing line, and cutting it as a heredoc would hide every later command.
      if (end >= lines.length) continue;
      heredocs.push({
        body: lines.slice(next, end).join("\n"),
        consumers: consumerNames(line),
        expands: match[2] === undefined && match[4] === "",
      });
      next = end + 1;
    }
    i = next - 1;
  }
  return { text: kept.join("\n"), heredocs };
}

/** Heredoc text a shell will run, plus the `$(...)` inside unquoted data heredocs, which expand even for `cat`. */
function heredocShellBodies(heredocs: Heredoc[]): string[] {
  return heredocs.flatMap(({ body, consumers, expands }) => {
    if ([...consumers].some((name) => SHELL_NAMES.has(name) || ["ssh", "source", "."].includes(name))) return [body];
    return expands ? body.split("\n").flatMap(substitutionBodies) : [];
  });
}

/** Line continuations, `$(which git)` and simple `name=word` assignments are resolved so `g=gh; $g pr merge 1` reads as the gh command it is. */
function normalizeShell(text: string): string {
  const lookups = text.replace(/\\\r?\n/g, " ").replace(
    /\$\(\s*(?:which|command\s+-v|type\s+-p|echo)\s+([\w./-]+)\s*\)|`\s*(?:which|command\s+-v|type\s+-p|echo)\s+([\w./-]+)\s*`/g,
    (_match, parenthesised, backticked) => parenthesised ?? backticked,
  );
  const values = new Map<string, string>();
  // One left-to-right pass, so `g=gh; $g pr merge 1; g=echo` still reads `$g` as gh.
  return lookups.replace(
    /(?:^|[;&|(\n]\s*)(?:(?:export|local|readonly|typeset|declare(?:\s+-\w+)*)\s+)?([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s"'`$;&|()<>]+))(?=\s*(?:[;&|)\n]|$))|\$\{?([A-Za-z_]\w*)\}?/g,
    (match, name, double, single, bare, used) => {
      if (used !== undefined) return values.get(used) ?? match;
      values.set(name, double ?? single ?? bare);
      return match;
    },
  );
}

function shellText(command: string): string {
  return normalizeShell(parseHeredocs(command).text);
}

/** Strings a shell runs that never appear as a command word: `eval` arguments, `echo '...' | sh` and `sh <<< '...'`. */
function evalAndPipedBodies(command: string): string[] {
  const segments: { tokens: string[]; afterPipe: boolean }[] = [];
  let tokens: string[] = [];
  let afterPipe = false;
  for (const token of splitShellWords(command)) {
    if (token !== "{}" && [...token].every((character) => ";&|(){}\n".includes(character))) {
      if (tokens.length > 0) segments.push({ tokens, afterPipe });
      tokens = [];
      afterPipe = token === "|";
    } else tokens.push(token);
  }
  if (tokens.length > 0) segments.push({ tokens, afterPipe });
  const bodies: string[] = [];
  segments.forEach(({ tokens: words, afterPipe: piped }, i) => {
    const index = executableIndex(words);
    if (index === undefined) return;
    const name = commandName(words[index]) ?? "";
    if (name === "eval") bodies.push(words.slice(index + 1).join(" "));
    if (!SHELL_NAMES.has(name) || words.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))) return;
    const here = words.indexOf("<<<");
    if (here !== -1 && words[here + 1] !== undefined) bodies.push(words[here + 1]);
    const feeder = piped ? segments[i - 1]?.tokens : undefined;
    const feederIndex = feeder ? executableIndex(feeder) : undefined;
    if (feeder && feederIndex !== undefined && ["echo", "printf"].includes(commandName(feeder[feederIndex]) ?? ""))
      bodies.push(feeder.slice(feederIndex + 1).filter((word) => !word.startsWith("-")).join(" "));
  });
  return bodies;
}

function nestedBodies(command: string): string[] {
  return [
    ...substitutionBodies(command),
    ...shellScriptBodies(command),
    ...evalAndPipedBodies(command),
  ].flatMap((body) => [body, ...nestedBodies(body)]);
}

/** The command plus every nested `$(...)`, backtick, `sh -c`, `eval` or piped-to-shell body, tokenized separately so an unclosed quote in one cannot swallow the next. */
function shellTokenLists(command: string): string[][] {
  const { text, heredocs } = parseHeredocs(command);
  const sources = [text, ...heredocShellBodies(heredocs)].map(normalizeShell);
  return sources.flatMap((source) => [source, ...nestedBodies(source)]).map(splitShellWords);
}

/** Code handed to python -c, node -e, perl -e, ruby -e or a heredoc fed to an interpreter. */
function inlineRuntimeCodes(command: string): string[] {
  const { text, heredocs } = parseHeredocs(command);
  const fromHeredocs = heredocs
    .filter(({ consumers }) => [...consumers].some((name) => RUNTIME_CODE_FLAGS.has(runtimeName(name))))
    .map(({ body }) => body);
  const source = normalizeShell(text);
  const fromFlags = [source, ...nestedBodies(source)].flatMap((body) =>
    shellCommandSegments(splitShellWords(body)).flatMap((tokens) => {
      const index = executableIndex(tokens);
      const flags = index === undefined ? undefined : RUNTIME_CODE_FLAGS.get(runtimeName(commandName(tokens[index]) ?? ""));
      const flag = flags ? tokens.findIndex((token, i) => i > (index ?? 0) && flags.has(token)) : -1;
      return flag === -1 || tokens[flag + 1] === undefined ? [] : [tokens[flag + 1]];
    }),
  );
  return [...fromHeredocs, ...fromFlags].map(resolveRuntimeAliases);
}

/** `import subprocess as sp` and `from subprocess import run` hide the calls the runtime checks look for. */
function resolveRuntimeAliases(code: string): string {
  let resolved = code;
  for (const [, module, alias] of code.matchAll(/\bimport\s+(subprocess|os)\s+as\s+(\w+)/g))
    resolved = resolved.replace(new RegExp(`\\b${alias}\\.`, "g"), `${module}.`);
  for (const [, names] of code.matchAll(/\bfrom\s+subprocess\s+import[ \t]+([\w \t,]+)/g))
    for (const name of names.split(",").map((part) => part.trim()).filter(Boolean))
      resolved = resolved.replace(new RegExp(`(?<![.\\w])${name}\\(`, "g"), `subprocess.${name}(`);
  return resolved;
}

function shellInvocations(
  command: string,
  executable: string,
): ShellInvocation[] {
  return shellTokenLists(command)
    .flatMap(shellCommandSegments)
    .flatMap((tokens) => {
    const index = executableIndex(tokens);
    if (index === undefined) return [];
    const name = commandName(tokens[index]);
    if (name === executable) return [{ tokens, executableIndex: index }];
    if (name !== "xargs" && name !== "find") return [];
    return tokens.flatMap((token, i) =>
      i > index && commandName(token) === executable
        ? [{ tokens, executableIndex: i }]
        : [],
    );
  });
}

function gitSubcommand(invocation: ShellInvocation): string | undefined {
  const valueOptions = new Set([
    "-C",
    "-c",
    "--config-env",
    "--git-dir",
    "--namespace",
    "--work-tree",
  ]);
  for (
    let index = invocation.executableIndex + 1;
    index < invocation.tokens.length;
    index += 1
  ) {
    const token = invocation.tokens[index];
    if (valueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      [...valueOptions].some((option) => token.startsWith(`${option}=`))
    )
      continue;
    if (!token.startsWith("-")) return token.toLowerCase();
  }
  return undefined;
}

// These create commits with the configured author, so they leak the wrong identity just like `git commit`.
const HISTORY_SUBCOMMANDS = ["merge", "rebase", "cherry-pick", "revert", "am"];
const NON_COMMITTING_FLAGS = new Set(["--abort", "--quit", "--no-commit", "--ff-only", "--dry-run"]);

function isGuardedInvocation(invocation: ShellInvocation): boolean {
  const subcommand = gitSubcommand(invocation);
  const args = invocation.tokens.slice(invocation.executableIndex + 1);
  if (subcommand === "push") return !args.some((arg) => arg === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(arg));
  if (subcommand === "commit") return !args.includes("--dry-run");
  return subcommand !== undefined && HISTORY_SUBCOMMANDS.includes(subcommand) && !args.some((arg) => NON_COMMITTING_FLAGS.has(arg));
}

export function guardedGitAction(command: string): string | undefined {
  for (const invocation of shellInvocations(command, "git")) {
    if (isGuardedInvocation(invocation)) return `git ${gitSubcommand(invocation)}`;
  }
  return inlineRuntimeCodes(command).map(guardedGitRuntimeAction).find((action) => action !== undefined);
}

export type GitTargets = { dirs: string[] } | { unresolved: string };

const SEQUENCE_SEPARATOR = /^(?:[;\n]+|&&|\|\|)$/;

function resolveDirectory(base: string, raw: string): string | undefined {
  if (/[$`*?\[]/.test(raw) || raw === "-" || /^~[^/]/.test(raw)) {
    return undefined;
  }
  if (raw === "~" || raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(base, raw);
}

function gitTargetDirs(
  words: string[],
  index: number,
  bases: Set<string>,
): string[] | string {
  for (const word of words.slice(0, index)) {
    if (/^(GIT_DIR|GIT_WORK_TREE)=/.test(word)) return "GIT_DIR or GIT_WORK_TREE is set";
    if (word === "-C" || word.startsWith("--chdir")) return "a wrapper changes the directory";
  }
  let dirs = [...bases];
  for (let i = index + 1; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith("--git-dir") || word.startsWith("--work-tree")) {
      return "--git-dir or --work-tree is used";
    }
    if (word === "-C") {
      const next = words[i + 1];
      const resolved = next === undefined ? [] : dirs.map((d) => resolveDirectory(d, next));
      if (resolved.length === 0 || resolved.includes(undefined)) {
        return `cannot resolve the path after -C (${next ?? "missing"})`;
      }
      dirs = resolved as string[];
      i += 1;
    } else if (["-c", "--config-env", "--namespace"].includes(word)) {
      i += 1;
    } else if (!word.startsWith("-")) {
      break;
    }
  }
  return dirs;
}

/**
 * The directories a guarded git command (commit/push) may really run in.
 * Follows leading `cd <path> &&` and `git -C <path>`; anything it cannot
 * resolve statically is reported as unresolved so the caller refuses it
 * instead of guessing. After `;`, `||` or a newline the previous directory
 * stays possible, because a failed `cd` does not stop the next command.
 */
export function guardedGitTargets(command: string, cwd: string): GitTargets {
  const parts: { words: string[]; separator?: string }[] = [];
  let words: string[] = [];
  for (const token of splitShellWords(shellText(command))) {
    if ([...token].every((c) => ";&|()\n{}".includes(c))) {
      parts.push({ words, separator: token });
      words = [];
    } else {
      words.push(token);
    }
  }
  parts.push({ words });

  const complex = parts.some(
    ({ separator }) => separator !== undefined && !SEQUENCE_SEPARATOR.test(separator),
  );
  const targets = new Set<string>();
  let state = new Set([cwd]);
  let chainStart = state;
  let direct = 0;

  for (const { words: segment, separator } of parts) {
    const index = executableIndex(segment);
    const name = index === undefined ? undefined : segment[index].split("/").at(-1)?.toLowerCase();
    let next = state;

    if (index !== undefined && (name === "pushd" || name === "popd")) {
      return { unresolved: `${name} is not supported` };
    }
    if (index !== undefined && name === "cd") {
      if (complex) return { unresolved: "cd inside a pipeline, subshell or group" };
      const raw = segment.slice(index + 1).find((w) => !["-L", "-P", "-e", "-@", "--"].includes(w)) ?? "~";
      const resolved = [...state].map((d) => resolveDirectory(d, raw));
      if (resolved.includes(undefined)) return { unresolved: `cannot resolve cd ${raw}` };
      next = new Set(resolved as string[]);
    } else if (index !== undefined && name === "git") {
      if (isGuardedInvocation({ tokens: segment, executableIndex: index })) {
        const dirs = gitTargetDirs(segment, index, state);
        if (typeof dirs === "string") return { unresolved: dirs };
        for (const dir of dirs) targets.add(dir);
        direct += 1;
      }
    }

    if (separator === "&&") {
      state = next;
    } else {
      state = new Set([...chainStart, ...next]);
      chainStart = state;
    }
  }
  const guarded = shellInvocations(command, "git").filter(isGuardedInvocation);
  if (guarded.length !== direct) {
    return { unresolved: "git runs inside a nested shell, substitution, xargs or find" };
  }
  if (inlineRuntimeCodes(command).some((code) => guardedGitRuntimeAction(code) !== undefined)) {
    return { unresolved: "git runs inside interpreter code" };
  }
  return { dirs: [...targets] };
}

export function isGuardedGitCommand(command: string): boolean {
  return guardedGitAction(command) !== undefined;
}

function ghSubcommandChain(invocation: ShellInvocation): string[] {
  const chain: string[] = [];
  for (
    let index = invocation.executableIndex + 1;
    index < invocation.tokens.length && chain.length < 2;
    index += 1
  ) {
    const token = invocation.tokens[index];
    if (!token.startsWith("-")) chain.push(token.toLowerCase());
  }
  return chain;
}

export function hasGhAuthSwitchCommand(command: string): boolean {
  return shellInvocations(command, "gh").some((invocation) => {
    const [first, second] = ghSubcommandChain(invocation);
    return first === "auth" && (second === "switch" || second === "login");
  });
}

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
]);

function apiArgument(
  token: string,
  next: string | undefined,
): { name: string; value?: string; consumesNext: boolean } {
  if (API_VALUE_FLAGS.has(token))
    return { name: token, value: next, consumesNext: true };
  const long = token.match(/^(--[^=]+)=([\s\S]*)$/);
  if (long) return { name: long[1], value: long[2], consumesNext: false };
  const short = token.match(/^(-[A-Za-z])([\s\S]+)$/);
  if (short && API_VALUE_FLAGS.has(short[1]))
    return { name: short[1], value: short[2], consumesNext: false };
  return { name: token, consumesNext: false };
}

function isReadOnlyGraphqlDocument(document: string): boolean {
  const stripped = document.replace(/#[^\n]*/g, " ");
  if (/\b(?:mutation|subscription)\b/i.test(stripped)) return false;
  return /^\s*(?:query\b|\{|fragment\b)/.test(stripped);
}

function hasUnsafeApiArguments(tokens: string[]): boolean {
  let method: string | undefined;
  let hasPayload = false;
  let endpoint: string | undefined;
  let graphqlQuery: string | undefined;
  let opaquePayload = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const { name, value, consumesNext } = apiArgument(
      tokens[index],
      tokens[index + 1],
    );
    if (consumesNext) index += 1;
    if (["-X", "--method"].includes(name)) {
      method = value;
    } else if (["-f", "--raw-field", "-F", "--field"].includes(name)) {
      hasPayload = true;
      const field = value ?? "";
      const separator = field.indexOf("=");
      if (separator === -1) opaquePayload = true;
      else if (field.slice(0, separator) === "query") {
        const document = field.slice(separator + 1);
        if (document.startsWith("@")) opaquePayload = true;
        else graphqlQuery = document;
      }
    } else if (name === "--input") {
      hasPayload = true;
      opaquePayload = true;
    } else if (!name.startsWith("-") && endpoint === undefined) {
      endpoint = name;
    }
  }
  if (
    endpoint === "graphql" &&
    !opaquePayload &&
    graphqlQuery !== undefined &&
    isReadOnlyGraphqlDocument(graphqlQuery)
  )
    return (
      method !== undefined && !["GET", "POST"].includes(method.toUpperCase())
    );
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
  if (
    ["browse", "completion", "search", "status"].includes(parsed.command) ||
    (parsed.command === "auth" && parsed.subcommand === "switch")
  )
    return true;
  return (
    parsed.subcommand === undefined ||
    READ_ONLY_GH_SUBCOMMANDS.has(parsed.subcommand)
  );
}

// A `gh` argument to these only names or searches for the program, so it is not an unparsed call.
const LOOKUP_COMMANDS = new Set(["which", "whereis", "type", "echo", "printf", "grep", "egrep", "fgrep", "rg", "ls", "brew", "man"]);

function isReadOnlyGhCommand(command: string): boolean {
  const invocations = shellInvocations(command, "gh");
  const ghTokens = shellTokenLists(command)
    .flatMap(shellCommandSegments)
    .flatMap((segment) => {
      const index = executableIndex(segment);
      if (index !== undefined && LOOKUP_COMMANDS.has(commandName(segment[index]) ?? "")) return [];
      return segment.filter((token) => /(?:^|\/)gh(?:\.exe)?$/i.test(token));
    });
  return (
    invocations.length > 0 &&
    invocations.length === ghTokens.length &&
    invocations.every(isReadOnlyGhInvocation)
  );
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

/** Every gh call and every GitHub HTTP call in the command must be a read, not just one of the two kinds. */
function isReadOnlyGithubCommand(command: string): boolean {
  const ghReadOnly = shellInvocations(command, "gh").length === 0 || isReadOnlyGhCommand(command);
  const httpReadOnly = githubHttpInvocations(command).length === 0 || isReadOnlyGithubHttpCommand(command);
  return ghReadOnly && httpReadOnly;
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

function quotedArguments(value: string): string[] | undefined {
  const arguments_: string[] = [];
  const pattern = /(["'])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let remainder = "";
  let end = 0;
  for (const match of value.matchAll(pattern)) {
    remainder += value.slice(end, match.index);
    arguments_.push(match[2].replace(/\\(["'\\])/g, "$1"));
    end = (match.index ?? 0) + match[0].length;
  }
  remainder += value.slice(end);
  return arguments_.length > 0 && /^[\s,]*$/.test(remainder)
    ? arguments_
    : undefined;
}

function runtimeGhInvocations(code: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  for (const match of code.matchAll(
    /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*(["'])([^"']*\/?gh(?:\.exe)?)\1\s*,\s*\[([\s\S]*?)\]\s*\)/gi,
  )) {
    const arguments_ = quotedArguments(match[3]);
    if (arguments_)
      invocations.push({
        tokens: [match[2], ...arguments_],
        executableIndex: 0,
      });
  }
  for (const match of code.matchAll(
    /\bsubprocess\.(?:Popen|call|check_call|check_output|run)\s*\(\s*\[\s*(["'])([^"']*\/?gh(?:\.exe)?)\1\s*,?([\s\S]*?)\]([\s\S]*?)\)/gi,
  )) {
    const arguments_ = quotedArguments(match[3]);
    const options = match[4];
    const hasOnlyStaticOptions =
      /^(?:\s*,\s*[A-Za-z_]\w*\s*=\s*(?:True|False|None|["'][^"']*["']|\d+))*\s*,?\s*$/.test(
        options,
      );
    if (arguments_ && hasOnlyStaticOptions && !/\bshell\s*=/.test(options))
      invocations.push({
        tokens: [match[2], ...arguments_],
        executableIndex: 0,
      });
  }
  return invocations;
}

const GITHUB_URL = /https?:\/\/(?:(?:api|uploads)\.)?github\.com(?:[/:]|["'`]|$)|["'](?:api|uploads)\.github\.com["']/i;
const GITHUB_SDK = /\bfrom\s+github\s+import\b|\bimport\s+github\b|@octokit\/|\bnew\s+Octokit\b|\bPyGithub\b/;
const HTTP_CALL = /\brequests\.(?:get|post|put|patch|delete|request|Session)\b|\b(?:httpx|aiohttp)\.[a-z]|\burllib\.request\b|\burlopen\(|\baxios(?:\.[a-z]|\()|XMLHttpRequest|Net::HTTP|\bcurl_exec\(|\bfetch\(|\bhttps?\.(?:get|post|request|newrequest)\(/i;

// Clients whose GET we cannot tell from a POST: one next to a GitHub URL is a call, never a proven read.
const HTTP_IMPORT =
  /\b(?:import|from)\s+(?:urllib3|http\.client|pycurl|httplib2)\b|require\(\s*["'](?:got|superagent|undici|ky|request|needle)["']\s*\)|\bfrom\s+["'](?:got|superagent|undici|ky|needle)["']|\bHTTParty\b|\bFaraday\b|\bRestClient\b|\breqwest::/;

// Clients whose methods are only recognisable once imported: `import requests as r; r.delete(url)`, `from requests import post`.
const HTTP_CLIENT_IMPORT =
  /\b(?:import|from)\s+(?:requests|httpx|aiohttp|urllib\.request)\b|require\(\s*["'](?:axios|node-fetch)["']\s*\)|\bfrom\s+["'](?:axios|node-fetch)["']/;

// Only call syntax counts as a write here: a quoted "POST" or a `data=` in a doc edit or test fixture is text, not a request.
// `.delete(` and a bare `post(` count only next to an imported client, so `Map.delete(x)` in a doc edit stays quiet.
const httpWriteCall = (code: string) =>
  /\.(?:post|put|patch)\s*\(/i.test(code) ||
  (HTTP_CLIENT_IMPORT.test(code) && /\b(?:post|put|patch|delete|request)\s*\(/.test(code));

// A github.com string in a script that never makes an HTTP call (a doc edit, a test fixture) is not a request.
const callsGithubOverHttp = (code: string) =>
  GITHUB_URL.test(code) && (HTTP_CALL.test(code) || HTTP_IMPORT.test(code) || httpWriteCall(code));

// urlopen(url, data) and Request(url, data) send a POST when the second argument is positional.
function isReadOnlyRuntimeHttp(code: string): boolean {
  return !(
    httpWriteCall(code) ||
    /\.(?:post|put|patch|delete)\s*\(|\bmethod\s*[:=]|["'](?:POST|PUT|PATCH|DELETE)["']|(?<=[(,{]\s*)(?:data|json|body|payload|files)\s*[:=](?!=)|\b(?:urlopen|Request)\(\s*[^,)]+,(?!\s*\w+\s*=)/i.test(code)
  );
}

function hasOnlyReadOnlyGithubRuntimeCommands(code: string): boolean {
  if (GITHUB_SDK.test(code)) return false;
  const shellCommands = runtimeShellCommands(code).filter(isGithubCommand);
  if (shellCommands.some((command) => !isReadOnlyGithubCommand(command))) return false;

  const ghExecutables = runtimeExecutables(code).filter((executable) =>
    /(?:^|\/)gh(?:\.exe)?$/i.test(executable),
  );
  const ghInvocations = runtimeGhInvocations(code);
  if (ghInvocations.length !== ghExecutables.length || !ghInvocations.every(isReadOnlyGhInvocation)) return false;
  const hasUrl = callsGithubOverHttp(code);
  if (hasUrl && (!isReadOnlyRuntimeHttp(code) || HTTP_IMPORT.test(code))) return false;
  return shellCommands.length + ghExecutables.length > 0 || hasUrl;
}

function isGithubRuntimeCode(code: string): boolean {
  return (
    runtimeShellCommands(code).some(isGithubCommand) ||
    runtimeExecutables(code).some((executable) =>
      /(?:^|\/)gh(?:\.exe)?$/i.test(executable),
    ) ||
    callsGithubOverHttp(code) ||
    GITHUB_SDK.test(code)
  );
}

export function guardedGitRuntimeAction(source: string): string | undefined {
  const code = resolveRuntimeAliases(source);
  const shellAction = runtimeShellCommands(code)
    .map(guardedGitAction)
    .find((action) => action !== undefined);
  if (shellAction) return shellAction;
  const match = code.match(
    /\b(?:execFile|execFileSync|spawn|spawnSync|subprocess\.(?:Popen|call|check_call|check_output|run))\s*\(\s*(?:\[\s*)?["'](?:[^"']*\/)?git["'][\s\S]{0,240}["'](commit|push|merge|rebase|cherry-pick|revert|am)["']/i,
  );
  return match ? `git ${match[1].toLowerCase()}` : undefined;
}

export function isGuardedGitRuntimeCode(code: string): boolean {
  return guardedGitRuntimeAction(code) !== undefined;
}

function isGitPushRuntimeCode(source: string): boolean {
  const code = resolveRuntimeAliases(source);
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
  return shellInvocations(command, "git").some(
    (invocation) => gitSubcommand(invocation) === "push" && isGuardedInvocation(invocation),
  );
}

function shellPushes(command: string): boolean {
  return isGitPush(command) || inlineRuntimeCodes(command).some(isGitPushRuntimeCode);
}

function shellWritesGithub(command: string): boolean {
  const inlineWrite = inlineRuntimeCodes(command).some(
    (code) => isGithubRuntimeCode(code) && !hasOnlyReadOnlyGithubRuntimeCommands(code),
  );
  return inlineWrite || (isGithubCommand(command) && !isReadOnlyGithubCommand(command));
}

function isReadOnlyGraphqlRequest(tokens: string[]): boolean {
  if (!tokens.some((token) => /github\.com\/graphql\/?$/i.test(token))) return false;
  const body = tokens.find((token) => token.startsWith("{") && token.includes("query"));
  try {
    const { query } = JSON.parse(body ?? "");
    return typeof query === "string" && isReadOnlyGraphqlDocument(query);
  } catch {
    return false;
  }
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
  if (isReadOnlyGraphqlRequest(tokens) && (!method || method.toUpperCase() === "POST")) return true;
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

function githubActionFromCommand(command: string): string | undefined {
  if (shellPushes(command)) return "git push";
  const ghInvocation = shellInvocations(command, "gh").find(
    (invocation) => !isReadOnlyGhInvocation(invocation),
  );
  if (ghInvocation) {
    const parsed = ghCommand(ghInvocation);
    if (parsed.command === "api") return "gh api";
    return ["gh", parsed.command, parsed.subcommand].filter(Boolean).join(" ");
  }
  const httpInvocation = githubHttpInvocations(command).find(
    (invocation) => !isReadOnlyGithubHttpInvocation(invocation),
  );
  if (httpInvocation) {
    const executable = httpInvocation.tokens[httpInvocation.executableIndex]
      .split("/")
      .at(-1);
    return `${executable ?? "HTTP client"} GitHub request`;
  }
  return inlineRuntimeCodes(command).some(isGithubRuntimeCode) ? "GitHub request in interpreter code" : undefined;
}

const GITHUB_TOOL_NAME = /github|(?:^|[^a-z0-9])gh(?:[^a-z0-9]|$)/i;

/** Name of a GitHub MCP call, including adapter proxies (`mcp` with server github, `...__mcp__github`) whose real operation is in `input.tool`. */
export function githubMcpToolName(event: ToolCallEvent): string | undefined {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const { server, tool } = event.input ?? {};
  if (toolName === "mcp" && typeof server === "string" && /github/i.test(server))
    return `github_${typeof tool === "string" ? tool : "list"}`;
  if (!GITHUB_TOOL_NAME.test(toolName)) return undefined;
  return typeof tool === "string" ? `${toolName}_${tool}` : toolName;
}

export function githubWriteAction(event: ToolCallEvent): string | undefined {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const mcpName = githubMcpToolName(event);
  if (mcpName) return mcpName;
  if (isCtxExecuteTool(toolName)) {
    const code = event.input?.code;
    if (typeof code !== "string") return undefined;
    if (event.input?.language === "shell") return githubActionFromCommand(code);
    if (isGitPushRuntimeCode(code)) return "git push";
    const shellAction = runtimeShellCommands(code)
      .map(githubActionFromCommand)
      .find((action) => action !== undefined);
    if (shellAction) return shellAction;
    if (
      runtimeExecutables(code).some((executable) =>
        /(?:^|\/)gh(?:\.exe)?$/i.test(executable),
      )
    ) {
      return "gh runtime invocation";
    }
    return /https?:\/\/(?:(?:api|uploads)\.)?github\.com(?:[/:]|["'`]|$)/i.test(
      code,
    )
      ? "GitHub HTTP request"
      : undefined;
  }
  if (isCtxBatchExecuteTool(toolName)) {
    return batchCommands(event.input)
      .map(githubActionFromCommand)
      .find((action) => action !== undefined);
  }
  return typeof event.input?.command === "string"
    ? githubActionFromCommand(event.input.command)
    : undefined;
}

export function githubWriteReason(event: ToolCallEvent): string | undefined {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const mcpName = githubMcpToolName(event);
  if (mcpName)
    return isReadOnlyGithubMcpTool(mcpName) ? undefined : `GitHub tool: ${mcpName}`;

  if (isCtxExecuteTool(toolName)) {
    const code = event.input?.code;
    if (typeof code !== "string") return undefined;
    if (event.input?.language === "shell") {
      if (shellPushes(code)) return "git push may mutate a GitHub remote";
      return shellWritesGithub(code)
        ? "ctx_execute shell code contains a GitHub write or cannot be proven read-only"
        : undefined;
    }
    const runtime = resolveRuntimeAliases(code);
    if (isGitPushRuntimeCode(runtime))
      return "git push may mutate a GitHub remote";
    if (hasOnlyReadOnlyGithubRuntimeCommands(runtime)) return undefined;
    return isGithubRuntimeCode(runtime)
      ? "ctx_execute can issue GitHub writes and cannot be proven read-only"
      : undefined;
  }

  if (isCtxBatchExecuteTool(toolName)) {
    const commands = batchCommands(event.input);
    if (commands.some(shellPushes)) return "git push may mutate a GitHub remote";
    return commands.some(shellWritesGithub)
      ? "ctx_batch_execute contains a GitHub write or cannot be proven read-only"
      : undefined;
  }

  if (toolName !== "bash" || typeof event.input?.command !== "string")
    return undefined;
  const command = event.input.command;
  if (shellPushes(command)) return "git push may mutate a GitHub remote";
  return shellWritesGithub(command)
    ? "GitHub command is a write or cannot be proven read-only"
    : undefined;
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

// The value of these flags is text the user wrote, so a GitHub URL there does not say which repository is written.
const TEXT_VALUE_FLAGS = new Set([
  "-b", "--body", "-t", "--title", "-m", "--message", "-n", "--notes", "-c", "--comment", "--description",
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-H", "--header", "-f", "--raw-field", "-F", "--field",
]);

function invocationRepo(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "-R" || tokens[index] === "--repo") return normalizeRepo(tokens[index + 1]);
    if (tokens[index].startsWith("--repo=")) return normalizeRepo(tokens[index].slice("--repo=".length));
  }
  for (const [index, token] of tokens.entries()) {
    if (TEXT_VALUE_FLAGS.has(tokens[index - 1])) continue;
    const url = token.match(
      /^(?:https?:\/\/(?:api\.|uploads\.)?github\.com\/(?:repos\/)?|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i,
    );
    if (url) return normalizeRepo(url[1]);
    const api = token.match(/^\/?repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
    if (api) return normalizeRepo(api[1]);
  }
  const repoIndex = tokens.findIndex((token) => token.toLowerCase() === "repo");
  return repoIndex === -1 ? undefined : normalizeRepo(tokens[repoIndex + 2]);
}

function githubWriteInvocations(command: string): ShellInvocation[] {
  return [
    ...shellInvocations(command, "gh").filter((invocation) => !isReadOnlyGhInvocation(invocation)),
    ...githubHttpInvocations(command).filter((invocation) => !isReadOnlyGithubHttpInvocation(invocation)),
  ];
}

function shellCommandsOf(event: ToolCallEvent): string[] | undefined {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const { command, code, language } = event.input ?? {};
  if (toolName === "bash" && typeof command === "string") return [command];
  if (isCtxExecuteTool(toolName) && language === "shell" && typeof code === "string") return [code];
  if (isCtxBatchExecuteTool(toolName)) return batchCommands(event.input);
  return undefined;
}

/** Skips the prompt only when every write in the call names an allowlisted repo, so a chained `&& gh pr merge -R other/repo` or `&& git push` still asks. */
function allowlistCovers(event: ToolCallEvent): boolean {
  const allowed = loadWriteAllowlist();
  if (allowed.size === 0) return false;
  const commands = shellCommandsOf(event);
  if (!commands) {
    const repo = repoFromInput(event.input);
    return repo !== undefined && allowed.has(repo);
  }
  let writes = 0;
  for (const command of commands) {
    if (shellPushes(command) || inlineRuntimeCodes(command).some(isGithubRuntimeCode)) return false;
    for (const invocation of githubWriteInvocations(command)) {
      const repo = invocationRepo(invocation.tokens);
      if (!repo || !allowed.has(repo)) return false;
      writes += 1;
    }
  }
  return writes > 0;
}

function notifyPendingConfirmation(action: string, repo?: string): void {
  if (
    process.platform !== "darwin" ||
    process.env.PI_GITHUB_WRITE_CONFIRM_NOTIFY === "0"
  )
    return;
  const notice = repo ? `${action} → ${repo}` : action;
  execFile(
    "open",
    [
      "-a",
      "terminal-notifier",
      "--args",
      "-title",
      "Waiting for your confirmation",
      "-message",
      notice,
      "-sound",
      "Ping",
    ],
    (error) => {
      if (!error) return;
      execFile(
        "osascript",
        [
          "-e",
          "on run {noticeText, noticeTitle}",
          "-e",
          'display notification noticeText with title noticeTitle sound name "Ping"',
          "-e",
          "end run",
          "--",
          notice,
          "Waiting for your confirmation",
        ],
        () => {},
      );
    },
  );
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", async (event, ctx) => {
    const reason = githubWriteReason(event);
    if (!reason) return undefined;
    const action = githubWriteAction(event) ?? "unknown GitHub write";

    if (allowlistCovers(event)) return undefined;
    const targetRepo = targetGithubRepo(event);

    if (!ctx.hasUI || !ctx.ui?.confirm) {
      return {
        block: true,
        reason: `Blocked ${reason}. Action: ${action}. No interactive confirmation is available.`,
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
    notifyPendingConfirmation(action, targetRepo);
    const allowed = await ctx.ui.confirm(
      "GitHub write confirmation",
      `${reason}.\n\nAction: ${action}.${repoLabel}\n\n${request ? `${request.label}:\n${request.value}\n\n` : ""}Allow this remote write?`,
    );
    return allowed
      ? undefined
      : {
          block: true,
          reason: `Blocked ${reason}. Action: ${action}. User did not confirm.`,
        };
  });
}
