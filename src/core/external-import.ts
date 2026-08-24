import { createHmac } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { loadConfig } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { getRepoStatus } from "./git.js";
import { flushLedgerOutbox, stageLedgerEntry } from "./ledger.js";
import { findSecrets, isSensitivePath, sanitizeText } from "./security.js";
import type {
  EntityRecord,
  EvidenceRecord,
  ExternalImportAuthority,
  ExternalImportRecord,
  ExternalImportSensitivity,
  ExternalImportSourceKind,
  TimelineEvent,
} from "./types.js";
import { nowIso, sha256, stableStringify } from "./util.js";

export const EXTERNAL_IMPORT_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_IMPORT_POLICY_VERSION = "external-import-policy-v1" as const;
export const EXTERNAL_IMPORT_EXTRACTOR_VERSION = "external-text-import-v1" as const;
export const MAX_EXTERNAL_IMPORT_BYTES = 256 * 1024;
export const MAX_EXTERNAL_IMPORT_PREVIEW_CHARACTERS = 1_000;

const IMPORT_CONFIRMATION = "IMPORT" as const;
const SUPPORTED_SOURCE_KINDS = new Set<ExternalImportSourceKind>(["external_document", "conversation_summary"]);
const SUPPORTED_AUTHORITIES = new Set<ExternalImportAuthority>(["documented", "human", "unknown"]);
const SUPPORTED_SENSITIVITIES = new Set<ExternalImportSensitivity>(["normal", "sensitive"]);
const UNSUPPORTED_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HUMAN_ACTOR = /^human:[a-zA-Z0-9._@-]{1,200}$/;

export interface ExternalImportRequest {
  sourceKind: ExternalImportSourceKind;
  originLabel: string;
  declaredAuthority: ExternalImportAuthority;
  sensitivityLabel: ExternalImportSensitivity;
  purpose: string;
  actor: string;
  title?: string;
  sourceObservedAt?: string;
}

export interface ExternalImportPlan {
  schemaVersion: typeof EXTERNAL_IMPORT_SCHEMA_VERSION;
  operation: "external-import-preview";
  dryRun: true;
  valid: true;
  planId: string;
  repositoryId: string;
  source: {
    kind: ExternalImportSourceKind;
    displayName: string;
    title: string;
    bytes: number;
    contentDigest: string;
    identityDigest: string;
    observedAt: string;
    previewText: string;
    previewTruncated: boolean;
    bodyPersistence: "stored" | "omitted_sensitive";
  };
  provenance: {
    originKind: "local_file";
    originLabel: string;
    originLocatorDigest: string;
    declaredAuthority: ExternalImportAuthority;
    sensitivityLabel: ExternalImportSensitivity;
    purpose: string;
    actor: string;
    policyVersion: typeof EXTERNAL_IMPORT_POLICY_VERSION;
    extractorVersion: typeof EXTERNAL_IMPORT_EXTRACTOR_VERSION;
  };
  consent: {
    consentId: string;
    scopeDigest: string;
    confirmationRequired: typeof IMPORT_CONFIRMATION;
  };
  planned: {
    importId: string;
    evidenceId: string;
    entityId: string;
    eventId: string;
    alreadyImported: boolean;
    writesPlanned: number;
  };
  findings: {
    secretFindingCategories: [];
  };
  warnings: string[];
}

export interface ExternalImportApplyOptions extends ExternalImportRequest {
  planId: string;
  confirmation: typeof IMPORT_CONFIRMATION;
}

export type ExternalImportTextSelectionKind = "browser_file" | "pasted_text";

/**
 * A caller-owned, in-memory source. `bytes` are copied and revalidated on each
 * call; the implementation does not retain them or write a staging file.
 */
export interface ExternalImportTextSource {
  bytes: Uint8Array;
  displayName: string;
  observedAt: string;
  selectionKind: ExternalImportTextSelectionKind;
}

export interface ExternalImportSummary {
  id: string;
  evidenceId: string;
  entityId: string;
  eventId: string;
  sourceKind: ExternalImportSourceKind;
  title: string;
  contentDigest: string;
  originKind: "local_file";
  originLabel: string;
  originLocatorDigest: string;
  sourceObservedAt: string;
  importedAt: string;
  importedBy: string;
  declaredAuthority: ExternalImportAuthority;
  sensitivityLabel: ExternalImportSensitivity;
  purpose: string;
  policyVersion: string;
  consentId: string;
  consentScopeDigest: string;
  ledgerHash: string;
  recordDigest: string;
  bodyPersistence: "stored" | "omitted_sensitive";
}

