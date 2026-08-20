import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ATLAS_SCHEMA_VERSION, type AtlasConfig } from "./types.js";
import { loadAtlasIgnore } from "./ignore.js";
import { atomicWriteJson, nowIso, posixPath, sha256, stableStringify } from "./util.js";
import { findGitRoot } from "./git.js";

export const ATLAS_DIRECTORY = ".context-atlas";
export const CONFIG_FILE = "config.json";
export const GUIDANCE_EXTRACTOR_VERSION = "repository-extractor-v1";
export const GUIDANCE_WATERMARK_SCHEMA_VERSION = 1;
const ATLAS_GITIGNORE_RULES = ["atlas.db", "atlas.db-*", "exports/", "backups/", "migrations/", "packs/"] as const;

export interface GuidanceDependencyWatermark {
  watermark: string;
  extractorVersion: string;
  schemaVersion: number;
  watermarkSchemaVersion: number;
  atlasIgnorePolicyHash: string;
  effectiveScanConfig: {
    projectName: string;
    staleAfterDays: number;
    maxCommits: number;
    maxComponentDepth: number;
    maxFiles: number;
    excludedPaths: string[];
  };
}

export interface InitializationPreview {
  repositoryRoot: string;
  alreadyInitialized: boolean;
  writes: Array<{ path: string; action: "create" | "preserve"; purpose: string }>;
  trackedProjectFilesModified: false;
}

export function atlasDirectory(repoRoot: string): string {
  return path.join(repoRoot, ATLAS_DIRECTORY);
}

export function configPath(repoRoot: string): string {
  return path.join(atlasDirectory(repoRoot), CONFIG_FILE);
}

export function initializeConfig(repoCandidate: string, projectName?: string): AtlasConfig {
  const repoRoot = findGitRoot(repoCandidate);
  const filePath = configPath(repoRoot);
  mkdirSync(atlasDirectory(repoRoot), { recursive: true, mode: 0o700 });
  ensureAtlasGitIgnore(repoRoot);
  if (existsSync(filePath)) return loadConfig(repoRoot).config;
  const config: AtlasConfig = {
    schemaVersion: ATLAS_SCHEMA_VERSION,
    projectName: projectName?.trim() || path.basename(repoRoot),
    createdAt: nowIso(),
    repoRoot: ".",
    staleAfterDays: 30,
    defaultTokenBudget: 8_000,
    maxCommits: 5_000,
    maxComponentDepth: 2,
    maxFiles: 50_000,
    excludedPaths: [
      ".git", ".context-atlas", "node_modules", "vendor", "dist", "build", "coverage", ".next", ".cache",
    ],
  };
  atomicWriteJson(filePath, config);
  return config;
}

/** Keeps every derived/backup SQLite location out of Git without replacing
 * operator rules. Migration paths are ensured for legacy initialized stores
 * before a protected snapshot is written. */
