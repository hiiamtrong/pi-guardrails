# Pi GitHub Guards

A Pi package with five workflow and security extensions:

- **`comment-guard`** reviews new code comments, suppressions, and Python future annotations before they are written.
- **`github-write-confirm`** permits GitHub reads and requires confirmation for GitHub remote writes.
- **`github-identity-guard-required`** blocks agent-initiated Git/GitHub writes until Git Identity Guard is installed in the current repository.
- **`pr-review-archive`** archives human PR review evidence in a local SQLite database.
- **`worktree-bootstrap`** configures a personal, per-repository `post-checkout` bootstrap hook that copies selected ignored files into new Git worktrees.

The GitHub write and identity gates fail closed when the required condition cannot be verified.

## GitHub write confirmation

- Allows known read-only `gh` commands and GET-only `gh api` calls.
- Confirms `gh` mutations, GitHub API POST/PUT/PATCH/DELETE calls, `git push`, and GitHub MCP mutation tools such as review-thread resolution.
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
cp config/github-write-confirm.example.json ~/.pi/agent/github-write-confirm.json
```

Reload Pi with `/reload` or restart it after installation.

## Comment review

`comment-guard` invokes a read-only Pi reviewer before accepting comments in code files. It also reviews type/linter suppression comments and `from __future__ import annotations`, and blocks the write if the reviewer cannot run.

## PR review archive

`pr-review-archive` requires authenticated `gh` and the `sqlite3` CLI. Data is stored with user-only permissions at `~/.pi/agent/pi-guardrails/pr-review-archive.sqlite`.

```text
/pr-review-archive sync --repo owner/repo --authors user1,user2 --limit 100
/pr-review-archive show 123
/pr-review-archive search authentication timeout
/pr-review-archive status
```

Only human-authored discussion, review, and inline comments are archived. Terminal control sequences are removed before archived content is displayed.

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
