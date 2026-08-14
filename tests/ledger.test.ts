import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { AtlasDatabase } from "../src/core/database.js";
import { getHealthReport } from "../src/core/health.js";
import { appendLedgerEntry, flushLedgerOutbox, ledgerPath, stageLedgerEntry, verifyLedger, verifyLedgerState } from "../src/core/ledger.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

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
  assert.match(damaged.error ?? "", /Invalid chain fields/);
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
