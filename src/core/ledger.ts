import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { atlasDirectory } from "./config.js";
import { AtlasDatabase } from "./database.js";
import type { LedgerEntry } from "./types.js";
import { nowIso, safeJsonParse, sha256, stableStringify } from "./util.js";

export interface LedgerVerification {
  valid: boolean;
  entries: number;
  head: string;
  error: string | null;
}

export interface LedgerStateVerification extends LedgerVerification {
  expectedHead: string;
  unflushedEntries: number;
  physicallyPendingEntries: number;
  consistent: boolean;
}

export function ledgerPath(repoRoot: string): string {
  return path.join(atlasDirectory(repoRoot), "ledger.ndjson");
}

export function appendLedgerEntry(
  repoRoot: string,
  input: { kind: string; actionId: string; payload: unknown; timestamp?: string },
): LedgerEntry {
  const verification = verifyLedger(repoRoot);
  if (!verification.valid) throw new Error(`Cannot append to invalid ledger: ${verification.error}`);
  const entryWithoutHash = {
    sequence: verification.entries + 1,
    previousHash: verification.head,
    timestamp: input.timestamp ?? nowIso(),
    kind: input.kind,
    actionId: input.actionId,
    payloadDigest: sha256(stableStringify(input.payload)),
  };
  const entry: LedgerEntry = { ...entryWithoutHash, hash: sha256(stableStringify(entryWithoutHash)) };
  appendLedgerLineDurably(repoRoot, entry);
  return entry;
}

export function stageLedgerEntry(
  repoRoot: string,
  database: AtlasDatabase,
  input: { kind: string; actionId: string; payload: unknown; timestamp?: string },
): LedgerEntry {
  const state = verifyLedgerState(repoRoot, database);
  if (!state.consistent) throw new Error(`Cannot stage an audit entry against inconsistent ledger state: ${state.error ?? "head or outbox mismatch"}`);
  const recordedSequence = database.getMeta("ledger_sequence");
  const lastSequence = recordedSequence === null ? state.entries + state.physicallyPendingEntries : Number(recordedSequence);
  if (!Number.isInteger(lastSequence) || lastSequence < 0) throw new Error("Stored ledger sequence is invalid.");
  const previousHash = database.getMeta("ledger_head") ?? state.head;
  const entryWithoutHash = {
    sequence: lastSequence + 1,
    previousHash,
    timestamp: input.timestamp ?? nowIso(),
    kind: input.kind,
    actionId: input.actionId,
    payloadDigest: sha256(stableStringify(input.payload)),
  };
  const entry: LedgerEntry = { ...entryWithoutHash, hash: sha256(stableStringify(entryWithoutHash)) };
  database.db.prepare(`
    INSERT INTO ledger_outbox(sequence, entry_hash, previous_hash, entry_json, created_at)
    VALUES(?, ?, ?, ?, ?)
  `).run(entry.sequence, entry.hash, entry.previousHash, stableStringify(entry), nowIso());
  database.setMeta("ledger_sequence", String(entry.sequence));
  database.setMeta("ledger_head", entry.hash);
  return entry;
}

export function flushLedgerOutbox(repoRoot: string, database: AtlasDatabase): { flushed: number; head: string } {
  return database.transaction(() => {
    const parsed = readLedger(repoRoot);
    if (!parsed.verification.valid) throw new Error(`Cannot flush audit outbox into invalid ledger: ${parsed.verification.error}`);
    const pending = pendingOutbox(database);
    const receipts: string[] = [];
    let flushed = 0;
    for (const row of pending) {
      const entry = parseOutboxEntry(row);
      const existing = parsed.entries[entry.sequence - 1];
      if (existing) {
        if (existing.hash !== entry.hash) throw new Error(`Ledger outbox conflicts with existing line ${entry.sequence}.`);
        receipts.push(entry.hash);
        continue;
      }
      const currentHead = parsed.entries.at(-1)?.hash ?? "GENESIS";
      if (entry.sequence !== parsed.entries.length + 1 || entry.previousHash !== currentHead) {
        throw new Error(`Ledger outbox is not contiguous at sequence ${entry.sequence}.`);
      }
      appendLedgerLineDurably(repoRoot, entry);
      parsed.entries.push(entry);
      receipts.push(entry.hash);
      flushed += 1;
    }
    if (receipts.length > 0) {
      const insert = database.db.prepare("INSERT OR IGNORE INTO ledger_flush_receipts(entry_hash, flushed_at) VALUES(?, ?)");
      const flushedAt = nowIso();
      for (const hash of receipts) insert.run(hash, flushedAt);
    }
    const head = parsed.entries.at(-1)?.hash ?? "GENESIS";
    const expectedHead = database.getMeta("ledger_head") ?? "GENESIS";
    if (head !== expectedHead) throw new Error(`Flushed ledger head ${head.slice(0, 12)} does not match expected head ${expectedHead.slice(0, 12)}.`);
    return { flushed, head };
  });
}

