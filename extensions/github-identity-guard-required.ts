import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type ToolCallEvent = { toolName?: unknown; input?: { command?: unknown } };
type ExtensionContext = { cwd: string };
type ExtensionApi = {
  on: (
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => void,
  ) => void;
};

function guardedGitOperation(command: string): boolean {
  return /(?:^|[;&|()]|\s)git(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:commit|push)(?:\s|$)/i.test(
    command,
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
    return Boolean(
      user &&
        email &&
        existsSync(join(repo, ".git", "identity-guard", "runner")),
    );
  } catch {
    return false;
  }
}

export default function (pi: ExtensionApi): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string")
      return;
    if (!guardedGitOperation(event.input.command)) return;

    const repo = repositoryPath(ctx.cwd);
    if (!repo || hasIdentityGuard(repo)) return;
    return {
      block: true,
      reason:
        "Git commit/push blocked: install Git Identity Guard for this repository before continuing.",
    };
  });
}
