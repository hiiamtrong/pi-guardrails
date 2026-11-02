import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { agentRoot, canonicalProjectRoot, encodeProjectPath } from "../packages/claude-memory/memory.ts";

type ExtensionContext = { cwd: string; ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void } };

type ExtensionApi = {
  on: (
    event: "before_agent_start",
    handler: (event: { systemPrompt?: string }, ctx: ExtensionContext) => { systemPrompt: string } | undefined,
  ) => void;
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
  ) => void;
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (
      id: string,
      params: Record<string, never>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  }) => void;
};

const DEFAULT_TEMPLATE = `# Me
- Name:
- Role:
- Preferences (language, tone):
`;

const PROJECT_TEMPLATE = `# This project
- Client:
- My role here:
- Team and contacts:
- Conventions:
`;

// Say when to call the tool, not what it holds: the files can be long and change often.
const HINT = `<whoami>
The user's role, client, team and conventions for this project are kept in files you cannot see until you call the \`whoami\` tool.
Call it before: writing a message, review, reply or report on the user's behalf; choosing a language, tone or format that depends on who the client is; or when the user asks who they are or what this project is.
Skip it for tasks that do not depend on the user's role or client.
</whoami>`;

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    // Only an absent file is "Missing"; a permission error or a directory must not look like a file to create.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function whoamiPaths(cwd: string) {
  const projectRoot = canonicalProjectRoot(cwd);
  const dir = join(agentRoot(), "whoami");
  // shortcut: two repos that encode to the same name share a file; add claude-memory's .project.json check when that happens.
  return { projectRoot, dir, paths: [join(dir, "default.md"), join(dir, `${encodeProjectPath(projectRoot)}.md`)] };
}

function whoami(cwd: string): { text: string; projectRoot: string; files: string[] } {
  const { projectRoot, paths } = whoamiPaths(cwd);
  const lines = [`Project root: ${projectRoot}`];
  const files: string[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    const content = readOptional(path);
    if (content === undefined) missing.push(path);
    else {
      files.push(path);
      lines.push("", content);
    }
  }
  for (const path of missing) lines.push(`Missing: ${path}`);
  return { text: lines.join("\n"), projectRoot, files };
}

function createIfAbsent(path: string, template: string): boolean {
  try {
    writeFileSync(path, template, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export default function (pi: ExtensionApi): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (!whoamiPaths(ctx.cwd).paths.some(existsSync)) return undefined;
    return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${HINT}` };
  });

  pi.registerCommand("whoami-init", {
    description: "Create the whoami template files for this project (default.md and the project file) if they do not exist",
    async handler(_args, ctx) {
      const { dir, paths } = whoamiPaths(ctx.cwd);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const created = [createIfAbsent(paths[0], DEFAULT_TEMPLATE) && paths[0], createIfAbsent(paths[1], PROJECT_TEMPLATE) && paths[1]]
        .filter((path): path is string => Boolean(path));
      const message = created.length
        ? `Created, now fill them in:\n${created.join("\n")}`
        : `Nothing to create, both files exist:\n${paths.join("\n")}`;
      ctx.ui?.notify?.(message, "info");
    },
  });

  pi.registerTool({
    name: "whoami",
    label: "Who am I",
    description:
      "Describe who the user is in the current project: role, client, team, conventions. Reads ~/.pi/agent/whoami/default.md and the project's file.",
    promptSnippet: "Who the user is in this project (role, client, context)",
    promptGuidelines: [
      "Call whoami before writing messages, reviews, or decisions on the user's behalf when their role, client, or project context matters.",
      "The files are written by the user; a Missing line names the file they can create.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const { text, projectRoot, files } = whoami(ctx.cwd);
      return { content: [{ type: "text", text }], details: { projectRoot, files } };
    },
  });
}
