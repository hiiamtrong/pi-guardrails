import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ToolCallEvent = {
    toolName?: unknown;
    input?: Record<string, unknown> & {
        command?: unknown;
        code?: unknown;
        language?: unknown;
    };
};
type ToolCallResult = { block: true; reason: string } | undefined;
type ToolHandler = (
    event: ToolCallEvent,
    ctx: {
        hasUI: boolean;
        ui: { confirm: (title: string, message: string) => Promise<boolean> };
    },
) => Promise<ToolCallResult>;
type GateOptions = { hasUI?: boolean; confirmed?: boolean };

const configDir = mkdtempSync(join(tmpdir(), "pi-github-write-confirm-"));
const configPath = join(configDir, "config.json");
writeFileSync(
    configPath,
    JSON.stringify({ writeAllowlist: ["hiiamtrong/allowed-repo"] }),
);
process.env.PI_GITHUB_WRITE_CONFIRM_CONFIG = configPath;
const { default: extension } = await import(
    `../extensions/github-write-confirm.ts?test=${Date.now()}`
);

test.after(() => rmSync(configDir, { recursive: true, force: true }));

function createGate({ hasUI = true, confirmed = true }: GateOptions = {}) {
    let handler: ToolHandler | undefined;
    let confirms = 0;
    let confirmation: { title: string; message: string } | undefined;
    extension({
        on(event: "tool_call", callback: ToolHandler) {
            if (event === "tool_call") handler = callback;
        },
    });
    return {
        async run(event: ToolCallEvent) {
            assert.ok(handler, "extension must register a tool_call handler");
            const result = await handler(event, {
                hasUI,
                ui: {
                    async confirm(title, message) {
                        confirms += 1;
                        confirmation = { title, message };
                        return confirmed;
                    },
                },
            });
            return { result, confirms, confirmation };
        },
    };
}

test("permits GitHub reads without confirmation", async () => {
    const gate = createGate();
    const { result, confirms } = await gate.run({
        toolName: "bash",
        input: { command: "gh repo view hiiamtrong/demo --json name" },
    });
    assert.equal(result, undefined);
    assert.equal(confirms, 0);
});

test("ignores local paths that contain GitHub names", async () => {
    const gate = createGate();
    for (const command of [
        "git add plugins/git-identity-guard/bin/gh",
        'cd ~/.pi/agent/git/github.com/example/tool && rg -n "security" tests | head -120',
        "env echo /tmp/gh",
        'echo "note; gh pr merge 12"',
    ]) {
        const { result, confirms } = await gate.run({
            toolName: "bash",
            input: { command },
        });
        assert.equal(result, undefined);
        assert.equal(confirms, 0);
    }
});

test("ignores local GitHub paths in ctx_execute code", async () => {
    const gate = createGate();
    const { result, confirms } = await gate.run({
        toolName: "ctx_execute",
        input: {
            code: "readFileSync('/tmp/github.com/example/tool/README.md', 'utf8')",
        },
    });
    assert.equal(result, undefined);
    assert.equal(confirms, 0);
});

test("permits GitHub HTTP reads without confirmation", async () => {
    const gate = createGate();
    for (const command of [
        "curl https://api.github.com/user",
        "http GET api.github.com/user",
        "http api.github.com/user page==2",
    ]) {
        const { result, confirms } = await gate.run({
            toolName: "bash",
            input: { command },
        });
        assert.equal(result, undefined);
        assert.equal(confirms, 0);
    }
});

test("permits GitHub API GET requests with output formatting", async () => {
    const gate = createGate();
    for (const command of [
        "gh api repos/swaglive/swag-server/pulls/18459/comments --paginate --jq '.[] | .id'",
        "gh api user -X GET -f page=1",
        "gh pr --repo swaglive/swag-server view 18459",
        "gh issue create --help",
    ]) {
        const { result, confirms } = await gate.run({
            toolName: "bash",
            input: { command },
        });
        assert.equal(result, undefined);
        assert.equal(confirms, 0);
    }
});

test("confirms GitHub writes and blocks them without UI", async () => {
    for (const command of [
        "gh pr merge 12 --merge",
        "FOO=1 gh pr merge 12",
        "time -p gh pr merge 12",
        "time -o /tmp/time.log gh pr merge 12",
        "env -C /tmp gh pr merge 12",
        "env -S 'gh pr merge 12'",
        "env --split-string='gh pr merge 12'",
        "if gh pr merge 12; then :; fi",
        "gh repo view hiiamtrong/demo; gh pr merge 12",
        "gh extension exec mutator repo view",
        "gh issue create --title test --body --help",
        ">/tmp/out /usr/bin/gh pr merge 12",
    ]) {
        const rejected = await createGate({ confirmed: false }).run({
            toolName: "bash",
            input: { command },
        });
        assert.equal(rejected.confirms, 1);
        assert.ok(rejected.result);
        assert.equal(rejected.result.block, true);
    }

    const nonInteractive = createGate({ hasUI: false });
    const blocked = await nonInteractive.run({
        toolName: "bash",
        input: { command: "gh api graphql -f query=mutation" },
    });
    assert.equal(blocked.confirms, 0);
    assert.ok(blocked.result);
    assert.equal(blocked.result.block, true);
});

