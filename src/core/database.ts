import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";
import type {
  Confidence,
  EntityRecord,
  EvidenceRecord,
  ProposalRecord,
  ProposalStatus,
  RelationshipRecord,
  TimelineEvent,
} from "./types.js";
import { atlasDirectory, ensureAtlasGitIgnore } from "./config.js";
import { nowIso, safeJsonParse, sha256, stableStringify } from "./util.js";

type Row = Record<string, unknown>;

interface StoredEventRow {
  id: unknown;
  timestamp: unknown;
  type: unknown;
  title: unknown;
  summary: unknown;
  commit_hash: unknown;
  files_json: unknown;
  evidence_ids_json: unknown;
  ledger_hash: unknown;
}

interface StoredEventIntegrityRow extends StoredEventRow {
  content_digest: unknown;
  binding_digest: unknown;
}

export interface EventIntegrityRecord {
  id: string;
  type: string;
  ledgerHash: string | null;
  contentDigest: string | null;
  bindingDigest: string | null;
  computedContentDigest: string;
  computedBindingDigest: string | null;
}

export interface ReadSchemaIntegrity {
  valid: boolean;
  error: string | null;
}

const REQUIRED_READ_SCHEMA_OBJECTS = [
  ["table", "event_integrity"],
  ["trigger", "events_immutable_content"],
  ["trigger", "events_ledger_hash_once"],
  ["trigger", "events_no_delete"],
  ["trigger", "event_integrity_immutable_content"],
  ["trigger", "event_integrity_binding_once"],
  ["trigger", "event_integrity_no_delete"],
] as const;

function storedEventContentDigest(row: StoredEventRow): string {
  return sha256(stableStringify({
    id: String(row.id),
    timestamp: String(row.timestamp),
    type: String(row.type),
    title: String(row.title),
    summary: String(row.summary),
    commitHash: row.commit_hash === null ? null : String(row.commit_hash),
    filesJson: String(row.files_json),
    evidenceIdsJson: String(row.evidence_ids_json),
  }));
}

