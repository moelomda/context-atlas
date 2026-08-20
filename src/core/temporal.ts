import type { SQLInputValue } from "node:sqlite";
import { AtlasDatabase } from "./database.js";
import { findSecrets, sanitizeText } from "./security.js";
import type { Confidence } from "./types.js";
import { newId, nowIso, safeJsonParse, sha256, stableStringify } from "./util.js";

export type AssertionAuthority = "observed" | "derived" | "documented" | "human" | "inferred";
export type AssertionLifecycle = "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn" | "stale" | "conflicting";
export type AssertionReviewState = "unreviewed" | "accepted" | "rejected";
export type AssertionEvidenceRole = "support" | "contradict" | "context";
export type ReviewAction = "propose" | "accept" | "edit_accept" | "reject" | "defer" | "withdraw" | "supersede" | "mark_stale" | "mark_conflict";

export interface AssertionRecord {
  id: string;
  logicalId: string;
  revision: number;
  subjectId: string;
  predicate: string;
  value: unknown;
  scope: string;
  authority: AssertionAuthority;
  confidence: Confidence;
  producer: string;
  lifecycle: AssertionLifecycle;
  reviewState: AssertionReviewState;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  supersedesId: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  evidence: Array<{ evidenceId: string; role: AssertionEvidenceRole }>;
}

