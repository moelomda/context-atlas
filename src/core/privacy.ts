import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { atlasDirectory, loadConfig } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { getRepoStatus, listRepositoryFiles } from "./git.js";
import { loadAtlasIgnore } from "./ignore.js";
import { findSecrets, isExcludedPath, isSensitivePath, sanitizeText } from "./security.js";
import { nowIso, stableStringify } from "./util.js";

export interface RetentionPreviewOptions {
  portableExportsOlderThanDays?: number | null;
  backupsOlderThanDays?: number | null;
}

export interface RetentionPreview {
  schemaVersion: 1;
  generatedAt: string;
  applied: false;
  deletionSupported: false;
  policy: {
    portableExportsOlderThanDays: number | null;
    backupsOlderThanDays: number | null;
  };
  inventory: Array<{
    dataClass: "canonical-database" | "audit-ledger" | "portable-export" | "physical-backup" | "sqlite-operational" | "model-payload" | "model-output" | "embedding-cache";
    retentionRole: "protected" | "operator-managed" | "absent";
    items: number;
    bytes: number;
  }>;
  candidates: Array<{
    dataClass: "portable-export" | "physical-backup";
    items: number;
    bytes: number;
    thresholdDays: number;
  }>;
  wouldDeleteItems: number;
  wouldDeleteBytes: number;
  protected: {
    canonicalDatabase: true;
    auditLedger: true;
    immutableReviewHistory: true;
  };
  warnings: string[];
}

export interface PrivacyReport {
  schemaVersion: 1;
  generatedAt: string;
  project: {
    name: string;
    repositoryId: string;
  };
  scope: {
    repositoryFilesObserved: number;
    scanTruncated: boolean;
    indexableFileCandidates: number;
    excludedByConfiguration: number;
    excludedByAtlasIgnore: number;
    sensitivePathsWithheld: number;
    configuredExclusionRuleCount: number;
    atlasIgnoreRuleCount: number;
    atlasIgnorePolicyHash: string | null;
    indexedEvidenceRecords: number;
    indexedFileEvidenceRecords: number;
  };
  findings: {
    sensitiveEvidenceRecords: number;
    categories: Array<{ category: string; records: number }>;
    storedTextRowsScanned: number;
    storedTextScanTruncated: boolean;
    storedPotentialSecretMatches: number;
    storedPotentialSecretCategories: Array<{ category: string; matches: number }>;
    secretValuesIncludedInReport: false;
  };
  storage: {
    databasePresent: boolean;
    databaseBytes: number;
    databaseModeOctal: string | null;
    leastPrivilegeAttempted: true;
    leastPrivilegeVerified: boolean | null;
    sensitiveBodyPolicy: "omit-or-redact";
    potentialSecretMaterialDetectedInKnownTextColumns: boolean;
    gitBodiesResolvedOnDemand: true;
    providerCredentialStorage: "not-implemented";
  };
  egress: {
    remoteProviderCapability: "not-implemented";
    configuredProviders: [];
    consentRecords: 0;
    attemptsRecorded: 0;
    retainedPayloads: 0;
    defaultNetworkEgress: false;
    inventoryBasis: string;
  };
  retention: RetentionPreview;
  limitations: string[];
}

type Row = Record<string, unknown>;

