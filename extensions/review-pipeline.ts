import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const POLL_MS = 1000;
const TOOLS = join("reports", "reviews", "tools");
const HANDBOOKS = ["AGENTS.local.md", "AGENTS.md"];
// The engine ships with this package; the review checkout only holds the project's rules.
const ENGINE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "review-pipeline");

function engineDir(): string {
  return process.env.REVIEW_PIPELINE_ENGINE ?? ENGINE;
}

// Rules live next to pi's memory: <agent dir>/review-pipeline/{global,projects/<repo path>}.
function rulesHome(): string {
  return (
    process.env.REVIEW_PIPELINE_HOME ??
    join(resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")), "review-pipeline")
  );
}

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

// shortcut: mirrors claude-memory's projectMemoryDir so a repo has the same key there and here; a linked worktree maps to its main repo.
function canonicalRoot(dir: string): string {
  const current = realpathOr(dir);
  try {
    const dotGit = join(current, ".git");
    if (!lstatSync(dotGit).isFile()) return current;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!pointer) return current;
    const gitDir = realpathOr(resolve(current, pointer[1].trim()));
    const commonDir = realpathOr(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
    return basename(commonDir) === ".git" ? dirname(commonDir) : current;
  } catch {
    return current;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function projectRulesDir(root: string): string {
  const canonical = canonicalRoot(root);
  const encoded = canonical.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-").replace(/[\u0000-\u001f<>"|?*]/g, "-");
  const key = Buffer.byteLength(encoded) <= 220 ? encoded : `${encoded.slice(0, 180)}-${shortHash(canonical)}`;
  const candidate = join(rulesHome(), "projects", key);
  try {
    const owner = (JSON.parse(readFileSync(join(candidate, ".project.json"), "utf8")) as { root?: unknown }).root;
    if (typeof owner === "string" && owner !== canonical) return `${candidate}-${shortHash(canonical)}`;
  } catch {
    // no .project.json yet: the folder is unclaimed
  }
  return candidate;
}

function globalRules(): string {
  return join(rulesHome(), "global");
}

// Project rules come first, so a file the project has wins over the global one.
export function ruleRoots(root: string): string[] {
  return [projectRulesDir(root), globalRules()].filter((dir) => existsSync(join(dir, "steps")));
}

// Records which repo owns the folder, so another repo whose path encodes the same cannot silently share it.
export function claimProjectRules(root: string): void {
  const dir = projectRulesDir(root);
  const file = join(dir, ".project.json");
  if (existsSync(join(dir, "steps")) && !existsSync(file))
    writeFileSync(file, `${JSON.stringify({ root: canonicalRoot(root) }, null, 2)}\n`);
}

const STEPS = ["00", "01", "02", "03", "04", "05", "06", "07"];
const ACTIONS = ["start", "note", "done", "end"];
const WIDGET = "review-pipeline";
export const RED_GATE = 10;

type Ctx = {
  cwd: string;
  hasUI?: boolean;
  isIdle: () => boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget: (key: string, lines: string[] | undefined) => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
};
type ToolResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
};
type ExtensionAPI = {
  registerCommand: (
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: Ctx) => Promise<void>;
    },
  ) => void;
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    promptGuidelines: string[];
    parameters: object;
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<ToolResult>;
  }) => void;
  on: (event: "session_shutdown", handler: () => void) => void;
  sendUserMessage: (text: string) => void;
};
type Env = Record<string, string>;
type Active = {
  pr: string;
  script: string;
  env: Env;
  widget: string;
  timer?: ReturnType<typeof setInterval>;
  lines?: string[];
  finished?: boolean;
};

