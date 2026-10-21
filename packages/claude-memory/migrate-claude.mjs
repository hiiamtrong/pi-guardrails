import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import {
  addMemory, agentRoot, canonicalProjectRoot, encodeProjectPath, projectStore, validateMemory,
} from "./memory.ts";

const apply = process.argv.includes("--apply");
const root = agentRoot();
const claudeProjects = resolve(process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"));
const MAX_SEARCH_DIRECTORIES = 100_000;
const MAX_SESSION_FILES_PER_PROJECT = 1_000;
const report = { apply, createdAt: new Date().toISOString(), errors: [], warnings: [], projects: {} };
const sourceKeys = discoverSourceKeys();
const sourceKeySet = new Set(sourceKeys);
const structuredCandidates = new Map();
const scan = { directories: 0, warned: false };
const candidates = discoverCandidates();

function readRegularFile(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Claude memory source must be a regular file: ${path}`);
    if (maxBytes === undefined) return readFileSync(fd, "utf8");
    const buffer = Buffer.alloc(maxBytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function discoverSourceKeys() {
  if (!existsSync(claudeProjects)) return [];
  const stat = lstatSync(claudeProjects);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Claude projects path must be a regular directory: ${claudeProjects}`);
  }
  return readdirSync(claudeProjects, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name !== basename(entry.name) || entry.name === "." || entry.name === "..") return [];
    const memory = join(claudeProjects, entry.name, "memory");
    if (!existsSync(memory)) return [];
    const memoryStat = lstatSync(memory);
    if (!memoryStat.isDirectory() || memoryStat.isSymbolicLink()) {
      report.errors.push(`${entry.name}: memory source must be a regular directory`);
      return [];
    }
    return [entry.name];
  });
}

function addCandidate(map, path) {
  try {
    const canonicalPath = realpathSync.native(path);
    const key = encodeProjectPath(canonicalPath);
    if (!sourceKeySet.has(key)) return;
    const values = map.get(key) || new Set();
    values.add(canonicalPath);
    map.set(key, values);
  } catch {}
}

function walkDirectories(start, map, depth = 0) {
  if (!existsSync(start) || depth > 7) return;
  if (++scan.directories > MAX_SEARCH_DIRECTORIES) {
    if (!scan.warned) {
      report.warnings.push(`project search stopped after ${MAX_SEARCH_DIRECTORIES} directories`);
      scan.warned = true;
    }
    return;
  }
  let entries;
  try {
    const stat = lstatSync(start);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    addCandidate(map, start);
    entries = readdirSync(start, { withFileTypes: true });
  } catch {
    return;
  }
  const ignored = new Set([".git", ".claude", ".pi", ".venv", "Library", "build", "dist", "node_modules", "venv"]);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
    walkDirectories(join(start, entry.name), map, depth + 1);
  }
}

function sessionCandidates(projectKey) {
  const dir = join(claudeProjects, projectKey);
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (++files > MAX_SESSION_FILES_PER_PROJECT) {
      report.warnings.push(`${projectKey}: session scan stopped after ${MAX_SESSION_FILES_PER_PROJECT} files`);
      break;
    }
    try {
      const text = readRegularFile(join(dir, entry.name), 64 * 1024);
      for (const line of (text || "").split("\n", 12)) {
        if (!line) continue;
        const record = JSON.parse(line);
        const cwd = typeof record.cwd === "string" ? record.cwd : record.session?.cwd;
        if (typeof cwd !== "string" || !existsSync(cwd)) continue;
        const values = structuredCandidates.get(projectKey) || new Set();
        values.add(canonicalProjectRoot(cwd));
        structuredCandidates.set(projectKey, values);
      }
    } catch {}
  }
}

function discoverCandidates() {
  const map = new Map();
  addCandidate(map, homedir());
  const configured = process.env.CLAUDE_PROJECT_SEARCH_ROOTS?.split(delimiter).filter(Boolean);
  const searchRoots = configured || [join(homedir(), "Works"), join(homedir(), "orca", "projects")];
  for (const searchRoot of searchRoots) walkDirectories(resolve(searchRoot), map);
  for (const key of sourceKeys) sessionCandidates(key);
  return map;
}