export function generatePrivacyReport(repoRoot: string): PrivacyReport {
  const { root, config } = loadConfig(repoRoot);
  const repository = getRepoStatus(root);
  const listed = listRepositoryFiles(root, config.maxFiles);
  const atlasIgnore = loadAtlasIgnore(root);
  let excludedByConfiguration = 0;
  let excludedByAtlasIgnore = 0;
  let sensitivePathsWithheld = 0;
  let indexableFileCandidates = 0;
  for (const relativePath of listed.files) {
    if (isExcludedPath(relativePath, config.excludedPaths)) excludedByConfiguration += 1;
    else if (atlasIgnore.matches(relativePath)) excludedByAtlasIgnore += 1;
    else if (isSensitivePath(relativePath)) sensitivePathsWithheld += 1;
    else indexableFileCandidates += 1;
  }

  const database = new AtlasDatabase(root, { readOnly: true });
  try {
    const evidence = database.listAllEvidence();
    const categories = new Map<string, number>();
    for (const item of evidence.filter((candidate) => candidate.sensitive)) {
      const findingKinds = Array.isArray(item.metadata.secretFindingKinds)
        ? item.metadata.secretFindingKinds.filter((value): value is string => typeof value === "string")
        : [];
      const reason = typeof item.metadata.reason === "string" ? item.metadata.reason : null;
      const labels = findingKinds.length > 0 ? findingKinds : [reason ?? "sensitive-unspecified"];
      for (const label of new Set(labels)) categories.set(label, (categories.get(label) ?? 0) + 1);
    }
    const storedScan = scanStoredText(database);
    const databaseFile = path.join(atlasDirectory(root), "atlas.db");
    const databaseStats = safeStat(databaseFile);
    const mode = databaseStats ? databaseStats.mode & 0o777 : null;
    const leastPrivilegeVerified = mode === null || process.platform === "win32" ? null : (mode & 0o077) === 0;
    const cleanProjectName = sanitizeText(config.projectName, 300).value || "Context Atlas project";
    const report: PrivacyReport = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      project: { name: cleanProjectName, repositoryId: repository.repositoryId },
      scope: {
        repositoryFilesObserved: listed.files.length,
        scanTruncated: listed.truncated,
        indexableFileCandidates,
        excludedByConfiguration,
        excludedByAtlasIgnore,
        sensitivePathsWithheld,
        configuredExclusionRuleCount: config.excludedPaths.length,
        atlasIgnoreRuleCount: atlasIgnore.patterns.length,
        atlasIgnorePolicyHash: atlasIgnore.hash,
        indexedEvidenceRecords: evidence.length,
        indexedFileEvidenceRecords: evidence.filter((item) => item.locator.startsWith("file:") && !item.sensitive).length,
      },
      findings: {
        sensitiveEvidenceRecords: evidence.filter((item) => item.sensitive).length,
        categories: [...categories.entries()]
          .map(([category, records]) => ({ category, records }))
          .sort((left, right) => left.category.localeCompare(right.category)),
        storedTextRowsScanned: storedScan.rowsScanned,
        storedTextScanTruncated: storedScan.truncated,
        storedPotentialSecretMatches: storedScan.matches,
        storedPotentialSecretCategories: [...storedScan.categories.entries()]
          .map(([category, matches]) => ({ category, matches }))
          .sort((left, right) => left.category.localeCompare(right.category)),
        secretValuesIncludedInReport: false,
      },
      storage: {
        databasePresent: databaseStats !== null,
        databaseBytes: databaseStats?.size ?? 0,
        databaseModeOctal: mode === null ? null : mode.toString(8).padStart(3, "0"),
        leastPrivilegeAttempted: true,
        leastPrivilegeVerified,
        sensitiveBodyPolicy: "omit-or-redact",
        potentialSecretMaterialDetectedInKnownTextColumns: storedScan.matches > 0,
        gitBodiesResolvedOnDemand: true,
        providerCredentialStorage: "not-implemented",
      },
      egress: {
        remoteProviderCapability: "not-implemented",
        configuredProviders: [],
        consentRecords: 0,
        attemptsRecorded: 0,
        retainedPayloads: 0,
        defaultNetworkEgress: false,
        inventoryBasis: "This release has no remote provider adapter, telemetry client, consent store, or egress-attempt store.",
      },
      retention: previewRetention(root),
      limitations: [
        "Scope counts are bounded by maxFiles; scanTruncated indicates when the configured boundary was reached.",
        "Stored-text scanning covers known schema text columns and reports categories/counts only; it is not a substitute for a filesystem or forensic secret scanner.",
        "No egress history exists because remote-provider capability is not implemented; this is not evidence about unrelated applications on the machine.",
        "Retention is preview-only in this release and never deletes data.",
      ],
    };
    if (findSecrets(stableStringify(report)).length > 0) {
      throw new Error("Privacy report generation was blocked because its safe metadata matched a secret pattern.");
    }
    return report;
  } finally {
    database.close();
  }
}