export interface AssertionInput {
  logicalId?: string;
  supersedesId?: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  scope?: string;
  authority: AssertionAuthority;
  confidence: Confidence;
  producer: string;
  lifecycle?: AssertionLifecycle;
  reviewState?: AssertionReviewState;
  validFrom?: string;
  validTo?: string | null;
  recordedAt?: string;
  evidence: Array<{ evidenceId: string; role?: AssertionEvidenceRole }>;
  actor?: string;
  action?: ReviewAction;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface AssertionQuery {
  validAt?: string;
  recordedAt?: string;
  subjectId?: string;
  predicate?: string;
  includeLifecycle?: AssertionLifecycle[];
}

export interface AssertionEvolutionQuery {
  subjectId?: string;
  predicate?: string;
  recordedFrom?: string;
  recordedTo?: string;
  validFrom?: string;
  validTo?: string;
}

export interface AssertionReviewRecord {
  id: string;
  assertionId: string;
  previousAssertionId: string | null;
  actor: string;
  action: ReviewAction;
  rationale: string | null;
  rationaleDigest: string | null;
  recordedAt: string;
}

export interface AssertionConflict {
  subjectId: string;
  predicate: string;
  scope: string;
  assertionIds: string[];
  values: unknown[];
}

type AssertionRow = Record<string, unknown>;

export function recordAssertionRevision(repoRoot: string, input: AssertionInput): AssertionRecord {
  const database = new AtlasDatabase(repoRoot);
  try {
    return recordAssertionRevisionInDatabase(database, input);
  } finally {
    database.close();
  }
}

/**
 * Records an immutable assertion revision using an already-open database.
 * Callers that already own a transaction can set `transaction: false` so the
 * assertion, its review action, and their projection commit atomically.
 */
export function recordAssertionRevisionInDatabase(
  database: AtlasDatabase,
  input: AssertionInput,
  options: { transaction?: boolean } = {},
): AssertionRecord {
    if (!database.getEntity(input.subjectId)) throw new Error(`Unknown assertion subject: ${input.subjectId}`);
    const predicate = normalizeToken(input.predicate, "predicate", 160);
    const scope = normalizeToken(input.scope ?? "project", "scope", 300);
    const producer = normalizeToken(input.producer, "producer", 300);
    const actor = input.actor ? normalizeToken(input.actor, "actor", 300) : null;
    const lifecycle = input.lifecycle ?? "proposed";
    const reviewState = input.reviewState ?? (lifecycle === "proposed" ? "unreviewed" : "accepted");
    validateReviewBoundary(lifecycle, reviewState, input.authority, producer, actor, input.action);
    const validFrom = normalizeIso(input.validFrom ?? nowIso(), "validFrom");
    const validTo = input.validTo ? normalizeIso(input.validTo, "validTo") : null;
    if (validTo && validTo <= validFrom) throw new Error("Assertion validTo must be later than validFrom.");
    const recordedAt = normalizeIso(input.recordedAt ?? nowIso(), "recordedAt");
    const serializedValue = serializeSafe(input.value, "assertion value", 100_000);
    const suppliedMetadata = input.metadata ?? {};
    const suppliedReviewedWatermark = suppliedMetadata.reviewedGuidanceWatermark;
    if (suppliedReviewedWatermark !== undefined && !isGuidanceWatermark(suppliedReviewedWatermark)) {
      throw new Error("Assertion reviewedGuidanceWatermark must be a SHA-256 digest.");
    }
    const acceptedGuidanceWatermark = lifecycle === "accepted" && reviewState === "accepted"
      ? suppliedReviewedWatermark ?? database.getMeta("last_synced_guidance_watermark")
      : null;
    if (lifecycle === "accepted" && reviewState === "accepted" && !isGuidanceWatermark(acceptedGuidanceWatermark)) {
      throw new Error("Synchronize Context Atlas before accepting an assertion so its reviewed guidance dependency boundary is explicit.");
    }
    const metadata = isGuidanceWatermark(acceptedGuidanceWatermark)
      ? { ...suppliedMetadata, reviewedGuidanceWatermark: acceptedGuidanceWatermark }
      : suppliedMetadata;
    serializeSafe(metadata, "assertion metadata", 100_000);

    const evidence = deduplicateEvidence(input.evidence);
    const evidenceIds = [...new Set(evidence.map((item) => item.evidenceId))];
    const resolved = database.listEvidence(evidenceIds);
    if (resolved.length !== evidenceIds.length) throw new Error("Every assertion evidence ID must resolve in the local evidence store.");
    const supportCount = evidence.filter((item) => item.role === "support").length;
    if (input.authority !== "human" && supportCount === 0) throw new Error("Non-human assertions require at least one supporting evidence reference.");
    if (input.authority === "human" && !actor?.startsWith("human:")) throw new Error("Human assertions require an attributed human: actor.");

    const previous = input.supersedesId ? getAssertionFromDatabase(database, input.supersedesId) : null;
    if (input.supersedesId && !previous) throw new Error(`Unknown superseded assertion: ${input.supersedesId}`);
    if (previous && (previous.subjectId !== input.subjectId || previous.predicate !== predicate || previous.scope !== scope)) {
      throw new Error("A revision cannot change its assertion subject, predicate, or scope.");
    }
    const logicalId = previous?.logicalId ?? input.logicalId ?? newId("claim");
    if (previous && input.logicalId && input.logicalId !== previous.logicalId) throw new Error("logicalId does not match the superseded assertion.");
    const latest = latestAssertion(database, logicalId);
    if (latest && !previous) throw new Error("Existing logical assertions must be revised with supersedesId.");
    if (previous && latest?.id !== previous.id) throw new Error("Assertion revisions must supersede the latest recorded revision.");
    const revision = (previous?.revision ?? 0) + 1;
    const canonical = {
      logicalId,
      revision,
      subjectId: input.subjectId,
      predicate,
      value: safeJsonParse<unknown>(serializedValue, null),
      scope,
      authority: input.authority,
      confidence: input.confidence,
      producer,
      lifecycle,
      reviewState,
      validFrom,
      validTo,
      supersedesId: previous?.id ?? null,
      evidence,
      metadata,
    };
    const contentHash = sha256(stableStringify(canonical));
    const existingByHash = database.db.prepare("SELECT id FROM assertions WHERE content_hash = ?").get(contentHash) as AssertionRow | undefined;
    if (typeof existingByHash?.id === "string") return getAssertionFromDatabase(database, existingByHash.id) as AssertionRecord;
    const id = `assertion_${contentHash.slice(0, 32)}`;
    const action = input.action ?? defaultAction(lifecycle, previous !== null);
    const cleanRationale = input.rationale ? sanitizeText(input.rationale, 4_000).value : null;

    const persist = (): void => {
      database.db.prepare(`
        INSERT INTO assertions(
          id, logical_id, revision, subject_id, predicate, value_json, scope, authority, confidence,
          producer, lifecycle, review_state, valid_from, valid_to, recorded_at, supersedes_id, content_hash, metadata_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, logicalId, revision, input.subjectId, predicate, serializedValue, scope, input.authority, input.confidence,
        producer, lifecycle, reviewState, validFrom, validTo, recordedAt, previous?.id ?? null, contentHash, stableStringify(metadata),
      );
      const insertEvidence = database.db.prepare("INSERT INTO assertion_evidence(assertion_id, evidence_id, role) VALUES(?, ?, ?)");
      for (const item of evidence) insertEvidence.run(id, item.evidenceId, item.role);
      database.db.prepare(`
        INSERT INTO review_actions(id, assertion_id, previous_assertion_id, actor, action, rationale, rationale_digest, recorded_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId("review"), id, previous?.id ?? null, actor ?? producer, action, cleanRationale,
        cleanRationale ? sha256(cleanRationale) : null, recordedAt,
      );
    };
    if (options.transaction === false) persist();
    else database.transaction(persist);
    return getAssertionFromDatabase(database, id) as AssertionRecord;
}

export function getAssertion(repoRoot: string, assertionId: string): AssertionRecord | null {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try { return getAssertionFromDatabase(database, assertionId); } finally { database.close(); }
}

export function getAssertionHistory(repoRoot: string, logicalId: string): AssertionRecord[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const rows = database.db.prepare("SELECT * FROM assertions WHERE logical_id = ? ORDER BY revision").all(logicalId) as AssertionRow[];
    return rows.map((row) => assertionFromRow(database, row));
  } finally { database.close(); }
}

export function getAssertionReviewHistory(repoRoot: string, logicalId: string): AssertionReviewRecord[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const rows = database.db.prepare(`
      SELECT review_actions.*
      FROM review_actions
      JOIN assertions ON assertions.id = review_actions.assertion_id
      WHERE assertions.logical_id = ?
      ORDER BY review_actions.recorded_at, review_actions.id
    `).all(logicalId) as AssertionRow[];
    return rows.map(reviewFromRow);
  } finally { database.close(); }
}

