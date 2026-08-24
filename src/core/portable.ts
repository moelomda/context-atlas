import { execFileSync } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { atlasDirectory, configPath, loadConfig } from "./config.js";
import { AtlasDatabase } from "./database.js";
import {
  EXTERNAL_IMPORT_EXTRACTOR_VERSION,
  externalImportAuditPayload,
  externalImportEntityId,
  externalImportEventId,
  externalImportRecordDigest,
  externalImportTimelineEvent,
} from "./external-import.js";
import { getRepoStatus } from "./git.js";
import { flushLedgerOutbox, ledgerPath, readVerifiedLedgerEntries, stageLedgerEntry, verifyLedger, verifyLedgerState } from "./ledger.js";
import { findSecrets } from "./security.js";
import type { AssertionRecord, ReviewAction } from "./temporal.js";
import type {
  AtlasConfig,
  EntityRecord,
  EvidenceRecord,
  ExternalImportRecord,
  LedgerEntry,
  ProposalRecord,
  RelationshipRecord,
  TimelineEvent,
} from "./types.js";
import { atomicWriteJson, nowIso, safeJsonParse, sha256, stableStringify } from "./util.js";

export const PORTABLE_FORMAT = "context-atlas-portable-knowledge";
export const PORTABLE_SCHEMA_VERSION = 2 as const;
const MAX_PORTABLE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS_PER_COLLECTION = 1_000_000;

export interface PortableEntity extends EntityRecord {
  versions: Array<{
    version: number;
    snapshot: Record<string, unknown>;
    evidenceIds: string[];
    createdAt: string;
    supersededAt: string | null;
    reason: string;
  }>;
}

export interface PortableReviewAction {
  id: string;
  assertionId: string;
  previousAssertionId: string | null;
  actor: string;
  action: ReviewAction;
  rationale: string | null;
  rationaleDigest: string | null;
  recordedAt: string;
}

/**
 * Repository-portable external-import provenance.
 *
 * The source store's ledger binding and derived record digest are deliberately
 * absent: restoration creates a new local audit entry and binds the immutable
 * record to that entry. The opaque locator digest is safe to carry, while the
 * per-store HMAC salt and host path never enter this format.
 */
export interface PortableExternalImport {
  id: string;
  evidenceId: string;
  sourceKind: ExternalImportRecord["sourceKind"];
  title: string;
  canonicalText: string | null;
  contentDigest: string;
  originKind: ExternalImportRecord["originKind"];
  originLabel: string;
  originLocatorDigest: string;
  sourceIdentityDigest: string;
  sourceObservedAt: string;
  importedAt: string;
  importedBy: string;
  declaredAuthority: ExternalImportRecord["declaredAuthority"];
  sensitivityLabel: ExternalImportRecord["sensitivityLabel"];
  purpose: string;
  policyVersion: string;
  consentId: string;
  consentScopeDigest: string;
  bodyPersistence: "stored" | "omitted_sensitive";
}

export interface PortablePayload {
  format: typeof PORTABLE_FORMAT;
  formatVersion: typeof PORTABLE_SCHEMA_VERSION;
  repository: {
    repositoryId: string;
    objectFormat: "sha1" | "sha256" | "unknown";
    head: string | null;
    defaultBranch: string | null;
    shallow: boolean;
  };
  project: {
    name: string;
    atlasSchemaVersion: number;
    lastSyncedHead: string | null;
    lastSyncedAt: string | null;
    ledgerHead: string | null;
  };
  configuration: AtlasConfig;
  entities: PortableEntity[];
  relationships: RelationshipRecord[];
  events: TimelineEvent[];
  proposals: ProposalRecord[];
  evidence: EvidenceRecord[];
  /** Optional only so already-created schema-2 exports remain verifiable. */
  externalImports?: PortableExternalImport[];
  assertions: AssertionRecord[];
  reviewActions: PortableReviewAction[];
  audit: LedgerEntry[];
  semanticHash: string;
}

export interface PortableExport {
  schemaVersion: typeof PORTABLE_SCHEMA_VERSION;
  exportedAt: string;
  payload: PortablePayload;
  checksum: string;
}

export interface LegacyPortableExport {
  schemaVersion: 1;
  exportedAt: string;
  payload: Record<string, unknown>;
  checksum: string;
}

export type VerifiedPortableExport = PortableExport | LegacyPortableExport;

export interface BackupManifest {
  schemaVersion: 1;
  createdAt: string;
  projectName: string;
  head: string | null;
  repositoryId?: string;
  objectFormat?: "sha1" | "sha256" | "unknown";
  files: Record<string, { bytes: number; sha256: string }>;
}

export interface PortableImportOptions {
  dryRun?: boolean;
  allowRepositoryMismatch?: boolean;
  allowUnreachableHistory?: boolean;
}

export interface PortableImportCollision {
  collection: "evidence" | "externalImports" | "entities" | "proposals" | "assertions" | "reviewActions";
  id: string;
  reason: string;
}

export interface PortableImportCollectionPlan {
  available: number;
  selected: number;
  insert: number;
  identical: number;
}

export interface PortableImportPlan {
  schemaVersion: number | null;
  sourceChecksum: string | null;
  sourceRepositoryId: string | null;
  targetRepositoryId: string;
  repositoryMatch: boolean;
  sourceHeadPresent: boolean | null;
  valid: boolean;
  dryRun: true;
  writesPlanned: number;
  collections: {
    evidence: PortableImportCollectionPlan;
    externalImports: PortableImportCollectionPlan;
    entities: PortableImportCollectionPlan;
    proposals: PortableImportCollectionPlan;
    assertions: PortableImportCollectionPlan;
    reviewActions: PortableImportCollectionPlan;
  };
  excludedDerived: {
    relationships: number;
    events: number;
    pendingProposals: number;
    observedEntitiesNotRequiredByCanonicalKnowledge: number;
    auditEntries: number;
  };
  collisions: PortableImportCollision[];
  errors: string[];
  warnings: string[];
}

export interface PortableImportResult {
  applied: boolean;
  importedAt: string | null;
  plan: PortableImportPlan;
}

export interface RebuildVerificationReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "verification-only";
  sourceValid: boolean;
  repositoryMatch: boolean;
  sourceHeadPresent: boolean | null;
  semanticEquivalent: boolean;
  sourceSemanticHash: string | null;
  currentSemanticHash: string | null;
  collectionCounts: Record<string, { source: number; current: number }>;
  derivedRebuildPerformed: false;
  warnings: string[];
}

type Row = Record<string, unknown>;

