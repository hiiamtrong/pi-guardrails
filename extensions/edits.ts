export type TextEdit = { oldText?: unknown; newText?: unknown };

/** Some callers send `edits` as a JSON string, which an `Array.isArray` check alone would treat as no edits at all. */
export function editsOf(input: { edits?: unknown } | undefined): TextEdit[] {
  let edits = input?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return [];
    }
  }
  return Array.isArray(edits) ? edits.filter((edit): edit is TextEdit => typeof edit === "object" && edit !== null) : [];
}
