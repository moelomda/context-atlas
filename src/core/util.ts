import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "item";
}

export function posixPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function truncateToTokenBudget(value: string, budget: number, requiredSuffix = "[Context truncated to token budget]"): string {
  const chars = Math.max(0, budget * 4);
  if (value.length <= chars) return value;
  const suffix = requiredSuffix.trim();
  if (suffix.length >= chars) return suffix.slice(0, chars);
  const candidate = value.slice(0, Math.max(0, chars - suffix.length - 2));
  const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(". "));
  const prefix = candidate.slice(0, boundary > candidate.length * 0.6 ? boundary + 1 : undefined).trimEnd();
  return `${prefix}\n\n${suffix}`;
}

export function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term));
}

export function relevanceScore(query: string, ...values: string[]): number {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return 0;
  const searchable = values.join(" ").toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (searchable.includes(term)) score += 1;
    if (values[0]?.toLowerCase().includes(term)) score += 1.5;
  }
  return score / queryTerms.length;
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

export function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${candidate}`);
  }
  return resolvedCandidate;
}

export function daysBetween(older: string, newer = nowIso()): number {
  const milliseconds = Date.parse(newer) - Date.parse(older);
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds / 86_400_000) : Number.POSITIVE_INFINITY;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "what", "when", "where", "how",
  "add", "make", "use", "using", "project", "code", "file", "files", "feature", "please",
]);
