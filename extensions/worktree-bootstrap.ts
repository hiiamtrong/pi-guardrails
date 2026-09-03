import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type ExtensionContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
};

type ExtensionApi = {
  registerCommand: (
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    },
  ) => void;
};

const CONFIG_PREFIX = "piGuardrails.worktreeBootstrap";
const HOOK_MARKER = "pi-guardrails-worktree-bootstrap";
const ORIGINAL_HOOK_SUFFIX = ".pi-guardrails-original";
const extensionDirectory = dirname(
  realpathSync(fileURLToPath(import.meta.url)),
);
const hookRunner = join(extensionDirectory, "worktree-bootstrap-hook.mjs");

export type SetupArguments = {
  source?: string;
  files: string[];
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return runGit(cwd, args);
  } catch {
    return undefined;
  }
}

function splitArguments(input: string): string[] {
  const values: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (value) values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  if (quote || escaped) throw new Error("Unterminated quoted argument.");
  if (value) values.push(value);
  return values;
}

export function normalizeCopyPath(value: string): string {
  const normalized = normalize(value.trim());
  if (
    !normalized ||
    normalized === "." ||
    isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized === ".git" ||
    normalized.startsWith(`.git${sep}`)
  ) {
    throw new Error(`Unsafe bootstrap path: ${value}`);
  }
  return normalized;
}

export function parseSetupArguments(input: string): SetupArguments {
  const values = splitArguments(input);
  let source: string | undefined;

  if (values[0] === "--source") {
    source = values[1];
    values.splice(0, 2);
    if (!source) throw new Error("--source requires a directory path.");
  }

  const files = values.map(normalizeCopyPath);
  if (!files.length) {
    throw new Error(
      "Provide at least one ignored file or directory to bootstrap.",
    );
  }
  return { source, files };
}

