import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

process.env.SWAG_REVIEW_PYTHON = "python3";

const { parsePrLink, parseBegin, readPipelineEnv, activeFor, STEP_MS, repoOf, splitFlags, findRoot, handbookOf, assembleTools, claimProjectRules, renderTimes, readPolicy, ruleRoots, projectRulesDir, readWidget, kickoff, withIdleWarning, IDLE_MS, STALE_TOOLS_MS, POLL_MS, default: reviewPipeline } =
  await import(`../extensions/review-pipeline.ts?test=${Date.now()}`);

const STUB = `import json, os, pathlib, sys
cmd, pr = sys.argv[1], sys.argv[2]
work = pathlib.Path(__file__).resolve().parent / "work"
work.mkdir(exist_ok=True)
log = work / "calls.txt"
with open(log, "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
(work / "policy.txt").write_text(" ".join(os.environ.get(k, "-") for k in ("WT_PREFIX", "GATES", "IMPACT_SECTIONS", "DRAFT_CHECK", "AUTHOR_PATTERN", "BASE_BRANCH", "K3S_SSH", "TRIGGERS", "WATCH_PATHS")) + "\\n")
(work / "env.txt").write_text(" ".join(os.environ.get(k, "-") for k in ("REPO", "RV", "HANDBOOK", "REVIEWER", "RULES")) + "\\n")
if cmd == "begin":
    if "STUB_REFUSE" in os.environ:
        print(os.environ["STUB_REFUSE"], file=sys.stderr)
        sys.exit(3)
    wfile = work / (f"widget-{pr}.txt" if "STUB_PER_PR" in os.environ else "widget.txt")
    wfile.write_text(f"Review #{pr}: Đang ở bước 00 intake\\n▶ 00 intake\\n")
    print(os.environ["STUB_BEGIN"] if "STUB_BEGIN" in os.environ else json.dumps({"url": "http://127.0.0.1:9", "widget": str(wfile)}))
    if "STUB_STDERR" in os.environ:
        print(os.environ["STUB_STDERR"], file=sys.stderr)
elif cmd == "done":
    print("VERDICT bước 01 comments: fail")
    sys.exit(10)
elif "traceback" in sys.argv:
    print("Traceback (most recent call last): boom", file=sys.stderr)
    sys.exit(1)
elif "crash" in sys.argv:
    print("broken", file=sys.stderr)
    sys.exit(3)
else:
    print(f"ok {cmd}")
`;

const RULES = ["/rules/project", "/rules/global"];

type Fixture = { root: string; work: string; engine: string; globalRules: string };

function repo(
  remote: string | null = "https://github.com/swaglive/swag-server.git",
  options: { reviewer?: string | null; handbook?: string | null; projectRules?: boolean } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "review-pipeline-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  if (remote) execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
  const { reviewer = "Sotatek-TheoNguyen2", handbook = "AGENTS.local.md", projectRules = true } = options;
  if (reviewer) execFileSync("git", ["-C", root, "config", "--local", "identity.guard.user", reviewer]);
  if (handbook) writeFileSync(join(root, handbook), "# handbook\n");
  process.env.REVIEW_PIPELINE_HOME = mkdtempSync(join(tmpdir(), "review-home-"));
  const globalRules = join(process.env.REVIEW_PIPELINE_HOME, "global");
  if (projectRules) mkdirSync(join(projectRulesDir(root), "steps"), { recursive: true });
  const engine = mkdtempSync(join(tmpdir(), "review-engine-"));
  mkdirSync(join(engine, "v2"));
  writeFileSync(join(engine, "v2", "pipeline_step.py"), STUB);
  process.env.REVIEW_PIPELINE_ENGINE = engine;
  return { root, work: join(engine, "v2", "work"), engine, globalRules };
}

function setup() {
  const sent: string[] = [];
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  type ToolFn = (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  const tools: Record<string, ToolFn | undefined> = {};
  const handlers: Record<string, () => void> = {};
  reviewPipeline({
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = command.handler;
    },
    registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }) => {
      tools[tool.name] = tool.execute;
    },
    on: (event: string, handler: () => void) => {
      handlers[event] = handler;
    },
    sendUserMessage: (text: string) => sent.push(text),
  });
  const notes: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const ctx = (cwd: string, idle = true) => ({
    cwd,
    isIdle: () => idle,
    ui: {
      notify: (message: string) => notes.push(message),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  });
  return { sent, commands, tools, handlers, notes, widgets, statuses, ctx };
}

test("parsePrLink reads a GitHub PR link, with or without scheme and trailing path, and nothing else", () => {
  const link = "https://github.com/swaglive/swag-server/pull/19233";
  assert.deepEqual(parsePrLink(link), { repo: "swaglive/swag-server", pr: "19233" });
  assert.deepEqual(parsePrLink(`${link}/files`), { repo: "swaglive/swag-server", pr: "19233" });
  assert.deepEqual(parsePrLink(`${link}#discussion_r1`), { repo: "swaglive/swag-server", pr: "19233" });
  assert.deepEqual(parsePrLink(`  github.com/swaglive/swag-server/pull/19233  `), { repo: "swaglive/swag-server", pr: "19233" });
  assert.deepEqual(parsePrLink("https://github.com/swaglive/swag-openim/pull/73"), { repo: "swaglive/swag-openim", pr: "73" });
  assert.equal(parsePrLink("19233"), undefined);
  assert.equal(parsePrLink("#19233"), undefined);
  assert.equal(parsePrLink(""), undefined);
  assert.equal(parsePrLink(`${link} and more words`), undefined);
  assert.equal(parsePrLink("https://github.com/swaglive/swag-server/issues/19233"), undefined);
});

test("findRoot walks up from a subdirectory to the git checkout, and stops at the filesystem root", () => {
  const { root } = repo();
  const sub = join(root, "swag", "features");
  mkdirSync(sub, { recursive: true });
  assert.equal(findRoot(sub), root);
  assert.equal(findRoot(mkdtempSync(join(tmpdir(), "no-repo-"))), undefined);
});

test("handbookOf prefers AGENTS.local.md, falls back to AGENTS.md, and is undefined without either", () => {
  const both = repo().root;
  writeFileSync(join(both, "AGENTS.md"), "x");
  assert.equal(handbookOf(both), join(both, "AGENTS.local.md"));
  const only = repo(undefined, { handbook: "AGENTS.md" }).root;
  assert.equal(handbookOf(only), join(only, "AGENTS.md"));
  assert.equal(handbookOf(repo(undefined, { handbook: null }).root), undefined);
});

test("ruleRoots lists the project rules before the global ones and skips a folder without steps", () => {
  const f = repo();
  assert.deepEqual(ruleRoots(f.root), [projectRulesDir(f.root)]);
  mkdirSync(join(f.globalRules, "steps"), { recursive: true });
  assert.deepEqual(ruleRoots(f.root), [projectRulesDir(f.root), f.globalRules]);
  const globalOnly = repo(undefined, { projectRules: false });
  assert.deepEqual(ruleRoots(globalOnly.root), []);
  mkdirSync(join(globalOnly.globalRules, "steps"), { recursive: true });
  assert.deepEqual(ruleRoots(globalOnly.root), [globalOnly.globalRules]);
});