export function createPortableExport(repoRoot: string): PortableExport {
  const { root, config } = loadConfig(repoRoot);
  const repository = getRepoStatus(root);
  const database = new AtlasDatabase(root, { readOnly: true });
  try {
    const ledgerVerification = verifyLedgerState(root, database);
    if (!ledgerVerification.consistent || ledgerVerification.unflushedEntries > 0) {
      throw new Error(`Cannot export unreconciled audit state: ${ledgerVerification.error ?? `${ledgerVerification.unflushedEntries} outbox entries require recovery`}.`);
    }
    const entities = database.listEntities({ includeRemoved: true })
      .map((entity) => portableSafeValue({ ...entity, versions: database.listEntityVersions(entity.id) }, root));
    const externalImports = database.listExternalImports().map(portableExternalImport);
    const payloadWithoutSemanticHash = {
      format: PORTABLE_FORMAT,
      formatVersion: PORTABLE_SCHEMA_VERSION,
      repository: {
        repositoryId: repository.repositoryId,
        objectFormat: repository.objectFormat,
        head: repository.head,
        defaultBranch: repository.defaultBranch,
        shallow: repository.shallow,
      },
      project: {
        name: portableSafeValue(config.projectName, root),
        atlasSchemaVersion: Number(database.getMeta("schema_version") ?? config.schemaVersion),
        lastSyncedHead: database.getMeta("last_synced_head"),
        lastSyncedAt: database.getMeta("last_synced_at"),
        ledgerHead: database.getMeta("ledger_head"),
      },
      configuration: portableSafeValue(config, root),
      entities,
      relationships: database.listRelationships(),
      events: portableSafeValue(readAllEvents(database), root),
      proposals: portableSafeValue(database.listProposals(), root),
      evidence: database.listAllEvidence().map((item) => safeEvidence(item, root)),
      externalImports,
      assertions: readAssertions(database),
      reviewActions: readReviewActions(database),
      audit: readVerifiedLedgerEntries(root),
    } satisfies Omit<PortablePayload, "semanticHash">;
    const semanticHash = semanticHashFor(payloadWithoutSemanticHash);
    const payload: PortablePayload = { ...payloadWithoutSemanticHash, semanticHash };
    assertRepositoryRootAbsent(payload, root);
    const validationErrors = validatePortablePayload(payload);
    if (validationErrors.length > 0) throw new Error(`Portable export validation failed: ${validationErrors.join(" ")}`);
    if (Buffer.byteLength(stableStringify(payload), "utf8") > MAX_PORTABLE_BYTES) {
      throw new Error(`Portable export exceeds the ${MAX_PORTABLE_BYTES}-byte safety limit.`);
    }
    const exportedAt = nowIso();
    const checksum = portableChecksum(PORTABLE_SCHEMA_VERSION, exportedAt, payload);
    return { schemaVersion: PORTABLE_SCHEMA_VERSION, exportedAt, payload, checksum };
  } finally {
    database.close();
  }
}

export function writePortableExport(repoRoot: string, destination: string): PortableExport {
  const value = createPortableExport(repoRoot);
  atomicWriteJson(path.resolve(destination), value);
  return value;
}

export function verifyPortableExport(filePath: string): {
  valid: boolean;
  error: string | null;
  export: VerifiedPortableExport | null;
} {
  const loaded = readPortableFile(filePath);
  if (!loaded.value) return { valid: false, error: loaded.error, export: null };
  const value = loaded.value;
  if (value.schemaVersion === 1) {
    const legacy = value as Partial<LegacyPortableExport>;
    if (!legacy.payload || typeof legacy.checksum !== "string" || typeof legacy.exportedAt !== "string") {
      return { valid: false, error: "Export schema is invalid.", export: null };
    }
    const calculated = sha256(stableStringify(legacy.payload));
    if (calculated !== legacy.checksum) return { valid: false, error: "Export checksum mismatch.", export: null };
    return { valid: true, error: null, export: legacy as LegacyPortableExport };
  }
  if (value.schemaVersion !== PORTABLE_SCHEMA_VERSION) {
    return { valid: false, error: `Unsupported portable schema version: ${String(value.schemaVersion)}`, export: null };
  }
  const candidate = value as Partial<PortableExport>;
  if (!candidate.payload || typeof candidate.checksum !== "string" || typeof candidate.exportedAt !== "string") {
    return { valid: false, error: "Export schema is invalid.", export: null };
  }
  const calculated = portableChecksum(PORTABLE_SCHEMA_VERSION, candidate.exportedAt, candidate.payload);
  if (calculated !== candidate.checksum) return { valid: false, error: "Export checksum mismatch.", export: null };
  const validationErrors = validatePortablePayload(candidate.payload);
  if (validationErrors.length > 0) return { valid: false, error: validationErrors.join(" "), export: null };
  return { valid: true, error: null, export: candidate as PortableExport };
}

export function previewPortableImport(
  repoRoot: string,
  sourceFile: string,
  options: Omit<PortableImportOptions, "dryRun"> = {},
): PortableImportPlan {
  const { root } = loadConfig(repoRoot);
  const targetRepository = getRepoStatus(root);
  const empty = emptyImportPlan(targetRepository.repositoryId);
  const verification = verifyPortableExport(sourceFile);
  if (!verification.valid || !verification.export) {
    empty.errors.push(verification.error ?? "Portable export verification failed.");
    return finalizePlan(empty);
  }
  empty.schemaVersion = verification.export.schemaVersion;
  empty.sourceChecksum = verification.export.checksum;
  if (verification.export.schemaVersion !== PORTABLE_SCHEMA_VERSION) {
    empty.errors.push("Portable schema version 1 can be verified but cannot be imported; export it again with Context Atlas schema version 2.");
    return finalizePlan(empty);
  }

  const source = verification.export;
  const payload = source.payload;
  empty.sourceRepositoryId = payload.repository.repositoryId;
  empty.repositoryMatch = payload.repository.repositoryId === targetRepository.repositoryId;
  if (!empty.repositoryMatch) {
    const message = `Source repository ${payload.repository.repositoryId} does not match target repository ${targetRepository.repositoryId}.`;
    if (options.allowRepositoryMismatch) empty.warnings.push(`${message} Explicit mismatch override is active.`);
    else empty.errors.push(message);
  }
  empty.sourceHeadPresent = payload.repository.head ? gitCommitExists(root, payload.repository.head) : null;
  if (empty.sourceHeadPresent === false) {
    const message = `The source head ${payload.repository.head} is not present in the target Git object database; history may have been rewritten or the clone may be incomplete.`;
    if (options.allowUnreachableHistory) empty.warnings.push(`${message} Explicit history override is active.`);
    else empty.errors.push(message);
  }
  if (payload.repository.objectFormat !== targetRepository.objectFormat) {
    empty.errors.push(`Git object format mismatch: source is ${payload.repository.objectFormat}, target is ${targetRepository.objectFormat}.`);
  }

  const database = new AtlasDatabase(root, { readOnly: true });
  try {
    const target = currentCanonicalState(database);
    const selection = selectCanonicalImport(payload, new Set(target.entities.map((item) => item.id)));
    empty.collections.evidence.available = payload.evidence.length;
    empty.collections.evidence.selected = selection.evidence.length;
    empty.collections.externalImports.available = payload.externalImports?.length ?? 0;
    empty.collections.externalImports.selected = selection.externalImports.length;
    empty.collections.entities.available = payload.entities.length;
    empty.collections.entities.selected = selection.entities.length;
    empty.collections.proposals.available = payload.proposals.length;
    empty.collections.proposals.selected = selection.proposals.length;
    empty.collections.assertions.available = payload.assertions.length;
    empty.collections.assertions.selected = selection.assertions.length;
    empty.collections.reviewActions.available = payload.reviewActions.length;
    empty.collections.reviewActions.selected = selection.reviewActions.length;
    empty.excludedDerived = {
      relationships: payload.relationships.length,
      events: payload.events.length,
      pendingProposals: payload.proposals.filter((item) => item.status === "pending").length,
      observedEntitiesNotRequiredByCanonicalKnowledge: payload.entities.length - selection.entities.length,
      auditEntries: payload.audit.length,
    };

    compareSelection("evidence", selection.evidence, target.evidence, empty, evidenceEquivalent);
    compareSelection("externalImports", selection.externalImports, target.externalImports, empty, externalImportEquivalent);
    compareSelection("entities", selection.entities, target.entities, empty, entityEquivalent);
    compareSelection("proposals", selection.proposals, target.proposals, empty, exactRecordEquivalent);
    compareSelection("assertions", selection.assertions, target.assertions, empty, exactRecordEquivalent);
    compareSelection("reviewActions", selection.reviewActions, target.reviewActions, empty, exactRecordEquivalent);

    const targetContentHashes = new Map(target.assertions.map((item) => [item.contentHash, item.id]));
    for (const assertion of selection.assertions) {
      const targetId = targetContentHashes.get(assertion.contentHash);
      if (targetId && targetId !== assertion.id) {
        empty.collisions.push({
          collection: "assertions",
          id: assertion.id,
          reason: `Content hash already belongs to assertion ${targetId}.`,
        });
      }
    }
    const targetEvidenceTuples = new Map(target.evidence.map((item) => [stableStringify([item.kind, item.locator, item.digest]), item.id]));
    for (const evidence of selection.evidence) {
      const tuple = stableStringify([evidence.kind, evidence.locator, evidence.digest]);
      const targetId = targetEvidenceTuples.get(tuple);
      if (targetId && targetId !== evidence.id) {
        empty.collisions.push({ collection: "evidence", id: evidence.id, reason: `The same evidence identity tuple belongs to ${targetId}.` });
      }
    }
    const targetLogicalRevisions = new Map(target.assertions.map((item) => [stableStringify([item.logicalId, item.revision]), item.id]));
    for (const assertion of selection.assertions) {
      const targetId = targetLogicalRevisions.get(stableStringify([assertion.logicalId, assertion.revision]));
      if (targetId && targetId !== assertion.id) {
        empty.collisions.push({ collection: "assertions", id: assertion.id, reason: `Logical revision already belongs to assertion ${targetId}.` });
      }
    }
    inspectExternalImportTargetCollisions(database, selection, target, empty);
    if (!empty.repositoryMatch && selection.externalImports.length > 0) {
      empty.errors.push(
        "External-import provenance cannot be restored across repository identities without a new explicit re-consent flow; the generic repository-mismatch override does not authorize it.",
      );
    }
    empty.warnings.push(
      "Import is canonical-only: relationships, ordinary timeline events, pending generated proposals, and external ledger entries are not copied; selected external imports receive new local audit and timeline bindings.",
    );
    empty.warnings.push(
      "All canonical rows and new external-import audit outbox entries are staged in one SQLite transaction; the recoverable outbox is flushed before and after import.",
    );
  } finally {
    database.close();
  }
  return finalizePlan(empty);
}

