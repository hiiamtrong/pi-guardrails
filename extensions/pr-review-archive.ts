import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type ExtensionContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
};

type ExtensionApi = {
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
  ) => void;
};

type GithubUser = { login?: string; type?: string };
type PullRequest = {
  number: number;
  title: string;
  state: string;
  url: string;
  author?: GithubUser;
  baseRefName?: string;
  headRefName?: string;
  updatedAt?: string;
};
type GithubComment = {
  id: number;
  body?: string;
  html_url?: string;
  path?: string;
  line?: number;
  original_line?: number;
  diff_hunk?: string;
  user?: GithubUser;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  state?: string;
};
type GithubFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  sha?: string;
};

type Options = {
  authors: string[];
  limit: number;
  repo?: string;
};

const DEFAULT_AUTHORS = ["Sotatek-DavidVu", "liamnguyen4-source"];
const DEFAULT_REPOSITORY = "swaglive/swag-server";
const DATABASE_PATH = process.env.PI_PR_REVIEW_ARCHIVE_DB
  ?? join(homedir(), ".pi", "agent", "pi-guardrails", "pr-review-archive.sqlite");

export function sanitizeTerminal(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  const safeMessage = sanitizeTerminal(message);
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(safeMessage, level);
  else console.log(safeMessage);
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
  if (quote || escaped) throw new Error("Unterminated quote or escape.");
  if (value) values.push(value);
  return values;
}