test("projectRulesDir encodes the repo path like memory does, maps a linked worktree to its main repo, and avoids another repo's folder", () => {
  const { root } = repo();
  const home = process.env.REVIEW_PIPELINE_HOME!;
  const real = realpathSync.native(root);
  assert.equal(projectRulesDir(root), join(home, "projects", real.replaceAll("/", "-")));

  const linked = mkdtempSync(join(tmpdir(), "linked-"));
  const gitDir = join(root, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
  assert.equal(projectRulesDir(linked), projectRulesDir(root));

  const claimed = projectRulesDir(root);
  mkdirSync(claimed, { recursive: true });
  writeFileSync(join(claimed, ".project.json"), JSON.stringify({ root: "/some/other/place" }));
  assert.match(projectRulesDir(root), new RegExp(`^${claimed}-[0-9a-f]{10}$`));
});

test("assembleTools links the engine, lets global then project files override it, and rebuilds on every run", () => {
  const f = repo();
  mkdirSync(join(f.engine, "v2"), { recursive: true });
  writeFileSync(join(f.engine, "impact_map.py"), "engine");
  mkdirSync(join(f.globalRules, "steps"), { recursive: true });
  mkdirSync(join(f.globalRules, "tools"), { recursive: true });
  writeFileSync(join(f.globalRules, "tools", "impact_map.py"), "global");
  writeFileSync(join(f.globalRules, "tools", "only_global.sh"), "g");
  mkdirSync(join(projectRulesDir(f.root), "tools", "v2"), { recursive: true });
  writeFileSync(join(projectRulesDir(f.root), "tools", "impact_map.py"), "project");
  writeFileSync(join(projectRulesDir(f.root), "tools", "v2", "check_draft_x.py"), "x");
  const tools = join(f.root, "reports", "reviews", "tools");
  const rules = ruleRoots(f.root);
  assert.equal(assembleTools(f.root, rules), undefined);
  assert.equal(readFileSync(join(tools, "impact_map.py"), "utf8"), "project");
  assert.equal(readFileSync(join(tools, "only_global.sh"), "utf8"), "g");
  assert.equal(readFileSync(join(tools, "v2", "check_draft_x.py"), "utf8"), "x");
  assert.ok(readFileSync(join(tools, "v2", "pipeline_step.py"), "utf8").length > 0);
  rmSync(join(projectRulesDir(f.root), "tools", "impact_map.py"), { force: true });
  assert.equal(assembleTools(f.root, ruleRoots(f.root)), undefined);
  assert.equal(readFileSync(join(tools, "impact_map.py"), "utf8"), "global");
});

test("assembleTools replaces a link left by an older version and refuses a real folder it does not manage", () => {
  const f = repo();
  const tools = join(f.root, "reports", "reviews", "tools");
  mkdirSync(dirname(tools), { recursive: true });
  symlinkSync(f.engine, tools);
  assert.equal(assembleTools(f.root, ruleRoots(f.root)), undefined);
  assert.notEqual(readlinkSync(tools), f.engine);
  assert.equal(existsSync(f.engine), true);
  const real = repo();
  const realTools = join(real.root, "reports", "reviews", "tools");
  mkdirSync(realTools, { recursive: true });
  writeFileSync(join(realTools, "impact_map.py"), "mine");
  assert.match(assembleTools(real.root, ruleRoots(real.root)) ?? "", /chưa do review-pipeline quản lý/);
  assert.equal(readFileSync(join(realTools, "impact_map.py"), "utf8"), "mine");
});

test("assembleTools swaps the tools link in one step, drops the folder it replaced, and never removes the engine", () => {
  const f = repo();
  const reviews = join(f.root, "reports", "reviews");
  const tools = join(reviews, "tools");
  assert.equal(assembleTools(f.root, ruleRoots(f.root), { REPO: "o/r" }), undefined);
  const first = readlinkSync(tools);
  assert.equal(assembleTools(f.root, ruleRoots(f.root), { REPO: "o/r" }), undefined);
  const second = readlinkSync(tools);
  assert.notEqual(first, second);
  assert.equal(existsSync(first), false);
  assert.deepEqual(readdirSync(reviews).filter((name) => name.startsWith(".tools-") || name.includes(".swap-")), [second.split("/").pop()]);
  assert.equal(existsSync(join(f.engine, "v2", "pipeline_step.py")), true);
});

test("assembleTools writes the environment next to the tools, quoted for sh, and a script run by hand loads it", () => {
  const f = repo();
  const real = join(dirname(new URL(import.meta.url).pathname), "..", "review-pipeline");
  process.env.REVIEW_PIPELINE_ENGINE = real;
  const env = { REPO: "o/r", RV: f.root, HANDBOOK: join(f.root, "AGENTS.local.md"), REVIEWER: "it's-me", GATES: "00 02", WT_PREFIX: "wt-" };
  assert.equal(assembleTools(f.root, [], env), undefined);
  const file = join(f.root, "reports", "reviews", "tools", ".pipeline-env");
  const loaded = execFileSync("sh", ["-c", `. "${file}"; printf '%s|%s' "$REVIEWER" "$GATES"`], { encoding: "utf8" });
  assert.equal(loaded, "it's-me|00 02");
  const run = (script: string, ...args: string[]) =>
    spawnSync("bash", [join(f.root, "reports", "reviews", "tools", script), ...args], { cwd: f.root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  // The fake reviewer has no token, so each script stops at its first gh call; what matters is that it got that far.
  for (const script of ["v2/gate_intake.sh", "v2/pipeline_status.sh", "v2/after_post.sh", "comments_seen.sh"]) {
    const out = run(script, "1", "draft.md");
    assert.doesNotMatch(out.stdout + out.stderr, /set RV|set REPO|set REVIEWER|set HANDBOOK|unbound variable/, script);
  }
  assert.match(run("v2/gate_intake.sh", "1").stdout, /INTAKE: ABORT/);
  const named = spawnSync("bash", [join(real, "v2", "gate_intake.sh"), "1"], { cwd: f.root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.match(named.stderr, /set RV/);
});

test("findRoot maps a PR worktree to the review clone instead of the worktree itself", () => {
  const f = repo();
  const gitDir = join(f.root, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  const worktree = mkdtempSync(join(tmpdir(), "swag-pr-"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  mkdirSync(join(worktree, "swag"));
  assert.equal(findRoot(join(worktree, "swag")), realpathSync.native(f.root));
  assert.equal(findRoot(join(f.root, "swag")), f.root);
});

test("claimProjectRules records the owner once, and only for a folder that has rules", () => {
  const f = repo();
  const file = join(projectRulesDir(f.root), ".project.json");
  claimProjectRules(f.root);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { root: realpathSync.native(f.root) });
  writeFileSync(file, JSON.stringify({ root: realpathSync.native(f.root), kept: true }));
  claimProjectRules(f.root);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).kept, true);
  const bare = repo(undefined, { projectRules: false });
  claimProjectRules(bare.root);
  assert.equal(existsSync(join(projectRulesDir(bare.root), ".project.json")), false);
});

test("/review-pr does not touch the checkout when the agent is busy", async () => {
  const f = repo();
  const { commands, ctx, notes } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(f.root, false));
  assert.match(notes[0], /bận/);
  assert.equal(existsSync(join(f.root, "reports")), false);
  assert.equal(existsSync(join(projectRulesDir(f.root), ".project.json")), false);
});

test("readPolicy merges pipeline.json with the project over global, and rejects a typo or a wrong type", () => {
  const f = repo();
  mkdirSync(join(f.globalRules, "steps"), { recursive: true });
  writeFileSync(join(f.globalRules, "pipeline.json"), JSON.stringify({ worktreePrefix: "g-", impactSections: 8, gates: ["00", "06"] }));
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ worktreePrefix: "p-", draftCheck: "check.py", authorPattern: "^(a|b)-", baseBranch: "release/1.x" }));
  assert.deepEqual(readPolicy(ruleRoots(f.root)), { worktreePrefix: "p-", impactSections: 8, gates: ["00", "06"], draftCheck: "check.py", authorPattern: "^(a|b)-", baseBranch: "release/1.x" });
  for (const bad of [{ gate: ["00"] }, { gates: ["99"] }, { impactSections: 0 }, { draftCheck: "../x.py" }, { worktreePrefix: 3 }, { authorPattern: "" }, { authorPattern: "(" }, { authorPattern: 5 }, { k3sHost: "k3s" }, { k3sHost: "root@k3s; rm -rf /" }, { k3sHost: 3 }, { baseBranch: "" }, { baseBranch: "a b" }, { baseBranch: "-x" }, { baseBranch: 3 }]) {
    writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify(bad));
    assert.throws(() => readPolicy(ruleRoots(f.root)), /lạ hoặc giá trị sai kiểu/);
  }
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), "{nope");
  assert.throws(() => readPolicy(ruleRoots(f.root)), /không đọc được/);
});

test("readPolicy merges the triggers vocabulary key by key and takes only an object", () => {
  const f = repo();
  mkdirSync(join(f.globalRules, "steps"), { recursive: true });
  writeFileSync(join(f.globalRules, "pipeline.json"), JSON.stringify({ triggers: { cross: "g", flag: "gf" } }));
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ triggers: { cross: "p", crossByExt: { ".go": "x" } } }));
  assert.deepEqual(readPolicy(ruleRoots(f.root)).triggers, { cross: "p", flag: "gf", crossByExt: { ".go": "x" } });
  for (const bad of ["x", ["cross"], null, 3]) {
    writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ triggers: bad }));
    assert.throws(() => readPolicy(ruleRoots(f.root)), /lạ hoặc giá trị sai kiểu/);
  }
});

test("/review-pr exports the policy to the pipeline, always keeps intake, and defaults the worktree prefix to the repo name", async () => {
  const f = repo("https://github.com/swaglive/swag-op-console-server.git");
  const { commands, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-op-console-server/pull/1076", ctx(f.root));
  assert.equal(readFileSync(join(f.work, "policy.txt"), "utf8"), "swag-op-console-server-pr- - - - - - - - -\n");
  handlers.session_shutdown();
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ worktreePrefix: "swag-op-pr-", gates: ["02", "06"], impactSections: 9, draftCheck: "check_draft_opc.py", authorPattern: "^acme-", baseBranch: "main", k3sHost: "root@k3s.example.ts.net", triggers: { cross: "(a|b)", flag: "x" }, watchPaths: "^(db/|deploy/)" }));
  await commands["review-pr"]("https://github.com/swaglive/swag-op-console-server/pull/1076", ctx(f.root));
  assert.equal(readFileSync(join(f.work, "policy.txt"), "utf8"), "swag-op-pr- 00 02 06 9 check_draft_opc.py ^acme- main root@k3s.example.ts.net {\"cross\":\"(a|b)\",\"flag\":\"x\"} ^(db/|deploy/)\n");
  handlers.session_shutdown();
});

test("/review-pr stops with a clear message when pipeline.json is wrong, before it touches the checkout", async () => {
  const f = repo();
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ gate: [] }));
  const { commands, notes, sent, ctx } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(f.root));
  assert.equal(sent.length, 0);
  assert.match(notes[0], /pipeline\.json: khóa "gate" lạ/);
  assert.equal(existsSync(join(f.root, "reports")), false);
});

test("renderTimes turns the engine's since marks into the time that has passed, and leaves other text alone", () => {
  const now = 1_000_000 * 1000;
  assert.deepEqual(
    renderTimes(["Review #7: Đang ở bước 01 comments ({{since:999955}}): đọc", "▶ 01 comments ({{since:999955}})", "✔ 00 intake (12s)", "· 02 map"], now),
    ["Review #7: Đang ở bước 01 comments (45s): đọc", "▶ 01 comments (45s)", "✔ 00 intake (12s)", "· 02 map"],
  );
  assert.equal(renderTimes(["({{since:999875}})"], now)[0], "(2m05s)");
  assert.equal(renderTimes(["({{since:1000000}}) ({{since:1000500}})"], now)[0], "(0s) (0s)");
});

test("/review-pr widget keeps counting while the engine's file does not change", async () => {
  const { root, work } = repo();
  const { commands, widgets, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  const start = Math.floor(Date.now() / 1000) - 120;
  writeFileSync(join(work, "widget.txt"), `Review #19233: Đang ở bước 01 comments ({{since:${start}}}): đọc\n▶ 01 comments ({{since:${start}}})\n`);
  await new Promise((resolve) => setTimeout(resolve, POLL_MS + 400));
  const first = widgets.at(-1)![0];
  assert.match(first, /\(2m0[0-9]s\)/);
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2 + 400));
  assert.notEqual(widgets.at(-1)![0], first);
  handlers.session_shutdown();
});

test("readWidget returns the lines of the file, or undefined while it is missing or empty", () => {
  const { root } = repo();
  assert.equal(readWidget(join(root, "missing.txt")), undefined);
  const file = join(root, "w.txt");
  writeFileSync(file, "");
  assert.equal(readWidget(file), undefined);
  writeFileSync(file, "a\n\nb\n");
  assert.deepEqual(readWidget(file), ["a", "b"]);
});

test("kickoff names the PR and the URL, and keeps the step 06 stop", () => {
  const text = kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "http://127.0.0.1:8765");
  assert.match(text, /swaglive\/swag-server #19233/);
  assert.match(text, /__REVIEWER__ = Sotatek-TheoNguyen2/);
  assert.match(text, /\/rules\/project, \/rules\/global/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8765/);
  assert.match(text, /Dừng sau bước 05/);
});