export function importPortableExport(
  repoRoot: string,
  sourceFile: string,
  options: PortableImportOptions = {},
): PortableImportResult {
  const plan = previewPortableImport(repoRoot, sourceFile, options);
  if (options.dryRun) return { applied: false, importedAt: null, plan };
  if (!plan.valid) {
    const details = [...plan.errors, ...plan.collisions.map((item) => `${item.collection}/${item.id}: ${item.reason}`)];
    throw new Error(`Portable import refused before writes: ${details.join(" ")}`);
  }
  const verification = verifyPortableExport(sourceFile);
  if (!verification.valid || verification.export?.schemaVersion !== PORTABLE_SCHEMA_VERSION) {
    throw new Error(`Portable import source changed after planning: ${verification.error ?? "unsupported schema"}`);
  }
  if (verification.export.checksum !== plan.sourceChecksum) throw new Error("Portable import source changed after planning.");
  const sourceExport = verification.export;

  const { root } = loadConfig(repoRoot);
  const database = new AtlasDatabase(root);
  const importedAt = nowIso();
  try {
    // Complete any earlier recoverable ledger append before selecting local
    // identities. A later flush failure leaves the newly committed outbox
    // recoverable and a retry remains idempotent.
    flushLedgerOutbox(root, database);
    const target = currentCanonicalState(database);
    const selection = selectCanonicalImport(sourceExport.payload, new Set(target.entities.map((item) => item.id)));
    const insertIds = {
      evidence: idsMissingFrom(selection.evidence, target.evidence),
      externalImports: idsMissingFrom(selection.externalImports, target.externalImports),
      entities: idsMissingFrom(selection.entities, target.entities),
      proposals: idsMissingFrom(selection.proposals, target.proposals),
      assertions: idsMissingFrom(selection.assertions, target.assertions),
      reviewActions: idsMissingFrom(selection.reviewActions, target.reviewActions),
    };
    database.transaction(() => {
      insertEvidence(database, selection.evidence.filter((item) => insertIds.evidence.has(item.id)));
      const restoredExternalImports = selection.externalImports
        .filter((item) => insertIds.externalImports.has(item.id))
        .map((item) => restoreExternalImport(root, database, sourceExport.payload.repository.repositoryId, item));
      insertEntities(database, selection.entities.filter((item) => insertIds.entities.has(item.id)));
      insertProposals(database, selection.proposals.filter((item) => insertIds.proposals.has(item.id)));
      insertAssertions(database, selection.assertions.filter((item) => insertIds.assertions.has(item.id)));
      insertReviewActions(database, selection.reviewActions.filter((item) => insertIds.reviewActions.has(item.id)));
      for (const record of restoredExternalImports) {
        if (!database.insertEvent(externalImportTimelineEvent(record))) {
          throw new Error(`Canonical external-import timeline identity collides for ${externalImportEventId(record.id)}.`);
        }
      }
      database.setMeta("last_portable_import_checksum", sourceExport.checksum);
      database.setMeta("last_portable_import_source_repository", sourceExport.payload.repository.repositoryId);
      database.setMeta("last_portable_import_at", importedAt);
    });
    flushLedgerOutbox(root, database);
  } finally {
    database.close();
  }
  return { applied: true, importedAt, plan };
}

export function createRebuildVerificationReport(repoRoot: string, sourceFile: string): RebuildVerificationReport {
  const verification = verifyPortableExport(sourceFile);
  const current = createPortableExport(repoRoot);
  const source = verification.export?.schemaVersion === PORTABLE_SCHEMA_VERSION ? verification.export : null;
  const repositoryMatch = source?.payload.repository.repositoryId === current.payload.repository.repositoryId;
  const sourceHeadPresent = source?.payload.repository.head
    ? gitCommitExists(loadConfig(repoRoot).root, source.payload.repository.head)
    : null;
  const names = ["entities", "relationships", "events", "proposals", "evidence", "externalImports", "assertions", "reviewActions", "audit"] as const;
  const collectionCounts = Object.fromEntries(names.map((name) => [name, {
    source: source?.payload[name]?.length ?? 0,
    current: current.payload[name]?.length ?? 0,
  }]));
  const warnings: string[] = [];
  if (!verification.valid) warnings.push(verification.error ?? "Source export is invalid.");
  if (verification.export?.schemaVersion === 1) warnings.push("Legacy schema version 1 has no canonical semantic hash and cannot be compared exactly.");
  if (!repositoryMatch) warnings.push("Repository identity differs; semantic equality would not establish source lineage.");
  if (sourceHeadPresent === false) warnings.push("Source Git head is absent; possible history rewrite or incomplete clone detected.");
  warnings.push("This report verifies exact exported state only; it does not execute or certify a derived-index rebuild.");
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    mode: "verification-only",
    sourceValid: verification.valid,
    repositoryMatch,
    sourceHeadPresent,
    semanticEquivalent: Boolean(source && source.payload.semanticHash === current.payload.semanticHash),
    sourceSemanticHash: source?.payload.semanticHash ?? null,
    currentSemanticHash: current.payload.semanticHash,
    collectionCounts,
    derivedRebuildPerformed: false,
    warnings,
  };
}

export async function createBackup(repoRoot: string, destination: string): Promise<BackupManifest> {
  const { root, config } = loadConfig(repoRoot);
  const repository = getRepoStatus(root);
  const target = path.resolve(destination);
  if (existsSync(target)) throw new Error(`Backup destination already exists: ${target}`);
  const recoveryDatabase = new AtlasDatabase(root);
  try { flushLedgerOutbox(root, recoveryDatabase); }
  finally { recoveryDatabase.close(); }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const database = new AtlasDatabase(root, { readOnly: true });
  try {
    await backup(database.db, path.join(target, "atlas.db"));
    copyFileSync(configPath(root), path.join(target, "config.json"));
    if (existsSync(ledgerPath(root))) copyFileSync(ledgerPath(root), path.join(target, "ledger.ndjson"));
    const portable = createPortableExport(root);
    atomicWriteJson(path.join(target, "knowledge-export.json"), portable);
    const filenames = ["atlas.db", "config.json", "knowledge-export.json", ...(existsSync(path.join(target, "ledger.ndjson")) ? ["ledger.ndjson"] : [])];
    const files = Object.fromEntries(filenames.map((filename) => {
      const file = path.join(target, filename);
      return [filename, { bytes: statSync(file).size, sha256: sha256(readFileSync(file)) }];
    }));
    const project = database.listEntities({ types: ["project"] })[0];
    const manifest: BackupManifest = {
      schemaVersion: 1,
      createdAt: nowIso(),
      projectName: config.projectName,
      head: typeof project?.payload.head === "string" ? project.payload.head : null,
      repositoryId: repository.repositoryId,
      objectFormat: repository.objectFormat,
      files,
    };
    atomicWriteJson(path.join(target, "backup-manifest.json"), manifest);
    return manifest;
  } finally {
    database.close();
  }
}