export interface ExternalImportResult {
  schemaVersion: typeof EXTERNAL_IMPORT_SCHEMA_VERSION;
  applied: boolean;
  alreadyImported: boolean;
  import: ExternalImportSummary;
  audit: {
    ledgerHash: string;
    outboxFlushed: true;
  };
}

interface SelectedExternalText {
  canonicalText: string;
  bytes: number;
  contentDigest: string;
  sourceIdentityDigest: string;
  originLocatorDigest: string;
  displayName: string;
  fileObservedAt: string;
}

interface InternalExternalImportPreview {
  plan: ExternalImportPlan;
  selected: SelectedExternalText;
}

export class ExternalImportInputError extends Error {
  readonly code = "invalid_external_import_input";
}

export class ExternalImportPlanChangedError extends Error {
  readonly code = "external_import_plan_changed";
}

/**
 * Reads and validates one explicitly selected local text file without writing
 * Atlas state. The returned plan deliberately contains no absolute host path.
 */
export function previewExternalImport(
  repoRoot: string,
  sourceFile: string,
  request: ExternalImportRequest,
): ExternalImportPlan {
  const { root } = loadConfig(repoRoot);
  const selected = readSelectedExternalText(sourceFile, externalImportPathIdentitySalt(root));
  return buildExternalImportPreview(root, selected, request).plan;
}

/**
 * Validates one explicitly selected UTF-8 text/Markdown value entirely in
 * memory. Only digest provenance and a safe display name enter the plan.
 */
export function previewExternalImportText(
  repoRoot: string,
  source: ExternalImportTextSource,
  request: ExternalImportRequest,
): ExternalImportPlan {
  const { root } = loadConfig(repoRoot);
  return buildExternalImportPreview(root, readExternalTextSource(source), request).plan;
}

/**
 * Rebuilds the preview from the live file, compares the caller's plan ID, and
 * commits the import/evidence/entity/event/audit outbox as one SQLite unit.
 */
export function applyExternalImport(
  repoRoot: string,
  sourceFile: string,
  options: ExternalImportApplyOptions,
): ExternalImportResult {
  validateExternalImportApplyOptions(options);
  const { root } = loadConfig(repoRoot);
  const selected = readSelectedExternalText(sourceFile, externalImportPathIdentitySalt(root));
  return applyBuiltExternalImportPreview(root, buildExternalImportPreview(root, selected, requestFromApplyOptions(options)), options);
}

/**
 * Rebuilds a browser/paste preview from newly supplied bytes before commit.
 * No server-side plan or source body is retained between preview and apply.
 */
export function applyExternalImportText(
  repoRoot: string,
  source: ExternalImportTextSource,
  options: ExternalImportApplyOptions,
): ExternalImportResult {
  validateExternalImportApplyOptions(options);
  const { root } = loadConfig(repoRoot);
  return applyBuiltExternalImportPreview(
    root,
    buildExternalImportPreview(root, readExternalTextSource(source), requestFromApplyOptions(options)),
    options,
  );
}