test("/review-pr opens the UI, shows the widget, then hands the agent its kickoff once", async () => {
  const { root, work } = repo();
  const { commands, notes, sent, widgets, statuses, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /#19233/);
  assert.match(sent[0], /127\.0\.0\.1:9/);
  assert.match(notes.join("\n"), /UI ở http:\/\/127\.0\.0\.1:9/);
  assert.deepEqual(widgets[0], ["Review #19233: Đang ở bước 00 intake", "▶ 00 intake"]);
  assert.equal(statuses[0], "Review #19233: Đang ở bước 00 intake");

  writeFileSync(join(work, "widget.txt"), "Review #19233: Xong: đã post\n✔ 00 intake\n");
  await new Promise((resolve) => setTimeout(resolve, POLL_MS + 400));
  assert.equal(widgets.at(-1)?.[0], "Review #19233: Xong: đã post");
  handlers.session_shutdown();
});

test("/review-pr refuses outside a checkout, with a busy agent, without a link, and for a repo that is not the checkout's", async () => {
  const { root, work } = repo();
  const { commands, notes, sent, ctx } = setup();
  const review = commands["review-pr"];
  await review("", ctx(root));
  await review("19233", ctx(root));
  await review("https://github.com/swaglive/swag-server/pull/19233", ctx(mkdtempSync(join(tmpdir(), "elsewhere-"))));
  await review("https://github.com/swaglive/swag-openim/pull/1234", ctx(root));
  await review("https://github.com/swaglive/swag-server/pull/19233", ctx(root, false));
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 5);
  assert.match(notes[0], /Usage: \/review-pr/);
  assert.match(notes[1], /Usage: \/review-pr/);
  assert.match(notes[2], /review checkout của repo cần review/);
  assert.match(notes[3], /checkout này là swaglive\/swag-server, không phải swaglive\/swag-openim/);
  assert.match(notes[4], /bận/);
  assert.equal(existsSync(join(work, "calls.txt")), false);
});

test("/review-pr refuses a checkout without a handbook, a reviewer or a free tools path, and starts nothing", async () => {
  const link = "https://github.com/swaglive/swag-server/pull/19233";
  const noHandbook = repo(undefined, { handbook: null });
  const noReviewer = repo(undefined, { reviewer: null });
  const realTools = repo();
  mkdirSync(join(realTools.root, "reports", "reviews", "tools"), { recursive: true });
  const { commands, notes, sent, ctx } = setup();
  await commands["review-pr"](link, ctx(noHandbook.root));
  await commands["review-pr"](link, ctx(noReviewer.root));
  await commands["review-pr"](link, ctx(realTools.root));
  assert.equal(sent.length, 0);
  assert.match(notes[0], /AGENTS\.local\.md hoặc AGENTS\.md/);
  assert.match(notes[1], /identity\.guard\.user/);
  assert.match(notes[2], /là thư mục thật/);
  for (const f of [noHandbook, noReviewer, realTools]) assert.equal(existsSync(join(f.work, "calls.txt")), false);
});

test("repoOf reads owner/name from https, scp-style host aliases and ssh remotes, and nothing else", () => {
  assert.equal(repoOf("https://github.com/swaglive/swag-server.git"), "swaglive/swag-server");
  assert.equal(repoOf("https://github.com/swaglive/swag-server"), "swaglive/swag-server");
  assert.equal(repoOf("git@github-harvey:swaglive/swag-op-console-server.git\n"), "swaglive/swag-op-console-server");
  assert.equal(repoOf("ssh://git@github.com/swaglive/swag-openim.git"), "swaglive/swag-openim");
  assert.equal(repoOf(""), undefined);
  assert.equal(repoOf("not-a-remote"), undefined);
});

