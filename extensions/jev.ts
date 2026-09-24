import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~15k tokens; keeps the state well under Jev's 32k-token state budget.
export const MAX_STATE_CHARS = 60_000;

type TypeSafeEnv = { TYPESAFE_API_KEY?: string; TYPESAFE_BASE_URL?: string };
type NoulAnswers = { answers: Record<string, { noul: number }> };

function typeSafeEnv(): TypeSafeEnv {
  if (process.env.TYPESAFE_API_KEY !== undefined) return process.env;
  // Pi only injects mcp-env.json into MCP servers, not into extension processes.
  const file = join(homedir(), ".pi/agent/mcp-env.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // JSON.parse errors quote file contents, and this file holds secrets.
    throw new Error(`Cannot read ${file}`);
  }
}

export async function askNoul(
  state: unknown,
  questions: Record<string, string>,
): Promise<Record<string, number>> {
  const env = typeSafeEnv();
  if (!env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set");
  const response = await fetch(
    `${env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, instructions]) => [
            id,
            { type: "noul", instructions },
          ]),
        ),
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Jev returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const { answers } = (await response.json()) as NoulAnswers;
  return Object.fromEntries(
    Object.keys(questions).map((id) => {
      const noul = answers?.[id]?.noul;
      if (typeof noul !== "number" || !(noul >= 0 && noul <= 1))
        throw new Error(`Jev returned an invalid answer for ${id}`);
      return [id, noul];
    }),
  );
}