function normalizeRepository(value: string): string {
  const match = value.trim().match(/(?:github\.com[:/])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error(`Invalid repository: ${value}`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function repositoryFromGit(cwd: string): string {
  try {
    return normalizeRepository(run("git", ["config", "--get", "remote.origin.url"], cwd));
  } catch {
    return DEFAULT_REPOSITORY;
  }
}

function parseOptions(values: string[], cwd: string): Options {
  let repo: string | undefined;
  let limit = 100;
  let authors = DEFAULT_AUTHORS;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--repo") repo = normalizeRepository(values[++index] ?? "");
    else if (value === "--authors") authors = (values[++index] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    else if (value === "--limit") {
      limit = Number(values[++index]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be 1–100.");
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return { repo: repo ?? repositoryFromGit(cwd), authors, limit };
}

function sql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("\0", "").replaceAll("'", "''")}'`;
}

function sqlite(query: string, json = false): unknown[] {
  const directory = dirname(DATABASE_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const args = json ? ["-json", DATABASE_PATH, query] : [DATABASE_PATH, query];
  const output = run("sqlite3", args);
  if (existsSync(DATABASE_PATH)) chmodSync(DATABASE_PATH, 0o600);
  if (!json || !output) return [];
  try {
    return JSON.parse(output) as unknown[];
  } catch (error) {
    throw new Error("sqlite3 returned invalid JSON.", { cause: error });
  }
}

function initializeDatabase(): void {
  sqlite(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pull_requests (
      repository TEXT NOT NULL, number INTEGER NOT NULL, author_login TEXT,
      title TEXT NOT NULL, state TEXT NOT NULL, base_ref TEXT, head_ref TEXT,
      url TEXT NOT NULL, updated_at TEXT, fetched_at TEXT NOT NULL,
      PRIMARY KEY (repository, number)
    );
    CREATE TABLE IF NOT EXISTS pr_files (
      repository TEXT NOT NULL, pr_number INTEGER NOT NULL, path TEXT NOT NULL,
      status TEXT NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      patch TEXT, blob_sha TEXT, PRIMARY KEY (repository, pr_number, path)
    );
    CREATE TABLE IF NOT EXISTS review_comments (
      archive_id TEXT PRIMARY KEY, repository TEXT NOT NULL, pr_number INTEGER NOT NULL,
      kind TEXT NOT NULL, author_login TEXT NOT NULL, body TEXT NOT NULL,
      path TEXT, line INTEGER, original_line INTEGER, diff_hunk TEXT, url TEXT,
      review_state TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS review_comments_pr_idx ON review_comments(repository, pr_number);
    CREATE INDEX IF NOT EXISTS review_comments_author_idx ON review_comments(author_login);
  `);
}

function ghJson<T>(args: string[]): T {
  const output = run("gh", args);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error("GitHub CLI returned invalid JSON.", { cause: error });
  }
}

function ghPages<T>(path: string): T[] {
  const pages = ghJson<T[][]>(["api", "--paginate", "--slurp", path]);
  return pages.flat();
}

function isHuman(comment: GithubComment): boolean {
  const login = comment.user?.login ?? "";
  return comment.user?.type === "User" && !/\[bot\]$/i.test(login);
}

function archivePullRequest(repository: string, pullRequest: PullRequest): number {
  const number = pullRequest.number;
  const files = ghPages<GithubFile>(`repos/${repository}/pulls/${number}/files?per_page=100`);
  const entries: Array<{ kind: string; item: GithubComment }> = [
    ...ghPages<GithubComment>(`repos/${repository}/issues/${number}/comments?per_page=100`).map((item) => ({ kind: "discussion", item })),
    ...ghPages<GithubComment>(`repos/${repository}/pulls/${number}/comments?per_page=100`).map((item) => ({ kind: "inline", item })),
    ...ghPages<GithubComment>(`repos/${repository}/pulls/${number}/reviews?per_page=100`).map((item) => ({ kind: "review", item })),
  ];
  const now = new Date().toISOString();
  const statements = [
    "BEGIN IMMEDIATE;",
    `INSERT INTO pull_requests VALUES (${sql(repository)}, ${sql(number)}, ${sql(pullRequest.author?.login)}, ${sql(pullRequest.title)}, ${sql(pullRequest.state)}, ${sql(pullRequest.baseRefName)}, ${sql(pullRequest.headRefName)}, ${sql(pullRequest.url)}, ${sql(pullRequest.updatedAt)}, ${sql(now)}) ON CONFLICT(repository, number) DO UPDATE SET author_login=excluded.author_login,title=excluded.title,state=excluded.state,base_ref=excluded.base_ref,head_ref=excluded.head_ref,url=excluded.url,updated_at=excluded.updated_at,fetched_at=excluded.fetched_at;`,
    `DELETE FROM pr_files WHERE repository=${sql(repository)} AND pr_number=${sql(number)};`,
    `DELETE FROM review_comments WHERE repository=${sql(repository)} AND pr_number=${sql(number)};`,
    ...files.map((file) => `INSERT INTO pr_files VALUES (${sql(repository)}, ${sql(number)}, ${sql(file.filename)}, ${sql(file.status)}, ${sql(file.additions)}, ${sql(file.deletions)}, ${sql(file.patch)}, ${sql(file.sha)});`),
  ];
  let count = 0;
  for (const { kind, item } of entries) {
    if (!isHuman(item) || !item.body?.trim()) continue;
    const timestamp = kind === "review" ? item.submitted_at ?? item.created_at : item.created_at;
    statements.push(`INSERT INTO review_comments VALUES (${sql(`${kind}:${item.id}`)}, ${sql(repository)}, ${sql(number)}, ${sql(kind)}, ${sql(item.user?.login)}, ${sql(item.body)}, ${sql(item.path)}, ${sql(item.line)}, ${sql(item.original_line)}, ${sql(item.diff_hunk)}, ${sql(item.html_url)}, ${sql(item.state)}, ${sql(timestamp)}, ${sql(kind === "review" ? item.submitted_at ?? item.updated_at : item.updated_at)});`);
    count += 1;
  }
  statements.push("COMMIT;");
  sqlite(statements.join("\n"));
  return count;
}

async function sync(args: string, ctx: ExtensionContext): Promise<void> {
  const options = parseOptions(splitArguments(args), ctx.cwd);
  initializeDatabase();
  const pullRequests = new Map<number, PullRequest>();
  for (const author of options.authors) {
    for (const pullRequest of ghJson<PullRequest[]>(["pr", "list", "--repo", options.repo!, "--author", author, "--state", "all", "--limit", String(options.limit), "--json", "number,title,state,url,author,baseRefName,headRefName,updatedAt"])) {
      pullRequests.set(pullRequest.number, pullRequest);
    }
  }
  let comments = 0;
  for (const pullRequest of pullRequests.values()) comments += archivePullRequest(options.repo!, pullRequest);
  notify(ctx, `Archived ${pullRequests.size} PRs and ${comments} human comments in ${DATABASE_PATH}.`);
}

function show(number: number, ctx: ExtensionContext): void {
  initializeDatabase();
  const repository = repositoryFromGit(ctx.cwd);
  const rows = sqlite(`SELECT kind, author_login, body, path, line, diff_hunk, url FROM review_comments WHERE repository=${sql(repository)} AND pr_number=${sql(number)} ORDER BY created_at;`, true) as Array<Record<string, unknown>>;
  if (!rows.length) {
    notify(ctx, `No archived human comments for ${repository}#${number}. Run /pr-review-archive sync first.`, "warning");
    return;
  }
  notify(ctx, rows.map((row) => `[${row.kind}] @${row.author_login}${row.path ? ` (${row.path}:${row.line ?? "?"})` : ""}\n${row.body}${row.diff_hunk ? `\n\n${row.diff_hunk}` : ""}\n${row.url ?? ""}`).join("\n\n"));
}

function search(query: string, ctx: ExtensionContext): void {
  initializeDatabase();
  const repository = repositoryFromGit(ctx.cwd);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error("Provide search terms.");
  const where = terms.map((term) => `lower(body || ' ' || coalesce(path, '') || ' ' || coalesce(diff_hunk, '')) LIKE ${sql(`%${term}%`)}`).join(" AND ");
  const rows = sqlite(`SELECT pr_number, kind, author_login, body, path, line, url FROM review_comments WHERE repository=${sql(repository)} AND ${where} ORDER BY updated_at DESC LIMIT 30;`, true) as Array<Record<string, unknown>>;
  notify(ctx, rows.length ? rows.map((row) => `#${row.pr_number} [${row.kind}] @${row.author_login}${row.path ? ` ${row.path}:${row.line ?? "?"}` : ""}\n${row.body}\n${row.url ?? ""}`).join("\n\n") : "No matching archived comments.");
}

export default function (pi: ExtensionApi): void {
  pi.registerCommand("pr-review-archive", {
    description: "Archive and search human GitHub PR review evidence in local SQLite",
    handler: async (args, ctx) => {
      try {
        const [action, ...rest] = splitArguments(args);
        if (action === "sync") return await sync(rest.join(" "), ctx);
        if (action === "show") return show(Number(rest[0]), ctx);
        if (action === "search") return search(rest.join(" "), ctx);
        if (action === "status") {
          initializeDatabase();
          const rows = sqlite("SELECT (SELECT count(*) FROM review_comments) AS comments, (SELECT count(*) FROM pull_requests) AS prs;", true) as Array<Record<string, unknown>>;
          return notify(ctx, `Archive: ${DATABASE_PATH}\n${JSON.stringify(rows[0] ?? {})}`);
        }
        notify(ctx, "Usage: /pr-review-archive sync [--repo owner/repo] [--authors user1,user2] [--limit 100] | show <PR-number> | search <terms> | status", "warning");
      } catch (error) {
        notify(ctx, `PR review archive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