export function verifyBackup(directory: string): { valid: boolean; errors: string[]; manifest: BackupManifest | null } {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "backup-manifest.json");
  if (!existsSync(manifestPath)) return { valid: false, errors: ["backup-manifest.json is missing."], manifest: null };
  const manifest = safeJsonParse<BackupManifest | null>(readFileSync(manifestPath, "utf8"), null);
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.files) return { valid: false, errors: ["Backup manifest schema is invalid."], manifest: null };
  const errors: string[] = [];
  for (const [filename, expected] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) { errors.push(`Unsafe filename in manifest: ${filename}`); continue; }
    const file = path.join(root, filename);
    if (!existsSync(file)) { errors.push(`${filename} is missing.`); continue; }
    const actual = { bytes: statSync(file).size, sha256: sha256(readFileSync(file)) };
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) errors.push(`${filename} failed its checksum.`);
  }
  if (errors.length === 0) {
    try {
      const db = new DatabaseSync(path.join(root, "atlas.db"), { readOnly: true, allowExtension: false });
      const result = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      db.close();
      if (String(Object.values(result)[0]) !== "ok") errors.push("Backup SQLite integrity check failed.");
    } catch (error) {
      errors.push(`Backup database cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
    const portableCheck = verifyPortableExport(path.join(root, "knowledge-export.json"));
    if (!portableCheck.valid) errors.push(portableCheck.error ?? "Portable knowledge export is invalid.");
  }
  return { valid: errors.length === 0, errors, manifest };
}

export async function restoreBackup(repoRoot: string, backupDirectory: string, confirmation: string): Promise<{ restored: true; recoveryBackup: string }> {
  if (confirmation !== "RESTORE") throw new Error("Restore requires the exact confirmation token RESTORE.");
  const verification = verifyBackup(backupDirectory);
  if (!verification.valid) throw new Error(`Backup verification failed: ${verification.errors.join(" ")}`);
  const recoveryBackup = path.join(atlasDirectory(repoRoot), "backups", `pre-restore-${nowIso().replace(/[:.]/g, "-")}`);
  await createBackup(repoRoot, recoveryBackup);

  const source = path.resolve(backupDirectory);
  const atlasRoot = atlasDirectory(repoRoot);
  copyFileSync(path.join(source, "atlas.db"), path.join(atlasRoot, "atlas.db"));
  copyFileSync(path.join(source, "config.json"), path.join(atlasRoot, "config.json"));
  if (existsSync(path.join(source, "ledger.ndjson"))) copyFileSync(path.join(source, "ledger.ndjson"), path.join(atlasRoot, "ledger.ndjson"));

  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    database.transaction(() => {
      stageLedgerEntry(repoRoot, database, {
        kind: "backup_restored",
        actionId: `restore_${Date.now()}`,
        payload: { backupManifest: sha256(readFileSync(path.join(source, "backup-manifest.json"))) },
      });
    });
    flushLedgerOutbox(repoRoot, database);
  } finally {
    database.close();
  }
  return { restored: true, recoveryBackup };
}

function readPortableFile(filePath: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(filePath)) return { value: null, error: "Export file does not exist." };
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return { value: null, error: "Export must be a regular, non-symlink file." };
    if (stats.size > MAX_PORTABLE_BYTES) return { value: null, error: `Export exceeds the ${MAX_PORTABLE_BYTES}-byte safety limit.` };
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) return { value: null, error: "Export root must be a JSON object." };
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: `Export cannot be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function validatePortablePayload(payload: PortablePayload): string[] {
  const errors: string[] = [];
  if (!isRecord(payload) || payload.format !== PORTABLE_FORMAT || payload.formatVersion !== PORTABLE_SCHEMA_VERSION) {
    return ["Portable payload format is invalid."];
  }
  try { inspectJsonTree(payload); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const arrays = ["entities", "relationships", "events", "proposals", "evidence", "assertions", "reviewActions", "audit"] as const;
  for (const name of arrays) {
    if (!Array.isArray(payload[name])) errors.push(`Portable payload ${name} must be an array.`);
    else if (payload[name].length > MAX_RECORDS_PER_COLLECTION) errors.push(`Portable payload ${name} exceeds its record limit.`);
  }
  if (payload.externalImports !== undefined) {
    if (!Array.isArray(payload.externalImports)) errors.push("Portable payload externalImports must be an array when present.");
    else if (payload.externalImports.length > MAX_RECORDS_PER_COLLECTION) errors.push("Portable payload externalImports exceeds its record limit.");
  }
  if (errors.length > 0) return errors;
  const externalImports = payload.externalImports ?? [];
  if (!isRecord(payload.repository) || !validId(payload.repository.repositoryId) || !["sha1", "sha256", "unknown"].includes(String(payload.repository.objectFormat))) {
    errors.push("Portable repository identity is invalid.");
  }
  if (!isRecord(payload.configuration) || payload.configuration.repoRoot !== "." || !Array.isArray(payload.configuration.excludedPaths)) {
    errors.push("Portable configuration is invalid.");
  }
  if (typeof payload.semanticHash !== "string" || payload.semanticHash !== semanticHashFor(payload)) {
    errors.push("Portable semantic hash mismatch.");
  }
  try { assertSecretFree(payload, "Portable payload"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }

  validateUniqueRecords(payload.evidence, "evidence", errors);
  validateUniqueRecords(externalImports, "externalImports", errors);
  validateUniqueRecords(payload.entities, "entities", errors);
  validateUniqueRecords(payload.relationships, "relationships", errors);
  validateUniqueRecords(payload.events, "events", errors);
  validateUniqueRecords(payload.proposals, "proposals", errors);
  validateUniqueRecords(payload.assertions, "assertions", errors);
  validateUniqueRecords(payload.reviewActions, "reviewActions", errors);
  const evidenceIds = idSet(payload.evidence);
  const entityIds = idSet(payload.entities);
  const assertionIds = idSet(payload.assertions);
  const externalImportEvidenceIds = new Set(externalImports.map((item) => item.evidenceId));
  const evidenceIdentityTuples = new Set<string>();

  for (const evidence of payload.evidence) {
    if (!validId(evidence.id) || !validText(evidence.kind, 200) || !validText(evidence.locator, 2_000)
      || !/^[a-f0-9]{32,128}$/i.test(String(evidence.digest)) || !validTimestamp(evidence.observedAt)
      || typeof evidence.sensitive !== "boolean" || !isRecord(evidence.metadata)) {
      errors.push(`Invalid evidence record: ${String(evidence.id)}`);
    }
    if (evidence.sensitive && !String(evidence.locator).startsWith("[withheld:") && !externalImportEvidenceIds.has(evidence.id)) {
      errors.push(`Sensitive evidence locator is not withheld: ${String(evidence.id)}`);
    }
    const tuple = stableStringify([evidence.kind, evidence.locator, evidence.digest]);
    if (evidenceIdentityTuples.has(tuple)) errors.push(`Duplicate evidence identity tuple: ${String(evidence.id)}`);
    evidenceIdentityTuples.add(tuple);
  }
  for (const entity of payload.entities) {
    if (!validId(entity.id) || !validText(entity.type, 200) || !validText(entity.title, 5_000)
      || !validText(entity.summary, 100_000) || !["active", "stale", "superseded", "removed"].includes(String(entity.status))
      || !["observed", "documented", "approved", "inferred"].includes(String(entity.confidence))
      || !validTimestamp(entity.firstSeen) || !validTimestamp(entity.lastSeen) || !Number.isInteger(entity.staleAfterDays)
      || !isRecord(entity.payload) || !Array.isArray(entity.versions)) {
      errors.push(`Invalid entity record: ${String(entity.id)}`);
    }
    if (entity.primaryEvidenceId && !evidenceIds.has(entity.primaryEvidenceId)) errors.push(`Entity ${entity.id} references missing primary evidence.`);
    const versions = new Set<number>();
    for (const version of entity.versions ?? []) {
      if (!Number.isInteger(version.version) || version.version < 1 || !isRecord(version.snapshot)
        || !Array.isArray(version.evidenceIds) || !validTimestamp(version.createdAt)
        || (version.supersededAt !== null && !validTimestamp(version.supersededAt)) || !validText(version.reason, 5_000)) {
        errors.push(`Entity ${entity.id} has an invalid version.`);
      }
      if (versions.has(version.version)) errors.push(`Entity ${entity.id} repeats version ${version.version}.`);
      versions.add(version.version);
      for (const evidenceId of version.evidenceIds ?? []) if (!evidenceIds.has(evidenceId)) errors.push(`Entity ${entity.id} version references missing evidence ${evidenceId}.`);
    }
  }
  for (const relationship of payload.relationships) {
    if (!validId(relationship.id) || !entityIds.has(relationship.sourceId) || !entityIds.has(relationship.targetId)
      || (relationship.evidenceId !== null && !evidenceIds.has(relationship.evidenceId))) {
      errors.push(`Invalid relationship record: ${String(relationship.id)}`);
    }
  }
  for (const event of payload.events) {
    if (!validId(event.id) || !validTimestamp(event.timestamp) || !Array.isArray(event.evidence)
      || event.evidence.some((id) => !evidenceIds.has(id))) errors.push(`Invalid event record: ${String(event.id)}`);
  }
  validateExternalImportProvenance(payload, externalImports, errors);
  for (const proposal of payload.proposals) {
    if (!validId(proposal.id) || !["pending", "approved", "rejected", "superseded"].includes(String(proposal.status))
      || !validText(proposal.kind, 200) || !validText(proposal.title, 5_000) || !validText(proposal.summary, 100_000)
      || !isRecord(proposal.payload) || !Array.isArray(proposal.evidenceIds) || !Array.isArray(proposal.riskFlags)
      || !validTimestamp(proposal.createdAt) || (proposal.reviewedAt !== null && !validTimestamp(proposal.reviewedAt))
      || (proposal.targetId !== null && !entityIds.has(proposal.targetId)) || proposal.evidenceIds.some((id) => !evidenceIds.has(id))) {
      errors.push(`Invalid proposal record: ${String(proposal.id)}`);
    }
  }
  const assertionsByLogicalId = new Map<string, AssertionRecord[]>();
  for (const assertion of payload.assertions) {
    const canonical = assertionCanonicalContent(assertion);
    if (!validId(assertion.id) || !validId(assertion.logicalId) || !entityIds.has(assertion.subjectId)
      || !Number.isInteger(assertion.revision) || assertion.revision < 1
      || !validText(assertion.predicate, 160) || !validText(assertion.scope, 300) || !validText(assertion.producer, 300)
      || !["observed", "derived", "documented", "human", "inferred"].includes(String(assertion.authority))
      || !["observed", "documented", "approved", "inferred"].includes(String(assertion.confidence))
      || !["proposed", "accepted", "rejected", "superseded", "withdrawn", "stale", "conflicting"].includes(String(assertion.lifecycle))
      || !["unreviewed", "accepted", "rejected"].includes(String(assertion.reviewState))
      || !validTimestamp(assertion.validFrom) || (assertion.validTo !== null && !validTimestamp(assertion.validTo))
      || (assertion.validTo !== null && assertion.validTo <= assertion.validFrom) || !validTimestamp(assertion.recordedAt)
      || !isRecord(assertion.metadata) || !Array.isArray(assertion.evidence)
      || assertion.evidence.some((item) => !["support", "contradict", "context"].includes(String(item.role)))
      || assertion.evidence.some((item) => !evidenceIds.has(item.evidenceId))
      || sha256(stableStringify(canonical)) !== assertion.contentHash
      || assertion.id !== `assertion_${assertion.contentHash.slice(0, 32)}`) {
      errors.push(`Invalid assertion record: ${String(assertion.id)}`);
    }
    if (assertion.supersedesId !== null && !assertionIds.has(assertion.supersedesId)) errors.push(`Assertion ${assertion.id} has a missing predecessor.`);
    const group = assertionsByLogicalId.get(assertion.logicalId) ?? [];
    group.push(assertion);
    assertionsByLogicalId.set(assertion.logicalId, group);
  }
  for (const [logicalId, group] of assertionsByLogicalId) {
    const ordered = [...group].sort((left, right) => left.revision - right.revision);
    for (let index = 0; index < ordered.length; index += 1) {
      const assertion = ordered[index] as AssertionRecord;
      const previous = ordered[index - 1] ?? null;
      if (assertion.revision !== index + 1) errors.push(`Assertion history ${logicalId} has a revision gap.`);
      if (assertion.supersedesId !== (previous?.id ?? null)) errors.push(`Assertion history ${logicalId} has an invalid predecessor chain.`);
      if (previous && (assertion.subjectId !== previous.subjectId || assertion.predicate !== previous.predicate || assertion.scope !== previous.scope)) {
        errors.push(`Assertion history ${logicalId} changes its subject, predicate, or scope.`);
      }
    }
  }
  for (const review of payload.reviewActions) {
    if (!validId(review.id) || !assertionIds.has(review.assertionId)
      || (review.previousAssertionId !== null && !assertionIds.has(review.previousAssertionId))
      || !validText(review.actor, 300)
      || !["propose", "accept", "edit_accept", "reject", "defer", "withdraw", "supersede", "mark_stale", "mark_conflict"].includes(String(review.action))
      || !validTimestamp(review.recordedAt)
      || (review.rationaleDigest !== null && !/^[a-f0-9]{64}$/i.test(review.rationaleDigest))
      || (Boolean(review.rationale) && review.rationaleDigest !== sha256(review.rationale as string))
      || (!review.rationale && review.rationaleDigest !== null)) {
      errors.push(`Invalid review action: ${String(review.id)}`);
    }
  }
  validateAuditChain(payload.audit, payload.project.ledgerHead, errors);
  return [...new Set(errors)].slice(0, 1_000);
}

function semanticHashFor(payload: Omit<PortablePayload, "semanticHash"> | PortablePayload): string {
  return sha256(stableStringify({
    configuration: payload.configuration,
    entities: payload.entities,
    relationships: payload.relationships,
    events: payload.events,
    proposals: payload.proposals,
    evidence: payload.evidence,
    externalImports: payload.externalImports ?? [],
    assertions: payload.assertions,
    reviewActions: payload.reviewActions,
    audit: payload.audit,
  }));
}

function portableChecksum(schemaVersion: number, exportedAt: string, payload: unknown): string {
  return sha256(stableStringify({ schemaVersion, exportedAt, payload }));
}

function readAssertions(database: AtlasDatabase): AssertionRecord[] {
  const rows = database.db.prepare("SELECT * FROM assertions ORDER BY logical_id, revision, id").all() as Row[];
  return rows.map((row) => {
    const evidence = database.db.prepare("SELECT evidence_id, role FROM assertion_evidence WHERE assertion_id = ? ORDER BY role, evidence_id")
      .all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      logicalId: String(row.logical_id),
      revision: Number(row.revision),
      subjectId: String(row.subject_id),
      predicate: String(row.predicate),
      value: safeJsonParse<unknown>(String(row.value_json), null),
      scope: String(row.scope),
      authority: String(row.authority) as AssertionRecord["authority"],
      confidence: String(row.confidence) as AssertionRecord["confidence"],
      producer: String(row.producer),
      lifecycle: String(row.lifecycle) as AssertionRecord["lifecycle"],
      reviewState: String(row.review_state) as AssertionRecord["reviewState"],
      validFrom: String(row.valid_from),
      validTo: row.valid_to === null ? null : String(row.valid_to),
      recordedAt: String(row.recorded_at),
      supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id),
      contentHash: String(row.content_hash),
      metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {}),
      evidence: evidence.map((item) => ({
        evidenceId: String(item.evidence_id),
        role: String(item.role) as AssertionRecord["evidence"][number]["role"],
      })),
    };
  });
}

function readReviewActions(database: AtlasDatabase): PortableReviewAction[] {
  return (database.db.prepare("SELECT * FROM review_actions ORDER BY recorded_at, id").all() as Row[]).map((row) => ({
    id: String(row.id),
    assertionId: String(row.assertion_id),
    previousAssertionId: row.previous_assertion_id === null ? null : String(row.previous_assertion_id),
    actor: String(row.actor),
    action: String(row.action) as ReviewAction,
    rationale: row.rationale === null ? null : String(row.rationale),
    rationaleDigest: row.rationale_digest === null ? null : String(row.rationale_digest),
    recordedAt: String(row.recorded_at),
  }));
}

function readAllEvents(database: AtlasDatabase): TimelineEvent[] {
  return (database.db.prepare("SELECT * FROM events ORDER BY timestamp DESC, id").all() as Row[]).map((row) => ({
    id: String(row.id),
    timestamp: String(row.timestamp),
    type: String(row.type),
    title: String(row.title),
    summary: String(row.summary),
    commit: row.commit_hash === null ? null : String(row.commit_hash),
    files: safeJsonParse<TimelineEvent["files"]>(String(row.files_json), []),
    evidence: safeJsonParse<string[]>(String(row.evidence_ids_json), []),
    ledgerHash: row.ledger_hash === null ? null : String(row.ledger_hash),
  }));
}

function safeEvidence(evidence: EvidenceRecord, repoRoot: string): EvidenceRecord {
  if (!evidence.sensitive) return portableSafeValue(evidence, repoRoot);
  // atlas-import locators are content-addressed local identifiers, not host
  // paths. Preserve them so a metadata-only sensitive import remains
  // resolvable after restore; its body is still omitted below.
  if (evidence.locator.startsWith("atlas-import:")) return portableSafeValue(evidence, repoRoot);
  const categories = Array.isArray(evidence.metadata.secretFindingKinds)
    ? evidence.metadata.secretFindingKinds.filter((item): item is string => typeof item === "string" && validText(item, 100))
    : [];
  const reason = typeof evidence.metadata.reason === "string" && validText(evidence.metadata.reason, 100)
    ? evidence.metadata.reason
    : "sensitive-content-policy";
  return {
    ...evidence,
    locator: `[withheld:${sha256(evidence.locator).slice(0, 20)}]`,
    metadata: { withheld: true, reason, secretFindingKinds: categories },
  };
}

function portableSafeValue<T>(value: T, repoRoot: string): T {
  if (typeof value === "string") {
    const escaped = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(escaped, "gi"), "[repository]") as T;
  }
  if (Array.isArray(value)) return value.map((item) => portableSafeValue(item, repoRoot)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, portableSafeValue(child, repoRoot)])) as T;
  }
  return value;
}