test("/review-pr works in the review checkout of another repo and hands that repo to the pipeline", async () => {
  const { root, work } = repo("git@github-harvey:swaglive/swag-op-console-server.git", { reviewer: "Sotatek-HarveyTran", handbook: "AGENTS.md" });
  const { commands, notes, sent, tools, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/SwagLive/swag-op-console-server/pull/1077", ctx(root));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /swaglive\/swag-op-console-server #1077/);
  assert.match(sent[0], /__REPO__ = swaglive\/swag-op-console-server và __REVIEWER__ = Sotatek-HarveyTran/);
  assert.equal(readFileSync(join(work, "env.txt"), "utf8"), `swaglive/swag-op-console-server ${root} ${join(root, "AGENTS.md")} Sotatek-HarveyTran ${projectRulesDir(root)}\n`);
  await tools.review_step!("id", { action: "note", step: "01", message: "x" });
  assert.equal(readFileSync(join(work, "env.txt"), "utf8"), `swaglive/swag-op-console-server ${root} ${join(root, "AGENTS.md")} Sotatek-HarveyTran ${projectRulesDir(root)}\n`);
  assert.doesNotMatch(notes.join("\n"), /Review checkout này/);
  handlers.session_shutdown();
});

test("/review-pr refuses a checkout without a readable origin remote and starts nothing", async () => {
  const { root, work } = repo(null);
  const { commands, notes, sent, ctx } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  assert.equal(sent.length, 0);
  assert.match(notes[0], /Không đọc được remote origin/);
  assert.equal(existsSync(join(work, "calls.txt")), false);
});

test("review_step exists from load, refuses a call before any review, and rejects bad calls after /review-pr", async () => {
  const { root } = repo();
  const { commands, tools, ctx, handlers } = setup();
  assert.ok(tools.review_step);
  await assert.rejects(tools.review_step!("0", { action: "start", step: "00" }), /Không có review đang chạy/);
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  const call = (params: Record<string, unknown>) => tools.review_step!("1", params);
  await assert.rejects(call({ action: "start" }), /cần step/);
  await assert.rejects(call({ action: "start", step: "09" }), /cần step/);
  await assert.rejects(call({ action: "note", step: "01" }), /cần message/);
  await assert.rejects(call({ action: "jump", step: "01" }), /action phải là/);
  handlers.session_shutdown();
});

test("readPipelineEnv reads back what assembleTools wrote, quotes included, and nothing without RV", () => {
  const { root } = repo();
  const env = { REPO: "o/r", RV: root, HANDBOOK: join(root, "AGENTS.local.md"), REVIEWER: "me", RULES: "/r'ules:/b" };
  assert.equal(assembleTools(root, [], env), undefined);
  const file = join(root, "reports", "reviews", "tools", ".pipeline-env");
  assert.deepEqual(readPipelineEnv(file), env);
  assert.equal(readPipelineEnv(join(root, "missing")), undefined);
  writeFileSync(join(root, "no-rv"), "export REPO='o/r'\n");
  assert.equal(readPipelineEnv(join(root, "no-rv")), undefined);
});

test("review_step works in a process that never ran /review-pr, from the environment the checkout's tools folder holds", async () => {
  const { root, work } = repo();
  assert.equal(assembleTools(root, [], { REPO: "o/r", RV: root, HANDBOOK: join(root, "AGENTS.local.md"), REVIEWER: "me", RULES: "/r'ules" }), undefined);
  const { tools } = setup();
  const before = process.cwd();
  process.chdir(root);
  try {
    assert.equal((await tools.review_step!("1", { action: "start", step: "00", pr: "77" })).content[0].text, "ok start");
    assert.match(readFileSync(join(work, "env.txt"), "utf8"), /^o\/r .* me \/r'ules\n$/);
    assert.deepEqual(readWidget(join(work, "calls.txt")), ["start 77 00"]);
    await assert.rejects(tools.review_step!("2", { action: "start", step: "00" }), /Không có review đang chạy/);
  } finally {
    process.chdir(before);
  }
});

test("review_step says why when neither the session nor the checkout knows the PR", async () => {
  const { root } = repo();
  const { tools } = setup();
  const before = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(tools.review_step!("1", { action: "start", step: "00", pr: "77" }), /PR #77 chưa chạy \/review-pr.*không có reports\/reviews\/tools\/\.pipeline-env/);
  } finally {
    process.chdir(before);
  }
});

test("kickoff for a background run wraps the task, ends it after step 05 and leaves steps 06 and 07 to this session", () => {
  const text = kickoff("swaglive/swag-server", "me", RULES, "19233", "http://u", undefined, "/co");
  assert.match(text, /agent=review-runner, async=true, cwd=\/co/);
  assert.match(text, /review_step action=start step=<NN> pr=19233/);
  assert.match(text, /KHÔNG làm bước 06 và 07, KHÔNG gọi action=end/);
  assert.match(text, /Chỉ khi họ nói OK mới tự làm tiếp bước 06 và 07 \(review_step pr=19233\)/);
  assert.doesNotMatch(text, /Dừng sau bước 05/);
  const foreground = kickoff("swaglive/swag-server", "me", RULES, "19233", "http://u");
  assert.doesNotMatch(foreground, /review-runner|KHÔNG làm bước 06/);
  assert.match(foreground, /Dừng sau bước 05/);
});

test("/review-pr --bg keeps --bg away from begin and hands the agent a background kickoff", async () => {
  const { root, work } = repo();
  const { commands, sent, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233 --bg --takeover", ctx(root));
  assert.deepEqual(readWidget(join(work, "calls.txt")), [`begin 19233 --owner ${process.pid} --takeover`]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`agent=review-runner, async=true, cwd=${root}`));
  handlers.session_shutdown();
});

async function inCheckout<T>(root: string, body: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(root);
  try {
    return await body();
  } finally {
    process.chdir(before);
  }
}

test("review_start and review_board are registered when the extension loads", () => {
  const { tools } = setup();
  assert.ok(tools.review_start);
  assert.ok(tools.review_board);
});

test("review_start opens the review without an idle agent, begins it as /review-pr does, and returns the background kickoff", async () => {
  const { root, work } = repo();
  const { commands, tools, ctx, sent, handlers } = setup();
  await commands["review-board"]("", ctx(root, false));
  const result = await inCheckout(root, () => tools.review_start!("1", { link: "https://github.com/swaglive/swag-server/pull/19233" }));
  const text = result.content[0].text;
  assert.match(text, /^Review #19233: UI ở http:\/\/127\.0\.0\.1:9/);
  assert.match(text, /agent=review-runner, async=true, cwd=/);
  assert.deepEqual(readWidget(join(work, "calls.txt")), [`begin 19233 --owner ${process.pid}`]);
  assert.equal(sent.length, 0);
  await tools.review_step!("2", { action: "note", step: "00", message: "x", pr: "19233" });
  handlers.session_shutdown();
});

test("review_start with background=false hands back the foreground kickoff", async () => {
  const { root } = repo();
  const { tools } = setup();
  const text = (await inCheckout(root, () => tools.review_start!("1", { link: "https://github.com/swaglive/swag-server/pull/19233", background: false }))).content[0].text;
  assert.doesNotMatch(text, /review-runner/);
  assert.match(text, /Dừng sau bước 05/);
});

test("review_start refuses a bad link, a checkout that is not the PR's repo and an eleventh open review, but not a rerun of an open one", async () => {
  const { root, work } = repo();
  const { tools, commands, ctx, handlers } = setup();
  const start = (n: number | string) => inCheckout(root, () => tools.review_start!("1", { link: `https://github.com/swaglive/swag-server/pull/${n}` }));
  await assert.rejects(inCheckout(root, () => tools.review_start!("1", { link: "19233" })), /Usage: \/review-pr/);
  for (const link of ["https://github.com/swaglive/swag-server/pull/9 --restart", "https://github.com/swaglive/swag-server/pull/9 --takeover --bg", "https://github.com/swaglive/swag-server/pull/9\n--restart"])
    await assert.rejects(inCheckout(root, () => tools.review_start!("1", { link })), /không kèm cờ nào/);
  assert.equal(existsSync(join(work, "calls.txt")), false);
  await assert.rejects(inCheckout(root, () => tools.review_start!("1", { link: "https://github.com/swaglive/other/pull/5" })), /không phải swaglive\/other/);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await start(n);
  await assert.rejects(start(11), /Đã có 10 review đang mở \(#1, #2, #3.*#10\).*tối đa 10 mỗi phiên Pi.*\/review-pr thì không bị giới hạn/);
  await start(2);
  await tools.review_step!("2", { action: "end", pr: "2" });
  await start(11);
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/5", ctx(root));
  handlers.session_shutdown();
});

test("review_board returns the board text for the checkout's repo and reviewer, and says why it cannot", async () => {
  const f = repo();
  writeFileSync(join(f.engine, "v2", "review_board.py"), BOARD_STUB);
  const { tools } = setup();
  const text = (await inCheckout(f.root, () => tools.review_board!("1", {}))).content[0].text;
  assert.match(text, /^BOARD --repo swaglive\/swag-server --reviewer Sotatek-TheoNguyen2 --no-color/);
  const bare = repo(null);
  writeFileSync(join(bare.engine, "v2", "review_board.py"), BOARD_STUB);
  await assert.rejects(inCheckout(bare.root, () => tools.review_board!("2", {})), /Không đọc được remote origin/);
});

function writeEvents(root: string, pr: string, states: string[], ageMs = 0): string {
  const dir = join(root, "reports", "reviews", "evidence", pr, "gates");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  writeFileSync(file, states.map((state) => JSON.stringify({ ts: 1, step: "01", state, msg: "" })).join("\n") + "\n");
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  return file;
}

test("activeFor reports seconds since the last event only while the review is open and the file was written within five minutes", () => {
  const { root } = repo();
  assert.equal(activeFor(root, "7"), undefined);
  writeEvents(root, "7", ["begin", "start"], 20_000);
  const seconds = activeFor(root, "7");
  assert.ok(seconds !== undefined && seconds >= 20 && seconds <= 25);
  writeEvents(root, "7", ["begin", "note"], IDLE_MS + 1000);
  assert.equal(activeFor(root, "7"), undefined);
  writeEvents(root, "7", ["begin", "done"], IDLE_MS + 1000);
  assert.equal(activeFor(root, "7"), undefined);
  writeEvents(root, "7", ["begin", "start"], IDLE_MS + 290_000);
  assert.ok(activeFor(root, "7") !== undefined, "a step in progress stays alive past five minutes");
  writeEvents(root, "7", ["begin", "start"], STEP_MS + 1000);
  assert.equal(activeFor(root, "7"), undefined);
  writeEvents(root, "7", ["begin", "start", "end"]);
  assert.equal(activeFor(root, "7"), undefined);
  const file = writeEvents(root, "7", ["begin"]);
  writeFileSync(file, '{"state":"star');
  assert.equal(activeFor(root, "7"), undefined);
});

test("/review-pr and review_start refuse a PR that another runner wrote to in the last five minutes, and --takeover or silence lets it through", async () => {
  const { root, work } = repo();
  const { commands, tools, ctx, notes, handlers } = setup();
  const link = "https://github.com/swaglive/swag-server/pull/19323";
  const begins = () => (existsSync(join(work, "calls.txt")) ? (readFileSync(join(work, "calls.txt"), "utf8").match(/^begin /gm) ?? []).length : 0);

  writeEvents(root, "19323", ["begin", "start"], 10_000);
  await commands["review-pr"](link, ctx(root));
  assert.match(notes.at(-1) ?? "", /PR #19323 đang có runner làm việc, sự kiện cuối \d+ giây trước.*--takeover/);
  await assert.rejects(inCheckout(root, () => tools.review_start!("1", { link })), /đang có runner làm việc.*tool không có cờ này/);
  assert.doesNotMatch(notes.at(-1) ?? "", /tool không có cờ này/);
  assert.equal(begins(), 0);

  await commands["review-pr"](`${link} --takeover`, ctx(root));
  assert.equal(begins(), 1);

  writeEvents(root, "19323", ["begin", "start"], 10 * 60_000);
  await commands["review-pr"](link, ctx(root));
  assert.match(notes.at(-1) ?? "", /đang có runner làm việc/);
  assert.equal(begins(), 1);

  writeEvents(root, "19323", ["begin", "done"], IDLE_MS + 1000);
  await commands["review-pr"](link, ctx(root));
  assert.equal(begins(), 2);
  handlers.session_shutdown();
});

test("the review-runner agent lists review_step and the tools a draft needs, and ships with the package", () => {
  const dir = join(dirname(new URL(import.meta.url).pathname), "..");
  const agent = readFileSync(join(dir, "agents", "review-runner.md"), "utf8");
  const tools = /^tools: (.*)$/m.exec(agent)?.[1].split(/,\s*/) ?? [];
  for (const tool of ["review_step", "bash", "edit", "write", "read"]) assert.ok(tools.includes(tool), tool);
  assert.match(agent, /^name: review-runner$/m);
  assert.ok((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { files: string[] }).files.includes("agents"));
});

test("review_step passes the call to the pipeline, returns a red gate as text, and throws when the script itself breaks", async () => {
  const { root, work } = repo();
  const { commands, tools, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  const step = tools.review_step!;
  const started = await step("1", { action: "start", step: "00", message: "fetch" });
  assert.equal(started.content[0].text, "ok start");
  const red = await step("2", { action: "done", step: "01" });
  assert.match(red.content[0].text, /VERDICT bước 01 comments: fail/);
  await assert.rejects(step("3", { action: "note", step: "02", message: "crash" }), /broken/);
  await step("4", { action: "end", message: "xong" });
  const calls = readWidget(join(work, "calls.txt")) ?? [];
  assert.deepEqual(calls, [
    `begin 19233 --owner ${process.pid}`,
    "start 19233 00 --msg fetch",
    "done 19233 01",
    "note 19233 02 --msg crash",
    "end 19233 --msg xong",
  ]);
  handlers.session_shutdown();
});

test("two reviews in one session keep their own widget line, and review_step goes to the PR it names", async () => {
  await perPr(async () => {
    const { root, work } = repo();
    const { commands, tools, ctx, widgets, statuses, handlers } = setup();
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/101", ctx(root));
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/202", ctx(root));
    assert.deepEqual(widgets.at(-1), ["Review #101: Đang ở bước 00 intake", "Review #202: Đang ở bước 00 intake"]);
    assert.equal(statuses.at(-1), "Review #101: Đang ở bước 00 intake | Review #202: Đang ở bước 00 intake");

    const step = tools.review_step!;
    await assert.rejects(step("1", { action: "start", step: "00" }), /2 review \(#101, #202\).*pr=/);
    await assert.rejects(step("2", { action: "start", step: "00", pr: "303" }), /PR #303 chưa chạy.*#101, #202/);
    await step("3", { action: "start", step: "01", pr: "202" });
    await step("4", { action: "note", step: "01", pr: "#101", message: "đọc" });

    writeFileSync(join(work, "widget-202.txt"), "Review #202: Đang ở bước 01 comments (3s)\n▶ 01 comments\n");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS + 400));
    assert.deepEqual(widgets.at(-1), ["Review #101: Đang ở bước 00 intake", "Review #202: Đang ở bước 01 comments (3s)"]);

    const calls = readWidget(join(work, "calls.txt")) ?? [];
    assert.deepEqual(calls.slice(-2), ["start 202 01", "note 101 01 --msg đọc"]);
    handlers.session_shutdown();
  });
});

test("review_step without pr goes to the only review still open, and a finished one does not block it", async () => {
  await perPr(async () => {
    const { root, work } = repo();
    const { commands, tools, ctx, handlers } = setup();
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/101", ctx(root));
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/202", ctx(root));
    await tools.review_step!("1", { action: "end", pr: "101" });
    await tools.review_step!("2", { action: "note", step: "02", message: "map" });
    const calls = readWidget(join(work, "calls.txt")) ?? [];
    assert.deepEqual(calls.slice(-2), ["end 101", "note 202 02 --msg map"]);
    handlers.session_shutdown();
  });
});

test("running /review-pr again for a PR replaces its entry instead of adding a second one", async () => {
  await perPr(async () => {
    const { root } = repo();
    const { commands, tools, ctx, widgets, handlers } = setup();
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/101", ctx(root));
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/101", ctx(root));
    assert.equal(widgets.at(-1)?.length, 2);
    assert.equal((await tools.review_step!("1", { action: "note", step: "00", message: "x" })).content[0].text, "ok note");
    handlers.session_shutdown();
  });
});

test("parseBegin returns url and widget only when both are strings on the last line", () => {
  const good = JSON.stringify({ url: "http://127.0.0.1:8765", widget: "/w.txt" });
  assert.deepEqual(parseBegin(good), { url: "http://127.0.0.1:8765", widget: "/w.txt" });
  assert.deepEqual(parseBegin(`noise\n${good}`), { url: "http://127.0.0.1:8765", widget: "/w.txt" });
  for (const bad of ["", "null", "{}", "[]", "5", '"text"', "not json", '{"url":"u"}', '{"widget":"w"}', '{"url":null,"widget":"w"}', '{"url":1,"widget":"w"}', `${good}\nwarning`]) {
    assert.equal(parseBegin(bad), undefined, JSON.stringify(bad));
  }
});

for (const [name, output] of [["an empty object", "{}"], ["null", "null"], ["nothing", ""], ["text that is not JSON", "oops"]]) {
  test(`/review-pr reports an error and starts nothing when begin prints ${name}`, async () => {
    const { root, work } = repo();
    const { commands, notes, sent, widgets, ctx } = setup();
    process.env.STUB_BEGIN = output;
    try {
      await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
    } finally {
      delete process.env.STUB_BEGIN;
    }
    assert.equal(sent.length, 0);
    assert.equal(widgets.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Không đọc được đầu ra của begin/);
    assert.equal(notes[0].includes("undefined"), false);
    assert.equal(existsSync(join(work, "calls.txt")), true);
  });
}

test("/review-pr reports the failure when the Python binary does not exist", async () => {
  const { root } = repo();
  const { commands, notes, sent, ctx } = setup();
  process.env.SWAG_REVIEW_PYTHON = "python-does-not-exist";
  try {
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  } finally {
    process.env.SWAG_REVIEW_PYTHON = "python3";
  }
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Không bật được UI: .*ENOENT/);
});

test("/review-pr still starts when begin prints a warning on stderr after its JSON", async () => {
  const { root } = repo();
  const { commands, notes, sent, ctx, handlers } = setup();
  process.env.STUB_STDERR = "DeprecationWarning: something noisy";
  try {
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  } finally {
    delete process.env.STUB_STDERR;
  }
  assert.equal(sent.length, 1);
  assert.match(notes.join("\n"), /UI ở http:\/\/127\.0\.0\.1:9/);
  handlers.session_shutdown();
});

test("review_step throws on a traceback (exit 1) and returns only a red gate (exit 10) as a result", async () => {
  const { root } = repo();
  const { commands, tools, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  const step = tools.review_step!;
  await assert.rejects(step("1", { action: "note", step: "02", message: "traceback" }), /Traceback/);
  const red = await step("2", { action: "done", step: "01" });
  assert.match(red.content[0].text, /VERDICT bước 01 comments: fail/);
  handlers.session_shutdown();
});

test("splitFlags takes --takeover and --restart out of the arguments and keeps the link", () => {
  const link = "https://github.com/swaglive/swag-server/pull/19233";
  assert.deepEqual(splitFlags(`${link} --takeover`), { rest: link, flags: ["--takeover"] });
  assert.deepEqual(splitFlags(`  ${link}   --restart  --takeover `), { rest: link, flags: ["--restart", "--takeover"] });
  assert.deepEqual(splitFlags(link), { rest: link, flags: [] });
  assert.deepEqual(splitFlags("--restart"), { rest: "", flags: ["--restart"] });
  assert.deepEqual(splitFlags(""), { rest: "", flags: [] });
});

test("parseBegin keeps the resume fields only when they have the right types", () => {
  const base = { url: "http://127.0.0.1:8765", widget: "/w.txt" };
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, resumed: true, next: "03", done: ["00", "01"] })), { ...base, resumed: true, next: "03", done: ["00", "01"] });
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, resumed: false, next: null, done: [] })), { ...base, resumed: false, next: null, done: [] });
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, resumed: "yes", next: 3, done: "00" })), base);
});

