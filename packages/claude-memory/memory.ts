import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync,
  linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, readdirSync,
  renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25 * 1024;
const MAX_TOPIC_READ_BYTES = 50 * 1024;
const MAX_TOPIC_METADATA_BYTES = 8 * 1024;
const MAX_INDEX_MUTATION_BYTES = 1024 * 1024;
const MAX_INDEX_ENTRY_BYTES = 1024;
const MAX_SEARCH_FILES = 1_000;
const MAX_SOURCE_SCAN_FILES = 1_000;
const MAX_REFS = 20;
const MAX_REF_FILE_BYTES = 5 * 1024 * 1024;
const TOPIC_FILE = /^[a-z0-9][a-z0-9._-]*\.md$/i;
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_POLL_MS = 10;
const SIMILARITY_THRESHOLD = 0.8;

export type MemoryScope = "global" | "project";
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryStore = { dir: string; root?: string; scope: MemoryScope; projectRoot?: string };
export type MemoryRefInput = { path: string };
export type MemoryRef = { hash: string; path: string };
export type RefStatus = MemoryRef & { reason?: "changed" | "missing" | "unreadable"; stale: boolean };
export type AddMemoryInput = {
  content: string;
  description?: string;
  name?: string;
  refs?: MemoryRefInput[];
  source?: string;
  type: MemoryType;
};
export type SimilarTopic = { description: string; file: string; score: number };
export type AddMemoryResult = { duplicate: boolean; file: string; similar: SimilarTopic[] };
export type MergeMemoryInput = {
  content: string;
  description?: string;
  keepFile: string;
  name?: string;
  refs?: MemoryRefInput[];
  removeFile: string;
};
export type SearchResult = {
  description: string;
  file: string;
  scope: MemoryScope;
  score: number;
  snippet: string;
  stale?: boolean;
  type?: string;
};

export function agentRoot(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"));
}

function realpathOrResolve(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

export function canonicalProjectRoot(cwd: string): string {
  let current = realpathOrResolve(cwd);
  while (true) {
    const dotGit = join(current, ".git");
    try {
      const stat = lstatSync(dotGit);
      if (stat.isDirectory() && existsSync(join(dotGit, "HEAD"))) return current;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!pointer) return current;
        const gitDir = realpathOrResolve(resolve(current, pointer[1].trim()));
        try {
          const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
          const commonDir = realpathOrResolve(resolve(gitDir, common));
          const backlink = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
          const expectedGitDirParent = realpathOrResolve(join(commonDir, "worktrees"));
          const linkedDotGit = realpathOrResolve(resolve(gitDir, backlink));
          if (
            common && basename(commonDir) === ".git" && existsSync(join(commonDir, "HEAD")) &&
            dirname(gitDir) === expectedGitDirParent && linkedDotGit === realpathOrResolve(dotGit)
          ) return dirname(commonDir);
        } catch { return current; }
        return current;
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return realpathOrResolve(cwd);
    current = parent;
  }
}

export function encodeProjectPath(projectRoot: string): string {
  const canonical = realpathOrResolve(projectRoot);
  const encoded = canonical.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-")
    .replace(/[\u0000-\u001f<>"|?*]/g, "-");
  return Buffer.byteLength(encoded) <= 220
    ? encoded
    : `${encoded.slice(0, 180)}-${shortHash(canonical)}`;
}

export function globalMemoryDir(root = agentRoot()): string {
  return join(root, "memory", "global");
}

export function projectMemoryDir(cwd: string, root = agentRoot()): string {
  const projectRoot = canonicalProjectRoot(cwd);
  const projectsRoot = join(root, "memory", "projects");
  const encoded = encodeProjectPath(projectRoot);
  const candidate = join(projectsRoot, encoded);
  const existingRoot = readProjectIdentity(candidate);
  return !existingRoot || existingRoot === projectRoot
    ? candidate
    : join(projectsRoot, `${encoded}-${shortHash(projectRoot)}`);
}

export function globalStore(root = agentRoot()): MemoryStore {
  return { dir: globalMemoryDir(root), root, scope: "global" };
}

export function projectStore(cwd: string, root = agentRoot()): MemoryStore {
  return { dir: projectMemoryDir(cwd, root), root, projectRoot: canonicalProjectRoot(cwd), scope: "project" };
}

function readProjectIdentity(dir: string): string | undefined {
  try {
    const path = join(dir, ".project.json");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { root?: unknown };
    return typeof parsed.root === "string" ? parsed.root : undefined;
  } catch { return undefined; }
}

function ensurePrivateDirectory(root: string, target: string): void {
  const anchor = resolve(root);
  const rel = relative(anchor, resolve(target));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Memory store escapes its agent directory.");
  }
  mkdirSync(anchor, { recursive: true, mode: 0o700 });
  const anchorStat = lstatSync(anchor);
  if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink()) {
    throw new Error("Agent directory must be a regular directory.");
  }
  let current = anchor;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Memory store path must contain only regular directories.");
    }
    chmodSync(current, 0o700);
  }
}