function applyBuiltExternalImportPreview(
  repoRoot: string,
  preview: InternalExternalImportPreview,
  options: ExternalImportApplyOptions,
): ExternalImportResult {
  validateExternalImportApplyOptions(options);
  if (preview.plan.planId !== options.planId) {
    throw new ExternalImportPlanChangedError(
      "External import source or consent metadata changed after preview; generate a new preview and confirm its plan ID.",
    );
  }

  const { root, config } = loadConfig(repoRoot);
  const database = new AtlasDatabase(root);
  try {
    flushLedgerOutbox(root, database);
    const existing = database.getExternalImport(preview.plan.planned.importId);
    if (existing) {
      assertExistingImportMatchesPlan(existing, preview.plan);
      assertExistingImportProjection(database, existing, preview.plan, config.staleAfterDays);
      return resultFor(existing, preview.plan.planned.entityId, preview.plan.planned.eventId, false, true);
    }

    const importedAt = nowIso();
    let record!: ExternalImportRecord;
    let created = false;
    database.transaction(() => {
      const raced = database.getExternalImport(preview.plan.planned.importId);
      if (raced) {
        assertExistingImportMatchesPlan(raced, preview.plan);
        assertExistingImportProjection(database, raced, preview.plan, config.staleAfterDays);
        record = raced;
        return;
      }
      if (database.getEntity(preview.plan.planned.entityId)) {
        throw new Error("Canonical external-import entity identity collides with an existing record.");
      }
      if (database.getEvidence(preview.plan.planned.evidenceId)) {
        throw new Error("Canonical external-import evidence identity exists without its immutable import record.");
      }

      const auditPayload = safeAuditPayload(preview.plan);
      const ledger = stageLedgerEntry(root, database, {
        kind: "external_import_event",
        actionId: preview.plan.planned.eventId,
        timestamp: importedAt,
        payload: auditPayload,
      });
      record = {
        id: preview.plan.planned.importId,
        evidenceId: preview.plan.planned.evidenceId,
        sourceKind: preview.plan.source.kind,
        title: preview.plan.source.title,
        canonicalText: preview.plan.provenance.sensitivityLabel === "sensitive"
          ? null
          : preview.selected.canonicalText,
        contentDigest: preview.plan.source.contentDigest,
        originKind: "local_file",
        originLabel: preview.plan.provenance.originLabel,
        originLocatorDigest: preview.plan.provenance.originLocatorDigest,
        sourceIdentityDigest: preview.plan.source.identityDigest,
        sourceObservedAt: preview.plan.source.observedAt,
        importedAt,
        importedBy: preview.plan.provenance.actor,
        declaredAuthority: preview.plan.provenance.declaredAuthority,
        sensitivityLabel: preview.plan.provenance.sensitivityLabel,
        purpose: preview.plan.provenance.purpose,
        policyVersion: preview.plan.provenance.policyVersion,
        consentId: preview.plan.consent.consentId,
        consentScopeDigest: preview.plan.consent.scopeDigest,
        ledgerHash: ledger.hash,
        recordDigest: "",
      };
      record.recordDigest = externalImportRecordDigest(record);

      const evidence = evidenceFor(record);
      database.insertEvidenceImmutable(evidence);
      database.insertExternalImport(record);
      database.upsertEntity(entityFor(record, preview.plan.planned.entityId, config.staleAfterDays), [evidence.id], "explicit external source import");
      const insertedEvent = database.insertEvent(externalImportTimelineEvent(record));
      if (!insertedEvent) throw new Error("Canonical external-import timeline identity collides with an existing event.");
      created = true;
    });

    // If a future competing writer wins between preview and BEGIN IMMEDIATE,
    // `record` names that identical immutable import. Either way no duplicate
    // semantic event or ledger action is created.
    const flushed = flushLedgerOutbox(root, database);
    if ((flushed.head || "GENESIS") !== record.ledgerHash && database.getMeta("ledger_head") !== record.ledgerHash) {
      throw new Error("External import committed but its recoverable audit outbox did not reach the expected ledger head.");
    }
    return resultFor(record, preview.plan.planned.entityId, preview.plan.planned.eventId, created, !created);
  } finally {
    database.close();
  }
}

function validateExternalImportApplyOptions(options: ExternalImportApplyOptions): void {
  if (options.confirmation !== IMPORT_CONFIRMATION) {
    throw new ExternalImportInputError("External import requires exact confirmation IMPORT.");
  }
  if (!/^[a-f0-9]{64}$/.test(options.planId)) {
    throw new ExternalImportInputError("External import requires a canonical preview plan ID.");
  }
}

/** Hashes every immutable field, using `contentDigest` as the body commitment. */
export function externalImportRecordDigest(record: Omit<ExternalImportRecord, "recordDigest"> | ExternalImportRecord): string {
  return sha256(stableStringify({
    id: record.id,
    evidenceId: record.evidenceId,
    sourceKind: record.sourceKind,
    title: record.title,
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
    ledgerHash: record.ledgerHash,
  }));
}

export function externalImportEntityId(sourceKind: ExternalImportSourceKind, importId: string): string {
  return `${sourceKind}:${sha256(importId).slice(0, 32)}`;
}

export function externalImportEventId(importId: string): string {
  return `event_external_import_${sha256(importId).slice(0, 32)}`;
}

/** Reconstructs the body-free payload committed by the import's event ledger entry. */
export function externalImportAuditPayload(
  record: ExternalImportRecord,
  repositoryId: string,
): Record<string, unknown> {
  return canonicalAuditPayload({
    importId: record.id,
    evidenceId: record.evidenceId,
    entityId: externalImportEntityId(record.sourceKind, record.id),
    eventId: externalImportEventId(record.id),
    repositoryId,
    sourceKind: record.sourceKind,
    contentDigest: record.contentDigest,
    sourceIdentityDigest: record.sourceIdentityDigest,
    originLocatorDigest: record.originLocatorDigest,
    declaredAuthority: record.declaredAuthority,
    sensitivityLabel: record.sensitivityLabel,
    actor: record.importedBy,
    purpose: record.purpose,
    consentId: record.consentId,
    consentScopeDigest: record.consentScopeDigest,
    policyVersion: record.policyVersion,
    extractorVersion: EXTERNAL_IMPORT_EXTRACTOR_VERSION,
  });
}