const PR_LINK =
  /^\s*(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?\s*$/i;

export function repoOf(remote: string): string | undefined {
  const match = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function checkoutRepo(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", root, "remote", "get-url", "origin"]);
    return repoOf(stdout);
  } catch {
    return undefined;
  }
}

export function parsePrLink(
  args: string,
): { repo: string; pr: string } | undefined {
  const match = PR_LINK.exec(args);
  return match ? { repo: `${match[1]}/${match[2]}`, pr: match[3] } : undefined;
}

const FLAGS = ["--takeover", "--restart", "--bg"];

export function splitFlags(args: string): { rest: string; flags: string[] } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  return {
    rest: words.filter((word) => !FLAGS.includes(word)).join(" "),
    flags: words.filter((word) => FLAGS.includes(word)),
  };
}

type Begin = {
  url: string;
  widget: string;
  resumed?: boolean;
  next?: string | null;
  done?: string[];
  waiting?: string | null;
};

export function parseBegin(text: string): Begin | undefined {
  try {
    const parsed: unknown = JSON.parse(text.split("\n").pop() ?? "");
    const { url, widget, resumed, next, done, waiting } = (parsed ?? {}) as Record<string, unknown>;
    if (typeof url !== "string" || typeof widget !== "string") return undefined;
    return {
      url,
      widget,
      ...(typeof resumed === "boolean" ? { resumed } : {}),
      ...(typeof next === "string" || next === null ? { next } : {}),
      ...(Array.isArray(done) ? { done: done.map(String) } : {}),
      ...(typeof waiting === "string" || waiting === null ? { waiting } : {}),
    };
  } catch {
    return undefined;
  }
}

export function findRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return lstatSync(join(dir, ".git")).isFile() ? canonicalRoot(dir) : dir; // a PR worktree maps to the review clone
    if (dirname(dir) === dir) return undefined;
  }
}

export function handbookOf(root: string): string | undefined {
  return HANDBOOKS.map((name) => join(root, name)).find(existsSync);
}

async function reviewerOf(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", root, "config", "--local", "--get", "identity.guard.user"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const MANAGED = ".review-pipeline-managed";

function overlay(source: string, dest: string): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      overlay(from, to);
    } else {
      rmSync(to, { force: true });
      symlinkSync(from, to);
    }
  }
}

// A build killed before its rename leaves a .tools-* folder behind. Only old ones go, so another window's build in flight is safe.
export const STALE_TOOLS_MS = 600_000;

function sweepStaleTools(reviews: string, keep: string): void {
  for (const name of readdirSync(reviews)) {
    if (!name.startsWith(".tools-") || name === keep) continue;
    const path = join(reviews, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_TOOLS_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // gone already (another window swept it) or unreadable: a leftover must not stop the command
    }
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Rules and scripts address the tools as reports/reviews/tools/: the engine, then global overrides, then project overrides, as links.
// The folder is built beside the old one and swapped in by renaming a link, so a running review never sees it missing.
// .pipeline-env carries the environment, so the scripts also work when the agent runs them by hand.
export function assembleTools(root: string, rules: string[], env: Env = {}): string | undefined {
  const reviews = join(root, "reports", "reviews");
  const dir = join(reviews, "tools");
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(dir);
  } catch {
    // nothing there yet
  }
  if (existing && !existing.isSymbolicLink() && !existsSync(join(dir, MANAGED)))
    return `${dir} là thư mục thật chưa do review-pipeline quản lý: chuyển nội dung sang ${join(projectRulesDir(root), "tools")} rồi chạy lại`;
  mkdirSync(reviews, { recursive: true });
  const built = mkdtempSync(join(reviews, ".tools-"));
  writeFileSync(join(built, MANAGED), "");
  for (const source of [engineDir(), ...[...rules].reverse().map((rule) => join(rule, "tools"))]) overlay(source, built);
  writeFileSync(join(built, ".pipeline-env"), Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join(""));
  const previous = existing?.isSymbolicLink() ? readlinkSync(dir) : undefined;
  if (existing && !existing.isSymbolicLink()) rmSync(dir, { recursive: true }); // a real folder an older version built
  const swap = `${dir}.swap-${process.pid}`;
  rmSync(swap, { force: true });
  symlinkSync(built, swap);
  renameSync(swap, dir);
  if (previous && dirname(previous) === reviews && basename(previous).startsWith(".tools-")) rmSync(previous, { recursive: true, force: true });
  sweepStaleTools(reviews, basename(built));
  return undefined;
}

// Reads back what assembleTools wrote, so a process that never ran /review-pr (a background subagent) gets the same environment.
export function readPipelineEnv(file: string): Env | undefined {
  if (!existsSync(file)) return undefined;
  const env: Env = {};
  for (const [, key, value] of readFileSync(file, "utf8").matchAll(/^export (\w+)='((?:[^']|'\\'')*)'$/gm)) env[key] = value.replaceAll("'\\''", "'");
  return env.RV ? env : undefined;
}

