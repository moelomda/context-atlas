import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { assertInside } from "../src/core/util.js";
import { findSecrets, isSensitivePath, redactSecrets, sanitizeText } from "../src/core/security.js";
import { loadAtlasIgnore } from "../src/core/ignore.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";
import { readFileSync, writeFileSync } from "node:fs";
import { initializeConfig, loadConfig } from "../src/core/config.js";
import { explainEntity, getOverview, getTimeline, searchAtlas } from "../src/core/query.js";
import { buildContextPack } from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { flushLedgerOutbox, stageLedgerEntry, verifyLedgerState } from "../src/core/ledger.js";

test("secret-like values are detected and redacted", () => {
  const value = "token=sk-abcdefghijklmnopqrstuvwxyz123456";
  const findings = findSecrets(value);
  assert.ok(findings.length >= 1);
  const redacted = redactSecrets(value).value;
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(redacted, /REDACTED/);
  assert.equal(sanitizeText(value).sensitive, true);
});

test("sensitive paths are withheld", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/credentials.json"), true);
  assert.equal(isSensitivePath("certs/server.pem"), true);
  assert.equal(isSensitivePath("src/index.ts"), false);
});

test("repository path containment rejects traversal", () => {
  const root = path.resolve("safe-root");
  assert.throws(() => assertInside(root, path.join(root, "..", "outside.txt")), /escapes repository root/);
});

test(".atlasignore applies ordered local-only glob rules", () => {
  const root = createFixtureRepository();
  try {
    writeFileSync(path.join(root, ".atlasignore"), "generated/**\n*.snapshot\n!important.snapshot\n");
    const ignore = loadAtlasIgnore(root);
    assert.equal(ignore.matches("generated/cache/value.json"), true);
    assert.equal(ignore.matches("src/example.snapshot"), true);
    assert.equal(ignore.matches("important.snapshot"), false);
    assert.equal(ignore.matches("src/index.ts"), false);
    assert.ok(ignore.hash);
  } finally {
    removeFixture(root);
  }
});

test("repository exclusions withhold Git-history paths from timeline, search, and packs", () => {
  const root = createFixtureRepository();
  try {
    writeFileSync(path.join(root, ".atlasignore"), "private/**\n", "utf8");
    commitFile(root, "private/client-list.csv", "CUSTOMER-CANARY\n", "Add restricted dataset");
    initializeFixture(root);

    const timeline = getTimeline(root);
    const search = searchAtlas(root, "private/client-list.csv", 20);
    const pack = buildContextPack(root, "Review the latest restricted dataset change", 8_000);
    const serialized = JSON.stringify({ timeline, search, pack });

    assert.doesNotMatch(serialized, /private[\\/]client-list\.csv/i);
    assert.doesNotMatch(serialized, /CUSTOMER-CANARY/);
    assert.match(serialized, /withheld:[a-f0-9]{10}/);
    assert.equal(
      search.results.some((result) => /private[\\/]client-list\.csv|CUSTOMER-CANARY/i.test(JSON.stringify(result))),
      false,
    );
  } finally {
    removeFixture(root);
  }
});

test("unsafe scan limits in local configuration are rejected", () => {
  const root = createFixtureRepository();
  try {
    initializeConfig(root, "Unsafe Limits Fixture");
    const filePath = path.join(root, ".context-atlas", "config.json");
    const config = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    writeFileSync(filePath, JSON.stringify({ ...config, maxFiles: 50_000_000 }, null, 2));
    assert.throws(() => loadConfig(root), /maxFiles/);
  } finally {
    removeFixture(root);
  }
});

test("new commit filenames containing secrets are withheld before storage and summary rendering", () => {
  const root = createFixtureRepository();
  try {
    commitFile(root, "src/payments/sk-seeded-filename-secret-1234567890.ts", "export const example = true;\n", "Add filename fixture");
    initializeFixture(root);
    const database = new AtlasDatabase(root);
    try {
      assert.doesNotMatch(JSON.stringify(database.listEvents()), /sk-seeded-filename-secret/);
      assert.doesNotMatch(JSON.stringify(database.listEntities()), /sk-seeded-filename-secret/);
    } finally {
      database.close();
    }
    const pack = buildContextPack(root, "Review filename fixture", 8_000);
    assert.doesNotMatch(JSON.stringify(pack), /sk-seeded-filename-secret/);
    assert.match(pack.markdown, /withheld by policy/);
  } finally {
    removeFixture(root);
  }
});

test("legacy secret filenames are redacted on every event presentation without changing audit history", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const database = new AtlasDatabase(root);
    const secretPath = "src/payments/sk-legacy-filename-secret-1234567890.ts";
    let rawEvents: string;
    try {
      const evidenceId = database.listEntities({ types: ["project"] })[0]?.primaryEvidenceId;
      assert.ok(evidenceId);
      const ledger = stageLedgerEntry(root, database, {
        kind: "legacy_filename_fixture_event",
        actionId: "event_legacy_filename",
        payload: { eventId: "event_legacy_filename", evidence: [evidenceId] },
      });
      database.insertEvent({
        id: "event_legacy_filename",
        timestamp: new Date().toISOString(),
        type: "commit",
        title: `Legacy filename navigation ${secretPath}`,
        summary: `Legacy filename navigation changed ${secretPath}`,
        commit: null,
        files: [{ status: "R100", path: secretPath, previousPath: `old/${secretPath}` }],
        evidence: [evidenceId],
        ledgerHash: ledger.hash,
      });
      flushLedgerOutbox(root, database);
      rawEvents = JSON.stringify(database.listEvents());
      assert.match(rawEvents, /sk-legacy-filename-secret/);
      assert.equal(verifyLedgerState(root, database).consistent, true);
    } finally {
      database.close();
    }
    const task = "Legacy filename navigation";
    const pack = buildContextPack(root, task, 20_000);
    assert.ok(pack.selection.includedEventIds.includes("event_legacy_filename"));
    const output = JSON.stringify({
      pack,
      timeline: getTimeline(root),
      overview: getOverview(root),
      search: searchAtlas(root, task),
      explanation: explainEntity(root, "src/payments"),
    });
    assert.doesNotMatch(output, /sk-legacy-filename-secret/);
    assert.match(output, /REDACTED/);
    assert.match(output, /withheld:[a-f0-9]{10}/);
    const after = new AtlasDatabase(root);
    try {
      assert.equal(JSON.stringify(after.listEvents()), rawEvents);
      assert.equal(verifyLedgerState(root, after).consistent, true);
    } finally {
      after.close();
    }
  } finally {
    removeFixture(root);
  }
});
