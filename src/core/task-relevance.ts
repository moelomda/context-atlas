/** Exact lexical matches keep `git` from matching `.github` and split code identifiers. */
function words(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "without",
  "from",
  "that",
  "this",
  "into",
  "of",
  "to",
  "in",
  "on",
  "is",
  "what",
  "when",
  "where",
  "how",
  "add",
  "make",
  "use",
  "using",
  "project",
  "code",
  "file",
  "files",
  "feature",
  "please",
]);

export function taskRelevance(task: string, ...values: string[]): number {
  const query = [...words(task)].filter((word) => !STOP_WORDS.has(word));
  if (query.length === 0) return 0;
  const searchable = words(values.join(" "));
  const title = words(values[0] ?? "");
  return query.reduce((score, word) => score + (searchable.has(word) ? 1 : 0) + (title.has(word) ? 1.5 : 0), 0) / query.length;
}

export function matchingComponentFiles(task: string, files: unknown): Array<{ path: string; score: number }> {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.filter((file): file is string => typeof file === "string"))]
    .map((path) => ({ path, score: taskRelevance(task, path.split("/").at(-1) ?? path, path) }))
    .filter((file) => file.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}