export function ensureAtlasGitIgnore(repoRoot: string): void {
  const atlasRoot = atlasDirectory(repoRoot);
  mkdirSync(atlasRoot, { recursive: true, mode: 0o700 });
  const filePath = path.join(atlasRoot, ".gitignore");
  if (existsSync(filePath)) {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Refusing to update a non-regular or symbolic-link Context Atlas .gitignore.");
    }
    const current = readFileSync(filePath, "utf8");
    const lines = new Set(current.replace(/\r\n/g, "\n").split("\n"));
    const missing = ATLAS_GITIGNORE_RULES.filter((rule) => !lines.has(rule));
    if (missing.length > 0) {
      const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
      writeFileSync(filePath, `${prefix}${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    }
  } else {
    writeFileSync(filePath, `${ATLAS_GITIGNORE_RULES.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  try { chmodSync(filePath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
}

export function previewInitialization(repoCandidate: string): InitializationPreview {
  const repositoryRoot = findGitRoot(repoCandidate);
  const atlasRoot = atlasDirectory(repositoryRoot);
  const planned = [
    { path: path.join(atlasRoot, "config.json"), purpose: "Versioned Context Atlas policy and project identity." },
    { path: path.join(atlasRoot, ".gitignore"), purpose: "Prevents derived database, export, and backup files from accidental commits." },
    { path: path.join(atlasRoot, "atlas.db"), purpose: "Derived local evidence and knowledge index." },
    { path: path.join(atlasRoot, "ledger.ndjson"), purpose: "Hash-chained project-memory audit ledger." },
  ];
  return {
    repositoryRoot,
    alreadyInitialized: existsSync(configPath(repositoryRoot)),
    writes: planned.map((item) => ({
      ...item,
      action: existsSync(item.path) ? "preserve" as const : "create" as const,
    })),
    trackedProjectFilesModified: false,
  };
}

export function findAtlasRoot(start = process.cwd()): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(configPath(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadConfig(start = process.cwd()): { root: string; config: AtlasConfig } {
  const root = findAtlasRoot(start);
  if (!root) {
    throw new Error("Context Atlas is not initialized. Run `context-atlas init` from a Git repository first.");
  }
  const raw = JSON.parse(readFileSync(configPath(root), "utf8")) as Partial<AtlasConfig>;
  if (raw.schemaVersion !== ATLAS_SCHEMA_VERSION) {
    throw new Error(`Unsupported Context Atlas schema version: ${String(raw.schemaVersion)}`);
  }
  if (!raw.projectName || !raw.createdAt || !Array.isArray(raw.excludedPaths)) {
    throw new Error("Invalid Context Atlas configuration.");
  }
  if (raw.projectName.length > 300 || !Number.isFinite(Date.parse(raw.createdAt)) || raw.repoRoot !== ".") {
    throw new Error("Invalid Context Atlas configuration identity fields.");
  }
  validateInteger(raw.staleAfterDays, "staleAfterDays", 1, 3_650);
  validateInteger(raw.defaultTokenBudget, "defaultTokenBudget", 500, 20_000);
  validateInteger(raw.maxCommits, "maxCommits", 1, 100_000);
  validateInteger(raw.maxComponentDepth, "maxComponentDepth", 1, 8);
  validateInteger(raw.maxFiles, "maxFiles", 1, 1_000_000);
  if (raw.excludedPaths.length > 512 || raw.excludedPaths.some((item) => typeof item !== "string" || item.length > 500 || item.includes("\0"))) {
    throw new Error("Invalid Context Atlas excludedPaths configuration.");
  }
  return { root, config: raw as AtlasConfig };
}

/**
 * Hashes only dependencies that can change extracted or freshness-bearing
 * project guidance. Runtime presentation controls such as token budgets and
 * non-semantic identity fields such as createdAt/repoRoot are deliberately
 * excluded. The local database directory is a mandatory exclusion even if a
 * hand-edited configuration accidentally omits it.
 */
export function getCurrentGuidanceWatermark(start = process.cwd()): GuidanceDependencyWatermark {
  const { root, config } = loadConfig(start);
  const atlasIgnore = loadAtlasIgnore(root);
  return computeGuidanceDependencyWatermark(config, atlasIgnore.patterns);
}

export function computeGuidanceDependencyWatermark(
  config: AtlasConfig,
  atlasIgnorePatterns: readonly string[],
): GuidanceDependencyWatermark {
  const effectiveScanConfig = {
    projectName: config.projectName,
    staleAfterDays: config.staleAfterDays,
    maxCommits: config.maxCommits,
    maxComponentDepth: config.maxComponentDepth,
    maxFiles: config.maxFiles,
    excludedPaths: effectiveExcludedPaths(config),
  };
  // Patterns are already trimmed and comments removed. Their order remains
  // significant because later negations can override earlier ignore rules.
  const atlasIgnorePolicyHash = sha256(stableStringify(atlasIgnorePatterns));
  const dependencies = {
    watermarkSchemaVersion: GUIDANCE_WATERMARK_SCHEMA_VERSION,
    extractorVersion: GUIDANCE_EXTRACTOR_VERSION,
    schemaVersion: ATLAS_SCHEMA_VERSION,
    atlasIgnorePolicyHash,
    effectiveScanConfig,
  };
  return {
    ...dependencies,
    watermark: sha256(stableStringify(dependencies)),
  };
}

export function effectiveExcludedPaths(config: Pick<AtlasConfig, "excludedPaths">): string[] {
  return [...new Set([ATLAS_DIRECTORY, ...config.excludedPaths]
    .map((item) => posixPath(item).toLowerCase().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean))]
    .sort();
}

function validateInteger(value: unknown, field: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Invalid Context Atlas ${field}; expected an integer from ${minimum} to ${maximum}.`);
  }
}