function resolveProject(projectKey) {
  const structured = [...(structuredCandidates.get(projectKey) || [])];
  const paths = structured.length ? structured : [...(candidates.get(projectKey) || [])];
  const canonical = [...new Set(paths.map((path) => canonicalProjectRoot(path)))];
  if (canonical.length !== 1) return { paths: canonical, mapping: "unresolved" };
  const mapping = structured.length ? "session" : "exact";
  return { paths: canonical, mapping, store: projectStore(canonical[0], root) };
}

function parseIndex(memoryDir) {
  const raw = readRegularFile(join(memoryDir, "MEMORY.md"));
  const topics = new Map();
  if (raw === undefined) return { raw, topics };
  for (const line of raw.split("\n")) {
    const match = /^- \[([^\]]+)\]\(([^)]+\.md)\)\s*(?:—|-)?\s*(.*)$/.exec(line.trim());
    if (match && match[2] === basename(match[2])) {
      topics.set(match[2], { name: match[1].trim(), description: match[3].trim() || match[1].trim() });
    }
  }
  return { raw, topics };
}

function fallbackDescription(content, file) {
  const line = content.split("\n").map((value) => value.replace(/^#+\s*/, "").trim()).find(Boolean);
  return (line || file.replace(/\.md$/i, "").replaceAll("_", " ")).slice(0, 180);
}

function migrateProject(projectKey) {
  const memoryDir = join(claudeProjects, projectKey, "memory");
  const resolved = resolveProject(projectKey);
  const destination = resolved.store?.dir || join(root, "memory", "unresolved-claude-projects", projectKey);
  const store = resolved.store || { dir: destination, root, scope: "project" };
  if (resolved.mapping === "unresolved") {
    report.warnings.push(`${projectKey}: copied to unresolved archive because no unique canonical project path exists`);
  }
  const projectReport = {
    source: memoryDir,
    destination,
    mapping: resolved.mapping,
    canonicalRoots: resolved.paths,
    topics: 0,
    added: 0,
  };
  report.projects[projectKey] = projectReport;

  let index;
  try {
    index = parseIndex(memoryDir);
  } catch (error) {
    report.errors.push(`${projectKey}/MEMORY.md: ${error.message}`);
    return;
  }

  const inputs = [];
  if (index.raw?.trim()) {
    inputs.push({
      content: index.raw.trim(),
      description: `Claude Code MEMORY.md snapshot for ${projectKey}`,
      name: `Claude memory index ${projectKey}`,
      source: `claude-code:${projectKey}/MEMORY.md`,
      type: "project",
    });
  }

  for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
    if (entry.name === "MEMORY.md") continue;
    const path = join(memoryDir, entry.name);
    if (entry.isSymbolicLink()) {
      report.errors.push(`${projectKey}/${entry.name}: symlink sources are not allowed`);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const content = readRegularFile(path)?.trim();
      if (!content) throw new Error("Claude memory topic cannot be empty");
      const metadata = index.topics.get(entry.name);
      inputs.push({
        content,
        description: metadata?.description || fallbackDescription(content, entry.name),
        name: metadata?.name || entry.name.replace(/\.md$/i, "").replaceAll("_", " "),
        source: `claude-code:${projectKey}/${entry.name}`,
        type: "project",
      });
    } catch (error) {
      report.errors.push(`${projectKey}/${entry.name}: ${error.message}`);
    }
  }

  projectReport.topics = inputs.length;
  for (const input of inputs) {
    try {
      validateMemory(input);
      if (apply) {
        const result = addMemory(store, input);
        if (!result.duplicate) projectReport.added++;
      }
    } catch (error) {
      report.errors.push(`${input.source}: ${error.message}`);
    }
  }
}

function ensureReportsDir() {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Agent directory must be a regular directory: ${root}`);
  }
  let current = root;
  for (const part of ["memory", "migrations"]) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Migration report path must be a regular directory: ${current}`);
    }
    chmodSync(current, 0o700);
  }
  return current;
}

for (const projectKey of sourceKeys) migrateProject(projectKey);

if (apply) {
  try {
    const reportsDir = ensureReportsDir();
    const reportPath = join(reportsDir, `claude-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Migration report: ${reportPath}`);
  } catch (error) {
    report.errors.push(`migration report: ${error.message}`);
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.errors.length) process.exitCode = 1;