export function getAssertionEvolution(repoRoot: string, query: AssertionEvolutionQuery = {}): AssertionRecord[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.subjectId) { conditions.push("subject_id = ?"); parameters.push(query.subjectId); }
    if (query.predicate) { conditions.push("predicate = ?"); parameters.push(query.predicate); }
    if (query.recordedFrom) { conditions.push("recorded_at >= ?"); parameters.push(normalizeIso(query.recordedFrom, "recordedFrom")); }
    if (query.recordedTo) { conditions.push("recorded_at <= ?"); parameters.push(normalizeIso(query.recordedTo, "recordedTo")); }
    if (query.validFrom) { conditions.push("(valid_to IS NULL OR valid_to > ?)"); parameters.push(normalizeIso(query.validFrom, "validFrom")); }
    if (query.validTo) { conditions.push("valid_from < ?"); parameters.push(normalizeIso(query.validTo, "validTo")); }
    if (query.recordedFrom && query.recordedTo
      && normalizeIso(query.recordedTo, "recordedTo") < normalizeIso(query.recordedFrom, "recordedFrom")) {
      throw new Error("recordedTo must not be earlier than recordedFrom.");
    }
    if (query.validFrom && query.validTo
      && normalizeIso(query.validTo, "validTo") <= normalizeIso(query.validFrom, "validFrom")) {
      throw new Error("validTo must be later than validFrom.");
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = database.db.prepare(`
      SELECT * FROM assertions
      ${where}
      ORDER BY recorded_at, logical_id, revision
    `).all(...parameters) as AssertionRow[];
    return rows.map((row) => assertionFromRow(database, row));
  } finally { database.close(); }
}

export function queryAssertions(repoRoot: string, query: AssertionQuery = {}): AssertionRecord[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try { return queryAssertionsInDatabase(database, query); } finally { database.close(); }
}

