import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  githubWriteAction,
  githubWriteReason,
  guardedGitAction,
  guardedGitRuntimeAction,
  hasGhAuthSwitchCommand,
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

function batchCommands(input: ToolInput | undefined): string[] {
  if (!Array.isArray(input?.commands)) return [];
  return input.commands.flatMap((entry) =>
    entry && typeof entry === "object" && typeof entry.command === "string"
      ? [entry.command]
      : [],
  );
}

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

function identityGuardRunner(repo: string): string | undefined {
  try {
    const runner = execFileSync(
      "git",
      ["-C", repo, "config", "--get", "identity.guard.runner"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return runner && existsSync(runner) ? runner : undefined;
  } catch {
    return undefined;
  }
}

function hasIdentityGuard(repo: string): boolean {
  try {
    const user = execFileSync(
      "git",
      ["-C", repo, "config", "--get", "identity.guard.user"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const email = execFileSync(
      "git",
      ["-C", repo, "config", "--get", "identity.guard.email"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
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

function githubIdentityMatches(repo: string): boolean {
  const runner = identityGuardRunner(repo);
  if (!runner) return false;
  try {
    execFileSync(runner, ["verify-gh"], {
      cwd: repo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", (event, ctx) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    const value =
      typeof event.input?.command === "string"
        ? event.input.command
        : typeof event.input?.code === "string"
          ? event.input.code
          : undefined;
    const commands = batchCommands(event.input);
    const isCtxExecute =
      toolName === "ctx_execute" || toolName.endsWith(".ctx_execute");
    const isCtxBatch =
      toolName === "ctx_batch_execute" ||
      toolName.endsWith(".ctx_batch_execute");
    const githubReason = githubWriteReason(event);
    const isGithubMcpMutation =
      toolName.toLowerCase().includes("github") && githubReason !== undefined;
    const gitAction =
      toolName === "bash" && typeof value === "string"
        ? guardedGitAction(value)
        : isCtxBatch
          ? commands
              .map(guardedGitAction)
              .find((action) => action !== undefined)
          : isCtxExecute && typeof value === "string"
            ? event.input?.language === "shell"
              ? guardedGitAction(value)
              : guardedGitRuntimeAction(value)
            : undefined;
    const requiresGitIdentity = gitAction !== undefined;
    const requiresGithubIdentity = githubReason !== undefined;
    if (!requiresGitIdentity && !requiresGithubIdentity) return;
    const action = githubWriteAction(event) ?? gitAction ?? toolName;
    const combinesAuthSwitch =
      (typeof value === "string" && hasGhAuthSwitchCommand(value)) ||
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
    const repo = repositoryPath(cwd);
    if (!repo || !hasIdentityGuard(repo)) {
      const kind = requiresGithubIdentity ? "GitHub write" : "Git write";
      return {
        block: true,
        reason: `${kind} blocked. Action: ${action}. Install Git Identity Guard for this repository before continuing.`,
      };
    }
    if (requiresGithubIdentity && !githubIdentityMatches(repo)) {
      return {
        block: true,
        reason: `GitHub write blocked. Action: ${action}. The authenticated gh account does not match identity.guard.user.`,
      };
    }
    return undefined;
  });
}
