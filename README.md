# Pi GitHub Guards

A Pi package with six workflow and security extensions:

- **`comment-guard`** reviews new code comments, suppressions, and Python future annotations before they are written.
- **`ponytail-review-on-settle`** runs `/skill:ponytail-review` after a turn that edited code, unless the edits were trivial.
- **`github-write-confirm`** permits GitHub reads and requires confirmation for GitHub remote writes.
- **`github-identity-guard-required`** blocks agent-initiated Git/GitHub writes until Git Identity Guard is installed in the current repository.
- **`pr-review-archive`** archives human PR review evidence in a local SQLite database.
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
cp config/github-write-confirm.example.json ~/.pi/agent/github-write-confirm.json
```

Reload Pi with `/reload` or restart it after installation.

## Comment review

`comment-guard` reviews comments in code files before accepting them. It also reviews type/linter suppression comments and `from __future__ import annotations`, and blocks the write if no reviewer can run.

When a TypeSafe key is configured (see [Jev decisions](#jev-decisions)), Jev scores each change first and approves or rejects it only when all scores are confident (≥ 0.8 or ≤ 0.2). Uncertain cases and Jev failures fall back to the read-only Pi reviewer.

## Ponytail review on settle

`ponytail-review-on-settle` sends `/skill:ponytail-review` once a turn settles after editing code files. With Jev configured, it first sends each edit's `before`/`after` text and skips the review when Jev is at least 0.8 confident the edits only change wording, names, formatting, or literal values. Jev failures and changes over 60,000 characters always get reviewed.

## Jev decisions

Both extensions call the [TypeSafe System One API](https://docs.typesafe.ai/api) with model `jev-latest`. They read `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) from the environment, or from `~/.pi/agent/mcp-env.json` when `TYPESAFE_API_KEY` is unset. To route through OpenRouter, set `TYPESAFE_BASE_URL` to `https://openrouter.ai/api` and use an OpenRouter key. Set `TYPESAFE_API_KEY=` (empty) to disable Jev.

Jev receives the proposed code text, so only enable it for code you may send to TypeSafe (and OpenRouter, if used).

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
