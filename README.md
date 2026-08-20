# Pi GitHub Guards

A Pi package with two security extensions:

- **`github-write-confirm`** permits GitHub reads and requires confirmation for GitHub remote writes.
- **`github-identity-guard-required`** blocks agent-initiated `git commit` and `git push` until Git Identity Guard is installed in the current repository.

Both extensions fail closed when the required condition cannot be verified.

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

`github-identity-guard-required` checks agent `bash` calls for `git commit` and `git push`. If the working repository lacks a configured Git Identity Guard runner, it blocks the command; it never installs a guard implicitly.

Install Git Identity Guard in each repository before committing or pushing. Use the installer supplied by your Git Identity Guard plugin:

```bash
/path/to/git-identity-guard install \
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
ln -sf "$PWD/extensions/github-write-confirm.ts" ~/.pi/agent/extensions/github-write-confirm.ts
ln -sf "$PWD/extensions/github-identity-guard-required.ts" ~/.pi/agent/extensions/github-identity-guard-required.ts
cp config/github-write-confirm.example.json ~/.pi/agent/github-write-confirm.json
```

Reload Pi with `/reload` or restart it after installation.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```