function ensureStore(store: MemoryStore): void {
  if (store.root) ensurePrivateDirectory(store.root, store.dir);
  else mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  const storeStat = lstatSync(store.dir);
  if (!storeStat.isDirectory() || storeStat.isSymbolicLink()) {
    throw new Error("Memory store must be a regular directory.");
  }
  chmodSync(store.dir, 0o700);
  if (!store.projectRoot) return;
  const identityPath = join(store.dir, ".project.json");
  if (existsSync(identityPath)) {
    const identityStat = lstatSync(identityPath);
    if (!identityStat.isFile() || identityStat.isSymbolicLink()) {
      throw new Error("Project memory identity must be a regular file.");
    }
    if (readProjectIdentity(store.dir) !== store.projectRoot) {
      throw new Error("Project memory identity does not match the current repository.");
    }
    return;
  }
  writeFileSync(identityPath, `${JSON.stringify({ root: store.projectRoot }, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
}

function resolveRefPath(store: MemoryStore, path: string): string {
  if (!store.projectRoot) throw new Error("Memory refs require a project-scoped store.");
  const resolved = resolve(store.projectRoot, path);
  const rel = relative(store.projectRoot, resolved);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Memory ref path escapes the project: ${path}`);
  }
  return resolved;
}

function hashFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const wrapped = new Error(
      code === "ELOOP" ? `Memory ref path must not be a symlink: ${path}` : `Memory ref path does not exist: ${path}`,
    ) as NodeJS.ErrnoException;
    wrapped.code = code;
    throw wrapped;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Memory ref path is not a regular file: ${path}`);
    if (stat.size > MAX_REF_FILE_BYTES) {
      throw new Error(`Memory ref file exceeds the ${MAX_REF_FILE_BYTES}-byte limit: ${path}`);
    }
    return createHash("sha256").update(readDescriptor(fd, stat.size)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function resolveRefs(store: MemoryStore, refs: MemoryRefInput[] | undefined): MemoryRef[] {
  if (!refs?.length) return [];
  if (refs.length > MAX_REFS) throw new Error(`Memory refs exceed the ${MAX_REFS}-entry limit.`);
  const unique = [...new Map(refs.map((ref) => [ref.path, ref])).values()];
  return unique.map((ref) => ({ hash: hashFile(resolveRefPath(store, ref.path)), path: ref.path }));
}

export function checkRefs(store: MemoryStore, refs: MemoryRef[]): RefStatus[] {
  return refs.map((ref) => {
    let current: string;
    try {
      current = hashFile(resolveRefPath(store, ref.path));
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
      return { ...ref, reason, stale: true };
    }
    return current === ref.hash ? { ...ref, stale: false } : { ...ref, reason: "changed", stale: true };
  });
}

export function refsStatus(store: MemoryStore, file: string): RefStatus[] {
  const refs = readTopicMetadata(containedTopicPath(store.dir, file)).refs;
  return refs?.length ? checkRefs(store, refs) : [];
}

export function listStaleRefs(store: MemoryStore): Array<{ file: string; stale: RefStatus[] }> {
  const results: Array<{ file: string; stale: RefStatus[] }> = [];
  let files: string[];
  try {
    files = readdirSync(store.dir).filter((candidate) => candidate !== "MEMORY.md" && TOPIC_FILE.test(candidate))
      .slice(0, MAX_SEARCH_FILES);
  } catch { return results; }
  for (const file of files) {
    let refs: MemoryRef[] | undefined;
    try { refs = readTopicMetadata(join(store.dir, file)).refs; } catch { continue; }
    if (!refs?.length) continue;
    const stale = checkRefs(store, refs).filter((ref) => ref.stale);
    if (stale.length) results.push({ file, stale });
  }
  return results;
}

export function capIndex(raw: string): { content: string; truncated: boolean } {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= MAX_INDEX_LINES) break;
    const nextBytes = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes + nextBytes > MAX_INDEX_BYTES) break;
    kept.push(line);
    bytes += nextBytes;
  }
  return { content: kept.join("\n"), truncated: kept.length < lines.length };
}

export function readIndex(store: MemoryStore): { content: string; truncated: boolean } | undefined {
  try {
    return capIndex(readRegularText(join(store.dir, "MEMORY.md"), MAX_INDEX_BYTES + 1));
  } catch { return undefined; }
}

export function validateMemory(input: Pick<AddMemoryInput, "content" | "description" | "name" | "source">): void {
  const content = input.content.trim();
  if (!content) throw new Error("Memory content cannot be empty.");
  const persisted = [content, input.name, input.description, input.source].filter(Boolean).join("\n");
  const secret = findSecret(persisted);
  if (secret) throw new Error(`Memory rejected: content looks like ${secret}.`);
}

export function addMemory(store: MemoryStore, input: AddMemoryInput): AddMemoryResult {
  validateMemory(input);
  const content = input.content.trim();
  ensureStore(store);
  const description = oneLine(input.description || firstSentence(content), 180);
  const title = oneLine(input.name || description, 80);
  const refs = resolveRefs(store, input.refs);
  return withStoreLock(store.dir, () => {
    assertWritableIndex(store.dir, MAX_INDEX_ENTRY_BYTES);
    const existingSource = input.source ? findTopicBySource(store.dir, input.source, input.type) : undefined;
    if (existingSource) {
      appendIndex(store.dir, existingSource, title, description);
      return { file: existingSource, duplicate: true, similar: [] };
    }
    const similar = findSimilarTopics(store.dir, input.type, content);
    const digest = createHash("sha256").update(`${input.type}\n${content}`).digest("hex");
    const rendered = renderTopic({ ...input, content, contentHash: digest, description, name: title, refs });
    let file = `${input.type}-${digest.slice(0, 10)}.md`;
    let topicPath = containedTopicPath(store.dir, file);
    let created = createTopic(topicPath, rendered);
    const storedHash = created ? digest : readTopicMetadata(topicPath).contentHash;
    if (!created && storedHash !== undefined && storedHash !== digest) {
      file = `${input.type}-${digest}.md`;
      topicPath = containedTopicPath(store.dir, file);
      created = createTopic(topicPath, rendered);
      if (!created && readTopicMetadata(topicPath).contentHash !== digest) {
        throw new Error("Memory content hash collision.");
      }
    }
    appendIndex(store.dir, file, title, description);
    return { file, duplicate: !created, similar: created ? similar : [] };
  });
}

export function mergeMemory(store: MemoryStore, input: MergeMemoryInput): { file: string; removed: string } {
  validateMemory(input);
  if (input.keepFile === input.removeFile) throw new Error("Merge files must be different.");
  const content = input.content.trim();
  ensureStore(store);
  const description = oneLine(input.description || firstSentence(content), 180);
  const title = oneLine(input.name || description, 80);
  return withStoreLock(store.dir, () => {
    assertWritableIndex(store.dir, MAX_INDEX_ENTRY_BYTES);
    const keepPath = containedTopicPath(store.dir, input.keepFile);
    const removePath = containedTopicPath(store.dir, input.removeFile);
    const keep = readTopicMetadata(keepPath);
    const remove = readTopicMetadata(removePath);
    if (!isMemoryType(keep.type) || keep.type !== remove.type) {
      throw new Error("Merged memories must have the same valid type.");
    }
    const digest = createHash("sha256").update(`${keep.type}\n${content}`).digest("hex");
    const sources = [...new Set([
      keep.source, ...(keep.sources || []), remove.source, ...(remove.sources || []),
    ].filter((source): source is string => Boolean(source)))];
    const refInputs = input.refs?.length
      ? input.refs
      : [...new Map([...(keep.refs || []), ...(remove.refs || [])].map((ref) => [ref.path, ref])).values()];
    const refs = resolveRefs(store, refInputs);
    replacePrivateFile(keepPath, renderTopic({
      content, contentHash: digest, description, name: title, refs, sources, type: keep.type,
    }));
    rewriteIndexAfterMerge(store.dir, input.keepFile, input.removeFile, title, description);
    unlinkSync(removePath);
    return { file: input.keepFile, removed: input.removeFile };
  });
}

function withStoreLock<T>(dir: string, action: () => T): T {
  const path = join(dir, ".write.lock");
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  while (true) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!storeLockOwnerAlive(path)) {
        try { unlinkSync(path); } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the memory store lock.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STORE_LOCK_POLL_MS);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  try {
    return action();
  } finally {
    try {
      const owner = JSON.parse(readRegularText(path));
      if (owner.token === token) unlinkSync(path);
    } catch {
      // Best-effort release; a stuck lock still expires after STORE_LOCK_TIMEOUT_MS.
    }
  }
}

function storeLockOwnerAlive(path: string): boolean {
  let owner: { pid?: unknown };
  try {
    owner = JSON.parse(readRegularText(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try {
      return Date.now() - lstatSync(path).mtimeMs < STORE_LOCK_TIMEOUT_MS;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw statError;
    }
  }
  if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  try {
    process.kill(owner.pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readDescriptor(fd: number, maxBytes: number): Buffer {
  const content = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < content.length) {
    const read = readSync(fd, content, offset, content.length - offset, offset);
    if (!read) break;
    offset += read;
  }
  return content.subarray(0, offset);
}

function readRegularText(path: string, maxBytes?: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    const wrapped = new Error("Memory file must be a regular file.") as NodeJS.ErrnoException;
    wrapped.code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Memory file must be a regular file.");
    return maxBytes === undefined ? readFileSync(fd, "utf8") : readDescriptor(fd, maxBytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function createTopic(path: string, content: string): boolean {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type TopicMetadata = {
  contentHash?: string; refs?: MemoryRef[]; source?: string; sources?: string[]; type?: string;
};

function isMemoryRef(value: unknown): value is MemoryRef {
  return value !== null && typeof value === "object"
    && typeof (value as MemoryRef).path === "string" && typeof (value as MemoryRef).hash === "string";
}

function frontmatterField(metadata: string[], key: string): string | undefined {
  return metadata.find((candidate) => candidate.startsWith(`${key}: `))?.slice(key.length + 2);
}

function parseStringField(metadata: string[], key: string): string | undefined {
  const raw = frontmatterField(metadata, key);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch { return undefined; }
}

function parseStringArrayField(metadata: string[], key: string): string[] | undefined {
  const raw = frontmatterField(metadata, key);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch { return undefined; }
}

function parseRefsField(metadata: string[], key: string): MemoryRef[] | undefined {
  const raw = frontmatterField(metadata, key);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isMemoryRef) ? parsed : undefined;
  } catch { return undefined; }
}

function parseTopicMetadata(raw: string): TopicMetadata {
  const boundary = raw.startsWith("---\n") ? raw.indexOf("\n---\n", 4) : -1;
  if (boundary < 0) return {};
  const metadata = raw.slice(4, boundary).split("\n");
  return {
    contentHash: parseStringField(metadata, "content_hash"),
    refs: parseRefsField(metadata, "refs"),
    source: parseStringField(metadata, "source"),
    sources: parseStringArrayField(metadata, "sources"),
    type: metadata.find((line) => line.startsWith("type: "))?.slice(6),
  };
}

function readTopicMetadata(path: string): TopicMetadata {
  return parseTopicMetadata(readRegularText(path, MAX_TOPIC_METADATA_BYTES));
}

function findTopicBySource(dir: string, source: string, type: MemoryType): string | undefined {
  const files = readdirSync(dir).filter((candidate) => candidate !== "MEMORY.md" && TOPIC_FILE.test(candidate));
  if (files.length > MAX_SOURCE_SCAN_FILES) {
    throw new Error(`Source dedup scan exceeds ${MAX_SOURCE_SCAN_FILES} topic files.`);
  }
  for (const file of files) {
    const metadata = readTopicMetadata(join(dir, file));
    if ((metadata.source === source || metadata.sources?.includes(source)) && metadata.type === type) return file;
  }
  return undefined;
}

function findSimilarTopics(dir: string, type: MemoryType, content: string): SimilarTopic[] {
  const incoming = wordSet(content);
  if (!incoming.size) return [];
  const results: SimilarTopic[] = [];
  for (const file of readdirSync(dir)
    .filter((candidate) => candidate !== "MEMORY.md" && TOPIC_FILE.test(candidate))
    .slice(0, MAX_SEARCH_FILES)) {
    const path = join(dir, file);
    if (readTopicMetadata(path).type !== type) continue;
    const text = readRegularText(path, MAX_TOPIC_READ_BYTES);
    const existing = wordSet(stripFrontmatter(text));
    if (!existing.size) continue;
    const shared = [...incoming].filter((word) => existing.has(word)).length;
    const score = shared / Math.max(incoming.size, existing.size);
    if (score < SIMILARITY_THRESHOLD) continue;
    results.push({
      description: topicMetadata(text).description || firstSentence(stripFrontmatter(text)),
      file,
      score: Math.round(score * 1_000) / 1_000,
    });
  }
  return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 3);
}

function wordSet(content: string): Set<string> {
  return new Set(normalizeSearch(content).split(" ").filter(Boolean));
}

function isMemoryType(value: string | undefined): value is MemoryType {
  return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

function replacePrivateFile(path: string, content: string, allowMissing = false): void {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Memory file must be a regular file.");
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function assertWritableIndex(dir: string, reserveBytes = 0): void {
  try {
    const raw = readIndexForMutation(join(dir, "MEMORY.md"));
    if (Buffer.byteLength(raw) + reserveBytes > MAX_INDEX_MUTATION_BYTES) {
      throw new Error(`MEMORY.md exceeds the ${MAX_INDEX_MUTATION_BYTES}-byte mutation limit.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readIndexForMutation(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    const wrapped = new Error("MEMORY.md must be a single-link regular file.") as NodeJS.ErrnoException;
    wrapped.code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("MEMORY.md must be a single-link regular file.");
    if (stat.size > MAX_INDEX_MUTATION_BYTES) {
      throw new Error(`MEMORY.md exceeds the ${MAX_INDEX_MUTATION_BYTES}-byte mutation limit.`);
    }
    return readDescriptor(fd, stat.size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function rewriteIndexAfterMerge(
  dir: string, keepFile: string, removeFile: string, title: string, description: string,
): void {
  const path = join(dir, "MEMORY.md");
  let raw: string;
  try { raw = readIndexForMutation(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = "# Memory Index\n";
  }
  const keepMarker = `](${keepFile})`;
  const removeMarker = `](${removeFile})`;
  const lines = raw.split(/\r?\n/).filter((line) => !line.includes(keepMarker) && !line.includes(removeMarker));
  while (lines.at(-1) === "") lines.pop();
  lines.push("", `- [${escapeMarkdown(title)}](${keepFile}) — ${escapeMarkdown(description)}`, "");
  replacePrivateFile(path, lines.join("\n"), true);
}

function appendIndex(dir: string, file: string, title: string, description: string): void {
  const path = join(dir, "MEMORY.md");
  const line = `- [${escapeMarkdown(title)}](${file}) — ${escapeMarkdown(description)}\n`;
  const noFollow = constants.O_NOFOLLOW || 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    writeSync(fd, `# Memory Index\n\n${line}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  fd = openSync(path, constants.O_RDWR | constants.O_APPEND | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("MEMORY.md must be a single-link regular file.");
    if (stat.size > MAX_INDEX_MUTATION_BYTES) {
      throw new Error(`MEMORY.md exceeds the ${MAX_INDEX_MUTATION_BYTES}-byte mutation limit.`);
    }
    fchmodSync(fd, 0o600);
    const raw = readDescriptor(fd, stat.size).toString("utf8");
    if (!raw.includes(`](${file})`)) {
      if (stat.size + Buffer.byteLength(line) > MAX_INDEX_MUTATION_BYTES) {
        throw new Error(`MEMORY.md exceeds the ${MAX_INDEX_MUTATION_BYTES}-byte mutation limit.`);
      }
      writeSync(fd, line);
    }
  } finally {
    closeSync(fd);
  }
}

function renderTopic(input: AddMemoryInput & {
  content: string; contentHash: string; description: string; name: string; refs?: MemoryRef[]; sources?: string[];
}): string {
  const metadata = [
    `name: ${yamlString(input.name)}`, `description: ${yamlString(input.description)}`,
    `type: ${input.type}`, `content_hash: ${JSON.stringify(input.contentHash)}`,
    ...(input.source ? [`source: ${JSON.stringify(input.source)}`] : []),
    ...(input.sources?.length ? [`sources: ${JSON.stringify(input.sources)}`] : []),
    ...(input.refs?.length ? [`refs: ${JSON.stringify(input.refs)}`] : []),
    `created: ${new Date().toISOString().slice(0, 10)}`,
  ];
  const frontmatter = `---\n${metadata.join("\n")}\n---\n`;
  if (Buffer.byteLength(frontmatter) > MAX_TOPIC_METADATA_BYTES) {
    throw new Error(`Memory metadata exceeds the ${MAX_TOPIC_METADATA_BYTES}-byte limit.`);
  }
  return `${frontmatter}${input.content}\n`;
}

export function searchMemories(stores: MemoryStore[], query: string, limit = 10): SearchResult[] {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  type Candidate = SearchResult & { refs?: MemoryRef[]; store: MemoryStore };
  const results: Candidate[] = [];
  for (const store of stores) {
    let files: string[];
    try {
      files = readdirSync(store.dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
        .slice(0, MAX_SEARCH_FILES);
    } catch { continue; }
    for (const file of files) {
      let text: string;
      try {
        const path = containedTopicPath(store.dir, file);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        text = readRegularText(path, MAX_TOPIC_READ_BYTES);
      } catch { continue; }
      const normalized = normalizeSearch(`${file} ${text}`);
      const score = terms.reduce((sum, term) => sum + occurrences(normalized, term), 0);
      if (!score) continue;
      const metadata = topicMetadata(text);
      results.push({
        description: metadata.description || firstSentence(stripFrontmatter(text)), file,
        refs: parseTopicMetadata(text).refs, scope: store.scope, score,
        snippet: oneLine(stripFrontmatter(text), 300), store, type: metadata.type,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(({ refs, store, ...result }) => {
      const stale = refs?.length ? checkRefs(store, refs).some((ref) => ref.stale) : undefined;
      return stale !== undefined ? { ...result, stale } : result;
    });
}

export function readTopic(store: MemoryStore, file: string): string {
  return readRegularText(containedTopicPath(store.dir, file), MAX_TOPIC_READ_BYTES);
}

function containedTopicPath(dir: string, file: string): string {
  if (file !== basename(file) || !TOPIC_FILE.test(file) || file === "MEMORY.md") {
    throw new Error("Invalid memory topic filename.");
  }
  const path = resolve(dir, file);
  if (dirname(path) !== resolve(dir)) throw new Error("Memory topic escapes its store.");
  return path;
}

function topicMetadata(text: string): Record<string, string> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return {};
  return Object.fromEntries(text.slice(4, end).split("\n").flatMap((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, "")]] : [];
  }));
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end < 0 ? text : text.slice(end + 5).trim();
}

function findSecret(content: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
    [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/, "a GitHub token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "an API key"],
    [/\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i, "a credential"],
  ];
  return patterns.find(([pattern]) => pattern.test(content))?.[1];
}

function firstSentence(content: string): string {
  return content.split(/(?<=[.!?])\s+|\n/)[0] || content;
}
function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
function yamlString(value: string): string { return JSON.stringify(oneLine(value, 240)); }
function escapeMarkdown(value: string): string { return value.replace(/[\[\]\\]/g, "\\$&"); }
function normalizeSearch(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function occurrences(value: string, term: string): number {
  let count = 0;
  let position = 0;
  while ((position = value.indexOf(term, position)) >= 0) {
    count++;
    position += term.length;
  }
  return count;
}
