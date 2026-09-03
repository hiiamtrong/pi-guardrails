#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const CONFIG_PREFIX = "piGuardrails.worktreeBootstrap";
const STATE_VERSION = 1;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configValues(key) {
  try {
    return git(["config", "--local", "--get-all", key])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isSafeRelativePath(value) {
  const normalized = normalize(value.trim());
  return Boolean(
    normalized &&
      normalized !== "." &&
      !isAbsolute(value) &&
      normalized !== ".." &&
      !normalized.startsWith(`..${sep}`) &&
      normalized !== ".git" &&
      !normalized.startsWith(`.git${sep}`),
  );
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertNoSymlinkComponents(root, candidate, file) {
  let current = root;
  for (const component of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Bootstrap path contains a symlink: ${file}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function pathIn(root, file) {
  if (!isSafeRelativePath(file)) throw new Error(`Unsafe configured bootstrap path: ${file}`);
  const value = resolve(root, file);
  if (!isInside(root, value)) throw new Error(`Bootstrap path escapes its worktree: ${file}`);
  assertNoSymlinkComponents(root, value, file);
  return value;
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFiles(root, prefix = "") {
  const stat = lstatSync(root);
  if (stat.isFile()) return [prefix];
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const fullPath = join(root, entry.name);
    if (entry.isFile()) files.push(relativePath);
    else if (entry.isDirectory()) files.push(...regularFiles(fullPath, relativePath));
  }
  return files;
}

function gitDirectory() {
  return git(["rev-parse", "--path-format=absolute", "--git-dir"]);
}

function commonGitDirectory() {
  return git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

function statePath() {
  return join(gitDirectory(), "pi-guardrails", "worktree-bootstrap-state.json");
}

function loadState(source) {
  const path = statePath();
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (
      state?.version === STATE_VERSION &&
      state.source === source &&
      state.files &&
      typeof state.files === "object"
    ) {
      state.roots = Array.isArray(state.roots) ? state.roots : [];
      return state;
    }
  } catch {}
  return { version: STATE_VERSION, source, files: {}, roots: [] };
}

function saveState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function recordCopiedRoot(state, sourceRoot, targetRoot, file) {
  let changed = false;
  if (!state.roots.includes(file)) {
    state.roots.push(file);
    changed = true;
  }
  const sourcePath = pathIn(sourceRoot, file);
  const targetPath = pathIn(targetRoot, file);
  if (!existsSync(sourcePath) || !existsSync(targetPath)) return changed;

  for (const relativeFile of regularFiles(sourcePath)) {
    const sourceFile = relativeFile ? join(sourcePath, relativeFile) : sourcePath;
    const targetFile = relativeFile ? join(targetPath, relativeFile) : targetPath;
    if (existsSync(targetFile) && fileHash(sourceFile) === fileHash(targetFile)) {
      const key = relativeFile ? join(file, relativeFile) : file;
      const hash = fileHash(sourceFile);
      if (state.files[key] !== hash) {
        state.files[key] = hash;
        changed = true;
      }
    }
  }
  return changed;
}

function bootstrap() {
  const target = realpathSync(git(["rev-parse", "--show-toplevel"]));
  const [source] = configValues(`${CONFIG_PREFIX}.source`);
  const files = configValues(`${CONFIG_PREFIX}.file`);
  const commands = configValues(`${CONFIG_PREFIX}.command`);

  if (!source || !files.length || !existsSync(source)) return;
  const canonicalSource = realpathSync(source);
  if (canonicalSource === target) return;
  const isNewWorktree = !existsSync(statePath());
  const state = loadState(canonicalSource);
  let changed = false;

  for (const file of files) {
    const sourcePath = pathIn(canonicalSource, file);
    const targetPath = pathIn(target, file);
    if (!existsSync(sourcePath)) continue;
    if (!existsSync(targetPath)) {
      cpSync(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      console.error(`worktree-bootstrap: copied ${file}`);
    }
    changed = recordCopiedRoot(state, canonicalSource, target, file) || changed;
  }

  if (changed) saveState(state);
  if (isNewWorktree) {
    for (const command of commands) {
      console.error(`worktree-bootstrap: running ${command}`);
      execFileSync("sh", ["-lc", command], { cwd: target, stdio: "inherit" });
    }
  }
}

function buildSyncPlan() {
  const target = realpathSync(git(["rev-parse", "--show-toplevel"]));
  const [source] = configValues(`${CONFIG_PREFIX}.source`);
  if (!source || !existsSync(source)) throw new Error("Configured bootstrap source does not exist.");
  const canonicalSource = realpathSync(source);
  if (canonicalSource === target) throw new Error("Cannot sync a primary worktree back to itself.");

  const state = loadState(canonicalSource);
  const updates = [];
  const conflicts = [];
  const deletions = [];

  for (const [file, baseline] of Object.entries(state.files)) {
    const sourcePath = pathIn(canonicalSource, file);
    const targetPath = pathIn(target, file);
    const sourceExists = existsSync(sourcePath);
    const targetExists = existsSync(targetPath);

    if (!targetExists) {
      if (sourceExists && fileHash(sourcePath) !== baseline) {
        conflicts.push({ file, reason: "deleted in worktree, changed in primary" });
      } else {
        deletions.push(file);
      }
      continue;
    }
    if (!sourceExists) {
      conflicts.push({ file, reason: "missing in primary" });
      continue;
    }

    const sourceHash = fileHash(sourcePath);
    const targetHash = fileHash(targetPath);
    if (targetHash === baseline || sourceHash === targetHash) continue;
    if (sourceHash === baseline) updates.push(file);
    else conflicts.push({ file, reason: "changed in both primary and worktree" });
  }

  for (const root of state.roots) {
    const targetRoot = pathIn(target, root);
    if (!existsSync(targetRoot)) continue;
    for (const relativeFile of regularFiles(targetRoot)) {
      const file = relativeFile ? join(root, relativeFile) : root;
      if (Object.hasOwn(state.files, file) || updates.includes(file)) continue;
      const sourcePath = pathIn(canonicalSource, file);
      if (existsSync(sourcePath)) {
        conflicts.push({ file, reason: "new in worktree but already exists in primary" });
      } else {
        updates.push(file);
      }
    }
  }

  return { state, target, source: canonicalSource, updates, conflicts, deletions };
}

function acquireSyncLock() {
  const lockPath = join(commonGitDirectory(), "pi-guardrails", "worktree-bootstrap-sync.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockPath, { recursive: false, mode: 0o700 });
    writeFileSync(join(lockPath, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, { mode: 0o600 });
    return lockPath;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Another worktree sync-back holds the lock: ${lockPath}`);
    }
    throw error;
  }
}

function syncBack(dryRun) {
  const lockPath = dryRun ? undefined : acquireSyncLock();
  try {
    const plan = buildSyncPlan();
    if (!dryRun && (plan.conflicts.length || plan.deletions.length)) {
      const reason = plan.conflicts.length ? "conflicts" : "deletions require manual review";
      throw new Error(`Sync-back stopped: ${reason}.`);
    }

    if (!dryRun) {
      const transactionPath = join(lockPath, "transaction");
      const stagedPath = join(transactionPath, "staged");
      const backupPath = join(transactionPath, "backup");
      const applied = [];
      mkdirSync(stagedPath, { recursive: true, mode: 0o700 });
      mkdirSync(backupPath, { recursive: true, mode: 0o700 });

      try {
        for (const file of plan.updates) {
          const sourcePath = pathIn(plan.source, file);
          const targetPath = pathIn(plan.target, file);
          const stagedFile = join(stagedPath, file);
          mkdirSync(dirname(stagedFile), { recursive: true, mode: 0o700 });
          cpSync(targetPath, stagedFile, { force: false, errorOnExist: true, preserveTimestamps: true });
          if (existsSync(sourcePath)) {
            const backupFile = join(backupPath, file);
            mkdirSync(dirname(backupFile), { recursive: true, mode: 0o700 });
            cpSync(sourcePath, backupFile, { force: false, errorOnExist: true, preserveTimestamps: true });
          }
        }

        for (const file of plan.updates) {
          let sourcePath = pathIn(plan.source, file);
          const stagedFile = join(stagedPath, file);
          const existed = existsSync(sourcePath);
          mkdirSync(dirname(sourcePath), { recursive: true });
          sourcePath = pathIn(plan.source, file);
          cpSync(stagedFile, sourcePath, { force: true, preserveTimestamps: true });
          applied.push({ file, existed });
          plan.state.files[file] = fileHash(stagedFile);
        }
        saveState(plan.state);
      } catch (error) {
        const rollbackFailures = [];
        for (const { file, existed } of applied.reverse()) {
          try {
            const sourcePath = pathIn(plan.source, file);
            if (existed) {
              cpSync(join(backupPath, file), sourcePath, { force: true, preserveTimestamps: true });
            } else {
              rmSync(sourcePath, { force: true });
            }
          } catch (rollbackError) {
            rollbackFailures.push(
              `${file}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        const rollback = rollbackFailures.length
          ? ` Rollback failures: ${rollbackFailures.join("; ")}`
          : " All primary changes were rolled back.";
        throw new Error(`Sync-back failed: ${message}.${rollback}`);
      }
    }

    return {
      updates: plan.updates,
      conflicts: plan.conflicts,
      deletions: plan.deletions,
      synced: dryRun ? false : plan.updates,
    };
  } finally {
    if (lockPath) rmSync(lockPath, { recursive: true, force: true });
  }
}

try {
  const args = new Set(process.argv.slice(2));
  if (args.has("--sync-back")) {
    process.stdout.write(`${JSON.stringify(syncBack(args.has("--dry-run")))}\n`);
  } else {
    bootstrap();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`worktree-bootstrap: ${message}`);
  process.exitCode = 1;
}
