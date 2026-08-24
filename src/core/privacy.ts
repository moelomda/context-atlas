import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { atlasDirectory, loadConfig } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { getRepoStatus, listRepositoryFiles } from "./git.js";
import { loadAtlasIgnore } from "./ignore.js";
import { flushLedgerOutbox, readVerifiedLedgerStateEntries, stageLedgerEntry } from "./ledger.js";
import { findSecrets, isExcludedPath, isSensitivePath, sanitizeText } from "./security.js";
import { newId, nowIso, posixPath, sha256, stableStringify } from "./util.js";

export interface RetentionPreviewOptions {
  portableExportsOlderThanDays?: number | null;
  backupsOlderThanDays?: number | null;
}

export interface RetentionPreview {
  schemaVersion: 2;
  generatedAt: string;
  applied: false;
  deletionSupported: true;
  planId: string;
  candidateManifestDigest: string;
  inventoryComplete: boolean;
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

export interface RetentionApplyOptions extends RetentionPreviewOptions {
  planId: string;
  actor: string;
  reason: string;
  userConfirmed: true;
}

export interface RetentionApplyResult {
  schemaVersion: 1;
  generatedAt: string;
  applied: true;
  status: "completed" | "partial" | "no-op";
  planId: string;
  actor: string;
  reasonDigest: string;
  policy: RetentionPreview["policy"];
  deleted: Array<{
    dataClass: "portable-export" | "physical-backup";
    items: number;
    bytes: number;
  }>;
  deletedItems: number;
  deletedBytes: number;
  failedItems: number;
  protected: RetentionPreview["protected"];
  tombstone: {
    runId: string;
    startedLedgerHash: string;
    completedLedgerHash: string;
  } | null;
  warnings: string[];
}

export interface RetentionTombstone {
  runId: string;
  planDigestPrefix: string;
  status: "started" | "completed" | "partial";
  startedAt: string;
  completedAt: string | null;
  startedLedgerHash: string;
  completedLedgerHash: string | null;
}

type RetentionDataClass = "portable-export" | "physical-backup";

interface RetentionCandidate {
  dataClass: RetentionDataClass;
  absolutePath: string;
  pathDigest: string;
  identityDigest: string;
  physicalIdentityDigest: string;
  bytes: number;
}

interface ArtifactInventory {
  items: number;
  bytes: number;
  eligibleItems: number;
  eligibleBytes: number;
  truncated: boolean;
  candidates: RetentionCandidate[];
}

interface InternalRetentionPlan {
  preview: RetentionPreview;
  candidates: RetentionCandidate[];
  storageScopeDigest: string;
}

interface RetentionStorageScope {
  atlasRoot: string;
  scopeDigest: string;
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
  externalImports: {
    records: number;
    normalBodiesStored: number;
    sensitiveBodiesOmitted: number;
    storedBodyBytes: number;
    consentRecords: number;
    rawOriginPathsStored: false;
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
    const externalImports = database.listExternalImports();
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
      externalImports: {
        records: externalImports.length,
        normalBodiesStored: externalImports.filter((item) => item.sensitivityLabel === "normal" && item.canonicalText !== null).length,
        sensitiveBodiesOmitted: externalImports.filter((item) => item.sensitivityLabel === "sensitive" && item.canonicalText === null).length,
        storedBodyBytes: externalImports.reduce((total, item) => total + (item.canonicalText === null ? 0 : Buffer.byteLength(item.canonicalText, "utf8")), 0),
        consentRecords: new Set(externalImports.map((item) => item.consentId)).size,
        rawOriginPathsStored: false,
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
        "External-import counts reconcile immutable local records; normal bodies are intentionally stored for local use, while sensitive bodies are omitted and origin paths are represented only by opaque digests.",
        "Retention apply is limited to explicitly selected portable exports and physical backups; canonical data, the ledger, review history, and SQLite operational state are always protected.",
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
  return buildRetentionPlan(repoRoot, options).preview;
}

export function applyRetention(repoRoot: string, options: RetentionApplyOptions): RetentionApplyResult {
  if (options.userConfirmed !== true) throw new Error("Retention apply requires explicit user confirmation.");
  if (!/^[a-f0-9]{64}$/.test(options.planId)) throw new Error("Retention apply requires a valid preview plan ID.");
  validateRetentionActor(options.actor);
  if (options.reason.length > 2_000) throw new Error("Retention rationale must not exceed 2000 characters.");
  const reason = sanitizeText(options.reason, 2_000);
  if (reason.sensitive) throw new Error("Retention rationale appears to contain sensitive data.");
  if (reason.value.length < 20) throw new Error("Retention rationale must contain at least 20 characters.");

  const plan = buildRetentionPlan(repoRoot, options);
  if (!plan.preview.inventoryComplete) throw new Error("Retention apply refuses an incomplete artifact inventory.");
  if (plan.preview.planId !== options.planId) {
    throw new Error("Retention artifacts changed after preview; generate a new preview and confirm its plan ID.");
  }
  const reasonDigest = sha256(reason.value);
  if (plan.candidates.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      applied: true,
      status: "no-op",
      planId: plan.preview.planId,
      actor: options.actor,
      reasonDigest,
      policy: plan.preview.policy,
      deleted: [
        { dataClass: "portable-export", items: 0, bytes: 0 },
        { dataClass: "physical-backup", items: 0, bytes: 0 },
      ],
      deletedItems: 0,
      deletedBytes: 0,
      failedItems: 0,
      protected: plan.preview.protected,
      tombstone: null,
      warnings: ["No eligible artifacts matched the confirmed retention plan; canonical and audit state were unchanged."],
    };
  }

  const { root } = loadConfig(repoRoot);
  if (!retentionStorageScopeMatches(root, plan.storageScopeDigest)) {
    throw new Error("Retention storage changed after preview; generate a new preview and confirm its plan ID.");
  }
  const database = new AtlasDatabase(root);
  const runId = `${newId("retention")}_${plan.preview.planId.slice(0, 16)}`;
  const startedAt = nowIso();
  let startedLedgerHash: string;
  try {
    flushLedgerOutbox(root, database);
    const started = database.transaction(() => stageLedgerEntry(root, database, {
      kind: "retention_apply_started",
      actionId: `${runId}:started`,
      timestamp: startedAt,
      payload: {
        planId: plan.preview.planId,
        actor: options.actor,
        reasonDigest,
        policy: plan.preview.policy,
        candidateManifestDigest: plan.preview.candidateManifestDigest,
        candidateItems: plan.preview.wouldDeleteItems,
        candidateBytes: plan.preview.wouldDeleteBytes,
      },
    }));
    flushLedgerOutbox(root, database);
    startedLedgerHash = started.hash;

    const deletedByClass: Record<RetentionDataClass, { items: number; bytes: number }> = {
      "portable-export": { items: 0, bytes: 0 },
      "physical-backup": { items: 0, bytes: 0 },
    };
    let failedItems = 0;
    for (let index = 0; index < plan.candidates.length; index += 1) {
      const candidate = plan.candidates[index] as RetentionCandidate;
      if (!retentionStorageScopeMatches(root, plan.storageScopeDigest)) {
        failedItems += plan.candidates.length - index;
        break;
      }
      const current = candidateIdentity(candidate.absolutePath, candidate.dataClass, artifactRoot(root, candidate.dataClass));
      if (!current
        || current.identityDigest !== candidate.identityDigest
        || !retentionStorageScopeMatches(root, plan.storageScopeDigest)) {
        failedItems += 1;
        continue;
      }
      const currentArtifactRoot = artifactRoot(root, candidate.dataClass);
      const finalPathStats = safeLstat(candidate.absolutePath);
      if (!hasSafeDirectoryChain(currentArtifactRoot, path.dirname(candidate.absolutePath))
        || !finalPathStats
        || finalPathStats.isSymbolicLink()
        || !finalPathStats.isFile()
        || finalPathStats.nlink !== 1
        || retentionPhysicalIdentityDigest(finalPathStats) !== current.physicalIdentityDigest) {
        failedItems += 1;
        continue;
      }
      try {
        unlinkSync(candidate.absolutePath);
        deletedByClass[candidate.dataClass].items += 1;
        deletedByClass[candidate.dataClass].bytes += candidate.bytes;
      } catch {
        failedItems += 1;
      }
    }

    const deleted = (["portable-export", "physical-backup"] as const).map((dataClass) => ({
      dataClass,
      ...deletedByClass[dataClass],
    }));
    const deletedItems = deleted.reduce((sum, item) => sum + item.items, 0);
    const deletedBytes = deleted.reduce((sum, item) => sum + item.bytes, 0);
    const status = failedItems === 0 ? "completed" as const : "partial" as const;
    const completedAt = nowIso();
    const completed = database.transaction(() => stageLedgerEntry(root, database, {
      kind: status === "completed" ? "retention_apply_completed" : "retention_apply_partial",
      actionId: `${runId}:${status}`,
      timestamp: completedAt,
      payload: {
        runId,
        planId: plan.preview.planId,
        startedLedgerHash,
        actor: options.actor,
        reasonDigest,
        status,
        deleted,
        deletedItems,
        deletedBytes,
        failedItems,
        protected: plan.preview.protected,
      },
    }));
    flushLedgerOutbox(root, database);
    return {
      schemaVersion: 1,
      generatedAt: completedAt,
      applied: true,
      status,
      planId: plan.preview.planId,
      actor: options.actor,
      reasonDigest,
      policy: plan.preview.policy,
      deleted,
      deletedItems,
      deletedBytes,
      failedItems,
      protected: plan.preview.protected,
      tombstone: { runId, startedLedgerHash, completedLedgerHash: completed.hash },
      warnings: [
        "Canonical database, audit ledger, immutable review history, and SQLite operational state were not retention targets.",
        ...(failedItems > 0 ? ["Some confirmed artifacts changed or could not be deleted; the immutable tombstone records a partial outcome."] : []),
      ],
    };
  } finally {
    database.close();
  }
}

export function listRetentionTombstones(repoRoot: string): RetentionTombstone[] {
  const { root } = loadConfig(repoRoot);
  retentionStorageScope(root);
  const database = new AtlasDatabase(root, { readOnly: true });
  let relevant: ReturnType<typeof readVerifiedLedgerStateEntries>;
  try {
    relevant = readVerifiedLedgerStateEntries(root, database).filter((entry) => [
      "retention_apply_started",
      "retention_apply_completed",
      "retention_apply_partial",
    ].includes(entry.kind));
  } finally {
    database.close();
  }
  const grouped = new Map<string, RetentionTombstone>();
  for (const entry of relevant) {
    const action = entry.actionId.match(/^(retention_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_([a-f0-9]{16})):(started|completed|partial)$/);
    if (!action) continue;
    const runId = action[1] as string;
    const planDigestPrefix = action[2] as string;
    const actionStatus = action[3] as "started" | "completed" | "partial";
    const expectedKind = `retention_apply_${actionStatus}`;
    if (entry.kind !== expectedKind) continue;
    const current = grouped.get(runId);
    if (entry.kind === "retention_apply_started") {
      grouped.set(runId, {
        runId,
        planDigestPrefix,
        status: current?.status ?? "started",
        startedAt: entry.timestamp,
        completedAt: current?.completedAt ?? null,
        startedLedgerHash: entry.hash,
        completedLedgerHash: current?.completedLedgerHash ?? null,
      });
    } else if (current) {
      current.status = entry.kind === "retention_apply_completed" ? "completed" : "partial";
      current.completedAt = entry.timestamp;
      current.completedLedgerHash = entry.hash;
    }
  }
  return [...grouped.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.runId.localeCompare(right.runId));
}

function buildRetentionPlan(repoRoot: string, options: RetentionPreviewOptions): InternalRetentionPlan {
  const { root } = loadConfig(repoRoot);
  const storageScope = retentionStorageScope(root);
  const atlasRoot = storageScope.atlasRoot;
  const exportThreshold = normalizeRetentionDays(options.portableExportsOlderThanDays, "portableExportsOlderThanDays");
  const backupThreshold = normalizeRetentionDays(options.backupsOlderThanDays, "backupsOlderThanDays");
  const exportsInventory = inventoryTree(path.join(atlasRoot, "exports"), exportThreshold, "portable-export");
  const backupsInventory = inventoryTree(path.join(atlasRoot, "backups"), backupThreshold, "physical-backup");
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
  const candidateManifest = [...exportsInventory.candidates, ...backupsInventory.candidates]
    .sort((left, right) => left.dataClass.localeCompare(right.dataClass) || left.pathDigest.localeCompare(right.pathDigest))
    .map(({ dataClass, pathDigest, identityDigest, bytes }) => ({ dataClass, pathDigest, identityDigest, bytes }));
  const policy = {
    portableExportsOlderThanDays: exportThreshold,
    backupsOlderThanDays: backupThreshold,
  };
  const candidateManifestDigest = sha256(stableStringify(candidateManifest));
  const planId = sha256(stableStringify({
    schemaVersion: 2,
    policy,
    candidateManifestDigest,
    storageScopeDigest: storageScope.scopeDigest,
  }));
  const preview: RetentionPreview = {
    schemaVersion: 2,
    generatedAt: nowIso(),
    applied: false,
    deletionSupported: true,
    planId,
    candidateManifestDigest,
    inventoryComplete: !exportsInventory.truncated && !backupsInventory.truncated,
    policy,
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
      "Preview only: no file was deleted. Apply requires this exact plan ID, an attributed human, a rationale, and explicit confirmation.",
      "Candidate counts are aggregate and paths are represented only by one-way digests so the report cannot disclose sensitive workspace names.",
      ...(exportsInventory.truncated || backupsInventory.truncated
        ? ["Artifact inventory is incomplete because an entry limit, unsafe filesystem object, identity change, or read failure was encountered."]
        : []),
    ],
  };
  return {
    preview,
    candidates: [...exportsInventory.candidates, ...backupsInventory.candidates],
    storageScopeDigest: storageScope.scopeDigest,
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
    "SELECT title, canonical_text, origin_label, purpose FROM external_imports",
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

function inventoryTree(directory: string, thresholdDays: number | null, dataClass: RetentionDataClass): ArtifactInventory {
  const root = path.resolve(directory);
  let rootStats: Stats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return {
      items: 0,
      bytes: 0,
      eligibleItems: 0,
      eligibleBytes: 0,
      truncated: code !== "ENOENT",
      candidates: [],
    };
  }
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return { items: 0, bytes: 0, eligibleItems: 0, eligibleBytes: 0, truncated: true, candidates: [] };
  }
  const stack = [root];
  let items = 0;
  let bytes = 0;
  let eligibleItems = 0;
  let eligibleBytes = 0;
  let truncated = false;
  let visitedEntries = 0;
  const candidates: RetentionCandidate[] = [];
  const now = Date.now();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try { entries = readdirSync(current).sort((left, right) => right.localeCompare(left)); }
    catch { truncated = true; continue; }
    for (const name of entries) {
      if (visitedEntries >= 50_000) { truncated = true; break; }
      visitedEntries += 1;
      const candidate = path.resolve(current, name);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
      const stats = safeLstat(candidate);
      if (!stats) { truncated = true; break; }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) stack.push(candidate);
      else if (stats.isFile()) {
        items += 1;
        bytes += stats.size;
        if (thresholdDays !== null && Math.max(0, now - stats.mtimeMs) >= thresholdDays * 86_400_000) {
          eligibleItems += 1;
          eligibleBytes += stats.size;
          const identity = candidateIdentity(candidate, dataClass, root, stats);
          if (identity) candidates.push(identity);
          else truncated = true;
        }
      }
    }
    if (truncated) break;
  }
  return { items, bytes, eligibleItems, eligibleBytes, truncated, candidates };
}