function buildExternalImportPreview(
  repoRoot: string,
  selected: SelectedExternalText,
  request: ExternalImportRequest,
): InternalExternalImportPreview {
  const normalized = normalizeRequest(request);
  const repository = getRepoStatus(repoRoot);
  const sourceObservedAt = normalized.sourceObservedAt ?? selected.fileObservedAt;
  const title = normalized.title ?? selected.displayName;
  const importScope = {
    repositoryId: repository.repositoryId,
    sourceKind: normalized.sourceKind,
    contentDigest: selected.contentDigest,
    sourceIdentityDigest: selected.sourceIdentityDigest,
    originLabel: normalized.originLabel,
    originLocatorDigest: selected.originLocatorDigest,
    sourceObservedAt,
    title,
    declaredAuthority: normalized.declaredAuthority,
    sensitivityLabel: normalized.sensitivityLabel,
    purpose: normalized.purpose,
    actor: normalized.actor,
    policyVersion: EXTERNAL_IMPORT_POLICY_VERSION,
    extractorVersion: EXTERNAL_IMPORT_EXTRACTOR_VERSION,
  };
  const consentScopeDigest = sha256(stableStringify({
    operation: "external-import",
    importScope,
  }));
  const consentId = `consent_${consentScopeDigest.slice(0, 32)}`;
  const importId = `import_${sha256(stableStringify(importScope)).slice(0, 32)}`;
  const locator = `atlas-import:${importId}`;
  const evidenceId = evidenceIdFor(normalized.sourceKind, locator, selected.contentDigest);
  const entityId = externalImportEntityId(normalized.sourceKind, importId);
  const eventId = externalImportEventId(importId);

  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  let alreadyImported = false;
  try {
    const existing = database.getExternalImport(importId);
    alreadyImported = existing !== null;
    if (existing && (existing.evidenceId !== evidenceId || existing.contentDigest !== selected.contentDigest)) {
      throw new Error("Canonical external-import identity collides with a different immutable record.");
    }
  } finally {
    database.close();
  }

  const planCore = {
    repositoryId: repository.repositoryId,
    importScope,
    consentId,
    consentScopeDigest,
    importId,
    evidenceId,
    entityId,
    eventId,
  };
  const planId = sha256(stableStringify(planCore));
  const previewText = selected.canonicalText.slice(0, MAX_EXTERNAL_IMPORT_PREVIEW_CHARACTERS);
  const plan: ExternalImportPlan = {
    schemaVersion: EXTERNAL_IMPORT_SCHEMA_VERSION,
    operation: "external-import-preview",
    dryRun: true,
    valid: true,
    planId,
    repositoryId: repository.repositoryId,
    source: {
      kind: normalized.sourceKind,
      displayName: selected.displayName,
      title,
      bytes: selected.bytes,
      contentDigest: selected.contentDigest,
      identityDigest: selected.sourceIdentityDigest,
      observedAt: sourceObservedAt,
      previewText,
      previewTruncated: previewText.length < selected.canonicalText.length,
      bodyPersistence: normalized.sensitivityLabel === "sensitive" ? "omitted_sensitive" : "stored",
    },
    provenance: {
      originKind: "local_file",
      originLabel: normalized.originLabel,
      originLocatorDigest: selected.originLocatorDigest,
      declaredAuthority: normalized.declaredAuthority,
      sensitivityLabel: normalized.sensitivityLabel,
      purpose: normalized.purpose,
      actor: normalized.actor,
      policyVersion: EXTERNAL_IMPORT_POLICY_VERSION,
      extractorVersion: EXTERNAL_IMPORT_EXTRACTOR_VERSION,
    },
    consent: { consentId, scopeDigest: consentScopeDigest, confirmationRequired: IMPORT_CONFIRMATION },
    planned: {
      importId,
      evidenceId,
      entityId,
      eventId,
      alreadyImported,
      writesPlanned: alreadyImported ? 0 : 5,
    },
    findings: { secretFindingCategories: [] },
    warnings: [
      "Imported text is untrusted external evidence, not executable instructions or automatically accepted project truth.",
      ...(normalized.sensitivityLabel === "sensitive"
        ? ["This source is classified sensitive: its body will not be persisted, and its evidence will remain policy-denied on ordinary pack and agent surfaces."]
        : []),
    ],
  };
  return { plan, selected };
}