function assertRepositoryRootAbsent(value: unknown, repoRoot: string): void {
  const serialized = stableStringify(value).toLowerCase();
  if (serialized.includes(repoRoot.toLowerCase())) throw new Error("Portable export contains an absolute repository path.");
}

function currentCanonicalState(database: AtlasDatabase): {
  evidence: EvidenceRecord[];
  externalImports: PortableExternalImport[];
  entities: PortableEntity[];
  proposals: ProposalRecord[];
  assertions: AssertionRecord[];
  reviewActions: PortableReviewAction[];
} {
  return {
    evidence: database.listAllEvidence(),
    externalImports: database.listExternalImports().map(portableExternalImport),
    entities: database.listEntities({ includeRemoved: true }).map((item) => ({ ...item, versions: database.listEntityVersions(item.id) })),
    proposals: database.listProposals(),
    assertions: readAssertions(database),
    reviewActions: readReviewActions(database),
  };
}

function selectCanonicalImport(payload: PortablePayload, targetEntityIds: Set<string>): {
  evidence: EvidenceRecord[];
  externalImports: PortableExternalImport[];
  entities: PortableEntity[];
  proposals: ProposalRecord[];
  assertions: AssertionRecord[];
  reviewActions: PortableReviewAction[];
} {
  const proposals = payload.proposals.filter((item) => item.status !== "pending");
  const assertions = payload.assertions;
  const reviewActions = payload.reviewActions;
  const availableExternalImports = payload.externalImports ?? [];
  const requiredEntityIds = new Set<string>();
  const evidenceIds = new Set<string>();
  // Explicitly selected external imports are canonical human knowledge, not a
  // derived cache. Preserve every import for a same-repository transfer even
  // when it has not yet been promoted into an accepted assertion.
  for (const imported of availableExternalImports) {
    requiredEntityIds.add(externalImportEntityId(imported.sourceKind, imported.id));
    evidenceIds.add(imported.evidenceId);
  }
  for (const entity of payload.entities) if (entity.source === "human_approved" || entity.confidence === "approved") requiredEntityIds.add(entity.id);
  for (const proposal of proposals) {
    if (proposal.targetId && !targetEntityIds.has(proposal.targetId)) requiredEntityIds.add(proposal.targetId);
    for (const id of proposal.evidenceIds) evidenceIds.add(id);
  }
  for (const assertion of assertions) {
    if (!targetEntityIds.has(assertion.subjectId)) requiredEntityIds.add(assertion.subjectId);
    for (const item of assertion.evidence) evidenceIds.add(item.evidenceId);
  }

  // Close the selection over external-import provenance. An explicitly
  // imported source is restored only when canonical knowledge selects its
  // entity or evidence, and selecting the import in turn selects both of its
  // canonical projections.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of payload.entities) {
      if (!requiredEntityIds.has(entity.id)) continue;
      if (entity.primaryEvidenceId && !evidenceIds.has(entity.primaryEvidenceId)) {
        evidenceIds.add(entity.primaryEvidenceId);
        changed = true;
      }
      for (const version of entity.versions) {
        for (const id of version.evidenceIds) {
          if (!evidenceIds.has(id)) {
            evidenceIds.add(id);
            changed = true;
          }
        }
      }
    }
    for (const imported of availableExternalImports) {
      const entityId = externalImportEntityId(imported.sourceKind, imported.id);
      if (!requiredEntityIds.has(entityId) && !evidenceIds.has(imported.evidenceId)) continue;
      if (!requiredEntityIds.has(entityId)) {
        requiredEntityIds.add(entityId);
        changed = true;
      }
      if (!evidenceIds.has(imported.evidenceId)) {
        evidenceIds.add(imported.evidenceId);
        changed = true;
      }
    }
  }
  const entities = payload.entities.filter((item) => requiredEntityIds.has(item.id));
  const externalImports = availableExternalImports.filter((item) => (
    requiredEntityIds.has(externalImportEntityId(item.sourceKind, item.id)) || evidenceIds.has(item.evidenceId)
  ));
  return {
    evidence: payload.evidence.filter((item) => evidenceIds.has(item.id)),
    externalImports,
    entities,
    proposals,
    assertions,
    reviewActions,
  };
}

