import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  githubWriteReason,
  isGuardedGitCommand,
  isGuardedGitRuntimeCode,
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
    const requiresGitIdentity =
      (toolName === "bash" &&
        typeof value === "string" &&
        isGuardedGitCommand(value)) ||
      (isCtxBatch && commands.some(isGuardedGitCommand)) ||
      (isCtxExecute &&
        typeof value === "string" &&
        (event.input?.language === "shell"
          ? isGuardedGitCommand(value)
          : isGuardedGitRuntimeCode(value)));
    const requiresGithubIdentity = githubReason !== undefined;
    if (!requiresGitIdentity && !requiresGithubIdentity) return;
    if (isGithubMcpMutation) {
      return {
        block: true,
        reason:
          "GitHub MCP write blocked: Git Identity Guard cannot verify the MCP token account. Use a guarded gh command instead.",
      };
    }

    const cwd =
      typeof event.input?.cwd === "string" ? event.input.cwd : ctx.cwd;
    const repo = repositoryPath(cwd);
    if (!repo || !hasIdentityGuard(repo)) {
      return {
        block: true,
        reason:
          "GitHub write blocked: install Git Identity Guard for this repository before continuing.",
      };
    }
    if (requiresGithubIdentity && !githubIdentityMatches(repo)) {
      return {
        block: true,
        reason:
          "GitHub write blocked: the authenticated gh account does not match identity.guard.user.",
      };
    }
    return undefined;
  });
}