function validPattern(value: string): boolean {
  try {
    return value.length > 0 && !!new RegExp(value);
  } catch {
    return false;
  }
}

type Policy = { worktreePrefix?: string; gates?: string[]; impactSections?: number; draftCheck?: string; authorPattern?: string; baseBranch?: string; k3sHost?: string };

// shortcut: a typo in pipeline.json fails loudly instead of silently turning a gate on or off; no schema library for six keys.
export function readPolicy(rules: string[]): Policy {
  const policy: Policy = {};
  for (const dir of [...rules].reverse()) {
    const file = join(dir, "pipeline.json");
    if (!existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${file} không đọc được: ${(error as Error).message}`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "worktreePrefix" && typeof value === "string" && /^[\w.-]+$/.test(value)) policy.worktreePrefix = value;
      else if (key === "gates" && Array.isArray(value) && value.every((v) => typeof v === "string" && STEPS.includes(v)))
        policy.gates = value as string[];
      else if (key === "impactSections" && Number.isInteger(value) && (value as number) > 0) policy.impactSections = value as number;
      else if (key === "draftCheck" && typeof value === "string" && /^[\w.-]+$/.test(value)) policy.draftCheck = value;
      else if (key === "authorPattern" && typeof value === "string" && validPattern(value)) policy.authorPattern = value;
      else if (key === "baseBranch" && typeof value === "string" && /^[\w][\w./-]*$/.test(value)) policy.baseBranch = value;
      else if (key === "k3sHost" && typeof value === "string" && /^[\w.-]+@[\w.-]+$/.test(value)) policy.k3sHost = value;
      else throw new Error(`${file}: khóa "${key}" lạ hoặc giá trị sai kiểu`);
    }
  }
  return policy;
}

function policyEnv(policy: Policy, repo: string): Env {
  return {
    WT_PREFIX: policy.worktreePrefix ?? `${repo.split("/").pop()}-pr-`,
    ...(policy.gates ? { GATES: [...new Set(["00", ...policy.gates])].join(" ") } : {}),
    ...(policy.impactSections ? { IMPACT_SECTIONS: String(policy.impactSections) } : {}),
    ...(policy.draftCheck ? { DRAFT_CHECK: policy.draftCheck } : {}),
    ...(policy.authorPattern ? { AUTHOR_PATTERN: policy.authorPattern } : {}),
    ...(policy.baseBranch ? { BASE_BRANCH: policy.baseBranch } : {}),
    ...(policy.k3sHost ? { K3S_SSH: policy.k3sHost } : {}),
  };
}

export const IDLE_MS = 300_000;

export function withIdleWarning(
  lines: string[],
  idleMs: number,
  pr: string,
): string[] {
  const running = lines[0]?.startsWith(`Review #${pr}: Đang ở bước`);
  if (!running || idleMs < IDLE_MS) return lines;
  const minutes = Math.floor(idleMs / 60_000);
  return [
    `Review #${pr}: ${minutes} phút không có ghi chú mới, agent có thể đang chạy lệnh dài hoặc đã dừng`,
    ...lines.slice(1),
  ];
}

export function readWidget(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

// Same format as the engine's fmt_secs: 45s, then 2m05s.
function elapsed(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  return n >= 60 ? `${Math.floor(n / 60)}m${String(n % 60).padStart(2, "0")}s` : `${n}s`;
}

// The engine writes a running time as {{since:<epoch seconds>}}, because its file is only rewritten on an event.
export function renderTimes(lines: string[], nowMs: number): string[] {
  return lines.map((line) => line.replace(/\{\{since:(\d+)\}\}/g, (_, since) => elapsed(nowMs / 1000 - Number(since))));
}

function idleMs(widgetPath: string): number {
  try {
    return Date.now() - statSync(join(dirname(widgetPath), "events.jsonl")).mtimeMs;
  } catch {
    return 0;
  }
}

// A step in progress writes nothing until it is done: #19323 had 587 s between a start and the next event, longer than IDLE_MS.
// Equal to the default TESTS_LOCK_WAIT in run_pr_tests.sh: a runner queued for the test lock is silent that long, so raise both together.
export const STEP_MS = 1_800_000;

// The owner lock in begin separates Pi processes only: every runner started by one Pi has the same pid, so it cannot see a second runner on the same PR.
export function activeFor(root: string, pr: string): number | undefined {
  const file = join(root, "reports", "reviews", "evidence", pr, "gates", "events.jsonl");
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    const last = JSON.parse(readFileSync(file, "utf8").trimEnd().split("\n").pop() ?? "") as { state?: string };
    return age < (last.state === "start" ? STEP_MS : IDLE_MS) && last.state !== "end" ? Math.round(age / 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function kickoff(repo: string, reviewer: string, rules: string[], pr: string, url: string, resume?: Begin, background?: string): string {
  const resumeLines = resume?.resumed
    ? [
        `Review này ĐANG DỞ từ phiên trước (bước đã xong: ${resume.done?.join(", ") || "chưa có"}; bước kế: ${resume.next ?? "không còn"}). Tiến độ nằm ở reports/reviews/evidence/${pr}/gates/events.jsonl, bản nháp ở reports/reviews/${pr}.md.`,
        "Chạy lại bước 00 trước vì head PR có thể đã đổi, rồi làm tiếp từ bước kế. Không làm lại bước đã xong trừ khi head đổi hoặc gate báo đỏ.",
        ...(resume.waiting
          ? [
              `Bước ${resume.waiting} đang CHỜ người review (${reviewer}) đọc bản nháp và nói OK post. Chưa làm bước nào sau nó khi họ chưa nói OK; nếu head không đổi thì chỉ báo họ là bản nháp đang chờ.`,
            ]
          : []),
      ]
    : [];
  const ending = background
    ? [
        `- Bạn chạy nền nên không ghi được lên GitHub: dừng ngay sau bước 05, KHÔNG làm bước 06 và 07, KHÔNG gọi action=end. Kết thúc bằng bản tóm tắt bản nháp reports/reviews/${pr}.md và gate nào còn đỏ hoặc chờ người.`,
      ]
    : [
        `- Dừng sau bước 05 để ${reviewer} đọc và nói OK post. Chưa làm bước 06 và chưa ghi gì lên GitHub trước đó.`,
        "- Xong thì gọi review_step action=end.",
      ];
  const text = [
    `Review PR ${repo} #${pr} theo pipeline v2. UI đã mở ở ${url}.`,
    `Bước 06 và mọi lệnh gh trong pipeline đọc repo ${repo} qua biến REPO; khi cụ thể hoá post_guard.template.sh thì điền __REPO__ = ${repo} và __REVIEWER__ = ${reviewer}. Thư mục rule, ưu tiên từ trên xuống (file nào có ở cả hai thì lấy bản trên): ${rules.join(", ")}.`,
    ...resumeLines,
    "Làm lần lượt các bước 00 intake, 01 comments, 02 map, 03 verify, 04 outside-diff, 05 draft, 06 post, 07 after.",
    `- Mọi lần gọi review_step phải kèm pr=${pr}: phiên này có thể đang chạy review PR khác song song.`,
    `- Trước mỗi bước gọi review_step action=start step=<NN> pr=${pr}: tool trả hướng dẫn của bước đó, đọc kỹ rồi làm đúng.`,
    "- Khi chuyển sang việc khác trong bước, gọi review_step action=note với một dòng ngắn để UI hiện bạn đang làm gì.",
    "- Hết bước gọi review_step action=done: tool tự chạy gate của bước, kết quả đó là kết luận, không tự khai pass. Gate đỏ thì sửa rồi gọi done lại.",
    ...ending,
  ].join("\n");
  if (!background) return text;
  return [
    `Chạy review PR ${repo} #${pr} ở nền để phiên này rảnh cho PR khác. Gọi tool subagent đúng một lần: agent=review-runner, async=true, cwd=${background}, task = nguyên văn khối dưới đây, không sửa, không tóm tắt. Gọi xong chỉ trả lời một dòng, không tự làm bước nào của review.`,
    `Khi subagent báo xong: nói ${reviewer} đọc bản nháp reports/reviews/${pr}.md. Chỉ khi họ nói OK mới tự làm tiếp bước 06 và 07 (review_step pr=${pr}); subagent nền không ghi được lên GitHub.`,
    "```",
    text,
    "```",
  ].join("\n");
}

async function pipeline(
  script: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 900_000,
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const python = process.env.SWAG_REVIEW_PYTHON ?? "python3.12";
  try {
    const { stdout, stderr } = await run(python, [script, ...args], {
      timeout,
      cwd,
      maxBuffer: 4_000_000,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout.trim(), err: stderr.trim() };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 2,
      out: (failure.stdout ?? "").trim(),
      err: (failure.stderr ?? "").trim() || failure.message,
    };
  }
}

export const MAX_OPEN = 10;

class Refusal extends Error {
  level: "warning" | "error";
  constructor(message: string, level: "warning" | "error" = "error") {
    super(message);
    this.level = level;
  }
}

export default function (pi: ExtensionAPI): void {
  const reviews = new Map<string, Active>();
  let lastCtx: Ctx | undefined;
  let board: Ctx["ui"] | undefined;
  let shown = "";

  function stop(review: Active): void {
    if (review.timer) clearInterval(review.timer);
    review.timer = undefined;
  }

  function render(): void {
    const blocks = [...reviews.values()].flatMap((review) => (review.lines ? [review.lines] : []));
    if (!board || blocks.length === 0) return;
    const lines = blocks.length === 1 ? blocks[0] : blocks.map((block) => block[0]);
    const status = blocks.map((block) => block[0]).join(" | ");
    const frame = `${lines.join("\n")}\n${status}`;
    if (frame === shown) return;
    shown = frame;
    board.setWidget(WIDGET, lines);
    board.setStatus(WIDGET, status);
  }

  // A process that never ran /review-pr (a background subagent) takes the environment the checkout's tools folder holds.
  function fromDisk(pr: string): Active | undefined {
    const root = findRoot(process.cwd());
    const env = root ? readPipelineEnv(join(root, TOOLS, ".pipeline-env")) : undefined;
    return root && env ? { pr, script: join(root, TOOLS, "v2", "pipeline_step.py"), env, widget: "" } : undefined;
  }

  function pick(pr: string | undefined): Active {
    if (pr) {
      const found = reviews.get(pr) ?? fromDisk(pr);
      if (!found) {
        const known = [...reviews.keys()].map((key) => `#${key}`).join(", ") || "không có";
        throw new Error(`PR #${pr} chưa chạy /review-pr trong phiên này (đang có: ${known}) và ${process.cwd()} không có ${join(TOOLS, ".pipeline-env")}`);
      }
      return found;
    }
    if (reviews.size === 0) throw new Error("Không có review đang chạy: gõ /review-pr <link PR> trước, hoặc truyền pr=<số PR> nếu checkout này đã chạy /review-pr");
    const open = [...reviews.values()].filter((review) => !review.finished);
    const pool = open.length > 0 ? open : [...reviews.values()];
    if (pool.length > 1) throw new Error(`Đang có ${pool.length} review (${pool.map((review) => `#${review.pr}`).join(", ")}): truyền pr=<số PR> để chọn`);
    return pool[0];
  }

  function watch(ctx: Ctx, current: Active): void {
    board = ctx.ui;
    const tick = () => {
      const read = readWidget(current.widget);
      if (!read) return;
      current.lines = renderTimes(withIdleWarning(read, idleMs(current.widget), current.pr), Date.now());
      render();
      if (current.lines[0].startsWith(`Review #${current.pr}: Xong`)) {
        current.finished = true;
        stop(current);
      }
    };
    tick();
    current.timer = setInterval(tick, POLL_MS);
    current.timer.unref?.();
  }

  function registerTool(): void {
    pi.registerTool({
      name: "review_step",
      label: "Review step",
      description:
        "Report progress of a /review-pr run. start: begin a step and get its instructions. note: say what you are doing now. done: run that step's gate, whose verdict is final. end: finish the review. Several PRs can be open at once: pass pr to say which.",
      promptGuidelines: [
        "During a /review-pr run, call review_step at every step boundary so the live UI shows the current step.",
        "Pass pr=<PR number> on every review_step call; it is required when more than one review is open.",
      ],
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ACTIONS },
          pr: {
            type: "string",
            description: "PR number of the review this call is for, required when more than one review is open",
          },
          step: {
            type: "string",
            enum: STEPS,
            description: "Step number, required for start, note and done",
          },
          message: {
            type: "string",
            description: "One short line shown in the UI, required for note",
          },
        },
        required: ["action"],
      },
      async execute(_id, params) {
        const action = String(params.action);
        const step = params.step === undefined ? undefined : String(params.step);
        const message =
          params.message === undefined ? undefined : String(params.message);
        if (!ACTIONS.includes(action))
          throw new Error(`action phải là một trong ${ACTIONS.join(", ")}`);
        if (action !== "end" && (!step || !STEPS.includes(step)))
          throw new Error(`action=${action} cần step là một trong ${STEPS.join(" ")}`);
        if (action === "note" && !message)
          throw new Error("action=note cần message");
        const target = pick(params.pr === undefined ? undefined : String(params.pr).replace(/^#/, ""));
        const argv =
          action === "end" ? [action, target.pr] : [action, target.pr, step!];
        if (message) argv.push("--msg", message);
        const { code, out, err } = await pipeline(target.script, argv, target.env);
        if (code !== 0 && code !== RED_GATE) throw new Error(err || out);
        if (action === "end") target.finished = true;
        return {
          content: [{ type: "text", text: out }],
          details: { action, step, code },
        };
      },
    });
  }

  // The command and the review_start tool share this; only the command has an agent to wait for, only the tool has a limit.
  async function startReview(args: string, cwd: string, ctx: Ctx | undefined, fromTool: boolean): Promise<{ notice: string; message: string }> {
    const { rest, flags } = splitFlags(args);
    const background = flags.includes("--bg");
    const link = parsePrLink(rest);
    if (!link) throw new Refusal("Usage: /review-pr <GitHub PR link> [--takeover | --restart] [--bg]", "warning");
    const root = findRoot(cwd);
    if (!root) throw new Refusal("Không thấy repo git: chạy /review-pr trong review checkout của repo cần review");
    const open = reviews.get(link.pr);
    if (open && !open.finished && open.env.RV !== root)
      throw new Refusal(`PR #${link.pr} đang mở ở ${open.env.RV}: dùng chung số PR với ${root} thì review_step không phân biệt được, xong review đó (action=end) hoặc mở phiên Pi khác`);
    const quiet = flags.includes("--takeover") ? undefined : activeFor(root, link.pr);
    if (quiet !== undefined)
      throw new Refusal(`PR #${link.pr} đang có runner làm việc, sự kiện cuối ${quiet} giây trước: hai runner cùng ghi một review sẽ giẫm lên nhau. Đợi nó xong hoặc dừng nó, hoặc ${fromTool ? "nhờ người dùng gõ /review-pr với --takeover (tool không có cờ này)" : "thêm --takeover"} nếu chắc nó đã chết`);
    const others = [...reviews.values()].filter((review) => !review.finished && review.pr !== link.pr);
    if (fromTool && others.length >= MAX_OPEN)
      throw new Refusal(`Đã có ${others.length} review đang mở (${others.map((review) => `#${review.pr}`).join(", ")}): xong bớt một cái (review_step action=end, mất khả năng tiếp tục review đó) rồi mới mở thêm, tối đa ${MAX_OPEN} mỗi phiên Pi; người dùng gõ /review-pr thì không bị giới hạn`);
    const repo = await checkoutRepo(root);
    if (!repo) throw new Refusal(`Không đọc được remote origin của ${root}: gate cần biết review checkout thuộc repo nào`);
    if (link.repo.toLowerCase() !== repo.toLowerCase())
      throw new Refusal(`Review checkout này là ${repo}, không phải ${link.repo}: các gate đọc repo của checkout, hãy chạy /review-pr trong review checkout của ${link.repo}`);
    const handbook = handbookOf(root);
    if (!handbook) throw new Refusal(`Không thấy ${HANDBOOKS.join(" hoặc ")} trong ${root}: sổ tay reviewer của dự án`);
    const reviewer = await reviewerOf(root);
    if (!reviewer) throw new Refusal(`Không đọc được identity.guard.user trong git config của ${root}: cần biết tài khoản GitHub của reviewer`);
    const rules = ruleRoots(root);
    if (rules.length === 0) throw new Refusal(`Không thấy rule: đặt steps/ trong ${projectRulesDir(root)} (dự án) hoặc ${globalRules()} (global)`);
    let policy: Policy;
    try {
      policy = readPolicy(rules);
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    if (!fromTool && ctx && !ctx.isIdle()) throw new Refusal("Agent đang bận, đợi xong rồi /review-pr lại", "warning");
    claimProjectRules(root);
    const env: Env = { REPO: repo, RV: root, HANDBOOK: handbook, REVIEWER: reviewer, RULES: rules.join(delimiter), ...policyEnv(policy, repo) };
    const linkError = assembleTools(root, rules, env);
    if (linkError) throw new Refusal(linkError);
    const script = join(root, TOOLS, "v2", "pipeline_step.py");
    const pr = link.pr;
    const begin = await pipeline(script, ["begin", pr, "--owner", String(process.pid), ...flags.filter((flag) => flag !== "--bg")], env);
    if (begin.code !== 0) throw new Refusal(`Không bật được UI: ${begin.err || begin.out}`);
    const opened = parseBegin(begin.out);
    if (!opened) throw new Refusal(`Không đọc được đầu ra của begin: ${begin.out || "(rỗng)"}`);
    const { url, widget } = opened;
    const previous = reviews.get(pr);
    if (previous) stop(previous);
    const active: Active = { pr, script, env, widget };
    reviews.set(pr, active);
    if (ctx && ctx.hasUI !== false) watch(ctx, active);
    return {
      notice: `Review #${pr}: UI ở ${url}${opened.resumed ? " (tiếp tục review dang dở)" : ""}`,
      message: kickoff(repo, reviewer, rules, pr, url, opened, background ? root : undefined),
    };
  }

  async function loadBoard(cwd: string): Promise<string> {
    const root = findRoot(cwd);
    if (!root) throw new Refusal("Không thấy repo git: chạy /review-board trong review checkout của repo cần xem");
    const repo = await checkoutRepo(root);
    if (!repo) throw new Refusal(`Không đọc được remote origin của ${root}: cần biết checkout thuộc repo nào`);
    const reviewer = await reviewerOf(root);
    if (!reviewer) throw new Refusal(`Không đọc được identity.guard.user trong git config của ${root}: cần biết tài khoản GitHub của reviewer`);
    let policy: Policy;
    try {
      policy = readPolicy(ruleRoots(root));
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    const argv = ["--repo", repo, "--reviewer", reviewer, "--no-color"];
    if (policy.authorPattern) argv.push("--author-pattern", policy.authorPattern);
    // The board only reads GitHub (about 13 s for 16 PRs), so a stuck gh must not hold the command for the pipeline's 15 minutes.
    // The script sees a pipe, not the terminal, so hand it the width for its line cut.
    const columns: Record<string, string> = process.stdout.columns ? { COLUMNS: String(process.stdout.columns) } : {};
    // The command is silent for ~13 s otherwise: show a status that counts seconds, and always clear it.
    const started = Date.now();
    const ui = lastCtx?.ui;
    const show = () => ui?.setStatus("review-board", `⏳ review-board: đang tải PR từ GitHub... ${Math.round((Date.now() - started) / 1000)}s`);
    show();
    const ticker = setInterval(show, 1000);
    let result: Awaited<ReturnType<typeof pipeline>>;
    try {
      result = await pipeline(join(engineDir(), "v2", "review_board.py"), argv, columns, Number(process.env.REVIEW_BOARD_TIMEOUT_MS) || 60_000, root);
    } finally {
      clearInterval(ticker);
      ui?.setStatus("review-board", undefined);
    }
    if (result.code !== 0) throw new Refusal(result.err || result.out || "review_board.py lỗi không rõ");
    return [result.out, result.err].filter(Boolean).join("\n");
  }

  pi.registerCommand("review-pr", {
    description:
      "Start or resume a PR review with the live pipeline UI, in the review checkout of the PR's repo: /review-pr <GitHub PR link> [--takeover | --restart] [--bg]; --bg hands the work to a background subagent so this session stays free",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      try {
        const started = await startReview(args, ctx.cwd, ctx, false);
        ctx.ui.notify(started.notice, "info");
        pi.sendUserMessage(started.message);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        ctx.ui.notify(error.message, error.level);
      }
    },
  });

  pi.registerCommand("review-board", {
    description:
      "Show every open PR you reviewed or were asked to review, grouped by what needs you next, in the review checkout of the repo: /review-board",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      try {
        ctx.ui.notify(await loadBoard(ctx.cwd), "info");
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        ctx.ui.notify(error.message, error.level);
      }
    },
  });

  pi.registerTool({
    name: "review_start",
    label: "Review start",
    description:
      "Start or resume the PR review pipeline for a GitHub PR link, in the review checkout of the current directory, like /review-pr. By default the review runs in a background review-runner subagent; the result tells you how to launch it. At most 10 reviews can be open at once.",
    promptGuidelines: [
      "Use review_start only when the user asked to review a PR; follow the instructions it returns exactly.",
    ],
    parameters: {
      type: "object",
      properties: {
        link: { type: "string", description: "Full GitHub PR link, e.g. https://github.com/owner/repo/pull/123" },
        background: { type: "boolean", description: "Run in a background subagent (default true); false makes this session do the review itself" },
      },
      required: ["link"],
    },
    async execute(_id, params) {
      const background = params.background !== false;
      // The whole string must be one link: startReview reads flags out of its arguments, and the agent may not pass --takeover or --restart.
      const link = parsePrLink(String(params.link ?? ""));
      if (!link) throw new Refusal("link phải là đúng một link PR GitHub, không kèm cờ nào. Usage: /review-pr <GitHub PR link>", "warning");
      const started = await startReview(`https://github.com/${link.repo}/pull/${link.pr}${background ? " --bg" : ""}`, process.cwd(), lastCtx, true);
      return { content: [{ type: "text", text: `${started.notice}\n\n${started.message}` }], details: { background } };
    },
  });

  pi.registerTool({
    name: "review_board",
    label: "Review board",
    description:
      "List every open PR the reviewer has reviewed or been asked to review in the current review checkout, grouped by the next action (review again, not reviewed, new replies, waiting for the author, done), like /review-board. Reads GitHub only and takes about 15 seconds.",
    promptGuidelines: ["Use review_board to decide which PR to review next, before calling review_start."],
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: await loadBoard(process.cwd()) }], details: {} };
    },
  });

  registerTool();
  pi.on("session_shutdown", () => reviews.forEach(stop));
}
