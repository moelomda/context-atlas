import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AtlasDatabase } from "../src/core/database.js";
import { getHealthReport } from "../src/core/health.js";
import { syncRepository } from "../src/core/ingest.js";
import { appendLedgerEntry, flushLedgerOutbox, ledgerPath, stageLedgerEntry, verifyLedger, verifyLedgerState } from "../src/core/ledger.js";
import { createPortableExport } from "../src/core/portable.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
const faultChildren = new Set<ChildProcess>();
afterEach(async () => {
  const children = [...faultChildren];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.allSettled(children.map((child) => waitForExit(child)));
  faultChildren.clear();
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

interface FaultChildMessage {
  type: "committed" | "ready" | "result";
  ok?: boolean;
  flushed?: number;
  head?: string;
  error?: string;
}

const faultChildPath = fileURLToPath(new URL("./fixtures/ledger-fault-child.ts", import.meta.url));

test("append-only ledger detects tampering", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  appendLedgerEntry(root, { kind: "test", actionId: "one", payload: { value: 1 } });
  appendLedgerEntry(root, { kind: "test", actionId: "two", payload: { value: 2 } });
  assert.deepEqual(verifyLedger(root), { valid: true, entries: 2, head: verifyLedger(root).head, error: null });
  appendFileSync(ledgerPath(root), "{\"sequence\":3,\"hash\":\"forged\"}\n");
  const damaged = verifyLedger(root);
  assert.equal(damaged.valid, false);
  assert.match(damaged.error ?? "", /Invalid ledger record schema/);
});

test("transactional outbox recovers a crash boundary without losing or duplicating audit entries", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const before = verifyLedger(root);

  const database = new AtlasDatabase(root);
  database.transaction(() => {
    stageLedgerEntry(root, database, { kind: "crash_fixture", actionId: "outbox-one", payload: { safe: true } });
  });
  const staged = verifyLedgerState(root, database);
  assert.equal(staged.consistent, true);
  assert.equal(staged.unflushedEntries, 1);
  assert.equal(staged.physicallyPendingEntries, 1);
  assert.equal(verifyLedger(root).entries, before.entries);
  const health = getHealthReport(root, database);
  assert.equal(health.checks.find((item) => item.id === "ledger-integrity")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "ledger-outbox")?.status, "warning");
  database.close();

  const recovered = new AtlasDatabase(root);
  assert.equal(flushLedgerOutbox(root, recovered).flushed, 1);
  const finalState = verifyLedgerState(root, recovered);
  assert.equal(finalState.unflushedEntries, 0);
  assert.equal(finalState.consistent, true);
  assert.equal(verifyLedger(root).entries, before.entries + 1);
  assert.throws(() => recovered.db.prepare("DELETE FROM ledger_outbox").run(), /immutable/);
  recovered.close();
});