export function hookDirectory(repoRoot: string): string {
  const configured = tryGit(repoRoot, ["config", "--get", "core.hooksPath"]);
  if (configured) {
    throw new Error(
      "Refusing to modify a configured core.hooksPath; it may be shared across repositories.",
    );
  }
  return join(
    runGit(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    "hooks",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookContent(hookPath: string): string {
  const originalHook = `${hookPath}${ORIGINAL_HOOK_SUFFIX}`;
  return `#!/bin/sh
# ${HOOK_MARKER}
original_status=0
if [ -x ${shellQuote(originalHook)} ]; then
  ${shellQuote(originalHook)} "$@" || original_status=$?
fi
node ${shellQuote(hookRunner)} "$@"
bootstrap_status=$?
[ "$original_status" -eq 0 ] || exit "$original_status"
exit "$bootstrap_status"
`;
}

function installHook(repoRoot: string): string {
  if (!existsSync(hookRunner))
    throw new Error(`Missing hook runner: ${hookRunner}`);

  const directory = hookDirectory(repoRoot);
  const hookPath = join(directory, "post-checkout");
  const backupPath = `${hookPath}${ORIGINAL_HOOK_SUFFIX}`;
  const temporaryPath = `${hookPath}.pi-guardrails-${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });

  const hasOriginal = existsSync(hookPath);
  if (hasOriginal && readFileSync(hookPath, "utf8").includes(HOOK_MARKER)) {
    return hookPath;
  }
  if (hasOriginal && existsSync(backupPath)) {
    throw new Error(
      `Refusing to overwrite existing backup hook: ${backupPath}`,
    );
  }

  writeFileSync(temporaryPath, hookContent(hookPath), {
    flag: "wx",
    mode: 0o755,
  });
  chmodSync(temporaryPath, 0o755);
  let originalMoved = false;
  try {
    if (hasOriginal) {
      renameSync(hookPath, backupPath);
      originalMoved = true;
    }
    renameSync(temporaryPath, hookPath);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (originalMoved && !existsSync(hookPath) && existsSync(backupPath)) {
      renameSync(backupPath, hookPath);
    }
    throw error;
  }
  return hookPath;
}

function removeHook(repoRoot: string): void {
  const hookPath = join(hookDirectory(repoRoot), "post-checkout");
  const backupPath = `${hookPath}${ORIGINAL_HOOK_SUFFIX}`;

  if (
    existsSync(hookPath) &&
    readFileSync(hookPath, "utf8").includes(HOOK_MARKER)
  ) {
    unlinkSync(hookPath);
    if (existsSync(backupPath)) renameSync(backupPath, hookPath);
  }

  for (const key of ["source", "file"]) {
    tryGit(repoRoot, [
      "config",
      "--local",
      "--unset-all",
      `${CONFIG_PREFIX}.${key}`,
    ]);
  }
}

function getStatus(repoRoot: string): string {
  const source = tryGit(repoRoot, [
    "config",
    "--local",
    "--get",
    `${CONFIG_PREFIX}.source`,
  ]);
  const files =
    tryGit(repoRoot, [
      "config",
      "--local",
      "--get-all",
      `${CONFIG_PREFIX}.file`,
    ])
      ?.split("\n")
      .filter(Boolean) ?? [];
  const hookPath = join(hookDirectory(repoRoot), "post-checkout");
  const installed =
    existsSync(hookPath) &&
    readFileSync(hookPath, "utf8").includes(HOOK_MARKER);

  return [
    `worktree bootstrap: ${installed ? "enabled" : "disabled"}`,
    `source: ${source ?? "(not configured)"}`,
    `files: ${files.length ? files.join(", ") : "(none)"}`,
    `hook: ${hookPath}`,
  ].join("\n");
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
  else console.log(message);
}

type SyncPlan = {
  updates: string[];
  conflicts: Array<{ file: string; reason: string }>;
  deletions: string[];
  synced: false | string[];
};

function runSyncBack(repoRoot: string, dryRun: boolean): SyncPlan {
  const args = [hookRunner, "--sync-back"];
  if (dryRun) args.push("--dry-run");
  const output = execFileSync("node", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(output) as SyncPlan;
  } catch {
    throw new Error(
      "Worktree bootstrap returned an invalid sync-back response.",
    );
  }
}

async function syncBack(ctx: ExtensionContext): Promise<void> {
  const repoRoot = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  let plan: SyncPlan;
  try {
    plan = runSyncBack(repoRoot, true);
  } catch (error) {
    notify(
      ctx,
      `Unable to plan sync-back: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (plan.conflicts.length || plan.deletions.length) {
    const details = [
      ...plan.conflicts.map(({ file, reason }) => `${file}: ${reason}`),
      ...plan.deletions.map(
        (file) => `${file}: deleted in worktree (manual review required)`,
      ),
    ];
    notify(
      ctx,
      `Sync-back stopped without changes:\n${details.join("\n")}`,
      "warning",
    );
    return;
  }
  if (!plan.updates.length) {
    notify(ctx, "Sync-back: primary already matches this worktree.");
    return;
  }

  if (ctx.hasUI && ctx.ui?.confirm) {
    const confirmed = await ctx.ui.confirm(
      "Sync ignored files back to primary?",
      `Copy these files to the configured primary worktree:\n${plan.updates.join("\n")}`,
    );
    if (!confirmed) {
      notify(ctx, "Sync-back was not changed.", "warning");
      return;
    }
  }

  try {
    const result = runSyncBack(repoRoot, false);
    const synced = Array.isArray(result.synced) ? result.synced : [];
    notify(ctx, `Sync-back completed:\n${synced.join("\n")}`);
  } catch (error) {
    notify(
      ctx,
      `Sync-back failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function configure(args: string, ctx: ExtensionContext): Promise<void> {
  const repoRoot = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  const setup = parseSetupArguments(args);
  const source = realpathSync(resolve(repoRoot, setup.source ?? repoRoot));

  if (ctx.hasUI && ctx.ui?.confirm) {
    const confirmed = await ctx.ui.confirm(
      "Enable worktree bootstrap?",
      `Copy missing ignored files from:\n${source}\n\nFiles: ${setup.files.join(", ")}`,
    );
    if (!confirmed) {
      notify(ctx, "Worktree bootstrap was not changed.", "warning");
      return;
    }
  }

  const hookPath = installHook(repoRoot);
  runGit(repoRoot, ["config", "--local", `${CONFIG_PREFIX}.source`, source]);
  tryGit(repoRoot, [
    "config",
    "--local",
    "--unset-all",
    `${CONFIG_PREFIX}.file`,
  ]);
  for (const file of setup.files) {
    runGit(repoRoot, [
      "config",
      "--local",
      "--add",
      `${CONFIG_PREFIX}.file`,
      file,
    ]);
  }
  notify(
    ctx,
    `Worktree bootstrap enabled.\n${getStatus(repoRoot)}\nHook: ${hookPath}`,
  );
}

export default function (pi: ExtensionApi): void {
  pi.registerCommand("worktree-bootstrap", {
    description:
      "Configure personal ignored-file bootstrap for new Git worktrees",
    handler: async (args, ctx) => {
      const [action, ...rest] = splitArguments(args);
      const repoRoot = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);

      if (action === "status") {
        notify(ctx, getStatus(repoRoot));
        return;
      }
      if (action === "disable") {
        removeHook(repoRoot);
        notify(ctx, "Worktree bootstrap disabled for this repository.");
        return;
      }
      if (action === "sync-back") {
        await syncBack(ctx);
        return;
      }
      if (action === "setup") {
        await configure(rest.join(" "), ctx);
        return;
      }

      notify(
        ctx,
        "Usage: /worktree-bootstrap setup [--source <directory>] <ignored-file-or-directory>...\n" +
          "       /worktree-bootstrap status\n" +
          "       /worktree-bootstrap sync-back\n" +
          "       /worktree-bootstrap disable",
        "warning",
      );
    },
  });
}
