import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ATLAS_SCHEMA_VERSION, type AtlasConfig } from "./types.js";
import { atomicWriteJson, nowIso } from "./util.js";
import { findGitRoot } from "./git.js";

export const ATLAS_DIRECTORY = ".context-atlas";
export const CONFIG_FILE = "config.json";

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
  const atlasGitIgnore = path.join(atlasDirectory(repoRoot), ".gitignore");
  if (!existsSync(atlasGitIgnore)) {
    writeFileSync(atlasGitIgnore, "atlas.db\natlas.db-*\nexports/\nbackups/\n", { encoding: "utf8", mode: 0o600 });
  }
  if (existsSync(filePath)) return loadConfig(repoRoot).config;
  const config: AtlasConfig = {
    schemaVersion: ATLAS_SCHEMA_VERSION,
    projectName: projectName?.trim() || path.basename(repoRoot),
    createdAt: nowIso(),
    repoRoot: ".",
    staleAfterDays: 30,
    defaultTokenBudget: 4_000,
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

function validateInteger(value: unknown, field: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Invalid Context Atlas ${field}; expected an integer from ${minimum} to ${maximum}.`);
  }
}