test("timeline event rows reject summary, file, and evidence rewrites and health detects bypassed tampering", () => {
  const cases = [
    { column: "summary", value: "forged summary" },
    { column: "files_json", value: '[{"path":"forged.ts","status":"M"}]' },
    { column: "evidence_ids_json", value: "[]" },
  ] as const;

  for (const mutation of cases) {
    const root = createFixtureRepository();
    fixtures.push(root);
    initializeFixture(root);
    const database = new AtlasDatabase(root);
    try {
      const before = getHealthReport(root, database).checks.find((item) => item.id === "event-ledger-coverage");
      assert.equal(before?.status, "pass");
      const target = database.db.prepare("SELECT id FROM events WHERE type = 'git_commit' ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
      const targetId = target?.id;
      assert.ok(targetId);
      const rewrite = database.db.prepare(`UPDATE events SET ${mutation.column} = ? WHERE id = ?`);
      assert.throws(() => rewrite.run(mutation.value, targetId), /timeline event content is immutable/i);

      // Model corruption performed outside the application/trigger boundary and
      // prove the independent content digest still fails health closed.
      database.db.exec("DROP TRIGGER events_immutable_content");
      rewrite.run(mutation.value, targetId);
      const damagedHealth = getHealthReport(root, database);
      const schemaHealth = damagedHealth.checks.find((item) => item.id === "database-schema-integrity");
      assert.equal(schemaHealth?.status, "critical");
      assert.match(schemaHealth?.details ?? "", /missing required trigger events_immutable_content/i);
      assert.equal(damagedHealth.verdict, "blocked");
      assert.equal(damagedHealth.safeToUse, false);
      const after = damagedHealth.checks.find((item) => item.id === "event-ledger-coverage");
      assert.equal(after?.status, "critical");
      assert.match(after?.details ?? "", /content-digest mismatch/i);
      assert.match(after?.details ?? "", new RegExp(targetId));
    } finally {
      database.close();
    }
  }
});

test("synchronization refuses to mutate after timeline content integrity is damaged", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const target = database.db.prepare("SELECT id FROM events WHERE type = 'git_commit' ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
  assert.ok(target?.id);
  const runsBefore = database.db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs").get() as { count: number };
  database.db.exec("DROP TRIGGER events_immutable_content");
  database.db.prepare("UPDATE events SET summary = ? WHERE id = ?").run("forged before sync", target.id);
  database.close();

  assert.throws(() => syncRepository(root), /timeline event integrity check failed before synchronization.*content-digest mismatch/i);
  const reopened = new AtlasDatabase(root, { readOnly: true });
  const runsAfter = reopened.db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs").get() as { count: number };
  assert.equal(runsAfter.count, runsBefore.count, "failed integrity preflight must not start a new ingestion run");
  reopened.close();
});

test("timeline hashes attach once and timeline rows cannot be deleted", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  try {
    const target = database.db.prepare("SELECT id FROM events ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
    const targetId = target?.id;
    assert.ok(targetId);
    assert.throws(
      () => database.db.prepare("UPDATE events SET ledger_hash = ledger_hash WHERE id = ?").run(targetId),
      /ledger hash can only be attached once/i,
    );
    assert.throws(
      () => database.db.prepare("DELETE FROM events WHERE id = ?").run(targetId),
      /timeline events are immutable/i,
    );
  } finally {
    database.close();
  }
});

test("timeline health rejects a content-bound event that reuses a non-event ledger action", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  try {
    const entries = database.db.prepare("SELECT entry_json FROM ledger_outbox ORDER BY sequence").all() as Array<{ entry_json: string }>;
    const proposalEntry = entries
      .map((row) => JSON.parse(row.entry_json) as { actionId: string; hash: string; kind: string; timestamp: string })
      .find((entry) => entry.kind === "proposal_created");
    assert.ok(proposalEntry);
    const evidence = database.db.prepare("SELECT id FROM evidence ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
    assert.ok(evidence?.id);

    assert.equal(database.insertEvent({
      id: proposalEntry.actionId,
      timestamp: proposalEntry.timestamp,
      type: "context_approval",
      title: "Forged approval timeline event",
      summary: "Reuses a proposal-created action with a valid local content binding.",
      commit: null,
      files: [],
      evidence: [evidence.id],
      ledgerHash: proposalEntry.hash,
    }), true);

    const health = getHealthReport(root, database).checks.find((item) => item.id === "event-ledger-coverage");
    assert.equal(health?.status, "critical");
    assert.match(health?.details ?? "", /ledger kind 'proposal_created' is invalid for 'context_approval'/i);
    assert.match(health?.details ?? "", new RegExp(proposalEntry.actionId));
  } finally {
    database.close();
  }
});

test("rolled-back audit staging never reaches the external ledger", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const before = verifyLedger(root);
  assert.throws(() => database.transaction(() => {
    stageLedgerEntry(root, database, { kind: "rollback_fixture", actionId: "rolled-back", payload: { safe: true } });
    throw new Error("force rollback");
  }), /force rollback/);
  assert.equal(verifyLedger(root).head, before.head);
  assert.equal(verifyLedgerState(root, database).unflushedEntries, 0);
  database.close();
});

