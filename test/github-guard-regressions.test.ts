import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "github-guard-regressions-"));
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({ writeAllowlist: ["hiiamtrong/allowed-repo"] }));
process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG = configPath;
process.env.PI_GITHUB_WRITE_CONFIRM_NOTIFY = "0";
const confirm = await import(`../extensions/github-write-confirm.ts?regressions=${Date.now()}`);
const identity = await import(`../extensions/github-identity-guard-required.ts?regressions=${Date.now()}`);

after(() => rmSync(dir, { recursive: true, force: true }));

type Event = { toolName: string; input: Record<string, unknown> };
const bash = (command: string): Event => ({ toolName: "bash", input: { command } });
const ctx = (language: string, code: string): Event => ({ toolName: "ctx_execute", input: { language, code } });
const asks = (event: Event) => confirm.githubWriteReason(event) !== undefined;

test("does not ask about text, comments and local-only commands", () => {
    for (const command of [
        "echo 'remember to git push later'",
        "echo ok # git push",
        "echo ok # a; git push",
        "gh pr view #12",
        "alias gp='git push'; gp",
        "cat > note.md <<'EOF'\nwe will git push after review\ngh pr merge 1 once approved\nEOF",
        "cat > note.md <<EOF\ngh issue create is blocked here\nEOF",
        "git commit -F - <<'EOF'\nmention git push in the message\nEOF",
        "which -a gh; grep -il 'gh auth token' ~/.pi/agent/bin/* | head; gh auth status 2>&1 | grep -i account",
        "grep -rn gh docs/ | head",
        "command -v gh",
        "sed -n 1,5p <(gh api repos/o/r/pulls/1 --jq .title)",
        "gh api repos/o/r/pulls/1 --jq .body | diff - body.txt | head -5",
        "git push --dry-run origin main",
        "git push -n",
        "gh pr checkout 5",
        "timeout 30 gh pr view 1",
        `curl -s https://api.github.com/graphql -d '{"query":"{viewer{login}}"}'`,
    ])
        assert.equal(asks(bash(command)), false, command);
});

test("still asks for writes that are written indirectly", () => {
    for (const command of [
        "sh -c 'git push origin main'",
        `eval "gh pr merge 1"`,
        "g=gh; $g pr merge 1",
        "V=push; git $V",
        "g='git push'; $g origin main",
        "$(which git) push",
        "`which gh` pr merge 1",
        "git \\\n  push origin main",
        "git push \\\n  origin main",
        "timeout 30 git push",
        "stdbuf -oL git push",
        "setsid git push",
        "echo 'git push origin main' | sh",
        "echo 'gh pr merge 1' | bash",
        "bash <<< 'git push origin main'",
        "bash <<'EOF'\ngit push origin main\nEOF",
        "cat <<EOF\n$(git push origin main)\nEOF",
        "python3 -c \"import subprocess; subprocess.run(['git','push'])\"",
        "node -e \"require('child_process').execSync('gh pr merge 1')\"",
        "perl -e 'system(\"git push\")'",
        "ruby -e 'system(\"gh pr merge 1\")'",
        "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git','push'])\nPY",
        "python3 -c \"import requests;requests.post('https://api.github.com/repos/o/r/issues',json={})\"",
        "gh pr view 1; curl -X POST https://api.github.com/repos/o/r/issues -d '{}'",
        "curl -s https://api.github.com/repos/o/r && gh pr merge 1",
    ])
        assert.equal(asks(bash(command)), true, command);
});

test("sees the write after a heredoc whose text holds an odd number of quotes", () => {
    const command = "cat > body.md <<'EOF'\nit's a fix, don't merge yet\nEOF\ngh pr create --body-file body.md";
    assert.equal(asks(bash(command)), true);
    assert.equal(confirm.guardedGitAction("cat > m.txt <<'EOF'\nit's here\nEOF\ngit commit -F m.txt"), "git commit");
});

