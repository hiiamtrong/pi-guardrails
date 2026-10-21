# Pi Claude-style Memory

Private file-based memory for Pi, modeled after Claude Code Auto Memory.

## Layout

```text
~/.pi/agent/memory/
├── global/
│   ├── MEMORY.md
│   └── <topic>.md
└── projects/
    └── -canonical-repository-path/
        ├── .project.json
        ├── MEMORY.md
        ├── <topic>.md
        └── skills/
```

`MEMORY.md` is processed on every turn up to 200 lines or 25 KiB, but only an opaque type/hash topic manifest is injected. Model-authored titles, summaries, and topic bodies stay retrieval-only to avoid persistent system-prompt injection. Topic files have no 5,000-character total-memory cap and are loaded with `memory_search` / `memory_read` only when relevant.

Project identity uses the canonical Git root. Linked worktrees resolve through `.git` + `commondir` to the main repository, and `.project.json` prevents collisions between paths that encode to the same directory name. Non-Git directories use their canonical absolute path.

## Tools

- `memory_add`: save global/user/failure or current-project memory and report same-type lexical near-duplicates (80% word overlap). Optionally set `refs` (project scope only) to project-relative files the memory depends on; each ref's SHA-256 is captured at save time.
- `memory_merge`: after the agent reads both candidates and confirms semantic redundancy, replace the canonical topic with merged content and remove the redundant topic. Refs carry forward re-hashed unless replaced explicitly.
- `memory_search`: search global and current-project topics; results flag `stale: true` when any ref's file no longer matches its stored hash.
- `memory_read`: read one topic; appends a `[stale refs]` note when a ref's file has changed or gone missing.
- `/memory status`: show paths and index limits.
- `/memory check-refs`: scan the current project store and list every topic with at least one stale ref.

Writes scan every persisted field for common credential formats, create private files (`0600`) and directories (`0700`), and refuse symlink or hardlinked index/skill destinations. Near-duplicate scoring only proposes candidates; the agent must read both and explicitly merge them, so lexical similarity never silently deletes information. Mutation reads fail closed above a 1 MiB index or 1,000-file source-dedup scan; topic bodies still have no per-memory character cap. Ref paths must resolve inside the project root (max 20 per topic, 5 MiB per file); staleness is checked lazily on read/search, never automatically rewritten. All memory reads, writes, injection, and skill discovery are disabled in untrusted directories.

## Hermes migration

Dry run:

```sh
node --experimental-strip-types migrate-hermes.mjs
```

Apply:

```sh
node --experimental-strip-types migrate-hermes.mjs --apply
```

The migration reads but never deletes `pi-hermes-memory/` or `projects-memory/`. It converts each `§`-separated entry into a topic, builds indexes, maps legacy project basenames to unique canonical paths found in Pi session headers, preserves project skills, and writes a JSON report under `~/.pi/agent/memory/`.

## Claude Code migration

Dry run, then apply:

```sh
node --experimental-strip-types migrate-claude.mjs
node --experimental-strip-types migrate-claude.mjs --apply
```

Each Claude topic and a lossless `MEMORY.md` snapshot become retrieval-only project topics. Projects are activated only from an exact full encoded path or a structured `cwd` in that Claude project’s session data. Ambiguous, old-home, and unmapped projects are copied to `~/.pi/agent/memory/unresolved-claude-projects/` without guessing an identity. Claude source files are never modified or deleted.

## Test

```sh
npm test
```