function compareSelection<T extends { id: string }>(
  collection: PortableImportCollision["collection"],
  source: T[],
  target: T[],
  plan: PortableImportPlan,
  equivalent: (sourceItem: T, targetItem: T) => boolean,
): void {
  const targetById = new Map(target.map((item) => [item.id, item]));
  for (const item of source) {
    const existing = targetById.get(item.id);
    if (!existing) plan.collections[collection].insert += 1;
    else if (equivalent(item, existing)) plan.collections[collection].identical += 1;
    else plan.collisions.push({ collection, id: item.id, reason: "The target already contains a different record with this canonical ID." });
  }
}

function evidenceEquivalent(source: EvidenceRecord, target: EvidenceRecord): boolean {
  return source.id === target.id && source.kind === target.kind && source.digest === target.digest && source.sensitive === target.sensitive
    && (source.sensitive || source.locator === target.locator);
}

function portableExternalImport(record: ExternalImportRecord): PortableExternalImport {
  const sensitive = record.sensitivityLabel === "sensitive";
  if (sensitive && record.canonicalText !== null) {
    throw new Error(`Sensitive external import ${record.id} unexpectedly contains a persisted body.`);
  }
  if (!sensitive && (record.canonicalText === null || sha256(record.canonicalText) !== record.contentDigest)) {
    throw new Error(`External import ${record.id} does not match its persisted content digest.`);
  }
  return {
    id: record.id,
    evidenceId: record.evidenceId,
    sourceKind: record.sourceKind,
    title: record.title,
    canonicalText: sensitive ? null : record.canonicalText,
    contentDigest: record.contentDigest,
    originKind: record.originKind,
    originLabel: record.originLabel,
    originLocatorDigest: record.originLocatorDigest,
    sourceIdentityDigest: record.sourceIdentityDigest,
    sourceObservedAt: record.sourceObservedAt,
    importedAt: record.importedAt,
    importedBy: record.importedBy,
    declaredAuthority: record.declaredAuthority,
    sensitivityLabel: record.sensitivityLabel,
    purpose: record.purpose,
    policyVersion: record.policyVersion,
    consentId: record.consentId,
    consentScopeDigest: record.consentScopeDigest,
    bodyPersistence: sensitive ? "omitted_sensitive" : "stored",
  };
}