export function queryAssertionsInDatabase(database: AtlasDatabase, query: AssertionQuery = {}): AssertionRecord[] {
  const validAt = normalizeIso(query.validAt ?? nowIso(), "validAt");
  const recordedAt = normalizeIso(query.recordedAt ?? nowIso(), "recordedAt");
  const conditions = ["recorded_at <= ?", "valid_from <= ?", "(valid_to IS NULL OR valid_to > ?)", "review_state = 'accepted'"];
  const parameters: SQLInputValue[] = [recordedAt, validAt, validAt];
  if (query.subjectId) { conditions.push("subject_id = ?"); parameters.push(query.subjectId); }
  if (query.predicate) { conditions.push("predicate = ?"); parameters.push(query.predicate); }
  const included = query.includeLifecycle ?? ["accepted", "stale", "conflicting"];
  const lifecyclePlaceholders = included.map(() => "?").join(",");
  parameters.push(...included);
  const rows = database.db.prepare(`
    WITH eligible AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY logical_id ORDER BY revision DESC) AS position
      FROM assertions
      WHERE ${conditions.join(" AND ")}
    )
    SELECT * FROM eligible
    WHERE position = 1 AND lifecycle IN (${lifecyclePlaceholders})
    ORDER BY subject_id, predicate, scope, logical_id
  `).all(...parameters) as AssertionRow[];
  return rows.map((row) => assertionFromRow(database, row));
}

export function detectAssertionConflicts(repoRoot: string, query: Omit<AssertionQuery, "includeLifecycle"> = {}): AssertionConflict[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try { return detectAssertionConflictsInDatabase(database, query); } finally { database.close(); }
}

export function detectAssertionConflictsInDatabase(
  database: AtlasDatabase,
  query: Omit<AssertionQuery, "includeLifecycle"> = {},
): AssertionConflict[] {
  const assertions = queryAssertionsInDatabase(database, { ...query, includeLifecycle: ["accepted", "conflicting"] });
  const groups = new Map<string, AssertionRecord[]>();
  for (const assertion of assertions) {
    const key = stableStringify([
      assertion.subjectId,
      assertion.predicate,
      assertion.scope,
      ...(isMultiValuedPredicate(assertion.predicate) ? [assertion.logicalId] : []),
    ]);
    const group = groups.get(key) ?? [];
    group.push(assertion);
    groups.set(key, group);
  }
  const conflicts: AssertionConflict[] = [];
  for (const group of groups.values()) {
    const values = new Map(group.map((item) => [stableStringify(item.value), item.value]));
    if (group.length > 1 && values.size > 1) {
      const first = group[0] as AssertionRecord;
      conflicts.push({
        subjectId: first.subjectId,
        predicate: first.predicate,
        scope: first.scope,
        assertionIds: group.map((item) => item.id).sort(),
        values: [...values.values()],
      });
    }
  }
  return conflicts.sort((left, right) => left.subjectId.localeCompare(right.subjectId) || left.predicate.localeCompare(right.predicate));
}

function isMultiValuedPredicate(predicate: string): boolean {
  return predicate === "decision.record" || predicate === "project.risk" || predicate === "project.narrative";
}

export function getAssertionFromDatabase(database: AtlasDatabase, assertionId: string): AssertionRecord | null {
  const row = database.db.prepare("SELECT * FROM assertions WHERE id = ?").get(assertionId) as AssertionRow | undefined;
  return row ? assertionFromRow(database, row) : null;
}

function latestAssertion(database: AtlasDatabase, logicalId: string): AssertionRecord | null {
  const row = database.db.prepare("SELECT * FROM assertions WHERE logical_id = ? ORDER BY revision DESC LIMIT 1").get(logicalId) as AssertionRow | undefined;
  return row ? assertionFromRow(database, row) : null;
}