test("treats ctx_execute code as a GitHub call only when it makes one", () => {
    assert.equal(asks(ctx("python", `print(open("README.md").read().replace("a", "https://github.com/o/r"))`)), false);
    assert.equal(asks(ctx("python", `import urllib.request\nprint(urllib.request.urlopen("https://api.github.com/repos/o/r").read())`)), false);
    assert.equal(asks(ctx("python", `import requests\nprint(requests.get("https://api.github.com/repos/o/r/pulls").json())`)), false);
    assert.equal(asks(ctx("javascript", `console.log(await (await fetch("https://api.github.com/repos/o/r")).json())`)), false);
    assert.equal(asks(ctx("python", `import requests\nrequests.post("https://api.github.com/repos/o/r/issues", json={})`)), true);
    assert.equal(asks(ctx("python", `import subprocess as sp\nsp.run(["gh","pr","merge"])`)), true);
    assert.equal(asks(ctx("python", `from subprocess import run\nrun(["git","push"])`)), true);
    assert.equal(asks(ctx("python", `from github import Github\nGithub("t").get_repo("o/r").create_issue("x")`)), true);
    assert.equal(asks(ctx("javascript", `const { Octokit } = require("@octokit/rest"); await new Octokit().issues.create({})`)), true);
});

test("treats the adapter proxy and gh-named tools as GitHub MCP calls", () => {
    assert.equal(asks({ toolName: "mcp", input: { server: "github", tool: "create_issue" } }), true);
    assert.equal(asks({ toolName: "mcp", input: { server: "github", tool: "get_issue" } }), false);
    assert.equal(asks({ toolName: "mcp", input: { server: "jira", tool: "create_issue" } }), false);
    assert.equal(asks({ toolName: "gh_create_issue", input: {} }), true);
    assert.equal(asks({ toolName: "mcp__custom-tools__mcp__github", input: { tool: "get_issue" } }), false);
    assert.equal(asks({ toolName: "mcp__custom-tools__mcp__github", input: { tool: "create_issue" } }), true);
});

test("guards commits, history rewrites and wrapped or indirect forms, but not dry runs or aborts", () => {
    for (const command of [
        "git commit -m x",
        "git -c user.name=x -c user.email=y commit -m z",
        "git merge feature",
        "git rebase main",
        "git rebase --continue",
        "git cherry-pick abc123",
        "git revert HEAD",
        "git am patch.mbox",
        "G='git -c user.name=x'; $G commit -m y",
        "timeout 30 git commit -m x",
        "python3 -c \"import subprocess; subprocess.run(['git','commit','-m','x'])\"",
    ])
        assert.notEqual(confirm.guardedGitAction(command), undefined, command);
    for (const command of [
        "git commit --dry-run",
        "git push --dry-run",
        "git push -n origin main",
        "git merge --abort",
        "git rebase --abort",
        "git cherry-pick --quit",
        "git merge --ff-only origin/main",
        "git merge --no-commit feature",
        "git merge-base HEAD main",
        "echo 'git commit -m x'",
        "cat > m.sh <<'EOF'\ngit commit -m x\nEOF",
    ])
        assert.equal(confirm.guardedGitAction(command), undefined, command);
});

function gate() {
    let handler: (event: Event, ctx: unknown) => Promise<{ block: true } | undefined>;
    confirm.default({ on: (_name: string, callback: typeof handler) => (handler = callback) });
    return async (event: Event) => (await handler(event, { hasUI: false, ui: {} }))?.block === true;
}

test("an allowlisted repository skips the prompt only when every write in the call is allowlisted", async () => {
    const blocked = gate();
    const ok = "gh issue comment 1 -R hiiamtrong/allowed-repo -b x";
    assert.equal(await blocked(bash(ok)), false);
    assert.equal(await blocked(bash(`${ok} && gh issue close 2 -R hiiamtrong/allowed-repo`)), false);
    assert.equal(await blocked(bash("gh api repos/hiiamtrong/allowed-repo/issues -f title=x")), false);
    for (const command of [
        `${ok} && gh pr merge 2 -R victim/r`,
        `gh pr merge 2 -R victim/r && ${ok}`,
        `${ok}; gh repo delete victim/r --yes`,
        `${ok} && git push origin main`,
        `${ok} && curl -X POST https://api.github.com/repos/victim/r/issues -d '{}'`,
        "gh api repos/hiiamtrong/allowed-repo/issues -f title=x; gh api -X DELETE repos/victim/r",
        "gh issue comment 1 -R hiiamtrong/allowed-repo-evil -b x",
        "gh issue comment 1 -R evil/allowed-repo -b x",
        "gh issue comment 1 -b x",
        `python3 -c "import subprocess; subprocess.run(['gh','pr','merge','1'])" # -R hiiamtrong/allowed-repo`,
    ])
        assert.equal(await blocked(bash(command)), true, command);
    const batch = (...commands: string[]): Event => ({ toolName: "ctx_batch_execute", input: { commands: commands.map((command) => ({ label: "x", command })) } });
    assert.equal(await blocked(batch(ok, "gh pr merge 2 -R victim/r")), true);
    assert.equal(await blocked(batch(ok, "gh pr view 3 -R victim/r")), false);
});