function eventLedgerBindingDigest(eventId: string, contentDigest: string, ledgerHash: string): string {
  return sha256(stableStringify({ eventId, contentDigest, ledgerHash }));
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export class AtlasDatabase {
  static readonly CURRENT_SCHEMA_VERSION = 5;
  readonly db: DatabaseSync;

  constructor(readonly repoRoot: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path.join(atlasDirectory(repoRoot), "atlas.db"), {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
      timeout: 5_000,
      defensive: true,
    });
    if (options.readOnly) {
      try { this.validateReadOnlySchema(); }
      catch (error) {
        try { this.db.close(); } catch { /* preserve the schema error */ }
        throw error;
      }
    } else {
      try { this.initialize(); }
      catch (error) {
        try { this.db.close(); } catch { /* preserve the migration error */ }
        throw error;
      }
      try { chmodSync(path.join(atlasDirectory(repoRoot), "atlas.db"), 0o600); } catch { /* best effort on platforms without POSIX modes */ }
    }
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    const rawVersion = this.getMeta("schema_version");
    const priorVersion = rawVersion === null ? null : Number(rawVersion);
    if (rawVersion !== null && (!Number.isInteger(priorVersion) || Number(priorVersion) < 1)) {
      throw new Error(`Invalid Context Atlas database schema version: ${rawVersion}`);
    }
    if (priorVersion !== null && priorVersion > AtlasDatabase.CURRENT_SCHEMA_VERSION) {
      throw new Error(`Context Atlas database schema ${priorVersion} is newer than supported schema ${AtlasDatabase.CURRENT_SCHEMA_VERSION}. Upgrade Context Atlas before opening it.`);
    }
    if (priorVersion !== null && priorVersion < AtlasDatabase.CURRENT_SCHEMA_VERSION) this.createMigrationSnapshot(priorVersion);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        locator TEXT NOT NULL,
        digest TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
        metadata_json TEXT NOT NULL,
        UNIQUE(kind, locator, digest)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evidence_locator_idx ON evidence(locator);
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'superseded', 'removed')),
        confidence TEXT NOT NULL CHECK (confidence IN ('observed', 'documented', 'approved', 'inferred')),
        source TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        stale_after_days INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        primary_evidence_id TEXT REFERENCES evidence(id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entities_type_status_idx ON entities(type, status);
      CREATE TABLE IF NOT EXISTS entity_versions (
        id INTEGER PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        reason TEXT NOT NULL,
        UNIQUE(entity_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES entities(id),
        target_id TEXT NOT NULL REFERENCES entities(id),
        type TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('observed', 'documented', 'approved', 'inferred')),
        evidence_id TEXT REFERENCES evidence(id),
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relationships_active_idx ON relationships(active, source_id, target_id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        commit_hash TEXT UNIQUE,
        files_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        ledger_hash TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp DESC);
      CREATE TABLE IF NOT EXISTS event_integrity (
        event_id TEXT PRIMARY KEY REFERENCES events(id),
        content_digest TEXT NOT NULL CHECK (
          length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
        ),
        binding_digest TEXT CHECK (
          binding_digest IS NULL OR (
            length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'
          )
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        risk_flags_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        review_note TEXT,
        conflict_group TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        head TEXT,
        status TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assertions (
        id TEXT PRIMARY KEY,
        logical_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        subject_id TEXT NOT NULL REFERENCES entities(id),
        predicate TEXT NOT NULL,
        value_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        authority TEXT NOT NULL CHECK (authority IN ('observed', 'derived', 'documented', 'human', 'inferred')),
        confidence TEXT NOT NULL CHECK (confidence IN ('observed', 'documented', 'approved', 'inferred')),
        producer TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('proposed', 'accepted', 'rejected', 'superseded', 'withdrawn', 'stale', 'conflicting')),
        review_state TEXT NOT NULL CHECK (review_state IN ('unreviewed', 'accepted', 'rejected')),
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        recorded_at TEXT NOT NULL,
        supersedes_id TEXT REFERENCES assertions(id),
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        CHECK (valid_to IS NULL OR valid_to > valid_from),
        UNIQUE(logical_id, revision),
        UNIQUE(content_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assertions_subject_predicate_idx ON assertions(subject_id, predicate, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS assertions_logical_revision_idx ON assertions(logical_id, revision DESC);
      CREATE TABLE IF NOT EXISTS assertion_evidence (
        assertion_id TEXT NOT NULL REFERENCES assertions(id),
        evidence_id TEXT NOT NULL REFERENCES evidence(id),
        role TEXT NOT NULL CHECK (role IN ('support', 'contradict', 'context')),
        PRIMARY KEY(assertion_id, evidence_id, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assertion_evidence_evidence_idx ON assertion_evidence(evidence_id, assertion_id);
      CREATE TABLE IF NOT EXISTS review_actions (
        id TEXT PRIMARY KEY,
        assertion_id TEXT NOT NULL REFERENCES assertions(id),
        previous_assertion_id TEXT REFERENCES assertions(id),
        actor TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('propose', 'accept', 'edit_accept', 'reject', 'defer', 'withdraw', 'supersede', 'mark_stale', 'mark_conflict')),
        rationale TEXT,
        rationale_digest TEXT,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_actions_assertion_idx ON review_actions(assertion_id, recorded_at);
      CREATE TABLE IF NOT EXISTS context_pack_overrides (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        reason_digest TEXT NOT NULL,
        task_digest TEXT,
        critical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (expires_at > created_at)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS context_pack_overrides_expiry_idx ON context_pack_overrides(expires_at, critical_digest);
      CREATE TABLE IF NOT EXISTS ledger_outbox (
        sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
        entry_hash TEXT NOT NULL UNIQUE,
        previous_hash TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_flush_receipts (
        entry_hash TEXT PRIMARY KEY REFERENCES ledger_outbox(entry_hash),
        flushed_at TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS assertions_no_update
      BEFORE UPDATE ON assertions BEGIN
        SELECT RAISE(ABORT, 'assertions are immutable; create a revision');
      END;
      CREATE TRIGGER IF NOT EXISTS assertions_no_delete
      BEFORE DELETE ON assertions BEGIN
        SELECT RAISE(ABORT, 'assertions are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS review_actions_no_update
      BEFORE UPDATE ON review_actions BEGIN
        SELECT RAISE(ABORT, 'review actions are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS review_actions_no_delete
      BEFORE DELETE ON review_actions BEGIN
        SELECT RAISE(ABORT, 'review actions are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS context_pack_overrides_no_update
      BEFORE UPDATE ON context_pack_overrides BEGIN
        SELECT RAISE(ABORT, 'context pack overrides are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS context_pack_overrides_no_delete
      BEFORE DELETE ON context_pack_overrides BEGIN
        SELECT RAISE(ABORT, 'context pack overrides are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS events_immutable_content
      BEFORE UPDATE ON events
      WHEN NEW.id IS NOT OLD.id
        OR NEW.timestamp IS NOT OLD.timestamp
        OR NEW.type IS NOT OLD.type
        OR NEW.title IS NOT OLD.title
        OR NEW.summary IS NOT OLD.summary
        OR NEW.commit_hash IS NOT OLD.commit_hash
        OR NEW.files_json IS NOT OLD.files_json
        OR NEW.evidence_ids_json IS NOT OLD.evidence_ids_json
      BEGIN
        SELECT RAISE(ABORT, 'timeline event content is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS events_ledger_hash_once
      BEFORE UPDATE OF ledger_hash ON events
      WHEN NOT (
        OLD.ledger_hash IS NULL
        AND NEW.ledger_hash IS NOT NULL
        AND length(NEW.ledger_hash) = 64
        AND NEW.ledger_hash NOT GLOB '*[^0-9a-f]*'
      )
      BEGIN
        SELECT RAISE(ABORT, 'timeline event ledger hash can only be attached once');
      END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete
      BEFORE DELETE ON events BEGIN
        SELECT RAISE(ABORT, 'timeline events are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS event_integrity_immutable_content
      BEFORE UPDATE OF event_id, content_digest ON event_integrity BEGIN
        SELECT RAISE(ABORT, 'timeline event content digest is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS event_integrity_binding_once
      BEFORE UPDATE OF binding_digest ON event_integrity
      WHEN NOT (
        OLD.binding_digest IS NULL
        AND NEW.binding_digest IS NOT NULL
        AND length(NEW.binding_digest) = 64
        AND NEW.binding_digest NOT GLOB '*[^0-9a-f]*'
      )
      BEGIN
        SELECT RAISE(ABORT, 'timeline event ledger binding can only be attached once');
      END;
      CREATE TRIGGER IF NOT EXISTS event_integrity_no_delete
      BEFORE DELETE ON event_integrity BEGIN
        SELECT RAISE(ABORT, 'timeline event integrity records are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ledger_outbox_no_update
      BEFORE UPDATE ON ledger_outbox BEGIN
        SELECT RAISE(ABORT, 'ledger outbox entries are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ledger_outbox_no_delete
      BEFORE DELETE ON ledger_outbox BEGIN
        SELECT RAISE(ABORT, 'ledger outbox entries are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ledger_flush_receipts_no_update
      BEFORE UPDATE ON ledger_flush_receipts BEGIN
        SELECT RAISE(ABORT, 'ledger flush receipts are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS ledger_flush_receipts_no_delete
      BEFORE DELETE ON ledger_flush_receipts BEGIN
        SELECT RAISE(ABORT, 'ledger flush receipts are immutable');
      END;
      `);
      if (priorVersion !== null && priorVersion < AtlasDatabase.CURRENT_SCHEMA_VERSION) {
        this.backfillEventIntegrity();
      }
      this.setMeta("schema_version", String(AtlasDatabase.CURRENT_SCHEMA_VERSION));
      if (priorVersion !== null && priorVersion < AtlasDatabase.CURRENT_SCHEMA_VERSION) {
        this.setMeta("last_migration", `${priorVersion}->${AtlasDatabase.CURRENT_SCHEMA_VERSION}@${nowIso()}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the schema error */ }
      throw error;
    }
  }

  private validateReadOnlySchema(): void {
    const integrity = this.inspectReadSchemaIntegrity();
    if (!integrity.valid) throw new Error(integrity.error ?? "Context Atlas database schema integrity validation failed.");
  }

  /**
   * Re-checks the immutable schema boundary on an already-open handle. Health
   * reporting uses this after startup so removing a guard cannot be mistaken
   * for a healthy database merely because SQLite's page check still passes.
   */
  inspectReadSchemaIntegrity(): ReadSchemaIntegrity {
    let rawVersion: string | null = null;
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
      rawVersion = typeof row?.value === "string" ? row.value : null;
    } catch {
      return {
        valid: false,
        error: "Context Atlas database is not initialized. Run `context-atlas init` first.",
      };
    }
    const version = rawVersion === null ? null : Number(rawVersion);
    if (!Number.isInteger(version) || version !== AtlasDatabase.CURRENT_SCHEMA_VERSION) {
      return {
        valid: false,
        error: `Context Atlas database schema ${rawVersion ?? "unknown"} requires explicit migration to ${AtlasDatabase.CURRENT_SCHEMA_VERSION}. Run \`context-atlas migrate\`.`,
      };
    }
    const lookup = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?");
    for (const [type, name] of REQUIRED_READ_SCHEMA_OBJECTS) {
      if (!lookup.get(type, name)) {
        return {
          valid: false,
          error: `Context Atlas database schema ${rawVersion} is missing required ${type} ${name}. Restore or migrate a verified store before reading it.`,
        };
      }
    }
    return { valid: true, error: null };
  }

  private backfillEventIntegrity(): void {
    const rows = this.db.prepare(`
      SELECT id, timestamp, type, title, summary, commit_hash, files_json, evidence_ids_json, ledger_hash
      FROM events
      ORDER BY id
    `).all() as unknown as StoredEventRow[];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO event_integrity(event_id, content_digest, binding_digest)
      VALUES(?, ?, ?)
    `);
    const read = this.db.prepare("SELECT content_digest, binding_digest FROM event_integrity WHERE event_id = ?");
    for (const row of rows) {
      const contentDigest = storedEventContentDigest(row);
      const ledgerHash = nullableString(row.ledger_hash);
      const bindingDigest = ledgerHash ? eventLedgerBindingDigest(String(row.id), contentDigest, ledgerHash) : null;
      insert.run(String(row.id), contentDigest, bindingDigest);
      const stored = read.get(String(row.id)) as { content_digest?: unknown; binding_digest?: unknown } | undefined;
      if (stored?.content_digest !== contentDigest || nullableString(stored?.binding_digest) !== bindingDigest) {
        throw new Error(`Timeline event integrity backfill disagrees with immutable event ${String(row.id)}.`);
      }
    }
  }

  private createMigrationSnapshot(priorVersion: number): void {
    ensureAtlasGitIgnore(this.repoRoot);
    const migrationDirectory = path.join(atlasDirectory(this.repoRoot), "migrations");
    if (existsSync(migrationDirectory) && lstatSync(migrationDirectory).isSymbolicLink()) {
      throw new Error("Refusing to write a migration snapshot through a symbolic link.");
    }
    mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
    const stamp = nowIso().replace(/[:.]/g, "-");
    let snapshotPath = path.join(migrationDirectory, `atlas-v${priorVersion}-to-v${AtlasDatabase.CURRENT_SCHEMA_VERSION}-${stamp}.db`);
    let suffix = 1;
    while (existsSync(snapshotPath)) {
      snapshotPath = path.join(migrationDirectory, `atlas-v${priorVersion}-to-v${AtlasDatabase.CURRENT_SCHEMA_VERSION}-${stamp}-${suffix}.db`);
      suffix += 1;
    }
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    this.db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    try { chmodSync(snapshotPath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  }

  transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private rollbackSavepoint(name: "context_atlas_event_insert" | "context_atlas_event_binding"): void {
    try { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* preserve the original write error */ }
    try { this.db.exec(`RELEASE SAVEPOINT ${name}`); } catch { /* preserve the original write error */ }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  upsertEvidence(evidence: EvidenceRecord): void {
    this.db.prepare(`
      INSERT INTO evidence(id, kind, locator, digest, observed_at, sensitive, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_at=excluded.observed_at,
        sensitive=MAX(evidence.sensitive, excluded.sensitive),
        metadata_json=excluded.metadata_json
    `).run(
      evidence.id,
      evidence.kind,
      evidence.locator,
      evidence.digest,
      evidence.observedAt,
      evidence.sensitive ? 1 : 0,
      stableStringify(evidence.metadata),
    );
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as Row | undefined;
    return row ? evidenceFromRow(row) : null;
  }

  listEvidence(ids: string[]): EvidenceRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM evidence WHERE id IN (${placeholders})`).all(...ids) as Row[];
    return rows.map(evidenceFromRow);
  }

  listAllEvidence(): EvidenceRecord[] {
    return (this.db.prepare("SELECT * FROM evidence ORDER BY observed_at, id").all() as Row[]).map(evidenceFromRow);
  }

  hasCommit(commitHash: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM events WHERE commit_hash = ?").get(commitHash));
  }

  insertEvent(event: TimelineEvent): boolean {
    if (event.ledgerHash !== null && !isSha256(event.ledgerHash)) {
      throw new Error("Timeline event ledger hash must be a canonical SHA-256 digest.");
    }
    const filesJson = stableStringify(event.files);
    const evidenceIdsJson = stableStringify(event.evidence);
    const contentDigest = storedEventContentDigest({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      title: event.title,
      summary: event.summary,
      commit_hash: event.commit,
      files_json: filesJson,
      evidence_ids_json: evidenceIdsJson,
      ledger_hash: event.ledgerHash,
    });
    const bindingDigest = event.ledgerHash
      ? eventLedgerBindingDigest(event.id, contentDigest, event.ledgerHash)
      : null;
    this.db.exec("SAVEPOINT context_atlas_event_insert");
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO events(id, timestamp, type, title, summary, commit_hash, files_json, evidence_ids_json, ledger_hash)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.timestamp, event.type, event.title, event.summary, event.commit,
        filesJson, evidenceIdsJson, event.ledgerHash,
      );
      const inserted = Number(result.changes) > 0;
      if (inserted) {
        this.db.prepare(`
          INSERT INTO event_integrity(event_id, content_digest, binding_digest)
          VALUES(?, ?, ?)
        `).run(event.id, contentDigest, bindingDigest);
      }
      this.db.exec("RELEASE SAVEPOINT context_atlas_event_insert");
      return inserted;
    } catch (error) {
      this.rollbackSavepoint("context_atlas_event_insert");
      throw error;
    }
  }

  updateEventLedgerHash(eventId: string, ledgerHash: string): void {
    if (!isSha256(ledgerHash)) throw new Error("Timeline event ledger hash must be a canonical SHA-256 digest.");
    const row = this.db.prepare(`
      SELECT events.id, events.ledger_hash, event_integrity.content_digest, event_integrity.binding_digest
      FROM events
      LEFT JOIN event_integrity ON event_integrity.event_id = events.id
      WHERE events.id = ?
    `).get(eventId) as Row | undefined;
    if (!row) throw new Error(`Unknown timeline event: ${eventId}`);
    const contentDigest = typeof row.content_digest === "string" ? row.content_digest : null;
    if (!contentDigest || !isSha256(contentDigest)) throw new Error(`Timeline event ${eventId} lacks a valid immutable content digest.`);
    const expectedBinding = eventLedgerBindingDigest(eventId, contentDigest, ledgerHash);
    const existingHash = nullableString(row.ledger_hash);
    if (existingHash !== null) {
      if (existingHash === ledgerHash && row.binding_digest === expectedBinding) return;
      throw new Error(`Timeline event ${eventId} already has an immutable ledger binding.`);
    }
    this.db.exec("SAVEPOINT context_atlas_event_binding");
    try {
      const eventUpdate = this.db.prepare("UPDATE events SET ledger_hash = ? WHERE id = ? AND ledger_hash IS NULL").run(ledgerHash, eventId);
      const integrityUpdate = this.db.prepare(`
        UPDATE event_integrity SET binding_digest = ?
        WHERE event_id = ? AND binding_digest IS NULL
      `).run(expectedBinding, eventId);
      if (Number(eventUpdate.changes) !== 1 || Number(integrityUpdate.changes) !== 1) {
        throw new Error(`Timeline event ${eventId} ledger binding was not attached atomically.`);
      }
      this.db.exec("RELEASE SAVEPOINT context_atlas_event_binding");
    } catch (error) {
      this.rollbackSavepoint("context_atlas_event_binding");
      throw error;
    }
  }

  listEventIntegrityRecords(): EventIntegrityRecord[] {
    const rows = this.db.prepare(`
      SELECT events.id, events.timestamp, events.type, events.title, events.summary,
             events.commit_hash, events.files_json, events.evidence_ids_json, events.ledger_hash,
             event_integrity.content_digest, event_integrity.binding_digest
      FROM events
      LEFT JOIN event_integrity ON event_integrity.event_id = events.id
      ORDER BY events.id
    `).all() as unknown as StoredEventIntegrityRow[];
    return rows.map((row) => {
      const id = String(row.id);
      const ledgerHash = nullableString(row.ledger_hash);
      const contentDigest = nullableString(row.content_digest);
      const bindingDigest = nullableString(row.binding_digest);
      const computedContentDigest = storedEventContentDigest(row);
      return {
        id,
        type: String(row.type),
        ledgerHash,
        contentDigest,
        bindingDigest,
        computedContentDigest,
        computedBindingDigest: ledgerHash
          ? eventLedgerBindingDigest(id, computedContentDigest, ledgerHash)
          : null,
      };
    });
  }

  listEvents(query = "", limit = 100): TimelineEvent[] {
    const capped = Math.max(1, Math.min(100_000, limit));
    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = query
      ? this.db.prepare(`SELECT * FROM events WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR commit_hash LIKE ? ESCAPE '\\' ORDER BY timestamp DESC, id ASC LIMIT ?`).all(pattern, pattern, pattern, capped) as Row[]
      : this.db.prepare("SELECT * FROM events ORDER BY timestamp DESC, id ASC LIMIT ?").all(capped) as Row[];
    return rows.map(eventFromRow);
  }

  countEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as Row;
    return Number(row.count ?? 0);
  }

  deactivateObservedState(): void {
    this.db.prepare("UPDATE relationships SET active = 0").run();
  }

  upsertEntity(entity: EntityRecord, evidenceIds: string[], reason: string): { created: boolean; changed: boolean } {
    const existing = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id) as Row | undefined;
    const snapshot = stableStringify({
      type: entity.type,
      title: entity.title,
      summary: entity.summary,
      status: entity.status,
      confidence: entity.confidence,
      source: entity.source,
      staleAfterDays: entity.staleAfterDays,
      payload: entity.payload,
      primaryEvidenceId: entity.primaryEvidenceId,
    });
    if (!existing) {
      this.db.prepare(`
        INSERT INTO entities(id, type, title, summary, status, confidence, source, first_seen, last_seen, stale_after_days, payload_json, primary_evidence_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entity.id, entity.type, entity.title, entity.summary, entity.status, entity.confidence, entity.source,
        entity.firstSeen, entity.lastSeen, entity.staleAfterDays, stableStringify(entity.payload), entity.primaryEvidenceId,
      );
      this.insertEntityVersion(entity.id, snapshot, evidenceIds, reason, entity.lastSeen);
      return { created: true, changed: true };
    }
    const previous = stableStringify({
      type: existing.type,
      title: existing.title,
      summary: existing.summary,
      status: existing.status,
      confidence: existing.confidence,
      source: existing.source,
      staleAfterDays: existing.stale_after_days,
      payload: safeJsonParse(String(existing.payload_json), {}),
      primaryEvidenceId: existing.primary_evidence_id,
    });
    const changed = previous !== snapshot;
    this.db.prepare(`
      UPDATE entities SET type=?, title=?, summary=?, status=?, confidence=?, source=?, last_seen=?, stale_after_days=?, payload_json=?, primary_evidence_id=?
      WHERE id=?
    `).run(
      entity.type, entity.title, entity.summary, entity.status, entity.confidence, entity.source,
      entity.lastSeen, entity.staleAfterDays, stableStringify(entity.payload), entity.primaryEvidenceId, entity.id,
    );
    if (changed) {
      this.db.prepare("UPDATE entity_versions SET superseded_at = ? WHERE entity_id = ? AND superseded_at IS NULL").run(entity.lastSeen, entity.id);
      this.insertEntityVersion(entity.id, snapshot, evidenceIds, reason, entity.lastSeen);
    }
    return { created: false, changed };
  }

  private insertEntityVersion(entityId: string, snapshot: string, evidenceIds: string[], reason: string, createdAt: string): void {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM entity_versions WHERE entity_id = ?").get(entityId) as Row;
    const version = Number(row.version ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO entity_versions(entity_id, version, snapshot_json, evidence_ids_json, created_at, superseded_at, reason)
      VALUES(?, ?, ?, ?, ?, NULL, ?)
    `).run(entityId, version, snapshot, stableStringify(evidenceIds), createdAt, reason);
  }

  markUnseenObservedEntities(scanTimestamp: string): number {
    const result = this.db.prepare(`
      UPDATE entities SET status='removed'
      WHERE source IN ('repository', 'document') AND last_seen <> ? AND status <> 'removed'
    `).run(scanTimestamp);
    return Number(result.changes);
  }

  upsertRelationship(relationship: RelationshipRecord): void {
    this.db.prepare(`
      INSERT INTO relationships(id, source_id, target_id, type, confidence, evidence_id, created_at, active)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence, evidence_id=excluded.evidence_id, active=excluded.active
    `).run(
      relationship.id, relationship.sourceId, relationship.targetId, relationship.type, relationship.confidence,
      relationship.evidenceId, nowIso(), relationship.active ? 1 : 0,
    );
  }

  getEntity(id: string): EntityRecord | null {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Row | undefined;
    return row ? entityFromRow(row) : null;
  }

  listEntities(options: { includeRemoved?: boolean; types?: string[] } = {}): EntityRecord[] {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (!options.includeRemoved) conditions.push("status <> 'removed'");
    if (options.types?.length) {
      conditions.push(`type IN (${options.types.map(() => "?").join(",")})`);
      parameters.push(...options.types);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM entities ${where} ORDER BY type, title`).all(...parameters) as Row[]).map(entityFromRow);
  }

  listRelationships(): RelationshipRecord[] {
    return (this.db.prepare("SELECT * FROM relationships WHERE active = 1 ORDER BY type, source_id, target_id").all() as Row[])
      .map(relationshipFromRow);
  }

  entityEvidenceCount(entityId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM evidence WHERE id IN (
        SELECT primary_evidence_id FROM entities WHERE id = ? AND primary_evidence_id IS NOT NULL
      )
    `).get(entityId) as Row;
    return Number(row.count ?? 0);
  }

  listEntityVersions(entityId: string): Array<{
    version: number;
    snapshot: Record<string, unknown>;
    evidenceIds: string[];
    createdAt: string;
    supersededAt: string | null;
    reason: string;
  }> {
    const rows = this.db.prepare("SELECT * FROM entity_versions WHERE entity_id = ? ORDER BY version DESC").all(entityId) as Row[];
    return rows.map((row) => ({
      version: Number(row.version),
      snapshot: safeJsonParse(String(row.snapshot_json), {}),
      evidenceIds: safeJsonParse(String(row.evidence_ids_json), []),
      createdAt: String(row.created_at),
      supersededAt: row.superseded_at === null ? null : String(row.superseded_at),
      reason: String(row.reason),
    }));
  }

  createProposal(proposal: ProposalRecord): ProposalRecord {
    let conflictGroup = proposal.conflictGroup;
    if (proposal.targetId) {
      const pending = this.db.prepare("SELECT id, conflict_group FROM proposals WHERE status='pending' AND target_id=? ORDER BY created_at").all(proposal.targetId) as Row[];
      if (pending.length > 0) {
        conflictGroup = String(pending[0]?.conflict_group ?? `conflict_${proposal.targetId.replace(/[^a-z0-9_-]/gi, "_")}`);
        this.db.prepare("UPDATE proposals SET conflict_group=? WHERE status='pending' AND target_id=?").run(conflictGroup, proposal.targetId);
      }
    }
    this.db.prepare(`
      INSERT INTO proposals(id, kind, target_id, title, summary, payload_json, evidence_ids_json, risk_flags_json, status, created_at, reviewed_at, review_note, conflict_group)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id, proposal.kind, proposal.targetId, proposal.title, proposal.summary,
      stableStringify(proposal.payload), stableStringify(proposal.evidenceIds), stableStringify(proposal.riskFlags),
      proposal.status, proposal.createdAt, proposal.reviewedAt, proposal.reviewNote, conflictGroup,
    );
    return { ...proposal, conflictGroup };
  }

  getProposal(id: string): ProposalRecord | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return row ? proposalFromRow(row) : null;
  }

  listProposals(status?: ProposalStatus): ProposalRecord[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
      : this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all() as Row[];
    return rows.map(proposalFromRow);
  }

  reviewProposal(id: string, status: Exclude<ProposalStatus, "pending">, note: string | null, reviewedAt = nowIso()): boolean {
    const result = this.db.prepare("UPDATE proposals SET status=?, reviewed_at=?, review_note=? WHERE id=? AND status='pending'")
      .run(status, reviewedAt, note, id);
    return Number(result.changes) === 1;
  }

  startIngestionRun(id: string, startedAt: string, head: string | null): void {
    this.db.prepare("INSERT INTO ingestion_runs(id, started_at, head, status, stats_json) VALUES(?, ?, ?, 'running', '{}')")
      .run(id, startedAt, head);
  }

  completeIngestionRun(id: string, status: "completed" | "failed", stats: unknown, error: string | null): void {
    this.db.prepare("UPDATE ingestion_runs SET completed_at=?, status=?, stats_json=?, error=? WHERE id=?")
      .run(nowIso(), status, stableStringify(stats), error, id);
  }

  quickCheck(): string {
    const row = this.db.prepare("PRAGMA quick_check").get() as Row;
    return String(Object.values(row)[0] ?? "unknown");
  }

  countMissingPrimaryEvidence(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM entities e
      LEFT JOIN evidence ev ON ev.id=e.primary_evidence_id
      WHERE e.status <> 'removed' AND (e.primary_evidence_id IS NULL OR ev.id IS NULL)
    `).get() as Row;
    return Number(row.count ?? 0);
  }

  countSensitiveEvidence(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE sensitive=1").get() as Row;
    return Number(row.count ?? 0);
  }

  countUnledgeredEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE ledger_hash IS NULL").get() as Row;
    return Number(row.count ?? 0);
  }
}

function evidenceFromRow(row: Row): EvidenceRecord {
  return {
    id: String(row.id), kind: String(row.kind), locator: String(row.locator), digest: String(row.digest),
    observedAt: String(row.observed_at), sensitive: Number(row.sensitive) === 1,
    metadata: safeJsonParse(String(row.metadata_json), {}),
  };
}

function entityFromRow(row: Row): EntityRecord {
  return {
    id: String(row.id), type: String(row.type), title: String(row.title), summary: String(row.summary),
    status: String(row.status) as EntityRecord["status"], confidence: String(row.confidence) as Confidence,
    source: String(row.source), firstSeen: String(row.first_seen), lastSeen: String(row.last_seen),
    staleAfterDays: Number(row.stale_after_days), payload: safeJsonParse(String(row.payload_json), {}),
    primaryEvidenceId: row.primary_evidence_id === null ? null : String(row.primary_evidence_id),
  };
}

function relationshipFromRow(row: Row): RelationshipRecord {
  return {
    id: String(row.id), sourceId: String(row.source_id), targetId: String(row.target_id), type: String(row.type),
    confidence: String(row.confidence) as Confidence,
    evidenceId: row.evidence_id === null ? null : String(row.evidence_id), active: Number(row.active) === 1,
  };
}

function eventFromRow(row: Row): TimelineEvent {
  return {
    id: String(row.id), timestamp: String(row.timestamp), type: String(row.type), title: String(row.title),
    summary: String(row.summary), commit: row.commit_hash === null ? null : String(row.commit_hash),
    files: safeJsonParse(String(row.files_json), []), evidence: safeJsonParse(String(row.evidence_ids_json), []),
    ledgerHash: row.ledger_hash === null ? null : String(row.ledger_hash),
  };
}

function proposalFromRow(row: Row): ProposalRecord {
  return {
    id: String(row.id), kind: String(row.kind), targetId: row.target_id === null ? null : String(row.target_id),
    title: String(row.title), summary: String(row.summary), payload: safeJsonParse(String(row.payload_json), {}),
    evidenceIds: safeJsonParse(String(row.evidence_ids_json), []), riskFlags: safeJsonParse(String(row.risk_flags_json), []),
    status: String(row.status) as ProposalStatus, createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
    reviewNote: row.review_note === null ? null : String(row.review_note),
    conflictGroup: row.conflict_group === null ? null : String(row.conflict_group),
  };
}