test("kickoff for a resumed review names the next step and tells the agent to redo intake, a fresh one does not", () => {
  const fresh = kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "http://127.0.0.1:8765");
  assert.doesNotMatch(fresh, /ĐANG DỞ/);
  const resumed = kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "http://127.0.0.1:8765", { url: "u", widget: "w", resumed: true, next: "03", done: ["00", "01", "02"] });
  assert.match(resumed, /ĐANG DỞ/);
  assert.match(resumed, /bước đã xong: 00, 01, 02; bước kế: 03/);
  assert.match(resumed, /Chạy lại bước 00 trước/);
  assert.match(resumed, /events\.jsonl/);
  assert.match(kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "u", { url: "u", widget: "w", resumed: true, next: null, done: [] }), /chưa có; bước kế: không còn/);
});

test("/review-pr passes the pi pid and the flags to begin, and says when it resumes", async () => {
  const { root, work } = repo();
  const { commands, notes, sent, ctx, handlers } = setup();
  process.env.STUB_BEGIN = JSON.stringify({ url: "http://127.0.0.1:9", widget: join(work, "widget.txt"), resumed: true, next: "03", done: ["00", "01", "02"] });
  try {
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233 --takeover", ctx(root));
  } finally {
    delete process.env.STUB_BEGIN;
  }
  assert.deepEqual(readWidget(join(work, "calls.txt")), [`begin 19233 --owner ${process.pid} --takeover`]);
  assert.match(notes.join("\n"), /tiếp tục review dang dở/);
  assert.match(sent[0], /ĐANG DỞ/);
  assert.match(sent[0], /bước kế: 03/);
  handlers.session_shutdown();
});

test("/review-pr shows why another pi owns the review and starts nothing", async () => {
  const { root } = repo();
  const { commands, notes, sent, widgets, ctx } = setup();
  process.env.STUB_REFUSE = "review #19233 đang chạy ở tiến trình pi 4242. Thêm --takeover nếu chắc.";
  try {
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  } finally {
    delete process.env.STUB_REFUSE;
  }
  assert.equal(sent.length, 0);
  assert.equal(widgets.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Không bật được UI: review #19233 đang chạy ở tiến trình pi 4242.*--takeover/);
});

test("parseBegin keeps waiting only as a string or null", () => {
  const base = { url: "u", widget: "w" };
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, waiting: "05" })), { ...base, waiting: "05" });
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, waiting: null })), { ...base, waiting: null });
  assert.deepEqual(parseBegin(JSON.stringify({ ...base, waiting: 5 })), base);
});

test("kickoff tells the agent to wait for Theo when a step is waiting, and not otherwise", () => {
  const waiting = kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "u", { url: "u", widget: "w", resumed: true, next: "05", done: ["00", "01", "02", "03", "04"], waiting: "05" });
  assert.match(waiting, /Bước 05 đang CHỜ người review \(Sotatek-TheoNguyen2\)/);
  assert.match(waiting, /Chưa làm bước nào sau nó/);
  const free = kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "u", { url: "u", widget: "w", resumed: true, next: "02", done: ["00", "01"], waiting: null });
  assert.doesNotMatch(free, /CHỜ người review/);
  assert.doesNotMatch(kickoff("swaglive/swag-server", "Sotatek-TheoNguyen2", RULES, "19233", "u"), /CHỜ người review/);
});

