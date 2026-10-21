import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  addMemory, agentRoot, canonicalProjectRoot, globalStore, projectStore, validateMemory,
} from "./memory.ts";

const apply = process.argv.includes("--apply");
const root = agentRoot();
const hermesDir = join(root, "pi-hermes-memory");
const legacyProjectsDir = join(root, "projects-memory");
const report = { apply, createdAt: new Date().toISOString(), errors: [], global: {}, projects: {} };

function entries(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Legacy memory source must be a regular file: ${path}`);
    return readFileSync(fd, "utf8").split(/\n§\n/).map((entry) => entry.trim()).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function title(entry, fallback) {
  const clean = entry.replace(/\s*<!--[^>]*-->\s*$/, "").trim();
  const first = clean.split(/(?<=[.!?])\s+|\n/)[0].replace(/\s+/g, " ").trim();
  return first ? first.slice(0, 80) : fallback;
}

function migrateFile(path, store, type, label) {
  let sourceEntries;
  try {
    sourceEntries = entries(path);
  } catch (error) {
    report.errors.push(`${label}: ${error.message}`);
    return { entries: 0, added: 0 };
  }
  let added = 0;
  for (const [index, content] of sourceEntries.entries()) {
    try {
      const input = {
        content,
        description: title(content, `${label} ${index + 1}`),
        name: title(content, `${label} ${index + 1}`),
        source: `pi-hermes-memory:${label}#${index + 1}`,
        type,
      };
      validateMemory(input);
      if (apply) {
        const result = addMemory(store, input);
        if (!result.duplicate) added++;
      }
    } catch (error) {
      report.errors.push(`${label}#${index + 1}: ${error.message}`);
    }
  }
  return { entries: sourceEntries.length, added };
}

function walkJsonl(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(path, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function sessionProjectCandidates() {
  const candidates = new Map();
  const add = (name, path) => {
    const values = candidates.get(name) || new Set();
    values.add(path);
    candidates.set(name, values);
  };
  for (const path of walkJsonl(join(root, "sessions"))) {
    try {
      const lines = readFileSync(path, "utf8").split("\n", 8);
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        const cwd = typeof record.cwd === "string" ? record.cwd : record.session?.cwd;
        if (typeof cwd !== "string" || !existsSync(cwd)) continue;
        const projectRoot = canonicalProjectRoot(cwd);
        add(basename(cwd), projectRoot);
        add(basename(projectRoot), projectRoot);
      }
    } catch {}
  }
  return candidates;
}

function skillFileCount(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) => sum + (entry.isDirectory() ? skillFileCount(join(dir, entry.name)) : entry.isFile() ? 1 : 0), 0,
  );
}

function ensurePrivateDestination(path) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Skill destination escapes the agent directory: ${path}`);
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Agent directory must be a regular directory: ${root}`);
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Skill destination must be a regular directory: ${current}`);
    }
    chmodSync(current, 0o700);
  }
}

function copySkills(source, destination) {
  if (!existsSync(source)) return 0;
  let copied = 0;
  const visit = (current, target) => {
    ensurePrivateDestination(target);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const from = join(current, entry.name);
      const to = join(target, entry.name);
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to migrate symlink: ${from}`);
      if (entry.isDirectory()) visit(from, to);
      else if (entry.isFile()) {
        try {
          writeFileSync(to, readFileSync(from), { flag: "wx", mode: 0o600 });
          copied++;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const destinationStat = lstatSync(to);
          if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
            throw new Error(`Skill destination must be a regular file: ${to}`);
          }
          if (!readFileSync(from).equals(readFileSync(to))) {
            throw new Error(`Skill destination already differs: ${to}`);
          }
          chmodSync(to, 0o600);
        }
      }
    }
  };
  if (apply) visit(source, destination);
  else copied = skillFileCount(source);
  return copied;
}

const global = globalStore(root);
for (const [file, type] of [["MEMORY.md", "reference"], ["USER.md", "user"], ["failures.md", "feedback"]]) {
  report.global[file] = migrateFile(join(hermesDir, file), global, type, file);
}
try {
  report.global.skills = copySkills(join(hermesDir, "skills"), join(global.dir, "skills"));
} catch (error) {
  report.errors.push(`global skills: ${error.message}`);
}

const candidates = sessionProjectCandidates();
if (existsSync(legacyProjectsDir)) {
  for (const entry of readdirSync(legacyProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(legacyProjectsDir, entry.name);
    const roots = [...(candidates.get(entry.name) || [])];
    let memoryEntries = 0;
    let validMemorySource = true;
    try {
      memoryEntries = entries(join(source, "MEMORY.md")).length;
    } catch (error) {
      validMemorySource = false;
      report.errors.push(`project/${entry.name}: ${error.message}`);
    }
    const projectReport = { legacyName: entry.name, memoryEntries, roots };
    report.projects[entry.name] = projectReport;
    if (roots.length !== 1) {
      if (memoryEntries || skillFileCount(join(source, "skills"))) {
        report.errors.push(`${entry.name}: expected one canonical project path, found ${roots.length}`);
      }
      continue;
    }
    if (!validMemorySource) continue;
    const store = projectStore(roots[0], root);
    projectReport.destination = store.dir;
    projectReport.memory = migrateFile(join(source, "MEMORY.md"), store, "project", `project/${entry.name}`);
    try {
      projectReport.skills = copySkills(join(source, "skills"), join(store.dir, "skills"));
    } catch (error) {
      report.errors.push(`${entry.name} skills: ${error.message}`);
    }
  }
}

if (apply) {
  const reportPath = join(root, "memory", `hermes-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Migration report: ${reportPath}`);
}
console.log(JSON.stringify(report, null, 2));
if (report.errors.length) process.exitCode = 1;
