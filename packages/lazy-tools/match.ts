export type SearchableTool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
};

const STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "the",
  "this",
  "tool",
  "tools",
  "use",
  "with",
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function findMatchingTools(
  query: string,
  tools: SearchableTool[],
  limit = 5,
): string[] {
  const normalizedQuery = normalize(query);
  const terms = [...new Set(normalizedQuery.split(" "))].filter(
    (term) => term.length > 2 && !STOP_WORDS.has(term),
  );
  if (!normalizedQuery || terms.length === 0) return [];

  return tools
    .map((tool) => {
      const name = normalize(tool.name);
      const description = normalize(tool.description);
      const guidelines = normalize(tool.promptGuidelines?.join(" ") ?? "");
      let score = name === normalizedQuery ? 100 : 0;
      if (name.includes(normalizedQuery)) score += 40;
      for (const term of terms) {
        if (name.split(" ").includes(term)) score += 12;
        else if (name.includes(term)) score += 8;
        if (description.includes(term)) score += 2;
        if (guidelines.includes(term)) score += 1;
      }
      return { name: tool.name, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}