test("confirms GitHub HTTP writes", async () => {
    for (const command of [
        "curl -dfoo https://api.github.com/repos/example/demo/issues",
        "curl --json '{}' https://api.github.com/repos/example/demo/issues",
        "curl --data-urlencode title=x https://api.github.com/repos/example/demo/issues",
        "curl --form-string title=x https://api.github.com/repos/example/demo/issues",
        "curl -T release.zip https://uploads.github.com/repos/example/demo/releases/1/assets",
        "wget --post-data body https://api.github.com/repos/example/demo/issues",
        "http POST api.github.com/repos/example/demo/issues title=test",
    ]) {
        const { result, confirms } = await createGate({ confirmed: false }).run(
            {
                toolName: "bash",
                input: { command },
            },
        );
        assert.equal(confirms, 1, command);
        assert.ok(result, command);
        assert.equal(result.block, true);
    }
});

test("confirms GitHub MCP review-thread resolution", async () => {
    const gate = createGate();
    const { result, confirms } = await gate.run({
        toolName: "mcp__github__resolve_review_thread",
        input: {},
    });
    assert.equal(result, undefined);
    assert.equal(confirms, 1);
});

test("confirms ctx_execute GitHub commands because their effects cannot be proven read-only", async () => {
    for (const code of [
        "execFileSync('gh', ['pr', 'comment', '12', '--body', 'hello'])",
        "execFileSync('/usr/bin/gh', ['pr', 'merge', '12'])",
        "execSync('gh pr merge 12')",
        "subprocess.run(['gh', 'pr', 'merge', '12'])",
        "subprocess.run('gh pr merge 12', shell=True)",
        "os.system('gh pr merge 12')",
        "execSync('git push origin main')",
    ]) {
        const { result, confirms } = await createGate({ confirmed: false }).run(
            {
                toolName: "ctx_execute",
                input: { code },
            },
        );
        assert.equal(confirms, 1);
        assert.ok(result);
        assert.equal(result.block, true);
    }
});

test("classifies raw shell ctx_execute code", async () => {
    const write = await createGate({ confirmed: false }).run({
        toolName: "ctx_execute",
        input: { language: "shell", code: "gh pr merge 12" },
    });
    assert.equal(write.confirms, 1);
    assert.ok(write.result);

    const read = await createGate().run({
        toolName: "ctx_execute",
        input: { language: "shell", code: "gh pr view 12" },
    });
    assert.equal(read.confirms, 0);
    assert.equal(read.result, undefined);
});

test("shows the ctx_execute code in the confirmation prompt", async () => {
    const gate = createGate({ confirmed: false });
    const code =
        "execFileSync('gh', ['pr', 'comment', '12', '--body', 'hello'])";
    const { confirmation } = await gate.run({
        toolName: "ctx_execute",
        input: { code },
    });
    assert.equal(confirmation?.title, "GitHub write confirmation");
    assert.match(confirmation?.message ?? "", /Code:\n/);
    assert.match(confirmation?.message ?? "", /gh', \['pr', 'comment'/);
});

test("blocks ctx_execute GitHub commands without UI", async () => {
    const gate = createGate({ hasUI: false });
    const { result, confirms } = await gate.run({
        toolName: "ctx_execute",
        input: {
            code: "execFileSync('gh', ['repo', 'view', 'hiiamtrong/demo'])",
        },
    });
    assert.equal(confirms, 0);
    assert.ok(result);
    assert.equal(result.block, true);
});

test("permits read-only GitHub commands in ctx_batch_execute", async () => {
    const gate = createGate();
    const { result, confirms } = await gate.run({
        toolName: "ctx_batch_execute",
        input: {
            commands: [
                { command: "gh pr view 18459 --repo swaglive/swag-server" },
            ],
        },
    });
    assert.equal(result, undefined);
    assert.equal(confirms, 0);
});

test("blocks GitHub writes in ctx_batch_execute without UI", async () => {
    const gate = createGate({ hasUI: false });
    const { result, confirms } = await gate.run({
        toolName: "ctx_batch_execute",
        input: {
            commands: [{ command: "gh pr comment 18459 --body hello" }],
        },
    });
    assert.equal(confirms, 0);
    assert.ok(result);
    assert.equal(result.block, true);
});

test("allows a configured repository to bypass confirmation", async () => {
    const gate = createGate();
    const { result, confirms } = await gate.run({
        toolName: "bash",
        input: {
            command:
                "gh repo edit hiiamtrong/allowed-repo --visibility private",
        },
    });
    assert.equal(result, undefined);
    assert.equal(confirms, 0);
});