test("an abruptly killed process leaves its committed audit entry recoverable exactly once", { timeout: 20_000 }, async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const before = verifyLedger(root);

  const child = startFaultChild("stage-and-wait", root);
  await waitForFaultMessage(child, "committed");
  const exit = waitForExit(child);
  assert.equal(child.kill("SIGKILL"), true);
  const killed = await exit;
  assert.notEqual(killed.code, 0);

  const database = new AtlasDatabase(root);
  try {
    const crashed = verifyLedgerState(root, database);
    assert.equal(crashed.consistent, true);
    assert.equal(crashed.unflushedEntries, 1);
    assert.equal(crashed.physicallyPendingEntries, 1);
    assert.equal(verifyLedger(root).entries, before.entries);

    assert.equal(flushLedgerOutbox(root, database).flushed, 1);
    assert.equal(flushLedgerOutbox(root, database).flushed, 0);
    assert.equal(verifyLedger(root).entries, before.entries + 1);
    assert.equal(verifyLedgerState(root, database).unflushedEntries, 0);
  } finally {
    database.close();
  }
});

test("a torn ledger tail is ambiguous corruption and recovery never edits it", { timeout: 20_000 }, async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  database.transaction(() => {
    stageLedgerEntry(root, database, {
      kind: "torn_tail_fixture",
      actionId: "must-remain-in-outbox",
      payload: { safe: false },
    });
  });
  database.close();

  const filePath = ledgerPath(root);
  const descriptor = openSync(filePath, "a");
  try {
    writeSync(descriptor, '{"sequence":999,"previousHash":"torn');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const damagedBytes = readFileSync(filePath);
  assert.equal(verifyLedger(root).valid, false);

  const child = startFaultChild("flush-on-command", root);
  await waitForFaultMessage(child, "ready");
  child.send({ type: "go" });
  const result = await waitForFaultMessage(child, "result");
  const exit = await waitForExit(child);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid ledger/i);
  assert.equal(exit.code, 1);
  assert.deepEqual(readFileSync(filePath), damagedBytes);

  const reopened = new AtlasDatabase(root);
  try {
    const state = verifyLedgerState(root, reopened);
    assert.equal(state.valid, false);
    assert.equal(state.consistent, false);
    assert.equal(state.unflushedEntries, 1);
    const health = getHealthReport(root, reopened);
    const outboxHealth = health.checks.find((item) => item.id === "ledger-outbox");
    assert.equal(outboxHealth?.status, "warning");
    assert.match(outboxHealth?.details ?? "", /automatic reconciliation is blocked/i);
    assert.match(outboxHealth?.recommendation ?? "", /do not retry or edit/i);
    const pending = reopened.db.prepare(`
      SELECT COUNT(*) AS count FROM ledger_outbox
      LEFT JOIN ledger_flush_receipts USING(entry_hash)
      WHERE ledger_flush_receipts.entry_hash IS NULL
    `).get() as { count: number };
    assert.equal(pending.count, 1);
  } finally {
    reopened.close();
  }
});

test("missing newline and blank record framing are rejected as torn or tampered ledger bytes", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  appendLedgerEntry(root, { kind: "framing_fixture", actionId: "one", payload: { value: 1 } });
  const complete = readFileSync(ledgerPath(root));

  truncateSync(ledgerPath(root), complete.length - 1);
  const missingNewline = verifyLedger(root);
  assert.equal(missingNewline.valid, false);
  assert.match(missingNewline.error ?? "", /terminating newline/i);

  const descriptor = openSync(ledgerPath(root), "w");
  try {
    writeSync(descriptor, Buffer.concat([complete, Buffer.from("\n")]));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const blankLine = verifyLedger(root);
  assert.equal(blankLine.valid, false);
  assert.match(blankLine.error ?? "", /blank ledger record/i);
});

test("non-object and non-canonical ledger records fail closed before export", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const filePath = ledgerPath(root);
  const original = readFileSync(filePath, "utf8");

  for (const invalid of ["null\n", "[]\n"]) {
    writeFileSync(filePath, invalid);
    const verification = verifyLedger(root);
    assert.equal(verification.valid, false);
    assert.match(verification.error ?? "", /record must be a JSON object/i);
  }

  writeFileSync(filePath, original);
  const lines = original.trimEnd().split(/\r?\n/);
  const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  first.unhashedInjected = "SECRET-CANARY-MUST-NOT-EXPORT";
  lines[0] = JSON.stringify(first);
  writeFileSync(filePath, `${lines.join("\n")}\n`);

  const verification = verifyLedger(root);
  assert.equal(verification.valid, false);
  assert.match(verification.error ?? "", /exactly the canonical ledger fields/i);
  assert.throws(() => createPortableExport(root), /Cannot export unreconciled audit state.*canonical ledger fields/i);
});

