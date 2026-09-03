import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const root = mkdtempSync(join(tmpdir(), "pi-pr-review-archive-"));
const fakeBin = join(root, "bin");
const database = join(root, "archive.sqlite");
mkdirSync(fakeBin);
symlinkSync("/bin/sh", join(fakeBin, "gh"));
writeFileSync(
  join(root, "pr"),
  `if [ "$1" = list ]; then
  printf '%s\n' '[{"number":12,"title":"Fix","state":"OPEN","url":"https://github.com/owner/repo/pull/12","author":{"login":"reviewer","type":"User"}}]'
fi
`,
);
writeFileSync(
  join(root, "api"),
  `if [ "\${FAKE_GH_FAIL:-0}" = 1 ]; then echo "simulated gh failure" >&2; exit 1; fi
case "$*" in *'/files?'*) printf '%s\n' '[[{"filename":"src/a.ts","status":"modified","additions":1,"deletions":0,"sha":"abc"}]]' ;; *'/issues/'*'/comments?'*) printf '%s\n' '[[{"id":1,"body":"keep me","html_url":"https://github.com/owner/repo/pull/12#issuecomment-1","user":{"login":"reviewer","type":"User"}}]]' ;; *) printf '%s\n' '[[]]' ;; esac
`,
);
process.chdir(root);
process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
process.env.PI_PR_REVIEW_ARCHIVE_DB = database;

const { default: extension, sanitizeTerminal } = await import(
  `../extensions/pr-review-archive.ts?test=${Date.now()}`
);

test.after(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  delete process.env.PI_PR_REVIEW_ARCHIVE_DB;
  delete process.env.FAKE_GH_FAIL;
  rmSync(root, { recursive: true, force: true });
});

test("syncs review evidence and preserves it when refresh fails", async () => {
  let handler:
    | ((
        args: string,
        ctx: {
          cwd: string;
          hasUI?: boolean;
          ui?: { notify?: (message: string) => void };
        },
      ) => Promise<void>)
    | undefined;
  extension({
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: { cwd: string }) => Promise<void>;
      },
    ) {
      if (name === "pr-review-archive") handler = command.handler;
    },
  });
  assert.ok(handler);

  const notifications: string[] = [];
  const context = {
    cwd: root,
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await handler("sync --repo owner/repo --authors reviewer --limit 1", context);
  assert.match(
    notifications.at(-1) ?? "",
    /Archived 1 PRs and 1 human comments/,
  );
  assert.equal(
    execFileSync("sqlite3", [database, "SELECT body FROM review_comments;"], {
      encoding: "utf8",
    }).trim(),
    "keep me",
  );

  process.env.FAKE_GH_FAIL = "1";
  await handler("sync --repo owner/repo --authors reviewer --limit 1", context);
  assert.match(notifications.at(-1) ?? "", /failed/i);
  assert.equal(
    execFileSync("sqlite3", [database, "SELECT body FROM review_comments;"], {
      encoding: "utf8",
    }).trim(),
    "keep me",
  );
});

test("strips terminal control sequences from archived output", () => {
  assert.equal(
    sanitizeTerminal("\u001b]0;spoof\u0007safe\u001b[31m text\u001b[0m"),
    "safe text",
  );
});