function normalizeRequest(request: ExternalImportRequest): Required<Omit<ExternalImportRequest, "title" | "sourceObservedAt">> & {
  title: string | undefined;
  sourceObservedAt: string | undefined;
} {
  if (!SUPPORTED_SOURCE_KINDS.has(request.sourceKind)) {
    throw new ExternalImportInputError("External import source kind must be external_document or conversation_summary.");
  }
  if (!SUPPORTED_AUTHORITIES.has(request.declaredAuthority)) {
    throw new ExternalImportInputError("External import authority must be documented, human, or unknown.");
  }
  if (!SUPPORTED_SENSITIVITIES.has(request.sensitivityLabel)) {
    throw new ExternalImportInputError("External import sensitivity must be normal or sensitive.");
  }
  const actor = normalizeHumanActor(request.actor);
  return {
    sourceKind: request.sourceKind,
    originLabel: normalizeSafeField(request.originLabel, "origin label", 300),
    declaredAuthority: request.declaredAuthority,
    sensitivityLabel: request.sensitivityLabel,
    purpose: normalizeSafeField(request.purpose, "purpose", 500),
    actor,
    title: request.title === undefined ? undefined : normalizeSafeField(request.title, "title", 300),
    sourceObservedAt: request.sourceObservedAt === undefined
      ? undefined
      : normalizeIso(request.sourceObservedAt, "source observation time"),
  };
}

function requestFromApplyOptions(options: ExternalImportApplyOptions): ExternalImportRequest {
  return {
    sourceKind: options.sourceKind,
    originLabel: options.originLabel,
    declaredAuthority: options.declaredAuthority,
    sensitivityLabel: options.sensitivityLabel,
    purpose: options.purpose,
    actor: options.actor,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.sourceObservedAt === undefined ? {} : { sourceObservedAt: options.sourceObservedAt }),
  };
}

function readSelectedExternalText(sourceFile: string, pathIdentitySalt: string): SelectedExternalText {
  if (typeof sourceFile !== "string" || !sourceFile || sourceFile.includes("\0")) {
    throw new ExternalImportInputError("External import requires one explicit local text file.");
  }
  const absolutePath = path.resolve(sourceFile);
  if (isSensitivePath(absolutePath.replaceAll("\\", "/"))) {
    throw new ExternalImportInputError("The selected external source is withheld by the sensitive-path policy.");
  }
  let initial;
  try { initial = lstatSync(absolutePath, { bigint: true }); }
  catch { throw new ExternalImportInputError("The selected external source could not be inspected."); }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1n) {
    throw new ExternalImportInputError("The selected external source must be one exclusively linked, regular, non-symbolic-link file.");
  }
  if (initial.size > BigInt(MAX_EXTERNAL_IMPORT_BYTES)) {
    throw new ExternalImportInputError(`The selected external source exceeds the ${MAX_EXTERNAL_IMPORT_BYTES}-byte limit.`);
  }

  let descriptor: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
  } catch {
    throw new ExternalImportInputError("The selected external source could not be opened safely.");
  }
  let bytes: Buffer;
  let opened;
  let after;
  try {
    opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_EXTERNAL_IMPORT_BYTES)) {
      throw new ExternalImportInputError("The selected external source is not a supported bounded regular file.");
    }
    bytes = readFileSync(descriptor);
    after = fstatSync(descriptor, { bigint: true });
  } catch (error) {
    if (error instanceof ExternalImportInputError) throw error;
    throw new ExternalImportInputError("The selected external source could not be read safely.");
  } finally {
    closeSync(descriptor);
  }
  let final;
  try { final = lstatSync(absolutePath, { bigint: true }); }
  catch { throw new ExternalImportInputError("The selected external source changed while it was being read."); }
  if (!sameFileIdentity(initial, opened) || !sameFileIdentity(opened, after) || !sameFileIdentity(after, final)
    || bytes.length !== Number(after.size)) {
    throw new ExternalImportInputError("The selected external source changed while it was being read.");
  }
  const canonicalText = decodeAndValidateExternalText(bytes, false);
  const displayName = normalizeSafeFileName(path.basename(absolutePath));
  const originLocatorDigest = createHmac("sha256", Buffer.from(pathIdentitySalt, "hex"))
    .update(normalizedHostPath(absolutePath), "utf8")
    .digest("hex");
  const sourceIdentityDigest = sha256(stableStringify({
    originLocatorDigest,
    device: String(after.dev),
    inode: String(after.ino),
    size: String(after.size),
    modifiedNanoseconds: String(after.mtimeNs),
    changedNanoseconds: String(after.ctimeNs),
  }));
  return {
    canonicalText,
    bytes: bytes.length,
    contentDigest: sha256(canonicalText),
    sourceIdentityDigest,
    originLocatorDigest,
    displayName,
    fileObservedAt: new Date(Number(after.mtimeMs)).toISOString(),
  };
}