test("withIdleWarning replaces the first line only for a running step that was silent long enough", () => {
  const running = ["Review #19233: Đang ở bước 03 verify (40s): chạy mutant", "✔ 00 intake", "▶ 03 verify"];
  assert.deepEqual(withIdleWarning(running, IDLE_MS - 1, "19233"), running);
  const warned = withIdleWarning(running, IDLE_MS, "19233");
  assert.match(warned[0], /^Review #19233: 5 phút không có ghi chú mới/);
  assert.deepEqual(warned.slice(1), running.slice(1));
  assert.match(withIdleWarning(running, 12 * 60_000, "19233")[0], /12 phút/);
  const waiting = ["Review #19233: Bước 05 draft xong: chờ bạn đọc bản nháp rồi nói OK post", "✔ 00 intake"];
  assert.deepEqual(withIdleWarning(waiting, 3_600_000, "19233"), waiting);
  const done = ["Review #19233: Xong: đã post"];
  assert.deepEqual(withIdleWarning(done, 3_600_000, "19233"), done);
  assert.deepEqual(withIdleWarning(running, 3_600_000, "999"), running);
  assert.deepEqual(withIdleWarning([], 3_600_000, "19233"), []);
});

test("/review-pr widget shows the silence warning when events.jsonl has not been touched for ten minutes", async () => {
  const { root, work } = repo();
  mkdirSync(work, { recursive: true });
  const events = join(work, "events.jsonl");
  writeFileSync(events, "");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(events, old, old);
  const { commands, widgets, statuses, ctx, handlers } = setup();
  await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/19233", ctx(root));
  assert.match(widgets[0]?.[0] ?? "", /^Review #19233: 10 phút không có ghi chú mới/);
  assert.equal(widgets[0]?.[1], "▶ 00 intake");
  assert.match(statuses[0] ?? "", /10 phút/);
  handlers.session_shutdown();
});

test("kickoff names the given reviewer and carries no Theo, Han or SotaTek rule for another reviewer", () => {
  const resumed = { url: "u", widget: "w", resumed: true, next: "05", done: ["00", "01", "02", "03", "04"], waiting: "05" };
  const text = kickoff("acme/widgets", "acme-reviewer", RULES, "7", "u", resumed);
  assert.match(text, /Dừng sau bước 05 để acme-reviewer đọc/);
  assert.match(text, /CHỜ người review \(acme-reviewer\)/);
  assert.doesNotMatch(text, /Theo|Han\b|SotaTek|SWAG/);
});

test("assembleTools removes tools folders an older build left behind, and only the old ones", () => {
  const f = repo();
  assert.equal(assembleTools(f.root, []), undefined);
  const reviews = join(f.root, "reports", "reviews");
  const stale = join(reviews, ".tools-stale");
  const fresh = join(reviews, ".tools-fresh");
  mkdirSync(stale);
  mkdirSync(fresh);
  const old = new Date(Date.now() - STALE_TOOLS_MS - 60_000);
  utimesSync(stale, old, old);
  assert.equal(assembleTools(f.root, []), undefined);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(join(reviews, "tools", ".review-pipeline-managed")), true);
});

test("run_tests_rc.sh refuses an argument with spaces instead of letting sh split it into a pytest usage error", () => {
  const f = repo();
  const real = join(dirname(new URL(import.meta.url).pathname), "..", "review-pipeline");
  process.env.REVIEW_PIPELINE_ENGINE = real;
  const env = { REPO: "o/r", RV: f.root, HANDBOOK: join(f.root, "AGENTS.local.md"), REVIEWER: "me", WT_PREFIX: "wt-" };
  assert.equal(assembleTools(f.root, [], env), undefined);
  const script = join(f.root, "reports", "reviews", "tools", "v2", "run_tests_rc.sh");
  const run = (...args: string[]) => spawnSync("bash", [script, "1", ...args], { cwd: f.root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const refused = run("-k", "case1 or case2");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /argument with spaces \(case1 or case2\)/);
  assert.doesNotMatch(run("-k", "case1").stderr, /argument with spaces/);
});

test("assembleTools is not stopped by a .tools-* entry it cannot read", () => {
  const f = repo();
  assert.equal(assembleTools(f.root, []), undefined);
  const reviews = join(f.root, "reports", "reviews");
  symlinkSync(join(f.root, "gone"), join(reviews, ".tools-dangling"));
  assert.equal(assembleTools(f.root, []), undefined);
  assert.equal(existsSync(join(reviews, "tools", ".review-pipeline-managed")), true);
});

// The stub writes one widget file per PR only when asked, so the single-review tests keep their shared widget.txt.
async function perPr(body: () => Promise<void>): Promise<void> {
  process.env.STUB_PER_PR = "1";
  try {
    await body();
  } finally {
    delete process.env.STUB_PER_PR;
  }
}

function testRunner() {
  const f = repo();
  process.env.REVIEW_PIPELINE_ENGINE = join(dirname(new URL(import.meta.url).pathname), "..", "review-pipeline");
  assert.equal(assembleTools(f.root, [], { REPO: "o/r", RV: f.root, HANDBOOK: join(f.root, "AGENTS.local.md"), REVIEWER: "me", WT_PREFIX: "wt-" }), undefined);
  writeFileSync(join(f.root, "compose.yaml"), "services: {}\n");
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const log = join(bin, "log.txt");
  // `docker rm -f <name>` kills a hung fake run the way it would remove the real container; FAKE_HANG makes the run hang until then.
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\nif [ "$1" = rm ]; then echo "rm $*" >> ${join(bin, "argv.txt")}; [ ! -f ${join(bin, "pid")} ] || kill $(cat ${join(bin, "pid")}) 2>/dev/null; exit 0; fi\necho "start $$" >> ${log}\necho "argv $*" >> ${join(bin, "argv.txt")}\nif [ -n "$FAKE_HANG" ]; then echo $$ > ${join(bin, "pid")}; exec sleep 30; fi\nsleep 1\necho "end $$" >> ${log}\necho "1 passed"\n`,
    { mode: 0o755 },
  );
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  const script = join(f.root, "reports", "reviews", "tools", "run_pr_tests.sh");
  const lock = join(f.root, "reports", "reviews", ".tests.lock");
  const run = (extraEnv: Record<string, string> = {}, cwd = f.root, path = script) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("sh", [path, wt, "tests/x.py"], { cwd, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...extraEnv } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return { run, log, lock, root: f.root, argv: join(bin, "argv.txt") };
}

test("run_pr_tests.sh runs the tests under compose.review.yaml, which mounts the checkout read-only and gives /tmp to the run alone", async () => {
  const { run, root, argv } = testRunner();
  assert.equal((await run()).code, 0);
  const call = readFileSync(argv, "utf8");
  const override = join(root, "reports", "reviews", "tools", "compose.review.yaml");
  assert.match(call, new RegExp(`^argv compose -f ${root}/compose.yaml -f ${override} --project-directory ${root} run --rm -T `));
  const yaml = readFileSync(override, "utf8");
  assert.match(yaml, /volumes: !override\n\s+- \.:\/usr\/src\/app\/:ro\n\s+- \/usr\/src\/app\/\.venv\n/);
  assert.match(yaml, /tmpfs:\n\s+- \/tmp\n/);
  assert.doesNotMatch(yaml, /tmp:\/tmp|:\/usr\/src\/app\/\s*$/m);
});

test("run_pr_tests.sh stops with a message when the lock path is taken by something that is not its link, instead of spinning forever", async () => {
  const { run, lock, log } = testRunner();
  writeFileSync(lock, "");
  const started = Date.now();
  const result = await run();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /không tạo được khoá .*\.tests\.lock/);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(existsSync(log), false);
});

test("run_pr_tests.sh refuses a checkout without compose.yaml before it touches the lock", async () => {
  const { run, root, lock, log } = testRunner();
  rmSync(join(root, "compose.yaml"));
  const result = await run();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no compose\.yaml in /);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(log), false);
});

test("run_pr_tests.sh finds compose.review.yaml when called by a relative path from a subdirectory of the checkout", async () => {
  const { run, root, argv } = testRunner();
  assert.equal((await run({}, join(root, "reports", "reviews"), join("tools", "run_pr_tests.sh"))).code, 0);
  // pwd inside the script gives the physical path when the shell inherits a cwd, and /var/folders is a link on macOS; tools/ itself is a link, so only root is resolved
  assert.ok(readFileSync(argv, "utf8").includes(` -f ${join(realpathSync(root), "reports", "reviews", "tools", "compose.review.yaml")} `));
});

test("run_pr_tests.sh lets two PRs take turns on the shared test databases, and cleans its lock", async () => {
  const { run, log, lock } = testRunner();
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[0]), ["start", "end", "start", "end"]);
  assert.match([a.stderr, b.stderr].join(""), /đợi lượt chạy test/);
  assert.equal(existsSync(lock), false);
});

test("run_pr_tests.sh takes over a lock left by a dead process instead of waiting forever", async () => {
  const { run, lock, log } = testRunner();
  const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(dead, lock);
  const result = await run();
  assert.equal(result.code, 0);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  assert.equal(existsSync(lock), false);
});

test("run_pr_tests.sh takes over a lock whose pid now belongs to an unrelated process", async () => {
  const { run, lock, log } = testRunner();
  const other = spawn("sleep", ["300"]);
  try {
    symlinkSync(String(other.pid), lock);
    const result = await run({ TESTS_LOCK_WAIT: "3" });
    assert.equal(result.code, 0);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  } finally {
    other.kill();
  }
});

test("run_pr_tests.sh gives up with a clear message when a real test run holds the lock too long", async () => {
  const { run, lock, log } = testRunner();
  const holder = spawn("sh", ["-c", "sleep 30; true # run_pr_tests.sh"]);
  try {
    symlinkSync(String(holder.pid), lock);
    const result = await run({ TESTS_LOCK_WAIT: "2" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /đợi quá 2s, pid \d+ vẫn giữ/);
    assert.equal(existsSync(log), false);
    assert.equal(readlinkSync(lock), String(holder.pid));
  } finally {
    holder.kill();
  }
});

test("run_pr_tests.sh does not count the time spent waiting for the lock against the run", async () => {
  const { run, lock, log } = testRunner();
  const holder = spawn("sh", ["-c", "sleep 3; true # run_pr_tests.sh"]);
  try {
    symlinkSync(String(holder.pid), lock);
    const result = await run({ TESTS_RUN_TIMEOUT: "2" });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /đợi lượt chạy test/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  } finally {
    holder.kill();
  }
});

test("run_pr_tests.sh kills a run that hangs once it has the lock, removes its container and frees the lock", async () => {
  const { run, lock, argv } = testRunner();
  const started = Date.now();
  const result = await run({ TESTS_RUN_TIMEOUT: "2", FAKE_HANG: "1" });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /test chạy quá 2s .*dừng container rvtest-\d+/);
  assert.ok(Date.now() - started < 15_000);
  assert.match(readFileSync(argv, "utf8"), /run --rm -T --name rvtest-\d+ /);
  assert.match(readFileSync(argv, "utf8"), /rm -f rvtest-\d+/);
  assert.equal(existsSync(lock), false);
});

test("/review-pr refuses a PR number that is open for another checkout in the same session, and allows it once that review ended", async () => {
  await perPr(async () => {
    const first = repo();
    const second = repo("https://github.com/swaglive/swag-openim.git");
    mkdirSync(join(projectRulesDir(first.root), "steps"), { recursive: true });
    const begins = () => (readFileSync(join(second.work, "calls.txt"), "utf8").match(/^begin /gm) ?? []).length;
    const { commands, tools, ctx, notes, handlers } = setup();
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/55", ctx(first.root));
    await commands["review-pr"]("https://github.com/swaglive/swag-openim/pull/55", ctx(second.root));
    assert.match(notes.at(-1) ?? "", /PR #55 đang mở ở .*review-pipeline-/);
    assert.equal(begins(), 1);
    await commands["review-pr"]("https://github.com/swaglive/swag-server/pull/55", ctx(first.root));
    assert.equal(begins(), 2);
    await tools.review_step!("1", { action: "end", pr: "55" });
    await commands["review-pr"]("https://github.com/swaglive/swag-openim/pull/55", ctx(second.root));
    assert.match(notes.at(-1) ?? "", /Review #55: UI ở/);
    handlers.session_shutdown();
  });
});

test("gate 00 checks the author only against the authorPattern the project set", () => {
  const f = repo();
  const real = join(dirname(new URL(import.meta.url).pathname), "..", "review-pipeline");
  process.env.REVIEW_PIPELINE_ENGINE = real;
  const bin = mkdtempSync(join(tmpdir(), "fakegh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"auth token"*) echo token ;;
  *"branches/"*) echo 0000000000000000000000000000000000000001 ;;
  *"issues/"*) echo "type/bug" ;;
  *"pulls/"*) echo "open false null $FAKE_AUTHOR 0000000000000000000000000000000000000002 \${FAKE_BASE:-develop}" ;;
esac
`, { mode: 0o755 });
  const gate = (author: string, pattern?: string, base?: { branch?: string; pr: string }) => {
    const env = { REPO: "o/r", RV: f.root, HANDBOOK: join(f.root, "AGENTS.local.md"), REVIEWER: "me", WT_PREFIX: "wt-", ...(pattern ? { AUTHOR_PATTERN: pattern } : {}), ...(base?.branch ? { BASE_BRANCH: base.branch } : {}) };
    assert.equal(assembleTools(f.root, [], env), undefined);
    return spawnSync("bash", [join(f.root, "reports", "reviews", "tools", "v2", "gate_intake.sh"), "1"], {
      cwd: f.root, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_AUTHOR: author, ...(base ? { FAKE_BASE: base.pr } : {}) },
    }).stdout;
  };
  assert.match(gate("acme-dev", "^acme-"), /INTAKE: PASS   author=acme-dev/);
  assert.match(gate("outsider", "^acme-"), /INTAKE: FAIL   author=outsider/);
  const unchecked = gate("outsider");
  assert.match(unchecked, /INTAKE: INFO   author=outsider \(pipeline.json không có authorPattern/);
  assert.doesNotMatch(unchecked, /FAIL   author/);
  // the base branch is develop unless the project says otherwise
  assert.match(gate("acme-dev", "^acme-", { pr: "develop" }), /INTAKE: PASS   base=develop/);
  assert.match(gate("acme-dev", "^acme-", { pr: "main" }), /INTAKE: FAIL   base=main/);
  assert.match(gate("acme-dev", "^acme-", { branch: "main", pr: "main" }), /INTAKE: PASS   base=main/);
  assert.match(gate("acme-dev", "^acme-", { branch: "main", pr: "develop" }), /INTAKE: FAIL   base=develop/);
});

const BOARD_STUB = `import sys
import os, time
print("BOARD " + " ".join(sys.argv[1:]) + " COLUMNS=" + os.environ.get("COLUMNS", "-"))
if "BOARD_CWD" in os.environ:
    print("CWD " + os.path.realpath(os.getcwd()))
if "BOARD_HANG" in os.environ:
    time.sleep(30)
if "BOARD_FAIL" in os.environ:
    print("gh search: boom", file=sys.stderr)
    sys.exit(2)
`;

test("/review-board runs the board for the checkout's repo and reviewer with the policy's author pattern, even with a busy agent", async () => {
  const f = repo();
  writeFileSync(join(f.engine, "v2", "review_board.py"), BOARD_STUB);
  writeFileSync(join(projectRulesDir(f.root), "pipeline.json"), JSON.stringify({ authorPattern: "^Sotatek-" }));
  const { commands, notes, ctx } = setup();
  await commands["review-board"]("", ctx(f.root, false));
  assert.equal(notes.length, 1);
  assert.equal(notes[0], "BOARD --repo swaglive/swag-server --reviewer Sotatek-TheoNguyen2 --no-color --author-pattern ^Sotatek- COLUMNS=-");
  assert.equal(existsSync(join(f.root, "reports")), false);
});