function externalImportEquivalent(source: PortableExternalImport, target: PortableExternalImport): boolean {
  return stableStringify(source) === stableStringify(target);
}

function validateExternalImportProvenance(
  payload: PortablePayload,
  imports: PortableExternalImport[],
  errors: string[],
): void {
  const evidenceById = new Map(payload.evidence.map((item) => [item.id, item]));
  const entityById = new Map(payload.entities.map((item) => [item.id, item]));
  const consentIds = new Set<string>();
  for (const item of imports) {
    const locator = `atlas-import:${item.id}`;
    const expectedEvidenceId = `evidence_${sha256(`${item.sourceKind}\0${locator}\0${item.contentDigest}`).slice(0, 32)}`;
    const evidence = evidenceById.get(item.evidenceId);
    const entity = entityById.get(externalImportEntityId(item.sourceKind, item.id));
    const sensitive = item.sensitivityLabel === "sensitive";
    const validBody = sensitive
      ? item.canonicalText === null && item.bodyPersistence === "omitted_sensitive"
      : typeof item.canonicalText === "string" && item.bodyPersistence === "stored"
        && sha256(item.canonicalText) === item.contentDigest;
    const validShape = /^import_[a-f0-9]{32}$/.test(item.id)
      && item.evidenceId === expectedEvidenceId
      && ["external_document", "conversation_summary"].includes(item.sourceKind)
      && validText(item.title, 5_000)
      && /^[a-f0-9]{64}$/.test(item.contentDigest)
      && item.originKind === "local_file"
      && validText(item.originLabel, 1_000)
      && /^[a-f0-9]{64}$/.test(item.originLocatorDigest)
      && /^[a-f0-9]{64}$/.test(item.sourceIdentityDigest)
      && validTimestamp(item.sourceObservedAt)
      && validTimestamp(item.importedAt)
      && /^human:[a-zA-Z0-9._@-]{1,200}$/.test(item.importedBy)
      && ["documented", "human", "unknown"].includes(item.declaredAuthority)
      && ["normal", "sensitive"].includes(item.sensitivityLabel)
      && validText(item.purpose, 2_000)
      && validText(item.policyVersion, 200)
      && /^consent_[a-f0-9]{32}$/.test(item.consentId)
      && /^[a-f0-9]{64}$/.test(item.consentScopeDigest)
      && validBody;
    if (!validShape) errors.push(`Invalid external import record: ${String(item.id)}`);
    if (consentIds.has(item.consentId)) errors.push(`Duplicate external import consent identity: ${item.consentId}`);
    consentIds.add(item.consentId);
    if (!evidence
      || evidence.kind !== item.sourceKind
      || evidence.locator !== locator
      || evidence.digest !== item.contentDigest
      || evidence.observedAt !== item.importedAt
      || evidence.sensitive !== sensitive
      || evidence.metadata.importId !== item.id
      || evidence.metadata.bodyPersistence !== item.bodyPersistence
      || evidence.metadata.extractorVersion !== EXTERNAL_IMPORT_EXTRACTOR_VERSION) {
      errors.push(`External import ${item.id} does not match its canonical evidence projection.`);
    }
    if (!entity || entity.type !== item.sourceKind || entity.primaryEvidenceId !== item.evidenceId
      || entity.payload.importId !== item.id || entity.payload.untrustedExternalInput !== true
      || entity.payload.bodyPersistence !== item.bodyPersistence) {
      errors.push(`External import ${item.id} does not match its canonical entity projection.`);
    }
  }
}

function inspectExternalImportTargetCollisions(
  database: AtlasDatabase,
  selection: ReturnType<typeof selectCanonicalImport>,
  target: ReturnType<typeof currentCanonicalState>,
  plan: PortableImportPlan,
): void {
  const targetConsent = new Map(target.externalImports.map((item) => [item.consentId, item.id]));
  for (const item of selection.externalImports) {
    const conflictingId = targetConsent.get(item.consentId);
    if (conflictingId && conflictingId !== item.id) {
      plan.collisions.push({
        collection: "externalImports",
        id: item.id,
        reason: `Consent identity already belongs to external import ${conflictingId}.`,
      });
    }
    const existingByEvidence = database.getExternalImportByEvidence(item.evidenceId);
    if (existingByEvidence && existingByEvidence.id !== item.id) {
      plan.collisions.push({
        collection: "externalImports",
        id: item.id,
        reason: `Evidence identity already belongs to external import ${existingByEvidence.id}.`,
      });
    }
  }
}

function restoreExternalImport(
  repoRoot: string,
  database: AtlasDatabase,
  repositoryId: string,
  item: PortableExternalImport,
): ExternalImportRecord {
  const provisional: ExternalImportRecord = {
    id: item.id,
    evidenceId: item.evidenceId,
    sourceKind: item.sourceKind,
    title: item.title,
    canonicalText: item.bodyPersistence === "stored" ? item.canonicalText : null,
    contentDigest: item.contentDigest,
    originKind: item.originKind,
    originLabel: item.originLabel,
    originLocatorDigest: item.originLocatorDigest,
    sourceIdentityDigest: item.sourceIdentityDigest,
    sourceObservedAt: item.sourceObservedAt,
    importedAt: item.importedAt,
    importedBy: item.importedBy,
    declaredAuthority: item.declaredAuthority,
    sensitivityLabel: item.sensitivityLabel,
    purpose: item.purpose,
    policyVersion: item.policyVersion,
    consentId: item.consentId,
    consentScopeDigest: item.consentScopeDigest,
    ledgerHash: "0".repeat(64),
    recordDigest: "",
  };
  const eventId = externalImportEventId(item.id);
  const ledger = stageLedgerEntry(repoRoot, database, {
    kind: "external_import_event",
    actionId: eventId,
    payload: externalImportAuditPayload(provisional, repositoryId),
  });
  const record: ExternalImportRecord = { ...provisional, ledgerHash: ledger.hash, recordDigest: "" };
  record.recordDigest = externalImportRecordDigest(record);
  database.insertExternalImport(record);
  return record;
}