function readExternalTextSource(source: ExternalImportTextSource): SelectedExternalText {
  if (!source || typeof source !== "object" || !(source.bytes instanceof Uint8Array)) {
    throw new ExternalImportInputError("External import requires explicitly selected in-memory UTF-8 bytes.");
  }
  if (source.bytes.byteLength > MAX_EXTERNAL_IMPORT_BYTES) {
    throw new ExternalImportInputError(`The selected external source exceeds the ${MAX_EXTERNAL_IMPORT_BYTES}-byte limit.`);
  }
  if (source.selectionKind !== "browser_file" && source.selectionKind !== "pasted_text") {
    throw new ExternalImportInputError("External import selection kind must be browser_file or pasted_text.");
  }
  const displayName = normalizeSafeField(source.displayName, "display name", 300);
  if (displayName !== source.displayName || displayName === "." || displayName === ".." || /[\\/]/.test(displayName)) {
    throw new ExternalImportInputError("External import display name must be one safe leaf name, not a host path.");
  }
  const observedAt = normalizeIso(source.observedAt, "source observation time");
  const bytes = Buffer.from(source.bytes);
  const canonicalText = decodeAndValidateExternalText(bytes, true);
  const byteDigest = sha256(bytes);
  const originLocatorDigest = sha256(stableStringify({
    namespace: "in-memory-external-source-v1",
    selectionKind: source.selectionKind,
    displayName,
    observedAt,
    byteDigest,
  }));
  const sourceIdentityDigest = sha256(stableStringify({
    namespace: "in-memory-external-source-identity-v1",
    originLocatorDigest,
    byteDigest,
    bytes: bytes.length,
  }));
  return {
    canonicalText,
    bytes: bytes.length,
    contentDigest: sha256(canonicalText),
    sourceIdentityDigest,
    originLocatorDigest,
    displayName,
    fileObservedAt: observedAt,
  };
}

function decodeAndValidateExternalText(bytes: Buffer, preserveUtf8Bom: boolean): string {
  if (bytes.length > MAX_EXTERNAL_IMPORT_BYTES) {
    throw new ExternalImportInputError(`The selected external source exceeds the ${MAX_EXTERNAL_IMPORT_BYTES}-byte limit.`);
  }
  if (bytes.includes(0)) {
    throw new ExternalImportInputError("The selected external source contains binary data and cannot be imported as text.");
  }
  let canonicalText: string;
  try {
    canonicalText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveUtf8Bom }).decode(bytes);
  } catch {
    throw new ExternalImportInputError("The selected external source is not valid UTF-8 text.");
  }
  if (!canonicalText.trim()) throw new ExternalImportInputError("The selected external source contains no text.");
  if (UNSUPPORTED_TEXT_CONTROLS.test(canonicalText)) {
    throw new ExternalImportInputError("The selected external source contains unsupported control characters.");
  }
  const findings = findSecrets(canonicalText);
  if (findings.length > 0) {
    const categories = [...new Set(findings.map((finding) => finding.kind))].sort().join(", ");
    throw new ExternalImportInputError(
      `External import was blocked because secret-shaped content was detected (categories: ${categories}). Create an explicitly redacted source and preview it again.`,
    );
  }
  return canonicalText;
}

function evidenceFor(record: ExternalImportRecord): EvidenceRecord {
  return {
    id: record.evidenceId,
    kind: record.sourceKind,
    locator: `atlas-import:${record.id}`,
    digest: record.contentDigest,
    observedAt: record.importedAt,
    sensitive: record.sensitivityLabel === "sensitive",
    metadata: {
      importId: record.id,
      sourceKind: record.sourceKind,
      declaredAuthority: record.declaredAuthority,
      sensitivityLabel: record.sensitivityLabel,
      consentId: record.consentId,
      policyVersion: record.policyVersion,
      extractorVersion: EXTERNAL_IMPORT_EXTRACTOR_VERSION,
      untrustedExternalInput: true,
      bodyPersistence: record.sensitivityLabel === "sensitive" ? "omitted_sensitive" : "stored",
    },
  };
}