test("recovery preflights the expected head and leaves an inconsistent ledger byte-identical", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  try {
    database.transaction(() => {
      stageLedgerEntry(root, database, {
        kind: "preflight_fixture",
        actionId: "must-not-append",
        payload: { safe: false },
      });
      database.setMeta("ledger_head", "0".repeat(64));
    });
    const before = readFileSync(ledgerPath(root));

    assert.throws(() => flushLedgerOutbox(root, database), /Recoverable ledger head .* does not match expected head/i);
    assert.deepEqual(readFileSync(ledgerPath(root)), before);
    const pending = database.db.prepare(`
      SELECT COUNT(*) AS count FROM ledger_outbox
      LEFT JOIN ledger_flush_receipts USING(entry_hash)
      WHERE ledger_flush_receipts.entry_hash IS NULL
    `).get() as { count: number };
    assert.equal(pending.count, 1);
  } finally {
    database.close();
  }
});

test("two recovery processes serialize one outbox append without conflict or duplication", { timeout: 25_000 }, async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const before = verifyLedger(root);
  const database = new AtlasDatabase(root);
  database.transaction(() => {
    stageLedgerEntry(root, database, {
      kind: "concurrent_recovery_fixture",
      actionId: "one-entry-two-recovery-processes",
      payload: { writers: 2 },
    });
  });
  database.close();

  const first = startFaultChild("flush-on-command", root);
  const second = startFaultChild("flush-on-command", root);
  try {
    await Promise.all([
      waitForFaultMessage(first, "ready"),
      waitForFaultMessage(second, "ready"),
    ]);
    const firstExit = waitForExit(first);
    const secondExit = waitForExit(second);
    const firstResult = waitForFaultMessage(first, "result");
    const secondResult = waitForFaultMessage(second, "result");
    first.send({ type: "go" });
    second.send({ type: "go" });

    const results = await Promise.all([firstResult, secondResult]);
    const exits = await Promise.all([firstExit, secondExit]);
    assert.deepEqual(results.map((item) => item.ok), [true, true]);
    assert.deepEqual(results.map((item) => item.flushed).sort(), [0, 1]);
    assert.equal(new Set(results.map((item) => item.head)).size, 1);
    assert.deepEqual(exits.map((item) => item.code), [0, 0]);
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  }

  const recovered = new AtlasDatabase(root);
  try {
    const finalState = verifyLedgerState(root, recovered);
    assert.equal(finalState.valid, true);
    assert.equal(finalState.consistent, true);
    assert.equal(finalState.unflushedEntries, 0);
    assert.equal(finalState.entries, before.entries + 1);
    const receipts = recovered.db.prepare("SELECT COUNT(*) AS count FROM ledger_flush_receipts").get() as { count: number };
    const outbox = recovered.db.prepare("SELECT COUNT(*) AS count FROM ledger_outbox").get() as { count: number };
    assert.equal(receipts.count, outbox.count);
  } finally {
    recovered.close();
  }
});

function startFaultChild(mode: "stage-and-wait" | "flush-on-command", repoRoot: string): ChildProcess {
  const child = fork(faultChildPath, [mode, repoRoot], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    execArgv: ["--import", "tsx"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  faultChildren.add(child);
  child.once("exit", () => { faultChildren.delete(child); });
  return child;
}

function waitForFaultMessage(child: ChildProcess, type: FaultChildMessage["type"], timeoutMs = 10_000): Promise<FaultChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for child ${type} message.`)), timeoutMs);
    const onMessage = (message: unknown): void => {
      if (isFaultChildMessage(message) && message.type === type) finish(null, message);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`Fault child exited before ${type}: code=${String(code)} signal=${String(signal)}`));
    };
    const finish = (error: Error | null, message?: FaultChildMessage): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message as FaultChildMessage);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for fault child exit.")), timeoutMs);
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(null, { code, signal });
    const finish = (error: Error | null, result?: { code: number | null; signal: NodeJS.Signals | null }): void => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(result as { code: number | null; signal: NodeJS.Signals | null });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function isFaultChildMessage(message: unknown): message is FaultChildMessage {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return type === "committed" || type === "ready" || type === "result";
}
