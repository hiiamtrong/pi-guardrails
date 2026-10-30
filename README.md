# Pi GitHub Guards

A Pi package with ten workflow and security extensions:

- **`comment-guard`** reviews new code comments, suppressions, and Python future annotations before they are written.
- **`ponytail-review-on-settle`** runs `/skill:ponytail-review` after a turn that edited code, unless the edits were trivial.
- **`test-gaps-on-settle`** asks the agent to cover missing happy-path and abnormal cases after it writes or edits a test file.
- **`github-write-confirm`** permits GitHub reads and requires confirmation for GitHub remote writes.
- **`github-identity-guard-required`** blocks agent-initiated Git/GitHub writes until Git Identity Guard is installed in the current repository.
- **`pr-review-archive`** archives human PR review evidence in a local SQLite database.
- **`review-pipeline`** adds `/review-pr <GitHub PR link>`, which opens a live web UI for the PR review pipeline of the repo whose review checkout you are in, and tracks the step the agent is on.
- **`compact-continue`** resumes the run once after Pi compacts the context at the end of a run, so the task is not left waiting for you.
- **`session-auto-name`** names each session after its work, keeps the name current as the work changes, and renames the Orca tab to match.
- **`worktree-bootstrap`** configures a personal, per-repository `post-checkout` bootstrap hook that copies selected ignored files into new Git worktrees.

The GitHub write and identity gates fail closed when the required condition cannot be verified.

## GitHub write confirmation

- Allows known read-only `gh` commands and GET-only `gh api` calls, including static string argv passed to supported `ctx_execute` subprocess APIs.
- Confirms `gh` mutations, dynamic subprocess argv, GitHub API POST/PUT/PATCH/DELETE calls, `git push`, and GitHub MCP mutation tools such as review-thread resolution.
- Defaults to confirmation when an action cannot be proven read-only.
- Redacts GitHub tokens from the confirmation preview.

### Write allowlist

By default every GitHub write requires confirmation. To bypass confirmation for an explicitly targeted trusted repository, create `~/.pi/agent/github-write-confirm.json`:

```json
{
  "writeAllowlist": [
    "hiiamtrong/example-repo"
  ]
}
```

The allowlist is case-insensitive. The write must identify its repository explicitly, for example `gh repo edit hiiamtrong/example-repo ...`, `gh --repo hiiamtrong/example-repo ...`, a GitHub URL, or MCP `owner`/`repo` input. Unknown targets, including `git push origin`, remain confirmation-gated.

## Git Identity Guard requirement

`github-identity-guard-required` checks Bash, `ctx_execute`, and batched commands for Git commits/pushes and GitHub writes. If the working repository lacks a configured Git Identity Guard runner, it blocks the command; it never installs a guard implicitly.