function entityFor(record: ExternalImportRecord, entityId: string, staleAfterDays: number): EntityRecord {
  const summary = record.sensitivityLabel === "sensitive" || record.canonicalText === null
    ? "Selected external text is withheld from ordinary presentation because it is classified sensitive."
    : summarizeImportedText(record.canonicalText);
  return {
    id: entityId,
    type: record.sourceKind,
    title: record.title,
    summary,
    status: "active",
    confidence: "documented",
    source: record.declaredAuthority === "human" ? "human-authored-import" : `${record.declaredAuthority}-import`,
    firstSeen: record.importedAt,
    lastSeen: record.importedAt,
    staleAfterDays,
    payload: {
      importId: record.id,
      sourceKind: record.sourceKind,
      originLabel: record.originLabel,
      declaredAuthority: record.declaredAuthority,
      sensitivityLabel: record.sensitivityLabel,
      consentId: record.consentId,
      sourceObservedAt: record.sourceObservedAt,
      untrustedExternalInput: true,
      bodyPersistence: record.sensitivityLabel === "sensitive" ? "omitted_sensitive" : "stored",
    },
    primaryEvidenceId: record.evidenceId,
  };
}

/** Reconstructs the immutable timeline projection for an imported source. */
export function externalImportTimelineEvent(record: ExternalImportRecord): TimelineEvent {
  return {
    id: externalImportEventId(record.id),
    timestamp: record.importedAt,
    type: record.sourceKind === "external_document" ? "external_document_imported" : "conversation_summary_imported",
    title: `Imported: ${record.title}`,
    summary: `An explicitly selected ${record.sourceKind === "external_document" ? "external document" : "conversation summary"} was added as untrusted ${record.declaredAuthority} evidence with attributed human consent.${record.sensitivityLabel === "sensitive" ? " Its sensitive body was omitted from persistence." : ""}`,
    commit: null,
    files: [],
    evidence: [record.evidenceId],
    ledgerHash: record.ledgerHash,
  };
}

function safeAuditPayload(plan: ExternalImportPlan): Record<string, unknown> {
  return canonicalAuditPayload({
    importId: plan.planned.importId,
    evidenceId: plan.planned.evidenceId,
    entityId: plan.planned.entityId,
    eventId: plan.planned.eventId,
    repositoryId: plan.repositoryId,
    sourceKind: plan.source.kind,
    contentDigest: plan.source.contentDigest,
    sourceIdentityDigest: plan.source.identityDigest,
    originLocatorDigest: plan.provenance.originLocatorDigest,
    declaredAuthority: plan.provenance.declaredAuthority,
    sensitivityLabel: plan.provenance.sensitivityLabel,
    actor: plan.provenance.actor,
    purpose: plan.provenance.purpose,
    consentId: plan.consent.consentId,
    consentScopeDigest: plan.consent.scopeDigest,
    policyVersion: plan.provenance.policyVersion,
    extractorVersion: plan.provenance.extractorVersion,
  });
}

function canonicalAuditPayload(input: {
  importId: string;
  evidenceId: string;
  entityId: string;
  eventId: string;
  repositoryId: string;
  sourceKind: ExternalImportSourceKind;
  contentDigest: string;
  sourceIdentityDigest: string;
  originLocatorDigest: string;
  declaredAuthority: ExternalImportAuthority;
  sensitivityLabel: ExternalImportSensitivity;
  actor: string;
  purpose: string;
  consentId: string;
  consentScopeDigest: string;
  policyVersion: string;
  extractorVersion: string;
}): Record<string, unknown> {
  return {
    importId: input.importId,
    evidenceId: input.evidenceId,
    entityId: input.entityId,
    eventId: input.eventId,
    repositoryId: input.repositoryId,
    sourceKind: input.sourceKind,
    contentDigest: input.contentDigest,
    sourceIdentityDigest: input.sourceIdentityDigest,
    originLocatorDigest: input.originLocatorDigest,
    declaredAuthority: input.declaredAuthority,
    sensitivityLabel: input.sensitivityLabel,
    actor: input.actor,
    purposeDigest: sha256(input.purpose),
    consentId: input.consentId,
    consentScopeDigest: input.consentScopeDigest,
    policyVersion: input.policyVersion,
    extractorVersion: input.extractorVersion,
  };
}

function resultFor(
  record: ExternalImportRecord,
  entityId: string,
  eventId: string,
  applied: boolean,
  alreadyImported: boolean,
): ExternalImportResult {
  return {
    schemaVersion: EXTERNAL_IMPORT_SCHEMA_VERSION,
    applied,
    alreadyImported,
    import: {
      id: record.id,
      evidenceId: record.evidenceId,
      entityId,
      eventId,
      sourceKind: record.sourceKind,
      title: record.title,
      contentDigest: record.contentDigest,
      originKind: record.originKind,
      originLabel: record.originLabel,
      originLocatorDigest: record.originLocatorDigest,
      sourceObservedAt: record.sourceObservedAt,
      importedAt: record.importedAt,
      importedBy: record.importedBy,
      declaredAuthority: record.declaredAuthority,
      sensitivityLabel: record.sensitivityLabel,
      purpose: record.purpose,
      policyVersion: record.policyVersion,
      consentId: record.consentId,
      consentScopeDigest: record.consentScopeDigest,
      ledgerHash: record.ledgerHash,
      recordDigest: record.recordDigest,
      bodyPersistence: record.sensitivityLabel === "sensitive" ? "omitted_sensitive" : "stored",
    },
    audit: { ledgerHash: record.ledgerHash, outboxFlushed: true },
  };
}

