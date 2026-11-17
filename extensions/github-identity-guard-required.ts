import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  batchCommands,
  githubMcpToolName,
  githubWriteAction,
  githubWriteReason,
  guardedGitAction,
  guardedGitRuntimeAction,
  guardedGitTargets,
  hasGhAuthSwitchCommand,
  isCtxBatchExecuteTool,
  shellWritesGithub,
} from "./github-write-confirm.ts";

type ToolInput = {
  command?: unknown;
  code?: unknown;
  commands?: unknown;
  cwd?: unknown;
  language?: unknown;
};
type ToolCallEvent = { toolName?: unknown; input?: ToolInput };
type ToolCallResult = { block: true; reason: string } | undefined;
type ExtensionContext = { cwd: string };
type ExtensionApi = {
  on: (
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallResult,
  ) => void;
};

function repositoryPath(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function gitConfig(repo: string, key: string): string {
  try {
    return execFileSync("git", ["-C", repo, "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function identityGuardRunner(repo: string): string | undefined {
  const runner = gitConfig(repo, "identity.guard.runner");
  return runner && existsSync(runner) ? runner : undefined;
}

function hasIdentityGuard(repo: string): boolean {
  try {
    const user = gitConfig(repo, "identity.guard.user");
    const email = gitConfig(repo, "identity.guard.email");
    if (user && email && identityGuardRunner(repo)) return true;

    const commonGitDir = execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return Boolean(
      user &&
        email &&
        existsSync(join(commonGitDir, "identity-guard", "runner")),
    );
  } catch {
    return false;
  }
}

function githubIdentityMatches(repo: string, token?: string): boolean {
  const runner = identityGuardRunner(repo);
  if (!runner) return false;
  try {
    execFileSync(runner, ["verify-gh"], {
      cwd: repo,
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// The keyring's active account is shared by every process on the machine, so a check of it says nothing about the account
// a later `gh` call uses. A write is only provable when its token is bound by name, in the command or the pi environment.
// shortcut: only a leading `export GH_TOKEN=` set from `gh auth token -u <user>` is recognised, and a reassignment hidden in a quoted
// string (`bash -c 'GH_TOKEN=... gh api'`) is not seen; upgrade when a real command needs another shape.
const TOKEN_PIN =
  /^\s*export\s+GH_TOKEN=("?)\$\(\s*gh\s+auth\s+token((?:\s+(?:-h|--hostname|-u|--user)(?:\s+|=)["']?[\w.-]+["']?)*)\s*\)\1\s*(?:;|&&|\n|#)/;
// Only a real reassignment rebinds the token. Quoted text is dropped first, so `--body "do not set GH_TOKEN=x"` stays words,
// while a subshell or brace group `(GH_TOKEN=y gh api ...)` is still seen because the scan is not tied to a statement start.
const TOKEN_OVERRIDE =
  /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)\s*=|\bunset\b[^;&|\n]*TOKEN|\benv\b[^;&|\n]*\s-u\s*\S*TOKEN/;
const QUOTED = /"[^"]*"|'[^']*'/g;
const unquote = (text: string): string => text.replace(QUOTED, '""');
// Bash still assigns and unsets through a quoted name (`export "GH_TOKEN=y"`, `unset "GH_TOKEN"`), and unquote hides it.
const QUOTED_ASSIGN =
  /\b(?:export|env|unset)\b[^;&|\n]*["'](?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)/;
const rebindsToken = (text: string): boolean =>
  TOKEN_OVERRIDE.test(unquote(text)) || QUOTED_ASSIGN.test(text);
// gh would sign this request with the header instead of the pinned token.
const AUTH_HEADER = /(?:^|\s)(?:-H|--header)[\s=]+["']?authorization\s*:/i;

type TokenPin = { user: string; host?: string };

function tokenPin(command: string): TokenPin | "override" | undefined {
  if (AUTH_HEADER.test(command)) return "override";
  const pin = TOKEN_PIN.exec(command);
  if (!pin) return rebindsToken(command) ? "override" : undefined;
  if (rebindsToken(command.slice(pin[0].length))) return "override";
  const user = /(?:-u|--user)(?:\s+|=)["']?([\w.-]+)/.exec(pin[2])?.[1];
  const host = /(?:-h|--hostname)(?:\s+|=)["']?([\w.-]+)/.exec(pin[2])?.[1];
  // Without `-u` the pin copies whatever account the keyring has active, which is the race again.
  return user ? { user, host } : "override";
}

/** Reads the pinned account's token the way the command will, so an unreadable pin (account not logged in) cannot fall back to the keyring. */
function pinnedToken(repo: string, pin: TokenPin): string | undefined {
  try {
    const runner = identityGuardRunner(repo);
    if (!runner) return undefined;
    const gh = execFileSync(runner, ["find-gh"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const token = execFileSync(
      gh,
      ["auth", "token", ...(pin.host ? ["-h", pin.host] : []), "-u", pin.user],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function scanPins(writes: string[], runtimeWrite: boolean): PinScan {
  const pins = new Map<string, TokenPin>();
  let usesEnvToken = runtimeWrite;
  for (const write of writes) {
    const pin = tokenPin(write);
    if (pin === "override") return { kind: "unknown" };
    if (pin) pins.set(`${pin.host ?? ""}\0${pin.user.toLowerCase()}`, pin);
    else usesEnvToken = true;
  }
  return { kind: "pins", pins: [...pins.values()], usesEnvToken };
}

type PinScan =
  | { kind: "pins"; pins: TokenPin[]; usesEnvToken: boolean }
  | { kind: "unknown" };

/** Why the gh writes in this call cannot be attributed to identity.guard.user, or undefined when they can. */
function githubWriteAuthFailure(
  repo: string,
  writes: string[],
  runtimeWrite: boolean,
  action: string,
): string | undefined {
  const prefix = `GitHub write blocked. Action: ${action}.`;
  const mismatch = `${prefix} The authenticated gh account does not match identity.guard.user.`;
  if (writes.length === 0 && !runtimeWrite)
    return githubIdentityMatches(repo) ? undefined : mismatch;
  const expected = gitConfig(repo, "identity.guard.user");
  const scan = scanPins(writes, runtimeWrite);
  if (scan.kind === "unknown")
    return `${prefix} The command sets or unsets GH_TOKEN after the check could read it, pins it without naming an account, or sends its own Authorization header, so the account that signs the write is unknown. Pin \`export GH_TOKEN="$(gh auth token -u <identity.guard.user>)"\` once, as the first statement, and do not change it.`;
  if (scan.usesEnvToken && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)
    return `${prefix} The gh account is shared by every process on this machine and can change between this check and the write, so the check cannot vouch for it. Start the command with \`export GH_TOKEN="$(gh auth token -h github.com -u ${expected || "<identity.guard.user>"})";\` (or export GH_TOKEN in the pi environment) so the write is bound to that account.`;
  if (scan.usesEnvToken && !githubIdentityMatches(repo)) return mismatch;
  for (const pin of scan.pins) {
    if (pin.user.toLowerCase() !== expected.toLowerCase())
      return `${prefix} The command pins the gh token of '${pin.user}', but identity.guard.user is '${expected}'.`;
    const token = pinnedToken(repo, pin);
    if (!token || !githubIdentityMatches(repo, token))
      return `${prefix} The pinned token for '${pin.user}' is missing or does not authenticate as identity.guard.user.`;
  }
  return undefined;
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", (event, ctx) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    const command =
      typeof event.input?.command === "string" ? event.input.command : undefined;
    const code = typeof event.input?.code === "string" ? event.input.code : undefined;
    const value = command ?? code;
    const commands = batchCommands(event.input);
    const isCtxExecute =
      toolName === "ctx_execute" || toolName.endsWith(".ctx_execute");
    const isCtxBatch = isCtxBatchExecuteTool(toolName);
    const githubReason = githubWriteReason(event);
    const isGithubMcpMutation =
      githubMcpToolName(event) !== undefined && githubReason !== undefined;
    let gitAction: string | undefined;
    if (toolName === "bash" && command !== undefined) {
      gitAction = guardedGitAction(command);
    } else if (isCtxBatch) {
      gitAction = commands.map(guardedGitAction).find((action) => action !== undefined);
    } else if (isCtxExecute && value !== undefined) {
      gitAction =
        event.input?.language === "shell"
          ? guardedGitAction(value)
          : guardedGitRuntimeAction(value);
    }
    const requiresGitIdentity = gitAction !== undefined;
    const requiresGithubIdentity = githubReason !== undefined;
    if (!requiresGitIdentity && !requiresGithubIdentity) return;
    const action = githubWriteAction(event) ?? gitAction ?? toolName;
    const combinesAuthSwitch =
      (value !== undefined && hasGhAuthSwitchCommand(value)) ||
      commands.some((command) => hasGhAuthSwitchCommand(command));
    if (combinesAuthSwitch) {
      return {
        block: true,
        reason: `GitHub write blocked. Action: ${action}. Run \`gh auth switch\` as its own command first, then retry this one separately: this identity check runs against the account active before your command executes, so combining the switch and the write in one invocation can never pass.`,
      };
    }
    if (isGithubMcpMutation) {
      return {
        block: true,
        reason: `GitHub MCP write blocked. Action: ${action}. Git Identity Guard cannot verify the MCP token account. Use a guarded gh command instead.`,
      };
    }

    const cwd =
      typeof event.input?.cwd === "string" ? event.input.cwd : ctx.cwd;
    const shellCommands: string[] = [];
    if (isCtxBatch) shellCommands.push(...commands);
    else if (
      value !== undefined &&
      (toolName === "bash" || event.input?.language === "shell")
    )
      shellCommands.push(value);
    const targetDirs = new Set<string>();
    let unresolved: string | undefined;
    for (const command of requiresGitIdentity ? shellCommands : []) {
      if (guardedGitAction(command) === undefined) continue;
      const targets = guardedGitTargets(command, cwd);
      if ("unresolved" in targets) unresolved ??= targets.unresolved;
      else for (const dir of targets.dirs) targetDirs.add(dir);
    }
    if (targetDirs.size === 0) targetDirs.add(cwd);
    const kind = requiresGithubIdentity ? "GitHub write" : "Git write";
    if (unresolved) {
      return {
        block: true,
        reason: `${kind} blocked. Action: ${action}. Cannot tell which repository this command targets (${unresolved}). Use a literal path (cd <path> && ..., git -C <path> ...) or set the tool's cwd.`,
      };
    }
    const pushOnly = githubReason?.startsWith("git push") === true;
    const ghWrites = shellCommands.filter(shellWritesGithub);
    // Interpreter code cannot be parsed for a pin, so only the pi environment can bind its token.
    const runtimeWrite =
      requiresGithubIdentity && !pushOnly && shellCommands.length === 0;
    const dirs = [
      ...(requiresGitIdentity ? targetDirs : []),
      ...(requiresGithubIdentity && !pushOnly ? [cwd] : []),
    ];
    for (const dir of dirs) {
      const repo = repositoryPath(dir);
      if (!repo || !hasIdentityGuard(repo)) {
        return {
          block: true,
          reason: `${kind} blocked. Action: ${action}. Install Git Identity Guard for this repository before continuing.`,
        };
      }
      if (requiresGithubIdentity) {
        const reason = githubWriteAuthFailure(repo, ghWrites, runtimeWrite, action);
        if (reason) return { block: true, reason };
      }
    }
    return undefined;
  });
}