function artifactRoot(repoRoot: string, dataClass: RetentionDataClass): string {
  return path.join(atlasDirectory(repoRoot), dataClass === "portable-export" ? "exports" : "backups");
}

function candidateIdentity(
  absolutePath: string,
  dataClass: RetentionDataClass,
  rootDirectory: string,
  knownStats?: Stats,
): RetentionCandidate | null {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(absolutePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!hasSafeDirectoryChain(root, path.dirname(candidate))) return null;
  let descriptor: number | null = null;
  try {
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(candidate, constants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile()
      || openedBefore.nlink !== 1
      || (knownStats && !sameFileIdentity(knownStats, openedBefore))) return null;

    const contentHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      contentHash.update(buffer.subarray(0, count));
      bytesRead += count;
    }

    const openedAfter = fstatSync(descriptor);
    const pathStats = safeLstat(candidate);
    if (bytesRead !== openedAfter.size
      || !sameFileIdentity(openedBefore, openedAfter)
      || !pathStats
      || pathStats.isSymbolicLink()
      || !sameFileIdentity(openedAfter, pathStats)
      || !hasSafeDirectoryChain(root, path.dirname(candidate))) {
      return null;
    }
    const normalized = posixPath(relative);
    const pathDigest = sha256(stableStringify({ dataClass, relativePath: normalized }));
    const physicalIdentityDigest = retentionPhysicalIdentityDigest(openedAfter);
    const identityDigest = sha256(stableStringify({
      dataClass,
      pathDigest,
      contentDigest: contentHash.digest("hex"),
      physicalIdentityDigest,
    }));
    return { dataClass, absolutePath: candidate, pathDigest, identityDigest, physicalIdentityDigest, bytes: openedAfter.size };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function retentionStorageScope(repoRoot: string): RetentionStorageScope {
  const logicalRoot = path.resolve(repoRoot);
  const atlasRoot = path.resolve(atlasDirectory(logicalRoot));
  const atlasStats = safeLstat(atlasRoot);
  if (!atlasStats || !atlasStats.isDirectory() || atlasStats.isSymbolicLink()) {
    throw new Error("Retention requires Context Atlas storage to be a regular, non-symlink directory inside the repository.");
  }
  try {
    const physicalRoot = realpathSync(logicalRoot);
    const physicalAtlasRoot = realpathSync(atlasRoot);
    const relative = path.relative(physicalRoot, physicalAtlasRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || posixPath(relative) !== ".context-atlas") {
      throw new Error("unsafe-retention-storage-scope");
    }
    return {
      atlasRoot,
      scopeDigest: sha256(stableStringify({
        physicalRoot,
        physicalAtlasRoot,
        device: atlasStats.dev,
        inode: atlasStats.ino,
      })),
    };
  } catch {
    throw new Error("Retention requires Context Atlas storage to be a regular, non-symlink directory inside the repository.");
  }
}

function retentionStorageScopeMatches(repoRoot: string, expectedDigest: string): boolean {
  try {
    return retentionStorageScope(repoRoot).scopeDigest === expectedDigest;
  } catch {
    return false;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink;
}

function retentionPhysicalIdentityDigest(stats: Stats): string {
  return sha256(stableStringify({
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    mode: stats.mode,
    device: stats.dev,
    inode: stats.ino,
    links: stats.nlink,
  }));
}

function hasSafeDirectoryChain(rootDirectory: string, leafDirectory: string): boolean {
  const root = path.resolve(rootDirectory);
  const leaf = path.resolve(leafDirectory);
  const relative = path.relative(root, leaf);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    const stats = safeLstat(current);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return false;
  }
  return true;
}

function validateRetentionActor(actor: string): void {
  const clean = sanitizeText(actor, 300);
  if (clean.sensitive || clean.value !== actor || !/^human:[a-zA-Z0-9._@-]{1,200}$/.test(actor)) {
    throw new Error("Retention apply requires a valid attributed human: actor.");
  }
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