Install [Git Identity Guard](https://github.com/hiiamtrong/git-identity-guard) in each repository before committing or pushing:

```bash
git clone --depth 1 https://github.com/hiiamtrong/git-identity-guard.git ~/.local/share/git-identity-guard
~/.local/share/git-identity-guard/scripts/git-identity-guard install \
  --user <github-login> \
  --email <verified-git-email> \
  --name <git-author-name>
```

Git Identity Guard installs local `pre-commit` and `pre-push` hooks. This Pi extension is an additional agent-side gate, not a replacement for remote branch protection or CI enforcement.

## Session names

`session-auto-name` asks a small model after every turn whether the session title still fits, and renames the session when it does not. It records each name in the session file, lists them with `/session-names`, and never touches a name you set with `/session-name`.

It first calls an OpenAI-compatible endpoint from `~/.pi/agent/session-auto-name.json` (set `SESSION_AUTO_NAME_CONFIG` for another path), then falls back to `claude-bridge/claude-haiku-5-5`, then to the session's own model. Keep the file private, since it holds a secret:

```json
{
  "endpoint": "https://example.com/v1",
  "secret": "<bearer token>"
}
```

## Bundled packages

`packages/` holds three standalone Pi extensions that keep their own `package.json`:

- **`claude-memory`** is registered by this package. It stores durable memory topics for Pi (see its README).
- **`lazy-tools`** loads tool schemas on demand. It is not registered here: add `./packages/lazy-tools/index.ts` to `pi.extensions` to enable it. Test with `npm run test:lazy-tools` (needs Bun).
- **`mcp-bridge`** connects MCP servers as Pi tools. It is not registered here and needs `npm install` inside `packages/mcp-bridge` first.

## Install

Install globally as a Pi package:

```bash
pi install git:github.com/hiiamtrong/pi-guardrails
```

Or install from a checkout:

```bash
ln -sf "$PWD/extensions/comment-guard.ts" ~/.pi/agent/extensions/comment-guard.ts
ln -sf "$PWD/extensions/github-write-confirm.ts" ~/.pi/agent/extensions/github-write-confirm.ts
ln -sf "$PWD/extensions/github-identity-guard-required.ts" ~/.pi/agent/extensions/github-identity-guard-required.ts
ln -sf "$PWD/extensions/pr-review-archive.ts" ~/.pi/agent/extensions/pr-review-archive.ts
ln -sf "$PWD/extensions/worktree-bootstrap.ts" ~/.pi/agent/extensions/worktree-bootstrap.ts
ln -sf "$PWD/extensions/ponytail-review-on-settle.ts" ~/.pi/agent/extensions/ponytail-review-on-settle.ts
ln -sf "$PWD/extensions/test-gaps-on-settle.ts" ~/.pi/agent/extensions/test-gaps-on-settle.ts
ln -sf "$PWD/extensions/review-pipeline.ts" ~/.pi/agent/extensions/review-pipeline.ts   # dev only: delete this link once the package that ships the extension is installed, or it loads twice
cp config/github-write-confirm.example.json ~/.pi/agent/github-write-confirm.json
```

Reload Pi with `/reload` or restart it after installation.

## Comment review

`comment-guard` reviews comments in code files before accepting them. It also reviews type/linter suppression comments and `from __future__ import annotations`, and blocks the write if no reviewer can run.

When a TypeSafe key is configured (see [Jev decisions](#jev-decisions)), Jev scores each change on three questions: does every comment document a non-obvious reason (`documentsWhy`), does one restate the code (`restatesCode`), and does it add an unexplained suppression (`unverifiedSuppression`). It rejects when `restatesCode` or `unverifiedSuppression` is ≥ 0.8 or `documentsWhy` is ≤ 0.2, and approves when `documentsWhy` ≥ 0.6, `restatesCode` ≤ 0.4, and `unverifiedSuppression` ≤ 0.2. Everything in between, and any Jev failure, falls back to the read-only Pi reviewer.

## Ponytail review on settle

`ponytail-review-on-settle` sends `/skill:ponytail-review` once a turn settles after editing code files. With Jev configured, it first sends each edit's `before`/`after` text and skips the review when Jev is at least 0.8 confident the edits only change wording, names, formatting, or literal values without adding or changing any logic, condition, operator, or control flow. Jev failures and changes over 60,000 characters always get reviewed.

## Test gaps on settle

`test-gaps-on-settle` runs after any turn in which the agent writes or edits a test file, whether you asked for tests or the agent added them on its own. You do not need to invoke it.

1. It finds the code under test from the test file: relative imports for JS/TS, imported modules under the repository root or `src/` for Python, and `foo.go` for `foo_test.go`. From each source file it keeps only the top-level declarations the test names, statements that use them (such as `app.get(...)` route handlers), the `export default` when the test imports it, and the declarations those use; if the test names nothing in the file, the whole file is kept. Large files otherwise drown the decision in unrelated code and report other functions' error paths as gaps.
2. It builds candidate cases: every `throw`/`raise`/`errors.New`/`fmt.Errorf` message in that code, plus a fixed checklist (happy path, empty input, null/None, values at and just past a limit, zero or negative numbers, malformed input, failing dependencies, duplicates).
3. Jev keeps the checklist cases relevant to the code (≥ 0.5); error paths are always kept.
4. Jev scores whether the tests contain an **assertion** that checks the outcome for each case, so a test that calls the code but ignores the result does not count. Cases scoring ≤ 0.4 are reported.

The report arrives as a `[test-gaps]` follow-up message listing the missing cases, so the agent adds those tests or states in one line why a case cannot happen. Each case is reported at most once per test file within 30 days, so a case the agent rejects is not raised again, even after `/reload` or in another session. Reported cases are kept in `~/.pi/agent/test-gaps-reported.json`; delete it to start over.

Example: you ask "write tests for `parseAge` in `src/age.ts`" and the agent writes only `parseAge("30")`. When the turn ends, the extension reports the untested `"age is required"` / `"age is unrealistic"` errors, empty and malformed input, and values at and past the 150 limit.

Recognized test files: `*.test.*`, `*.spec.*` (JS/TS), `test_*.py`, `*_test.py`, and `*_test.go`. Test files whose code under test cannot be resolved, or whose trimmed source and tests exceed 60,000 characters, are skipped silently, as is the whole check when Jev fails.

## Review pipeline

`/review-pr <GitHub PR link> [--takeover | --restart] [--bg]` starts or resumes a PR review in the review checkout you are in, and opens a local page (127.0.0.1) that shows which pipeline step the agent is on, what it is doing, and each gate's verdict.

The package ships the engine in `review-pipeline/` (runner, live UI, gates, post guard). Rules are separate, laid out like Pi memory under the agent directory, so nothing is stored in the repo:

```
~/.pi/agent/review-pipeline/
├── global/                       rules shared by every repo
└── projects/-canonical-repository-path/   rules of one repo (same key as ~/.pi/agent/memory/projects)
    └── .project.json             {"root": "<repo path>"}   written by /review-pr when missing
```

A rules folder holds `steps/NN-*.md` (what the agent reads at `start`), `steps/NN-*.rules.md`, `reference/` and `draft_template.md`. **The project folder is looked up first, then global**, so a project overrides a global file and falls back to it for the rest. The command needs `steps/` in at least one of them. `REVIEW_PIPELINE_HOME` replaces `~/.pi/agent/review-pipeline`.

A rules folder can also hold:

- **`pipeline.json`**: the project's policy, merged over the global one. `worktreePrefix` (default `<repo name>-pr-`; the worktree is `../<prefix><PR>`), `gates` (steps with a machine gate, from `00` to `07`; default all, `00` is always on, a step without a gate is recorded as passed with an INFO line and checked by the reviewer), `impactSections` (how many `## ` sections `evidence/<PR>/impact-map.txt` must have, default 8) `draftCheck` (a script in `tools/v2` that replaces the default draft gate) `authorPattern` (an extended regular expression the PR author must match at gate 00; without it the author is not checked) and `k3sHost` (`user@host` of the k3s node, reached over Tailscale; with it the tests run on the node, see below). A typo or a wrong type stops `/review-pr` with a message.
- **`tools/`**: overrides for engine scripts, same layout as the engine (`tools/impact_map.py`, `tools/v2/check_draft_x.py`). The command rebuilds `reports/reviews/tools/` on every run from the engine, then global overrides, then project overrides, as links: it builds a new folder beside the old one and swaps a link, so a review in progress never sees it missing. It also writes `tools/.pipeline-env` (the variables below), which the scripts load when the agent runs them by hand. A real `tools` folder that the command did not create is never touched: move its files into the project's `tools/` first.

Besides the rules, the review checkout needs:

- **A handbook** at the checkout root, `AGENTS.local.md` or `AGENTS.md`. The gates refuse to run without one.
- **`identity.guard.user`** in the checkout's local git config: the GitHub login the gates read as the reviewer (its token, its reviews, its comments).
- **An `origin` remote**: `owner/name` is taken from it, so the gates read that repo. A PR link for another repo is refused.

The command builds `reports/reviews/tools` (rules and scripts address the tools by that path), exports `REPO`, `RV` (the checkout), `HANDBOOK`, `REVIEWER`, `RULES` (the existing rules folders, project first) and the policy (`WT_PREFIX`, `GATES`, `IMPACT_SECTIONS`, `DRAFT_CHECK`, `AUTHOR_PATTERN`) to every pipeline call, shows the step list as a widget in Pi, then hands the agent a kickoff prompt. A real `reports/reviews/tools` directory is never overwritten: move it away first.

- It registers a `review_step` tool the agent calls at each step boundary: `start` returns that step's instructions, `note` shows what it is doing, `done` runs that step's gate and records its verdict. Every call carries `pr=<number>` (the kickoff tells the agent to); it may be left out only while one review is open.
- **Several PRs at once.** Run `/review-pr <link>` again for another PR, in the same Pi or in other Pi windows on the same checkout. Each PR keeps its own evidence, progress, owner lock and UI port, and its own PR worktree. In one Pi the widget then shows one header line per review (the step each is on) and the status bar joins them; the full step list of a PR is on its UI page. Running the command again for a PR already open replaces its entry, unless a runner wrote to that PR's `events.jsonl` recently (within 5 minutes, or within 30 minutes when the last event is a step `start`, since a step writes nothing until it is done) and the review has not ended: the owner lock only tells Pi processes apart, so two runners started by one Pi would both pass it and overwrite each other's evidence, draft and worktree. The command and `review_start` then refuse; `--takeover` on the command overrides it when you know that runner is dead. Also, the same PR number open for a different checkout (two repos in one Pi) is refused until that review has ended, because `review_step` could not tell them apart. `review_step` without `pr` is refused while two or more reviews are open, and a PR that has ended no longer counts as open.
- **In the background (`--bg`).** `/review-pr <link> --bg` does the same setup, then asks the session agent to start the `review-runner` subagent (`agents/review-runner.md`) with `async: true` and to answer in one line, so the session is free for the next `/review-pr` at once. The subagent runs steps 00 to 05 and stops; the widget and the PR's UI page follow it as before. A background subagent cannot write to GitHub (the guards refuse every write because no confirmation is available to it), so steps 06 and 07 stay with the session agent: once the subagent is done and you say OK to the draft, the session agent runs them with `review_step pr=<number>`. `review_step` is registered when the extension loads and, in a process that never ran `/review-pr`, takes its environment from `reports/reviews/tools/.pipeline-env` of the checkout it runs in. Install the agent once: `mkdir -p ~/.pi/agent/agents && ln -sf "$PWD/agents/review-runner.md" ~/.pi/agent/agents/review-runner.md`, then `/reload`.
- **Tools for the agent.** Two commands also exist as tools, so the agent can run them itself (a slash command only comes from your own input). `review_start` takes `link` and `background` (default true) and does what `/review-pr` does, except that it does not wait for an idle agent (the agent is busy while it calls the tool) and it refuses an eleventh open review (`MAX_OPEN`, 10), counting the reviews of this Pi session that have not ended (ending one with `review_step action=end` frees the slot but a later start of that PR begins fresh, and the command `/review-pr` has no limit); running it again for an open PR is allowed. Its result is the kickoff text, so with `background` the agent follows it by launching `review-runner`. `link` must be one bare PR link: anything after it, such as `--takeover` or `--restart`, is refused, so a review owned by another Pi is refused with the message that names them and only you can take it over. `review_board` returns what `/review-board` shows, for the checkout of the agent's working directory, so the agent can pick the next PR before calling `review_start`. Both work from the working directory (`process.cwd()`), like `review_step` does in a subagent.
- **The PR's tests cannot touch the review.** The project's `compose.yaml` mounts the whole checkout read-write and keeps `/tmp` in a volume shared by every run (and on `PYTHONPATH`), so a test or `conftest.py` from the PR could rewrite `reports/reviews/` (the evidence the gates read, the draft, the `tools` links the host then executes), `.git/` of the review clone, or leave a `.pth` for the next PR's run. `run_pr_tests.sh` therefore runs compose with `compose.review.yaml` from the engine on top: the checkout is mounted read-only, `/tmp` is a fresh tmpfs per run, and only the venv (an anonymous volume) stays writable for `pip install`. The PR's `swag/`, `tests/` and `libs/` are overlaid read-only as before. A test that writes into the repository fails under review now; that is the point. Suites that need the compose `docker` (dind) service through `/tmp/docker.sock` do not see it, which is also the default (`replicas: 0`). The shared `swag_test` databases are still shared: see the rules on cloning them.
- **Trace a nullable value to where it is written.** `scan_triggers.py` adds a `VALUE_ORIGIN` row for each attribute or key the PR starts reading in a file, on a line that guards against `None` or supplies a default (`x or 'free'`, `a and b`, `y if x else z`, `.get(k, d)`, `Optional[...]`). Docstrings, tests, attribute paths the file already read (`session.mode.nbf` counts as `mode` and `mode.nbf`, so a `show.nbf` elsewhere in the file does not hide it) and a few container names (`get`, `items`, `keys`, `values`, `datetime`) are skipped, and every value found gets a row. Column 4 lists where other non-test code writes that name: database writes such as MongoEngine's `set_on_insert__mode=` come first, then files next to the changed one, at most three shown with a count. `check_draft.py` then fails unless the section `## Giá trị có thể rỗng do ai ghi` has a line per value that names it and cites a `file.py:line` that exists in the worktree with the name within two lines of it (or says there is no writer), and it adds a manual line asking whether the tests build their data through that writer. This is the check an agent skipped on #19308: it read `session.mode.nbf`, trusted another reviewer's probe, and accepted a test whose session had no mode, while `activate_session` always writes `mode=free, nbf=now`. It is a heuristic that forces the trace, not a verdict: it reads Python only, finds writers by name, and `mode` alone has about a hundred. The step texts and `draft_template.md` of a project must carry the section (swag-server's do). `DRAFT_CHECK` projects use their own gate and are unaffected.
- **Tests run on a pod of their own (k3s).** With `k3sHost` in `pipeline.json` (exported as `K3S_SSH`), `run_pr_tests.sh` and the projects' test wrappers run each test command through `review-pipeline/k3s/rv_k3s.sh`: one throwaway pod in the `review-env` namespace of the k3s node, holding the PR's code (the whole worktree is copied up) next to its own databases (swag-server: Postgres, a single-node Mongo replica set and Redis on the pod's localhost, schema built with `alembic upgrade head`; op-console and openim: a Docker daemon for their testcontainers). Nothing is shared between two runs or two reviews, so there is no lock, and any number of reviews run at once. The agent itself stays on your machine: only the test run goes to the node.
  - **Only the run is timed.** The pod waits (`Pending`) until the node has room; that wait is capped by `RV_QUEUE_WAIT` (default 1200 s, so that finding a slot stays inside an agent tool call, which the harness cuts at about 25 minutes) but is not part of any test limit. Environment setup has its own `RV_SETUP_TIMEOUT` (600 s) and the tests `RV_RUN_TIMEOUT` (1500 s), which starts only when the tests start. Exit codes: 124 a timeout, 125 the node or pod could not be used, 123 the PR head moved while waiting; anything else is the command's own.
  - **Nothing is left behind.** The pod is deleted when the command ends, on a signal, and by the node itself after `RV_POD_DEADLINE` (5400 s) if this machine died (`activeDeadlineSeconds`); finished pods are kept an hour for their log and swept by age at the next run (so is a pod whose creator was killed before it was scheduled, the one case the deadline cannot cover). A container that dies while the pod starts is reported with its log instead of waiting forever.
  - **Setup.** Per node, once: the manifests in `homelab/k8s/review-env` (namespace, a low `PriorityClass`, network policies that deny everything but let `rv/net=internet` pods reach only the internet, never the cluster, the LAN or the tailnet), and one runner image per profile built on the node with `K3S_SSH=user@host review-pipeline/k3s/build_image.sh <swag-server|op-console|openim> <checkout> [ref]` (k3s has no registry; rebuild when the checkout's dependencies change; keep docker's copy on the node, because kubelet drops unused images from k3s when the disk passes 85% and each run puts the image back from docker's copy). The Mongo and Postgres images are pulled by the node on first use. `RV_MONGO_IMAGE` overrides the Mongo image; MongoDB 5 and later needs a CPU with AVX, so the VM's CPU type must be `host` (or `x86-64-v3`), not the default `x86-64-v2`.
  - **Security.** The PR's code runs on the node as an unprivileged container with no service account and no network (swag-server), so a test that calls out fails at once instead of hanging. The op-console and openim profiles run a privileged Docker daemon beside the tests, so that code can reach the node's kernel: use them only for authors you would let run code on the node.
  - `REVIEW_ENV=local` keeps the old behaviour (compose stack on this machine, below); its cleanup relies on shell traps, so a `kill -9` of the script still leaves the container for `docker rm -f rvtest-<pid>`. The head check fails open when GitHub cannot be reached, and `123`/`124`/`125` are reserved: a wrapped command that exits with one of them is read as an infrastructure status.
- **Tests take turns (local).** Without `k3sHost`, or with `REVIEW_ENV=local`, `run_pr_tests.sh` (and so `run_tests_rc.sh`) holds `reports/reviews/.tests.lock` while it runs, because every PR's tests share the same `swag_test` databases and redis db 15. A second run waits and says whose turn it is. A lock whose pid is dead, or now belongs to a process that is not a `run_pr_tests.sh` (pids repeat after a reboot), is taken over. Waiting is capped by `TESTS_LOCK_WAIT` seconds (default 1800; exit 2 and the holder named), and is not part of the run: `TESTS_RUN_TIMEOUT` (default 1500) starts once the lock is ours, and a run over it is killed together with its container (`rvtest-<pid>`, exit 124), which is also removed when the script is interrupted. Anything else the rules write outside the checkout is not namespaced: `build_payload.py` and the post guard still use `/tmp/rv/post/<PR>...`, so the same PR number in two repos reviewed at once would collide.
- **A new commit stops the runner.** Gate 00 records the PR head it saw in `evidence/<PR>/gates/head.sha`. `review_step` `start` and `done` of any later step, and every k3s test run (also while it waits in the queue), ask GitHub for the head again (`v2/check_head.sh`); if the author pushed, they stop with `HEAD_MOVED` (exit 5, 123 for the test run) and a note in the UI, so the runner does not go on with a head nobody reviewed. Running step 00 again takes the new head. A check that cannot reach GitHub says nothing and does not stop the review.
- A review that was left half done (agent killed, machine restarted) is resumed, not wiped: the agent is told which steps are done and to redo intake first. `--restart` archives the old progress and starts clean, `--takeover` takes the review over from another Pi.
- The command takes a full PR link such as `https://github.com/swaglive/swag-server/pull/19233`. Run from a PR worktree it still works on the review clone, not the worktree. It refuses a bare number, a link to a repo other than the checkout's, a checkout without rules, a handbook, a reviewer or an `origin`, and a busy agent.
- Set `SWAG_REVIEW_PYTHON` to use a Python other than `python3.12`. Set `REVIEW_PIPELINE_ENGINE` to run another engine directory (the tests do).
- `/review-board` runs it for you inside Pi: it takes the repo from `origin`, the reviewer from `identity.guard.user` and `authorPattern` from `pipeline.json`, so it works in any review checkout without `/review-pr` having run, and it does not need an idle agent. Reload Pi (`/reload`) after updating the package so the command appears.
- `review-pipeline/v2/review_board.py` prints one terminal screen of every open PR the reviewer has reviewed or been asked to review, grouped by the next action: review again (new commit or a dismissed review), not reviewed, new replies since your review, waiting for the author, done. Run it from the review checkout, `python3.12 <engine>/v2/review_board.py` (or `reports/reviews/tools/v2/review_board.py` once `/review-pr` has built the tools). It reads `REPO`, `REVIEWER` and `AUTHOR_PATTERN` from the flags, the environment or `reports/reviews/tools/.pipeline-env`, and only issues GET and search calls. The board keeps no memory of what you or an agent already read, so replies you have seen stay under "new replies" until you review again. `review_board.py --ack N [N ...]` records the newest reply on those PRs in `reports/reviews/.board-ack.json`; a later reply or a new commit brings the PR back. Run it after an agent has gone through the replies.
- The engine's tests: `cd review-pipeline/v2 && python3.12 -m unittest test_gates test_policy test_board`.

With no `pipeline.json` every gate runs with swag-server's policy (release labels, the "Heads up" flag, cross-service evidence, trial blocks). The base branch is `develop` in all of them for now.

## Jev decisions

All three Jev-backed extensions call the [TypeSafe System One API](https://docs.typesafe.ai/api) with model `TYPESAFE_MODEL` (default `jev-latest`). They read `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), and `TYPESAFE_MODEL` from the environment, or from `~/.pi/agent/mcp-env.json` when `TYPESAFE_API_KEY` is unset. To route through OpenRouter, set `TYPESAFE_BASE_URL` to `https://openrouter.ai/api` and use an OpenRouter key. Set `TYPESAFE_API_KEY=` (empty) to disable Jev.

The thresholds were calibrated against Jev 1.13, and the `jev-latest` alias moves when TypeSafe ships a new version. Pin the version with `TYPESAFE_MODEL`, then rerun `bench/` before moving to a newer one. Version IDs differ by provider: `jev-1.13.0` on `api.typesafe.ai`, `typesafe/jev-1.13-20260917` on OpenRouter.

Jev receives the proposed code text, and `test-gaps-on-settle` sends whole test files and the source files they import, so only enable it for code you may send to TypeSafe (and OpenRouter, if used).

## PR review archive

`pr-review-archive` requires authenticated `gh` and the `sqlite3` CLI. Data is stored with user-only permissions at `~/.pi/agent/pi-guardrails/pr-review-archive.sqlite`.

```text
/pr-review-archive sync --repo owner/repo --authors user1,user2 --limit 100
/pr-review-archive show 123
/pr-review-archive search authentication timeout
/pr-review-archive status
```

Only human-authored discussion, review, and inline comments are archived. Terminal control sequences are removed before archived content is displayed.

After each `sync`, newly archived comments of at least 80 characters are handed to the agent as a follow-up message asking it to store the durable ones with `memory_add`, so the guidance stays searchable in later sessions. Comment text is delimited and marked as untrusted data. A per-repository watermark keeps a later `sync` from proposing the same comments again.

## Personal worktree bootstrap

`/worktree-bootstrap` keeps its configuration in the repository's local Git configuration and installs only a local `post-checkout` hook. Neither is tracked or pushed. It does **not** set `core.hooksPath`, so existing Git Identity Guard hooks remain active. For isolation, it refuses setup when `core.hooksPath` is already configured because that directory may be shared by other repositories.

From the canonical worktree that contains your local settings:

```text
/worktree-bootstrap setup .env .env.local .bruno
```

Use a distinct source worktree for a repository when needed:

```text
/worktree-bootstrap setup --source "/path/to/canonical-worktree" .env docker-compose.override.yml
```

Useful commands:

```text
/worktree-bootstrap status
/worktree-bootstrap sync-back
/worktree-bootstrap disable
```

`sync-back` is explicit and copies only changed regular files from the current linked worktree to primary. It stores a SHA-256 baseline per worktree in Git metadata, acquires a common-Git-dir lock, and refuses to overwrite when primary and the worktree both changed the same file. It also reports deletions for manual handling and never removes files automatically.

The hook only copies missing configured paths, rejects absolute/traversal/`.git` paths and symlinked path components, and preserves any existing target file. Git runs `post-checkout` during `git worktree add` unless `--no-checkout` is used.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```

### Jev benchmark

`bench/` holds 150 hand-labeled cases (50 per Jev-backed extension) and a runner that calls the real Jev API through each extension's own handler or `findGaps`:

```bash
node --experimental-strip-types bench/jev-bench.ts              # all three
node --experimental-strip-types bench/jev-bench.ts comment-guard  # or ponytail, test-gaps
node --experimental-strip-types bench/jev-bench.ts "" holdout    # all three on bench/holdout/
```

`bench/holdout/` (16 + 16 + 15 cases) was written before the thresholds and questions were tuned on the main set; use it to check that a change generalizes instead of fitting the main set.

It reads the same TypeSafe settings as the extensions and costs well under $0.01 per full run. `comment-guard` runs with a stub Pi reviewer that always answers `DEFER`, so cases Jev leaves undecided show up as deferred instead of spawning Pi. The `test-gaps` report includes recall and precision for several gap thresholds, computed from the recorded scores.