function assertionFromRow(database: AtlasDatabase, row: AssertionRow): AssertionRecord {
  const evidenceRows = database.db.prepare("SELECT evidence_id, role FROM assertion_evidence WHERE assertion_id = ? ORDER BY role, evidence_id")
    .all(String(row.id)) as AssertionRow[];
  return {
    id: String(row.id),
    logicalId: String(row.logical_id),
    revision: Number(row.revision),
    subjectId: String(row.subject_id),
    predicate: String(row.predicate),
    value: safeJsonParse<unknown>(String(row.value_json), null),
    scope: String(row.scope),
    authority: String(row.authority) as AssertionAuthority,
    confidence: String(row.confidence) as Confidence,
    producer: String(row.producer),
    lifecycle: String(row.lifecycle) as AssertionLifecycle,
    reviewState: String(row.review_state) as AssertionReviewState,
    validFrom: String(row.valid_from),
    validTo: row.valid_to === null ? null : String(row.valid_to),
    recordedAt: String(row.recorded_at),
    supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id),
    contentHash: String(row.content_hash),
    metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {}),
    evidence: evidenceRows.map((item) => ({ evidenceId: String(item.evidence_id), role: String(item.role) as AssertionEvidenceRole })),
  };
}

function reviewFromRow(row: AssertionRow): AssertionReviewRecord {
  return {
    id: String(row.id),
    assertionId: String(row.assertion_id),
    previousAssertionId: row.previous_assertion_id === null ? null : String(row.previous_assertion_id),
    actor: String(row.actor),
    action: String(row.action) as ReviewAction,
    rationale: row.rationale === null ? null : String(row.rationale),
    rationaleDigest: row.rationale_digest === null ? null : String(row.rationale_digest),
    recordedAt: String(row.recorded_at),
  };
}

function deduplicateEvidence(items: AssertionInput["evidence"]): AssertionRecord["evidence"] {
  const unique = new Map<string, { evidenceId: string; role: AssertionEvidenceRole }>();
  for (const item of items) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(item.evidenceId)) throw new Error(`Invalid assertion evidence ID: ${item.evidenceId}`);
    const role = item.role ?? "support";
    unique.set(`${item.evidenceId}\0${role}`, { evidenceId: item.evidenceId, role });
  }
  return [...unique.values()].sort((left, right) => left.role.localeCompare(right.role) || left.evidenceId.localeCompare(right.evidenceId));
}

function validateReviewBoundary(
  lifecycle: AssertionLifecycle,
  reviewState: AssertionReviewState,
  authority: AssertionAuthority,
  producer: string,
  actor: string | null,
  action?: ReviewAction,
): void {
  if (lifecycle === "proposed" && reviewState !== "unreviewed") throw new Error("Proposed assertions must remain unreviewed.");
  if (lifecycle !== "proposed" && reviewState === "unreviewed") throw new Error("Non-proposed assertion revisions require an explicit review state.");
  if (reviewState !== "unreviewed" && !actor) throw new Error("Reviewed assertion revisions require an actor.");
  if (authority === "inferred" && actor === producer) throw new Error("An inference producer cannot review its own assertion.");
  if (action === "defer" && lifecycle !== "proposed") throw new Error("Deferred candidates remain proposed and unreviewed.");
}

function defaultAction(lifecycle: AssertionLifecycle, revision: boolean): ReviewAction {
  if (lifecycle === "proposed") return "propose";
  if (lifecycle === "accepted") return revision ? "edit_accept" : "accept";
  if (lifecycle === "rejected") return "reject";
  if (lifecycle === "withdrawn") return "withdraw";
  if (lifecycle === "superseded") return "supersede";
  if (lifecycle === "stale") return "mark_stale";
  return "mark_conflict";
}

function isGuidanceWatermark(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeToken(value: string, field: string, maximum: number): string {
  const clean = sanitizeText(value, maximum).value.trim();
  if (!clean || clean.length > maximum || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error(`Invalid assertion ${field}.`);
  if (findSecrets(clean).length > 0) throw new Error(`Assertion ${field} appears to contain a secret.`);
  return clean;
}

function normalizeIso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid assertion ${field} timestamp.`);
  return new Date(milliseconds).toISOString();
}

function serializeSafe(value: unknown, label: string, maximum: number): string {
  if (value === undefined) throw new Error(`${label} cannot be undefined.`);
  const serialized = stableStringify(value);
  if (typeof serialized !== "string" || serialized.length > maximum) throw new Error(`${label} exceeds its size limit.`);
  if (findSecrets(serialized).length > 0) throw new Error(`${label} appears to contain a secret.`);
  return serialized;
}