export function verifyLedgerState(repoRoot: string, database: AtlasDatabase): LedgerStateVerification {
  const parsed = readLedger(repoRoot);
  const expectedHead = database.getMeta("ledger_head") ?? "GENESIS";
  if (!parsed.verification.valid) {
    return { ...parsed.verification, expectedHead, unflushedEntries: 0, physicallyPendingEntries: 0, consistent: false };
  }
  const pending = pendingOutbox(database);
  let virtualHead = parsed.verification.head;
  let virtualLength = parsed.entries.length;
  let physicallyPendingEntries = 0;
  for (const row of pending) {
    const entry = parseOutboxEntry(row);
    const existing = parsed.entries[entry.sequence - 1];
    if (existing) {
      if (existing.hash !== entry.hash) {
        return { ...parsed.verification, expectedHead, unflushedEntries: pending.length, physicallyPendingEntries, consistent: false, error: `Outbox conflicts with ledger line ${entry.sequence}` };
      }
      continue;
    }
    if (entry.sequence !== virtualLength + 1 || entry.previousHash !== virtualHead) {
      return { ...parsed.verification, expectedHead, unflushedEntries: pending.length, physicallyPendingEntries, consistent: false, error: `Outbox chain is discontinuous at ${entry.sequence}` };
    }
    virtualLength += 1;
    virtualHead = entry.hash;
    physicallyPendingEntries += 1;
  }
  return {
    ...parsed.verification,
    expectedHead,
    unflushedEntries: pending.length,
    physicallyPendingEntries,
    consistent: virtualHead === expectedHead,
    ...(virtualHead === expectedHead ? {} : { error: `Expected ledger head ${expectedHead.slice(0, 12)} but recoverable chain ends at ${virtualHead.slice(0, 12)}` }),
  };
}

export function verifyLedger(repoRoot: string): LedgerVerification {
  return readLedger(repoRoot).verification;
}

function readLedger(repoRoot: string): { verification: LedgerVerification; entries: LedgerEntry[] } {
  const filePath = ledgerPath(repoRoot);
  if (!existsSync(filePath)) return { verification: { valid: true, entries: 0, head: "GENESIS", error: null }, entries: [] };
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { verification: { valid: false, entries: 0, head: "GENESIS", error: "Ledger must be a regular, non-symlink file" }, entries: [] };
  }
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  let previousHash = "GENESIS";
  const entries: LedgerEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const entry = safeJsonParse<Partial<LedgerEntry>>(lines[index] ?? "", {});
    const expectedSequence = index + 1;
    if (entry.sequence !== expectedSequence || entry.previousHash !== previousHash || typeof entry.hash !== "string") {
      return { verification: { valid: false, entries: index, head: previousHash, error: `Invalid chain fields at line ${expectedSequence}` }, entries };
    }
    const calculated = sha256(stableStringify({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      timestamp: entry.timestamp,
      kind: entry.kind,
      actionId: entry.actionId,
      payloadDigest: entry.payloadDigest,
    }));
    if (calculated !== entry.hash) {
      return { verification: { valid: false, entries: index, head: previousHash, error: `Hash mismatch at line ${expectedSequence}` }, entries };
    }
    previousHash = entry.hash;
    entries.push(entry as LedgerEntry);
  }
  return { verification: { valid: true, entries: lines.length, head: previousHash, error: null }, entries };
}

function pendingOutbox(database: AtlasDatabase): Array<Record<string, unknown>> {
  return database.db.prepare(`
    SELECT ledger_outbox.*
    FROM ledger_outbox
    LEFT JOIN ledger_flush_receipts ON ledger_flush_receipts.entry_hash = ledger_outbox.entry_hash
    WHERE ledger_flush_receipts.entry_hash IS NULL
    ORDER BY ledger_outbox.sequence
  `).all() as Array<Record<string, unknown>>;
}

function parseOutboxEntry(row: Record<string, unknown>): LedgerEntry {
  const entry = safeJsonParse<Partial<LedgerEntry>>(String(row.entry_json), {});
  if (!Number.isInteger(entry.sequence) || entry.sequence !== Number(row.sequence)
    || entry.hash !== String(row.entry_hash) || entry.previousHash !== String(row.previous_hash)
    || typeof entry.timestamp !== "string" || typeof entry.kind !== "string"
    || typeof entry.actionId !== "string" || typeof entry.payloadDigest !== "string") {
    throw new Error(`Malformed immutable ledger outbox entry at sequence ${String(row.sequence)}.`);
  }
  const calculated = sha256(stableStringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    timestamp: entry.timestamp,
    kind: entry.kind,
    actionId: entry.actionId,
    payloadDigest: entry.payloadDigest,
  }));
  if (calculated !== entry.hash) throw new Error(`Ledger outbox hash mismatch at sequence ${entry.sequence}.`);
  return entry as LedgerEntry;
}

function appendLedgerLineDurably(repoRoot: string, entry: LedgerEntry): void {
  const directory = atlasDirectory(repoRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = ledgerPath(repoRoot);
  if (existsSync(filePath)) {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Refusing to append through a non-regular or symbolic-link ledger path.");
  }
  const descriptor = openSync(filePath, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(entry)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}