test("/review-board works without project rules, and reports a failing board or a checkout it cannot identify", async () => {
  const bare = repo("https://github.com/swaglive/swag-server.git", { projectRules: false });
  writeFileSync(join(bare.engine, "v2", "review_board.py"), BOARD_STUB);
  const { commands, notes, ctx } = setup();
  await commands["review-board"]("", ctx(bare.root));
  assert.equal(notes[0], "BOARD --repo swaglive/swag-server --reviewer Sotatek-TheoNguyen2 --no-color COLUMNS=-");

  process.env.BOARD_FAIL = "1";
  await commands["review-board"]("", ctx(bare.root));
  delete process.env.BOARD_FAIL;
  assert.match(notes[1], /boom/);

  await commands["review-board"]("", ctx(mkdtempSync(join(tmpdir(), "elsewhere-"))));
  const noOrigin = repo(null);
  await commands["review-board"]("", ctx(noOrigin.root));
  const noReviewer = repo("https://github.com/swaglive/swag-server.git", { reviewer: null });
  await commands["review-board"]("", ctx(noReviewer.root));
  assert.match(notes[2], /review checkout/);
  assert.match(notes[3], /remote origin/);
  assert.match(notes[4], /identity\.guard\.user/);
});

test("/review-board passes the terminal width, and gives up on a board that hangs instead of waiting for the pipeline's 15 minutes", async () => {
  const f = repo();
  writeFileSync(join(f.engine, "v2", "review_board.py"), BOARD_STUB);
  const { commands, notes, ctx } = setup();
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 91, configurable: true });
  try {
    await commands["review-board"]("", ctx(f.root));
  } finally {
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
  }
  assert.match(notes[0], /COLUMNS=91$/);

  process.env.BOARD_HANG = "1";
  process.env.REVIEW_BOARD_TIMEOUT_MS = "300";
  const started = Date.now();
  await commands["review-board"]("", ctx(f.root));
  delete process.env.BOARD_HANG;
  delete process.env.REVIEW_BOARD_TIMEOUT_MS;
  assert.ok(Date.now() - started < 5000);
  assert.match(notes[1], /Command failed/);
});

test("/review-board runs the board in the checkout root, so its ack file is found from a subdirectory too", async () => {
  const f = repo();
  writeFileSync(join(f.engine, "v2", "review_board.py"), BOARD_STUB);
  const sub = join(f.root, "reports", "reviews");
  mkdirSync(sub, { recursive: true });
  const { commands, notes, ctx } = setup();
  process.env.BOARD_CWD = "1";
  try {
    await commands["review-board"]("", ctx(sub));
  } finally {
    delete process.env.BOARD_CWD;
  }
  assert.ok(notes[0].endsWith(`CWD ${realpathSync(f.root)}`), notes[0]);
});

test("/review-board shows a counting status while it loads and clears it on success, failure and timeout", async () => {
  const f = repo();
  writeFileSync(join(f.engine, "v2", "review_board.py"), BOARD_STUB);
  const { commands, statuses, ctx } = setup();
  await commands["review-board"]("", ctx(f.root));
  assert.match(statuses[0] ?? "", /đang tải PR.*0s/);
  assert.equal(statuses.at(-1), undefined);

  process.env.BOARD_FAIL = "1";
  statuses.length = 0;
  await commands["review-board"]("", ctx(f.root));
  delete process.env.BOARD_FAIL;
  assert.equal(statuses.at(-1), undefined);

  process.env.BOARD_HANG = "1";
  process.env.REVIEW_BOARD_TIMEOUT_MS = "1500";
  statuses.length = 0;
  await commands["review-board"]("", ctx(f.root));
  delete process.env.BOARD_HANG;
  delete process.env.REVIEW_BOARD_TIMEOUT_MS;
  assert.ok(statuses.some((s) => /1s$/.test(s ?? "")), "the status ticks while waiting");
  assert.equal(statuses.at(-1), undefined);
});

// The k3s driver against a fake ssh that plays the node: it answers kubectl calls from a list of pod states and records every call.
const FAKE_NODE = `#!/bin/sh
for a; do cmd="$a"; done
[ "$cmd" = exit ] && exit 0
echo "$cmd" >> "$NODE_DIR/calls.txt"
case "$cmd" in
  *range*) echo "mongo" ;;
  *"-keep -o jsonpath"*creationTimestamp*) cat "$NODE_DIR/keep" 2>/dev/null ;;
  *"get pod"*)
    n=$(( $(cat "$NODE_DIR/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$NODE_DIR/n"
    line=$(sed -n "\${n}p" "$NODE_DIR/states"); [ -n "$line" ] || line=$(tail -1 "$NODE_DIR/states"); echo "$line" ;;
  *"create -f -"*) cat > "$NODE_DIR/pod.yaml" ;;
  *"tar -x"*) cat > "$NODE_DIR/shipped.tar" ;;
  *"bash -s"*) cat > "$NODE_DIR/sweep.sh" ;;
  *"logs"*) echo "mongod: illegal instruction" ;;
  *"sh -s"*)
    script=$(cat)
    case "$script" in
      "# Runs in the runner container"*) [ -z "$FAKE_SETUP_FAIL" ] || { echo "alembic: boom"; exit 1; }; [ -z "$FAKE_SETUP_HANG" ] || sleep 30 ;;
      *) printf '%s\\n' "$script" > "$NODE_DIR/run.sh"; [ -z "$FAKE_HANG" ] || exec sleep 30; sleep "\${FAKE_RUN_SECONDS:-0}"; echo "5 passed"; exit "\${FAKE_RUN_RC:-0}" ;;
    esac ;;
esac
exit 0
`;

function k3sNode(states: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fake-node-"));
  writeFileSync(join(dir, "ssh"), FAKE_NODE, { mode: 0o755 });
  writeFileSync(join(dir, "states"), states.join("\n") + "\n");
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  writeFileSync(join(wt, "marker.txt"), "pr head");
  const engine = join(dirname(new URL(import.meta.url).pathname), "..", "review-pipeline");
  const run = (extraEnv: Record<string, string> = {}, pr = "19372", command = "echo hi") =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bash", [join(engine, "k3s", "rv_k3s.sh"), "run", "swag-server", pr, wt, command], {
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: dir, NODE_DIR: dir, K3S_SSH: "root@node", REPO: "o/swag-server", RV_POLL: "1", ...extraEnv },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const calls = () => (existsSync(join(dir, "calls.txt")) ? readFileSync(join(dir, "calls.txt"), "utf8") : "");
  // what the node answers about the PR's kept pod: phase, creation time, schema label (empty file: no such pod)
  const keep = (phase: string, ageMs: number, schema: string) =>
    writeFileSync(join(dir, "keep"), `${phase} ${phase === "Running" ? "True" : "False"} ${new Date(Date.now() - ageMs).toISOString().replace(/\.\d+Z$/, "Z")} ${schema}\n`);
  return { dir, run, calls, engine, wt, keep };
}
// sha256 of nothing: the test worktree has no alembic/versions, so that is the schema hash of every tree here
const NO_SCHEMA = "e3b0c44298fc";

const READY = "Running True W: T:";
const PENDING = "Pending False W:ContainerCreating T:";

test("rv_k3s.sh builds the PR's kept pod on the first run, wipes the image's tree before the worktree lands, sets up, runs, and leaves the pod for the next run", async () => {
  const node = k3sNode([PENDING, READY]);
  const result = await node.run({}, "19372", "python -m pytest tests/x.py");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /5 passed/);
  const yaml = readFileSync(join(node.dir, "pod.yaml"), "utf8");
  assert.match(yaml, /name: rv-swag-server-19372-keep\n/);
  assert.match(yaml, /rv\/pr: "19372"/);
  assert.match(yaml, new RegExp(`rv/schema: "${NO_SCHEMA}"`));
  assert.match(yaml, /activeDeadlineSeconds: 5400/);
  assert.doesNotMatch(yaml, /__[A-Z_]+__/);
  assert.match(yaml, /automountServiceAccountToken: false/);
  assert.match(readFileSync(join(node.dir, "run.sh"), "utf8"), /^\[ ! -f \/tmp\/rv\.env \] \|\| \. \/tmp\/rv\.env\ncd \/usr\/src\/app\nexec 2>&1\npython -m pytest tests\/x\.py\n$/);
  const calls = node.calls();
  assert.match(calls, /ctr images ls -q \| grep -qx docker\.io\/library\/rv-swag-server:dev \|\| \{ docker image inspect rv-swag-server:dev/);
  assert.ok(calls.indexOf("ctr images ls") < calls.indexOf("create -f -"), "the image is back in k3s before the pod needs it");
  assert.match(calls, /kubectl -n review-env create -f -/);
  // the image holds the tree it was built from: a module the PR deleted must not survive into the run
  assert.match(calls, /exec -i rv-swag-server-19372-keep -c runner -- sh -c 'cd \/usr\/src\/app && find \. -mindepth 1 -maxdepth 1 ! -name \.venv -exec rm -rf \{\} \+ && tar -x -o -C \/usr\/src\/app'/);
  assert.doesNotMatch(calls, /delete pod/);
  assert.ok(calls.indexOf("tar -x") < calls.indexOf("-- sh -s"), "the code goes up before anything runs");
  assert.match(execFileSync("tar", ["-tf", join(node.dir, "shipped.tar")], { encoding: "utf8" }), /marker\.txt/);
  assert.equal(existsSync(join(node.dir, "rv-k3s-keep-swag-server-19372")), false, "the per-PR lock is released");
});

test("rv_k3s.sh reuses the kept pod of the PR: no new pod, no setup, the tree shipped again and compiled before the command", async () => {
  const node = k3sNode([READY]);
  node.keep("Running", 60_000, NO_SCHEMA);
  const result = await node.run({ FAKE_SETUP_FAIL: "1" }, "19372", "python -m pytest tests/x.py");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /rv-swag-server-19372-keep \(dùng lại\)/);
  assert.match(result.stdout, /5 passed/);
  const calls = node.calls();
  assert.doesNotMatch(calls, /create -f -|delete pod|bash -s|ctr images/);
  assert.equal((calls.match(/get pod/g) ?? []).length, 1, "one probe, no queue polling");
  assert.match(calls, /find \. -mindepth 1 -maxdepth 1 ! -name \.venv -exec rm -rf \{\} \+ && tar -x -o -C \/usr\/src\/app/);
  assert.match(readFileSync(join(node.dir, "run.sh"), "utf8"), /cd \/usr\/src\/app\nexec 2>&1\npython -m compileall -q -j 0 -o 0 swag libs tests >\/dev\/null 2>&1 \|\| true\npython -m pytest tests\/x\.py\n$/);
});

test("rv_k3s.sh replaces a kept pod that has other migration files, or too little time left before the node's deadline", async () => {
  for (const [why, phase, age, schema] of [["schema", "Running", 60_000, "deadbeef0000"], ["age", "Running", 4000_000, NO_SCHEMA], ["phase", "Failed", 60_000, NO_SCHEMA]] as const) {
    const node = k3sNode([READY]);
    node.keep(phase, age, schema);
    const result = await node.run();
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /pod rv-swag-server-19372-keep cũ .* xoá để dựng lại/, why);
    const calls = node.calls();
    assert.ok(calls.indexOf("delete pod rv-swag-server-19372-keep --wait=true") < calls.indexOf("create -f -"), `${why}: the old pod goes before the new one is created`);
  }
});