export function previewRetention(repoRoot: string, options: RetentionPreviewOptions = {}): RetentionPreview {
  const { root } = loadConfig(repoRoot);
  const atlasRoot = atlasDirectory(root);
  const exportThreshold = normalizeRetentionDays(options.portableExportsOlderThanDays, "portableExportsOlderThanDays");
  const backupThreshold = normalizeRetentionDays(options.backupsOlderThanDays, "backupsOlderThanDays");
  const exportsInventory = inventoryTree(path.join(atlasRoot, "exports"), exportThreshold);
  const backupsInventory = inventoryTree(path.join(atlasRoot, "backups"), backupThreshold);
  const databaseStats = safeStat(path.join(atlasRoot, "atlas.db"));
  const ledgerStats = safeStat(path.join(atlasRoot, "ledger.ndjson"));
  const sqliteOperational = ["atlas.db-wal", "atlas.db-shm"]
    .map((name) => safeStat(path.join(atlasRoot, name)))
    .filter((item): item is Stats => item !== null);
  const candidates: RetentionPreview["candidates"] = [];
  if (exportThreshold !== null) candidates.push({
    dataClass: "portable-export",
    items: exportsInventory.eligibleItems,
    bytes: exportsInventory.eligibleBytes,
    thresholdDays: exportThreshold,
  });
  if (backupThreshold !== null) candidates.push({
    dataClass: "physical-backup",
    items: backupsInventory.eligibleItems,
    bytes: backupsInventory.eligibleBytes,
    thresholdDays: backupThreshold,
  });
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    applied: false,
    deletionSupported: false,
    policy: {
      portableExportsOlderThanDays: exportThreshold,
      backupsOlderThanDays: backupThreshold,
    },
    inventory: [
      { dataClass: "canonical-database", retentionRole: "protected", items: databaseStats ? 1 : 0, bytes: databaseStats?.size ?? 0 },
      { dataClass: "audit-ledger", retentionRole: "protected", items: ledgerStats ? 1 : 0, bytes: ledgerStats?.size ?? 0 },
      { dataClass: "portable-export", retentionRole: "operator-managed", items: exportsInventory.items, bytes: exportsInventory.bytes },
      { dataClass: "physical-backup", retentionRole: "operator-managed", items: backupsInventory.items, bytes: backupsInventory.bytes },
      { dataClass: "sqlite-operational", retentionRole: "protected", items: sqliteOperational.length, bytes: sqliteOperational.reduce((sum, item) => sum + item.size, 0) },
      { dataClass: "model-payload", retentionRole: "absent", items: 0, bytes: 0 },
      { dataClass: "model-output", retentionRole: "absent", items: 0, bytes: 0 },
      { dataClass: "embedding-cache", retentionRole: "absent", items: 0, bytes: 0 },
    ],
    candidates,
    wouldDeleteItems: candidates.reduce((sum, item) => sum + item.items, 0),
    wouldDeleteBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    protected: { canonicalDatabase: true, auditLedger: true, immutableReviewHistory: true },
    warnings: [
      "Preview only: no file was deleted and this API has no deletion operation.",
      "Candidate counts are aggregate and omit paths so the report cannot disclose sensitive workspace names.",
      ...(exportsInventory.truncated || backupsInventory.truncated ? ["Artifact inventory reached its 50,000-entry safety limit and is incomplete."] : []),
    ],
  };
}

function scanStoredText(database: AtlasDatabase): {
  rowsScanned: number;
  truncated: boolean;
  matches: number;
  categories: Map<string, number>;
} {
  const queries = [
    "SELECT locator, metadata_json FROM evidence",
    "SELECT title, summary, payload_json FROM entities",
    "SELECT title, summary, files_json FROM events",
    "SELECT title, summary, payload_json, review_note FROM proposals",
    "SELECT predicate, value_json, scope, producer, metadata_json FROM assertions",
    "SELECT actor, rationale FROM review_actions",
  ];
  const maximumRows = 100_000;
  let rowsScanned = 0;
  let truncated = false;
  let matches = 0;
  const categories = new Map<string, number>();
  for (const query of queries) {
    const remaining = maximumRows - rowsScanned;
    if (remaining <= 0) { truncated = true; break; }
    const rows = database.db.prepare(`${query} LIMIT ?`).all(remaining + 1) as Row[];
    if (rows.length > remaining) truncated = true;
    for (const row of rows.slice(0, remaining)) {
      rowsScanned += 1;
      for (const value of Object.values(row)) {
        if (typeof value !== "string") continue;
        for (const finding of findSecrets(value)) {
          matches += 1;
          categories.set(finding.kind, (categories.get(finding.kind) ?? 0) + 1);
        }
      }
    }
  }
  return { rowsScanned, truncated, matches, categories };
}

function inventoryTree(directory: string, thresholdDays: number | null): {
  items: number;
  bytes: number;
  eligibleItems: number;
  eligibleBytes: number;
  truncated: boolean;
} {
  if (!existsSync(directory)) return { items: 0, bytes: 0, eligibleItems: 0, eligibleBytes: 0, truncated: false };
  const root = path.resolve(directory);
  const stack = [root];
  let items = 0;
  let bytes = 0;
  let eligibleItems = 0;
  let eligibleBytes = 0;
  let truncated = false;
  const now = Date.now();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try { entries = readdirSync(current); } catch { continue; }
    for (const name of entries) {
      if (items >= 50_000) { truncated = true; break; }
      const candidate = path.resolve(current, name);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
      const stats = safeLstat(candidate);
      if (!stats || stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) stack.push(candidate);
      else if (stats.isFile()) {
        items += 1;
        bytes += stats.size;
        if (thresholdDays !== null && Math.max(0, now - stats.mtimeMs) >= thresholdDays * 86_400_000) {
          eligibleItems += 1;
          eligibleBytes += stats.size;
        }
      }
    }
    if (truncated) break;
  }
  return { items, bytes, eligibleItems, eligibleBytes, truncated };
}

function normalizeRetentionDays(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 36_500) throw new Error(`${field} must be an integer from 0 to 36500 days.`);
  return value;
}

function safeStat(filePath: string): Stats | null {
  try { return statSync(filePath) as Stats; } catch { return null; }
}

function safeLstat(filePath: string): Stats | null {
  try { return lstatSync(filePath) as Stats; } catch { return null; }
}