test("the identity guard blocks a commit hidden behind a heredoc, a variable or the adapter proxy", () => {
    const repo = mkdtempSync(join(dir, "repo-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    type Handler = (event: Event, ctx: { cwd: string }) => { block: true; reason: string } | undefined;
    let found: Handler | undefined;
    identity.default({ on: (_name: string, callback: Handler) => (found = callback) });
    assert.ok(found);
    const handler: Handler = found;
    for (const event of [
        bash("cat > m.txt <<'EOF'\nit's here\nEOF\ngit commit -F m.txt"),
        bash("G='git -c user.name=x'; $G commit -m y"),
        bash("git merge feature"),
        bash("python3 -c \"import subprocess; subprocess.run(['git','commit','-m','x'])\""),
        { toolName: "mcp", input: { server: "github", tool: "create_issue" } },
    ])
        assert.equal(handler(event, { cwd: repo })?.block, true, JSON.stringify(event));
    for (const event of [bash("git commit --dry-run"), bash("git merge --abort"), bash("echo 'git commit -m x'")])
        assert.equal(handler(event, { cwd: repo }), undefined, JSON.stringify(event));
});

type IdentityHandler = (event: Event, ctx: { cwd: string }) => { block: true; reason: string } | undefined;
function identityHandler(): IdentityHandler {
    let found: IdentityHandler | undefined;
    identity.default({ on: (_name: string, callback: IdentityHandler) => (found = callback) });
    assert.ok(found);
    return found;
}

test("empty, missing and wrongly typed input is quiet, not an error", () => {
    for (const event of [
        { toolName: "bash", input: { command: "" } },
        { toolName: "bash", input: { command: "  \n ; | " } },
        { toolName: "bash", input: { command: 5 } },
        { toolName: "bash" },
        { input: { command: "git push" } },
        { toolName: "ctx_batch_execute", input: { commands: [] } },
        { toolName: "ctx_execute", input: { language: "python" } },
        bash('python3 -c ""'),
        bash("cat <<'EOF'\nEOF"),
    ])
        assert.equal(confirm.githubWriteReason(event), undefined, JSON.stringify(event));
    assert.equal(confirm.guardedGitAction(""), undefined);
    assert.equal(confirm.githubMcpToolName({ toolName: "mcp", input: { server: "github", tool: 5 } }), "github_list");
    assert.equal(identityHandler()({ toolName: "bash" } as Event, { cwd: dir }), undefined);
});

test("null entries in a batch do not hide the commands around them", () => {
    const commands = [null, { command: 5 }, { command: "gh pr merge 1" }];
    assert.notEqual(confirm.githubWriteReason({ toolName: "ctx_batch_execute", input: { commands } }), undefined);
    const repo = mkdtempSync(join(dir, "batch-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    const event = { toolName: "ctx_batch_execute", input: { commands: [null, { command: "git commit -m x" }] } };
    assert.equal(identityHandler()(event, { cwd: repo })?.block, true);
});

test("malformed commands get the safe answer", () => {
    for (const command of [`curl -d '{"query": ' https://api.github.com/graphql`, "gh issue comment 1 -R", "echo $(gh pr merge 1"])
        assert.equal(asks(bash(command)), true, command);
});

test("a `<<` without a closing line is not a heredoc and hides nothing", () => {
    for (const command of [
        "cat <<EOF\nhello\ngit push origin main",
        "x=$((1<<4))\ngit push origin main",
        'echo "shift a << b"\ngh pr merge 1',
        "echo $((1<<2)); git push",
    ])
        assert.equal(asks(bash(command)), true, command);
    assert.equal(asks(bash("x=$((1<<4))\necho done")), false);
});

test("versioned interpreters run their inline code and heredocs like the plain ones", () => {
    for (const command of [
        "python3.12 - <<'PY'\nimport subprocess\nsubprocess.run(['gh','pr','merge','1'])\nPY",
        "python3.12 -I -c \"import subprocess; subprocess.run(['git','push'])\"",
        "node18 -e \"require('child_process').execSync('gh pr merge 1')\"",
        "perl5.34 -e 'system(\"git push\")'",
    ])
        assert.equal(asks(bash(command)), true, command);
    assert.equal(asks(bash("python3.12 -c \"print('git push')\"")), false);
    assert.notEqual(confirm.guardedGitAction("python3.12 -c \"import subprocess; subprocess.run(['git','commit','-m','x'])\""), undefined);
});

test("a script that only writes review text is not a GitHub call, even if the text says requests or fetch", () => {
    const heredoc = (body: string) => `cd reports && python3.12 - <<'PY'\n${body}\nopen('r.md', 'w').write(body)\nPY`;
    for (const body of [
        "body = '''PR: https://github.com/o/r/pull/1\nThe handler requests a token twice.'''",
        "body = '''see https://github.com/o/r and the urllib docs'''",
        "body = '''PR https://github.com/o/r: call fetch (twice) here, then httpx. Done'''",
    ])
        assert.equal(asks(bash(heredoc(body))), false, body);
    assert.equal(asks(bash(heredoc("import requests\nrequests.post('https://api.github.com/repos/o/r/issues', json={})"))), true);
});

test("a GitHub write through any HTTP client is asked about, not only through the well-known ones", () => {
    const url = "https://api.github.com/repos/o/r/issues";
    const writes: [string, string][] = [
        ["python", `import urllib.request\nurllib.request.urlopen('${url}', b'{"title":"x"}')`],
        ["python", `import urllib.request\nurllib.request.urlopen(urllib.request.Request('${url}', b'{}'))`],
        ["python", `import urllib3\nurllib3.PoolManager().request('POST', '${url}', body=b'{}')`],
        ["python", `import http.client\nc = http.client.HTTPSConnection('api.github.com')\nc.request('POST', '/repos/o/r/issues', '{}')`],
        ["python", `import pycurl\nc = pycurl.Curl()\nc.setopt(c.URL, '${url}')\nc.setopt(c.POST, 1)\nc.perform()`],
        ["javascript", `const got = require('got');\nawait got.post('${url}', { json: {} })`],
        ["javascript", `await require('superagent').post('${url}').send({})`],
        ["ruby", `HTTParty.post('${url}', body: {}.to_json)`],
    ];
    for (const [language, code] of writes) assert.equal(asks(ctx(language, code)), true, code);
    assert.equal(asks(bash(`python3.12 -c "import urllib3; urllib3.PoolManager().request('POST', '${url}')"`)), true);

    const reads: [string, string][] = [
        ["python", `import requests\nprint(requests.get('${url}').json())`],
        ["python", `import urllib.request\nprint(urllib.request.urlopen(urllib.request.Request('${url}', headers={'Accept': 'x'})).read())`],
        ["javascript", `console.log(await (await fetch('${url}')).json())`],
        ["python", `print('api.github.com is the host')`],
    ];
    for (const [language, code] of reads) assert.equal(asks(ctx(language, code)), false, code);
});

test("a GitHub write through an aliased or bare-imported HTTP client is asked about", () => {
    const url = "https://api.github.com/repos/o/r";
    const writes: [string, string][] = [
        ["python", `import requests as r\nr.delete('${url}')`],
        ["python", `import requests as r\nr.request('POST', '${url}/issues', json={})`],
        ["python", `from requests import post\npost('${url}/issues', json={})`],
        ["python", `from requests import delete\ndelete('${url}')`],
        ["python", `import httpx as h\nh.delete('${url}')`],
        ["javascript", `import a from 'axios'\nawait a.delete('${url}')`],
    ];
    for (const [language, code] of writes) assert.equal(asks(ctx(language, code)), true, code);

    const reads: [string, string][] = [
        ["python", `import requests as r\nprint(r.get('${url}').json())`],
        ["javascript", `const m = new Map();\nm.delete('x');\nconst u = '${url}';`],
    ];
    for (const [language, code] of reads) assert.equal(asks(ctx(language, code)), false, code);
});

test("a read that stores its result in a variable called data or body is still a read", () => {
    for (const code of [
        "import requests\ndata = requests.get('https://api.github.com/repos/o/r').json()",
        "import requests\nbody = requests.get('https://api.github.com/repos/o/r').text",
        "import urllib.request\njson = urllib.request.urlopen('https://api.github.com/repos/o/r').read()",
    ])
        assert.equal(asks(ctx("python", code)), false, code);
    for (const code of [
        "import requests\nrequests.get('https://api.github.com/repos/o/r', data=x)",
        "import requests\nrequests.get('https://api.github.com/repos/o/r',\n    json=x)",
        "fetch('https://api.github.com/repos/o/r', { body: x })",
    ])
        assert.equal(asks(ctx("python", code)), true, code);
    assert.equal(asks(ctx("javascript", "const data = await (await fetch('https://api.github.com/repos/o/r')).json()")), false);
});

test("a variable set with local, declare or readonly is read like one set with export", () => {
    for (const command of [
        "local g=gh; $g pr merge 1",
        "declare g=gh; $g pr merge 1",
        "declare -x g=gh; $g pr merge 1",
        "readonly g=git; $g push",
        "typeset g=gh; $g pr merge 1",
    ])
        assert.equal(asks(bash(command)), true, command);
    assert.equal(asks(bash("local g=echo; $g pr merge 1")), false);
});

test("a variable is read as of the point where it is used", () => {
    for (const command of ["g=gh; $g pr merge 1; g=echo", "g=echo; $g hi; g=gh; $g pr merge 1", "g=git; $g push; g=ls"])
        assert.equal(asks(bash(command)), true, command);
    assert.equal(asks(bash("g=gh; g=echo; $g pr merge 1")), false);
});

test("an allowlisted URL inside text the user wrote does not pick the repository", async () => {
    const blocked = gate();
    for (const command of [
        "gh issue comment 1 --body 'see https://github.com/hiiamtrong/allowed-repo/issues/1'",
        "gh issue comment 1 --body https://github.com/hiiamtrong/allowed-repo/issues/1",
        "gh issue comment 1 --body=https://github.com/hiiamtrong/allowed-repo/issues/1",
        "gh issue comment 1 -b https://github.com/hiiamtrong/allowed-repo",
        "gh api repos/victim/r/issues/1/comments -f body=https://github.com/hiiamtrong/allowed-repo",
        "gh pr create --title https://github.com/hiiamtrong/allowed-repo --body x",
    ])
        assert.equal(await blocked(bash(command)), true, command);
    assert.equal(await blocked(bash("gh pr edit https://github.com/hiiamtrong/allowed-repo/pull/3 --title x")), false);
});

test("a missing or broken allowlist file falls back to asking", async () => {
    const saved = process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG;
    const cases: [string, string | undefined][] = [
        ["missing", undefined],
        ["broken", "{not json"],
        ["wrong-type", JSON.stringify({ writeAllowlist: "hiiamtrong/allowed-repo" })],
    ];
    for (const [name, content] of cases) {
        const file = join(dir, `config-${name}.json`);
        if (content !== undefined) writeFileSync(file, content);
        process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG = file;
        const fresh = await import(`../extensions/github-write-confirm.ts?config=${name}-${Date.now()}`);
        process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG = saved;
        let handler: ((event: Event, ctx: unknown) => Promise<{ block: true } | undefined>) | undefined;
        fresh.default({ on: (_name: string, callback: typeof handler) => (handler = callback) });
        assert.ok(handler);
        const result = await handler(bash("gh issue comment 1 -R hiiamtrong/allowed-repo -b x"), { hasUI: false, ui: {} });
        assert.equal(result?.block, true, name);
    }
});

test("the identity guard blocks, not crashes, when the directory or the runner is unusable", () => {
    const handler = identityHandler();
    assert.equal(handler(bash("git commit -m x"), { cwd: join(dir, "does-not-exist") })?.block, true);
    const repo = mkdtempSync(join(dir, "broken-runner-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    for (const [key, value] of [["user", "u"], ["email", "u@example.com"], ["runner", join(dir, "no-such-runner")]])
        execFileSync("git", ["-C", repo, "config", `identity.guard.${key}`, value], { stdio: "ignore" });
    assert.match(handler(bash("git commit -m x"), { cwd: repo })?.reason ?? "", /Install Git Identity Guard/);
});