test("rv_k3s.sh gives a throwaway pod on RV_FRESH_POD=1 and to a second run of the same PR at the same time, and takes over a lock whose owner died", async () => {
  const fresh = k3sNode([READY]);
  fresh.keep("Running", 60_000, NO_SCHEMA);
  await fresh.run({ RV_FRESH_POD: "1" });
  assert.match(readFileSync(join(fresh.dir, "pod.yaml"), "utf8"), /name: rv-swag-server-19372-[a-z0-9]{6}\n/);
  assert.match(fresh.calls(), /delete pod rv-swag-server-19372-[a-z0-9]{6} --wait=false/);
  assert.doesNotMatch(fresh.calls(), /-keep/);

  const busy = k3sNode([READY]);
  mkdirSync(join(busy.dir, "rv-k3s-keep-swag-server-19372"));
  writeFileSync(join(busy.dir, "rv-k3s-keep-swag-server-19372", "pid"), `${process.pid}\n`);
  await busy.run();
  assert.match(readFileSync(join(busy.dir, "pod.yaml"), "utf8"), /name: rv-swag-server-19372-[a-z0-9]{6}\n/);
  assert.equal(existsSync(join(busy.dir, "rv-k3s-keep-swag-server-19372")), true, "another run's lock is left alone");

  const stale = k3sNode([READY]);
  mkdirSync(join(stale.dir, "rv-k3s-keep-swag-server-19372"));
  writeFileSync(join(stale.dir, "rv-k3s-keep-swag-server-19372", "pid"), "999999\n");
  await stale.run();
  assert.match(readFileSync(join(stale.dir, "pod.yaml"), "utf8"), /name: rv-swag-server-19372-keep\n/);
});

test("rv_k3s.sh deletes a kept pod whose setup or run broke, so the next run builds a sound one", async () => {
  const node = k3sNode([READY]);
  const failed = await node.run({ FAKE_SETUP_FAIL: "1" });
  assert.equal(failed.code, 125);
  assert.match(node.calls(), /delete pod rv-swag-server-19372-keep --wait=false/);
  const hung = k3sNode([READY]);
  hung.keep("Running", 60_000, NO_SCHEMA);
  const result = await hung.run({ RV_RUN_TIMEOUT: "2", FAKE_HANG: "1" });
  assert.equal(result.code, 124);
  assert.match(hung.calls(), /delete pod rv-swag-server-19372-keep --wait=false/);
});

test("rv_k3s.sh does not count the time in the queue against the run", async () => {
  const node = k3sNode([PENDING, PENDING, PENDING, PENDING, PENDING, READY]);
  const result = await node.run({ RV_RUN_TIMEOUT: "3", FAKE_RUN_SECONDS: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /pod sẵn sàng sau [4-9]s/);
  assert.match(result.stdout, /5 passed/);
});

test("rv_k3s.sh stops a run that hangs after the run limit, with exit 124, and still deletes the pod", async () => {
  const node = k3sNode([READY]);
  const started = Date.now();
  const result = await node.run({ RV_RUN_TIMEOUT: "2", FAKE_HANG: "1" });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /test chạy quá 2s/);
  assert.ok(Date.now() - started < 15_000);
  assert.match(node.calls(), /delete pod rv-swag-server-19372-/);
});

test("rv_k3s.sh gives the setup its own limit, and reports a setup that fails instead of running the tests on a broken pod", async () => {
  const hang = await k3sNode([READY]).run({ RV_SETUP_TIMEOUT: "2", FAKE_SETUP_HANG: "1" });
  assert.equal(hang.code, 124);
  assert.match(hang.stderr, /dựng môi trường quá 2s/);
  const node = k3sNode([READY]);
  const failed = await node.run({ FAKE_SETUP_FAIL: "1" });
  assert.equal(failed.code, 125);
  assert.match(failed.stderr, /alembic: boom/);
  assert.equal(existsSync(join(node.dir, "run.sh")), false);
  assert.match(node.calls(), /delete pod/);
});

test("rv_k3s.sh reports a container that died while the pod was starting, with its log, instead of waiting for a pod that cannot become ready", async () => {
  const node = k3sNode(["Running False W: T:Error"]);
  const result = await node.run({ RV_QUEUE_WAIT: "5" });
  assert.equal(result.code, 125);
  assert.match(result.stderr, /một container của pod .* đã dừng/);
  assert.match(result.stderr, /illegal instruction/);
});

test("rv_k3s.sh gives up waiting for room on the node after RV_QUEUE_WAIT, and says the wait is not part of the run limit", async () => {
  const node = k3sNode([PENDING]);
  const result = await node.run({ RV_QUEUE_WAIT: "3" });
  assert.equal(result.code, 125);
  assert.match(result.stderr, /đợi quá 3s mà node vẫn chưa có chỗ/);
  assert.match(node.calls(), /delete pod/);
});

test("rv_k3s.sh sweeps old pods by age on the node, and leaves the finished pods of a review that is still running alone", async () => {
  const node = k3sNode([READY]);
  await node.run();
  const sweep = readFileSync(join(node.dir, "sweep.sh"), "utf8");
  assert.doesNotMatch(node.calls(), /--field-selector/);
  // finished pods wait an hour; anything else (a Pending pod whose creator died) waits for the deadline, the longest queue and 5 minutes
  assert.match(sweep, /Failed\|Succeeded\) \[ "\$age" -gt 3600 \]/);
  assert.match(sweep, /-gt 6900 \]/);
  // run for real against a fake kubectl: only the old pods go (a Running pod past the deadline is stuck by definition)
  const fake = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  const old = new Date(Date.now() - 7200_000).toISOString().replace(/\.\d+Z$/, "Z");
  const fresh = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  writeFileSync(
    join(fake, "kubectl"),
    `#!/bin/sh\ncase "$*" in\n  *"get pods"*) printf 'old-failed ${old} Failed\\nfresh-failed ${fresh} Failed\\nold-running ${old} Running\\nfresh-pending ${fresh} Pending\\n' ;;\n  *delete*) echo "$*" >> ${join(fake, "deleted.txt")} ;;\nesac\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(fake, "date"), `#!/bin/sh\nif [ "$1" = "-d" ]; then exec python3 -c 'import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$2"; fi\nexec /bin/date "$@"\n`, { mode: 0o755 });
  spawnSync("bash", ["-s"], { input: sweep, env: { PATH: `${fake}:${process.env.PATH}` } });
  assert.deepEqual(readFileSync(join(fake, "deleted.txt"), "utf8").trim().split("\n").map((l) => l.match(/pod (\S+)/)![1]), ["old-failed", "old-running"]);
});

test("rv_k3s.sh refuses a PR that is not a number before it uses it anywhere", async () => {
  const node = k3sNode([READY]);
  const result = await node.run({}, "1|touch /tmp/pwned");
  assert.equal(result.code, 125);
  assert.match(result.stderr, /PR phải là số/);
  assert.equal(node.calls(), "");
});

test("rv_k3s.sh refuses to start without the node's address, before it touches anything", async () => {
  const node = k3sNode([READY]);
  const result = await node.run({ K3S_SSH: "" });
  assert.equal(result.code, 125);
  assert.match(result.stderr, /K3S_SSH trống/);
  assert.equal(node.calls(), "");
});

test("rv_k3s.sh stops with exit 123 before it creates a pod when the PR head already moved, and while it waits in the queue", async () => {
  const rv = mkdtempSync(join(tmpdir(), "rv-head-"));
  const work = join(rv, "reports", "reviews", "evidence", "19372", "gates");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "head.sha"), `${"a".repeat(40)}\n`);
  const node = k3sNode([READY]);
  writeFileSync(join(node.dir, "gh"), `#!/bin/sh\ncase "$1" in auth) echo token ;; api) echo ${"b".repeat(40)} ;; esac\n`, { mode: 0o755 });
  const result = await node.run({ RV: rv, REVIEWER: "me" });
  assert.equal(result.code, 123);
  assert.match(result.stderr, /HEAD_MOVED/);
  assert.equal(node.calls(), "");
  const queued = k3sNode([PENDING]);
  writeFileSync(join(queued.dir, "gh"), `#!/bin/sh\ncase "$1" in auth) echo token ;; api) echo "$(cat ${join(queued.dir, "head")})" ;; esac\n`, { mode: 0o755 });
  writeFileSync(join(queued.dir, "head"), "a".repeat(40));
  const slow = queued.run({ RV: rv, REVIEWER: "me", RV_QUEUE_WAIT: "200", RV_HEAD_CHECK: "2" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  writeFileSync(join(queued.dir, "head"), "b".repeat(40));
  const moved = await slow;
  assert.equal(moved.code, 123);
  assert.match(queued.calls(), /delete pod/);
});

test("run_pr_tests.sh with a k3s host runs on the node, filters the pod's output like the local run, and passes the infrastructure exit codes on", async () => {
  const node = k3sNode([READY]);
  const f = repo();
  process.env.REVIEW_PIPELINE_ENGINE = node.engine;
  assert.equal(assembleTools(f.root, [], { REPO: "o/swag-server", RV: f.root, HANDBOOK: join(f.root, "AGENTS.local.md"), REVIEWER: "me", WT_PREFIX: "wt-", K3S_SSH: "root@node" }), undefined);
  const script = join(f.root, "reports", "reviews", "tools", "run_pr_tests.sh");
  const wt = join(mkdtempSync(join(tmpdir(), "wts-")), "swag-pr-19372");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "marker.txt"), "pr head");
  const go = (extraEnv: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("sh", [script, wt, "tests/x.py", "; echo R0::pytest_rc=$?"], {
        cwd: f.root,
        env: { PATH: `${node.dir}:${process.env.PATH}`, HOME: process.env.HOME, NODE_DIR: node.dir, RV_POLL: "1", ...extraEnv },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const ok = await go();
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "5 passed");
  assert.match(readFileSync(join(node.dir, "run.sh"), "utf8"), /python -m pytest -q -s -p no:cacheprovider -rfE tests\/x\.py ; echo R0::pytest_rc=\$\?\n$/);
  assert.equal(existsSync(join(f.root, "reports", "reviews", ".tests.lock")), false);
  const hung = await go({ RV_RUN_TIMEOUT: "2", FAKE_HANG: "1" });
  assert.equal(hung.code, 124);
  assert.match(hung.stderr, /test chạy quá 2s/);
  const local = await go({ REVIEW_ENV: "local" });
  assert.match(local.stderr, /no compose\.yaml/);
});
