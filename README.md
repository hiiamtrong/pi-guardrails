# Pi GitHub Write Confirm

A Pi extension that permits GitHub reads and requires an interactive confirmation for GitHub remote writes. It blocks writes when no interactive UI is available.

## Coverage

- Allows known read-only `gh` commands and GET-only `gh api` calls.
- Confirms `gh` mutations, GitHub API POST/PUT/PATCH/DELETE calls, `git push`, and GitHub MCP mutation tools such as review-thread resolution.
- Defaults to confirmation when an action cannot be proven read-only.
- Redacts GitHub tokens from the confirmation preview.

## Install

```bash
pi install git:github.com/hiiamtrong/pi-github-write-confirm
```

Or install from a checkout:

```bash
ln -sf "$PWD/extensions/github-write-confirm.ts" ~/.pi/agent/extensions/github-write-confirm.ts
cp config/github-write-confirm.example.json ~/.pi/agent/github-write-confirm.json
```

Reload Pi with `/reload` or restart it after installation.

## Write allowlist

By default every GitHub write requires confirmation. To bypass confirmation for an explicitly targeted trusted repository, create `~/.pi/agent/github-write-confirm.json`:

```json
{
  "writeAllowlist": [
    "hiiamtrong/example-repo"
  ]
}
```

The extension normalizes repository names case-insensitively. An allowlisted write must identify its repository explicitly, for example `gh repo edit hiiamtrong/example-repo ...`, `gh --repo hiiamtrong/example-repo ...`, a GitHub URL, or MCP `owner`/`repo` input. Unknown targets, including `git push origin` where no GitHub repository is explicit, remain confirmation-gated.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```
