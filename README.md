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

`/review-pr <GitHub PR link> [--takeover | --restart]` starts or resumes a PR review in the review checkout you are in, and opens a local page (127.0.0.1) that shows which pipeline step the agent is on, what it is doing, and each gate's verdict.

The package ships the engine in `review-pipeline/` (runner, live UI, gates, post guard). Rules are separate, laid out like Pi memory under the agent directory, so nothing is stored in the repo:

```
~/.pi/agent/review-pipeline/
├── global/                       rules shared by every repo
└── projects/-canonical-repository-path/   rules of one repo (same key as ~/.pi/agent/memory/projects)
    └── .project.json             {"root": "<repo path>"}   written by /review-pr when missing
```

A rules folder holds `steps/NN-*.md` (what the agent reads at `start`), `steps/NN-*.rules.md`, `reference/` and `draft_template.md`. **The project folder is looked up first, then global**, so a project overrides a global file and falls back to it for the rest. The command needs `steps/` in at least one of them. `REVIEW_PIPELINE_HOME` replaces `~/.pi/agent/review-pipeline`.

A rules folder can also hold:

- **`pipeline.json`**: the project's policy, merged over the global one. `worktreePrefix` (default `<repo name>-pr-`; the worktree is `../<prefix><PR>`), `gates` (steps with a machine gate, from `00` to `07`; default all, `00` is always on, a step without a gate is recorded as passed with an INFO line and checked by the reviewer), `impactSections` (how many `## ` sections `evidence/<PR>/impact-map.txt` must have, default 8) `draftCheck` (a script in `tools/v2` that replaces the default draft gate) and `authorPattern` (an extended regular expression the PR author must match at gate 00; without it the author is not checked). A typo or a wrong type stops `/review-pr` with a message.
- **`tools/`**: overrides for engine scripts, same layout as the engine (`tools/impact_map.py`, `tools/v2/check_draft_x.py`). The command rebuilds `reports/reviews/tools/` on every run from the engine, then global overrides, then project overrides, as links: it builds a new folder beside the old one and swaps a link, so a review in progress never sees it missing. It also writes `tools/.pipeline-env` (the variables below), which the scripts load when the agent runs them by hand. A real `tools` folder that the command did not create is never touched: move its files into the project's `tools/` first.

Besides the rules, the review checkout needs:

- **A handbook** at the checkout root, `AGENTS.local.md` or `AGENTS.md`. The gates refuse to run without one.
- **`identity.guard.user`** in the checkout's local git config: the GitHub login the gates read as the reviewer (its token, its reviews, its comments).
- **An `origin` remote**: `owner/name` is taken from it, so the gates read that repo. A PR link for another repo is refused.

The command builds `reports/reviews/tools` (rules and scripts address the tools by that path), exports `REPO`, `RV` (the checkout), `HANDBOOK`, `REVIEWER`, `RULES` (the existing rules folders, project first) and the policy (`WT_PREFIX`, `GATES`, `IMPACT_SECTIONS`, `DRAFT_CHECK`, `AUTHOR_PATTERN`) to every pipeline call, shows the step list as a widget in Pi, then hands the agent a kickoff prompt. A real `reports/reviews/tools` directory is never overwritten: move it away first.

- It registers a `review_step` tool the agent calls at each step boundary: `start` returns that step's instructions, `note` shows what it is doing, `done` runs that step's gate and records its verdict.
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