function entityEquivalent(source: PortableEntity, target: PortableEntity): boolean {
  return stableStringify({
    type: source.type,
    title: source.title,
    summary: source.summary,
    status: source.status,
    confidence: source.confidence,
    source: source.source,
    staleAfterDays: source.staleAfterDays,
    payload: source.payload,
    primaryEvidenceId: source.primaryEvidenceId,
  }) === stableStringify({
    type: target.type,
    title: target.title,
    summary: target.summary,
    status: target.status,
    confidence: target.confidence,
    source: target.source,
    staleAfterDays: target.staleAfterDays,
    payload: target.payload,
    primaryEvidenceId: target.primaryEvidenceId,
  });
}

function exactRecordEquivalent<T>(source: T, target: T): boolean {
  return stableStringify(source) === stableStringify(target);
}

function idsMissingFrom<T extends { id: string }>(source: T[], target: T[]): Set<string> {
  const existing = new Set(target.map((item) => item.id));
  return new Set(source.filter((item) => !existing.has(item.id)).map((item) => item.id));
}

function insertEvidence(database: AtlasDatabase, items: EvidenceRecord[]): void {
  const statement = database.db.prepare(`
    INSERT INTO evidence(id, kind, locator, digest, observed_at, sensitive, metadata_json)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) statement.run(
    item.id, item.kind, item.locator, item.digest, item.observedAt, item.sensitive ? 1 : 0, stableStringify(item.metadata),
  );
}

function insertEntities(database: AtlasDatabase, items: PortableEntity[]): void {
  const entityStatement = database.db.prepare(`
    INSERT INTO entities(id, type, title, summary, status, confidence, source, first_seen, last_seen, stale_after_days, payload_json, primary_evidence_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const versionStatement = database.db.prepare(`
    INSERT INTO entity_versions(entity_id, version, snapshot_json, evidence_ids_json, created_at, superseded_at, reason)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    entityStatement.run(
      item.id, item.type, item.title, item.summary, item.status, item.confidence, item.source,
      item.firstSeen, item.lastSeen, item.staleAfterDays, stableStringify(item.payload), item.primaryEvidenceId,
    );
    for (const version of [...item.versions].sort((left, right) => left.version - right.version)) {
      versionStatement.run(
        item.id, version.version, stableStringify(version.snapshot), stableStringify(version.evidenceIds),
        version.createdAt, version.supersededAt, version.reason,
      );
    }
  }
}

function insertProposals(database: AtlasDatabase, items: ProposalRecord[]): void {
  const statement = database.db.prepare(`
    INSERT INTO proposals(id, kind, target_id, title, summary, payload_json, evidence_ids_json, risk_flags_json, status, created_at, reviewed_at, review_note, conflict_group)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) statement.run(
    item.id, item.kind, item.targetId, item.title, item.summary, stableStringify(item.payload),
    stableStringify(item.evidenceIds), stableStringify(item.riskFlags), item.status, item.createdAt,
    item.reviewedAt, item.reviewNote, item.conflictGroup,
  );
}

function insertAssertions(database: AtlasDatabase, items: AssertionRecord[]): void {
  const assertionStatement = database.db.prepare(`
    INSERT INTO assertions(
      id, logical_id, revision, subject_id, predicate, value_json, scope, authority, confidence,
      producer, lifecycle, review_state, valid_from, valid_to, recorded_at, supersedes_id, content_hash, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const evidenceStatement = database.db.prepare("INSERT INTO assertion_evidence(assertion_id, evidence_id, role) VALUES(?, ?, ?)");
  for (const item of [...items].sort((left, right) => left.logicalId.localeCompare(right.logicalId) || left.revision - right.revision)) {
    assertionStatement.run(
      item.id, item.logicalId, item.revision, item.subjectId, item.predicate, stableStringify(item.value), item.scope,
      item.authority, item.confidence, item.producer, item.lifecycle, item.reviewState, item.validFrom, item.validTo,
      item.recordedAt, item.supersedesId, item.contentHash, stableStringify(item.metadata),
    );
    for (const evidence of item.evidence) evidenceStatement.run(item.id, evidence.evidenceId, evidence.role);
  }
}

function insertReviewActions(database: AtlasDatabase, items: PortableReviewAction[]): void {
  const statement = database.db.prepare(`
    INSERT INTO review_actions(id, assertion_id, previous_assertion_id, actor, action, rationale, rationale_digest, recorded_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) statement.run(
    item.id, item.assertionId, item.previousAssertionId, item.actor, item.action,
    item.rationale, item.rationaleDigest, item.recordedAt,
  );
}

function assertionCanonicalContent(assertion: AssertionRecord): Record<string, unknown> {
  return {
    logicalId: assertion.logicalId,
    revision: assertion.revision,
    subjectId: assertion.subjectId,
    predicate: assertion.predicate,
    value: assertion.value,
    scope: assertion.scope,
    authority: assertion.authority,
    confidence: assertion.confidence,
    producer: assertion.producer,
    lifecycle: assertion.lifecycle,
    reviewState: assertion.reviewState,
    validFrom: assertion.validFrom,
    validTo: assertion.validTo,
    supersedesId: assertion.supersedesId,
    evidence: assertion.evidence,
    metadata: assertion.metadata,
  };
}

function emptyImportPlan(targetRepositoryId: string): PortableImportPlan {
  const collection = (): PortableImportCollectionPlan => ({ available: 0, selected: 0, insert: 0, identical: 0 });
  return {
    schemaVersion: null,
    sourceChecksum: null,
    sourceRepositoryId: null,
    targetRepositoryId,
    repositoryMatch: false,
    sourceHeadPresent: null,
    valid: false,
    dryRun: true,
    writesPlanned: 0,
    collections: {
      evidence: collection(),
      externalImports: collection(),
      entities: collection(),
      proposals: collection(),
      assertions: collection(),
      reviewActions: collection(),
    },
    excludedDerived: {
      relationships: 0,
      events: 0,
      pendingProposals: 0,
      observedEntitiesNotRequiredByCanonicalKnowledge: 0,
      auditEntries: 0,
    },
    collisions: [],
    errors: [],
    warnings: [],
  };
}

function finalizePlan(plan: PortableImportPlan): PortableImportPlan {
  plan.writesPlanned = Object.values(plan.collections).reduce((total, item) => total + item.insert, 0);
  plan.valid = plan.errors.length === 0 && plan.collisions.length === 0;
  return plan;
}

function gitCommitExists(repoRoot: string, commit: string): boolean {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) return false;
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function inspectJsonTree(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > 2_000_000) throw new Error("Portable payload exceeds the JSON node safety limit.");
    if (current.depth > 64) throw new Error("Portable payload exceeds the JSON nesting safety limit.");
    if (typeof current.value === "string" && current.value.length > 1_000_000) throw new Error("Portable payload contains an oversized string.");
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`Portable payload contains a forbidden object key: ${key}`);
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function assertSecretFree(value: unknown, label: string): void {
  if (findSecrets(stableStringify(value)).length > 0) throw new Error(`${label} contains material that matches a secret pattern.`);
}

function validateUniqueRecords(items: Array<{ id: string }>, label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`Duplicate ${label} ID: ${item.id}`);
    seen.add(item.id);
  }
}

function validateAuditChain(entries: LedgerEntry[], recordedHead: string | null, errors: string[]): void {
  let previousHash = "GENESIS";
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as LedgerEntry;
    const expectedSequence = index + 1;
    const calculated = sha256(stableStringify({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      timestamp: entry.timestamp,
      kind: entry.kind,
      actionId: entry.actionId,
      payloadDigest: entry.payloadDigest,
    }));
    if (entry.sequence !== expectedSequence || entry.previousHash !== previousHash || entry.hash !== calculated) {
      errors.push(`Portable audit chain is invalid at sequence ${expectedSequence}.`);
      return;
    }
    previousHash = entry.hash;
  }
  if ((recordedHead ?? "GENESIS") !== previousHash) errors.push("Portable project ledger head does not match its audit chain.");
}

function idSet(items: Array<{ id: string }>): Set<string> {
  return new Set(items.map((item) => item.id));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,499}$/.test(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