function assertExistingImportMatchesPlan(record: ExternalImportRecord, plan: ExternalImportPlan): void {
  if (record.id !== plan.planned.importId
    || record.evidenceId !== plan.planned.evidenceId
    || record.sourceKind !== plan.source.kind
    || record.title !== plan.source.title
    || record.contentDigest !== plan.source.contentDigest
    || record.sourceIdentityDigest !== plan.source.identityDigest
    || record.sourceObservedAt !== plan.source.observedAt
    || record.originKind !== plan.provenance.originKind
    || record.originLabel !== plan.provenance.originLabel
    || record.originLocatorDigest !== plan.provenance.originLocatorDigest
    || record.importedBy !== plan.provenance.actor
    || record.declaredAuthority !== plan.provenance.declaredAuthority
    || record.sensitivityLabel !== plan.provenance.sensitivityLabel
    || record.purpose !== plan.provenance.purpose
    || record.policyVersion !== plan.provenance.policyVersion
    || record.consentId !== plan.consent.consentId
    || record.consentScopeDigest !== plan.consent.scopeDigest
    || record.recordDigest !== externalImportRecordDigest(record)) {
    throw new Error("Existing external import does not match the immutable preview identity.");
  }
}

function assertExistingImportProjection(
  database: AtlasDatabase,
  record: ExternalImportRecord,
  plan: ExternalImportPlan,
  staleAfterDays: number,
): void {
  const evidence = database.getEvidence(record.evidenceId);
  const entity = database.getEntity(plan.planned.entityId);
  const event = database.getEvent(plan.planned.eventId);
  const expectedEntity = entityFor(record, plan.planned.entityId, staleAfterDays);
  const expectedEvent = externalImportTimelineEvent(record);
  if (!evidence
    || stableStringify(evidence) !== stableStringify(evidenceFor(record))
    || !entity
    || stableStringify(entity) !== stableStringify(expectedEntity)
    || !event
    || stableStringify(event) !== stableStringify(expectedEvent)) {
    throw new Error("Existing external import is missing its canonical evidence, entity, or timeline projection.");
  }
}

function evidenceIdFor(kind: ExternalImportSourceKind, locator: string, digest: string): string {
  return `evidence_${sha256(`${kind}\0${locator}\0${digest}`).slice(0, 32)}`;
}

function normalizeSafeField(value: string, field: string, maximum: number): string {
  if (typeof value !== "string") throw new ExternalImportInputError(`External import ${field} is required.`);
  const trimmed = value.trim();
  const clean = sanitizeText(trimmed, maximum);
  if (!trimmed || trimmed.length > maximum || clean.sensitive || clean.value !== trimmed) {
    throw new ExternalImportInputError(`External import ${field} is invalid or contains sensitive/control material.`);
  }
  return trimmed;
}

function normalizeHumanActor(actor: string): string {
  if (typeof actor !== "string" || !HUMAN_ACTOR.test(actor) || sanitizeText(actor, 206).value !== actor) {
    throw new ExternalImportInputError("External import requires a valid attributed human: actor.");
  }
  return actor;
}

function normalizeIso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new ExternalImportInputError(`External import ${field} must be a valid timestamp.`);
  return new Date(milliseconds).toISOString();
}

function normalizeSafeFileName(value: string): string {
  const clean = sanitizeText(value, 300);
  if (!clean.value || clean.sensitive || clean.value !== value || clean.value.length > 300) {
    return "selected-external-source.txt";
  }
  return clean.value;
}

function normalizedHostPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function externalImportPathIdentitySalt(repoRoot: string): string {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const salt = database.getMeta("external_import_path_identity_salt");
    if (!salt || !/^[a-f0-9]{64}$/.test(salt)) {
      throw new ExternalImportInputError("External import path privacy metadata is unavailable or invalid.");
    }
    return salt;
  } finally {
    database.close();
  }
}

function sameFileIdentity(
  left: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === 1n
    && right.nlink === 1n
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function summarizeImportedText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 1_000 ? compact : `${compact.slice(0, 997).trimEnd()}...`;
}
