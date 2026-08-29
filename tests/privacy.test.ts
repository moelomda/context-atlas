import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { AtlasDatabase } from "../src/core/database.js";
import { applyExternalImport, previewExternalImport } from "../src/core/external-import.js";
import { flushLedgerOutbox, stageLedgerEntry } from "../src/core/ledger.js";
import { applyRetention, generatePrivacyReport, listRetentionTombstones, previewRetention } from "../src/core/privacy.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

test("privacy report reconciles bounded scope and exposes only secret-safe egress and finding metadata", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const report = generatePrivacyReport(root);
  const serialized = JSON.stringify(report);

  assert.equal(report.scope.scanTruncated, false);
  assert.ok(report.scope.repositoryFilesObserved >= report.scope.indexableFileCandidates);
  assert.ok(report.scope.sensitivePathsWithheld >= 1);
  assert.ok(report.findings.sensitiveEvidenceRecords >= 1);
  assert.equal(report.findings.secretValuesIncludedInReport, false);
  assert.equal(report.findings.storedPotentialSecretMatches, 0);
  assert.equal(report.egress.remoteProviderCapability, "not-implemented");
  assert.equal(report.egress.attemptsRecorded, 0);
  assert.equal(report.externalImports.records, 0);
  assert.equal(report.retention.applied, false);
  assert.doesNotMatch(serialized, /sk-this-must-never-enter-context-storage/);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY=/);
  assert.doesNotMatch(serialized, /[A-Z]:\\|\/Users\//i);
});

test("privacy report reconciles stored and metadata-only external imports without paths or bodies", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const sourceDirectory = mkdtempSync(path.join(tmpdir(), "context-atlas-test-external-"));
  fixtures.push(sourceDirectory);
  const normalFile = path.join(sourceDirectory, "normal-notes.md");
  const sensitiveFile = path.join(sourceDirectory, "sensitive-notes.md");
  const normalBody = "External architecture notes describe an idempotent worker boundary.";
  const sensitiveBody = "Private customer interview summary intentionally withheld from ordinary presentation.";
  writeFileSync(normalFile, normalBody, "utf8");
  writeFileSync(sensitiveFile, sensitiveBody, "utf8");
  const base = {
    sourceKind: "external_document" as const,
    originLabel: "Explicit privacy fixture",
    declaredAuthority: "documented" as const,
    purpose: "Verify external import storage disclosure and sensitive body omission.",
    actor: "human:privacy-test",
    sourceObservedAt: "2026-08-23T10:00:00.000Z",
  };
  const normalRequest = { ...base, sensitivityLabel: "normal" as const, title: "Normal architecture notes" };
  const normalPlan = previewExternalImport(root, normalFile, normalRequest);
  applyExternalImport(root, normalFile, { ...normalRequest, planId: normalPlan.planId, confirmation: "IMPORT" });
  const sensitiveRequest = { ...base, sensitivityLabel: "sensitive" as const, title: "Sensitive interview notes" };
  const sensitivePlan = previewExternalImport(root, sensitiveFile, sensitiveRequest);
  applyExternalImport(root, sensitiveFile, { ...sensitiveRequest, planId: sensitivePlan.planId, confirmation: "IMPORT" });

  const report = generatePrivacyReport(root);
  const serialized = JSON.stringify(report);
  assert.equal(report.externalImports.records, 2);
  assert.equal(report.externalImports.normalBodiesStored, 1);
  assert.equal(report.externalImports.sensitiveBodiesOmitted, 1);
  assert.equal(report.externalImports.storedBodyBytes, Buffer.byteLength(normalBody, "utf8"));
  assert.equal(report.externalImports.consentRecords, 2);
  assert.equal(report.externalImports.rawOriginPathsStored, false);
  assert.doesNotMatch(serialized, new RegExp(sensitiveBody.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(serialized.toLowerCase().includes(sourceDirectory.toLowerCase()), false);
});

test("retention preview is non-destructive and apply requires a fresh attributed confirmation", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const exportsDirectory = path.join(root, ".context-atlas", "exports");
  const backupsDirectory = path.join(root, ".context-atlas", "backups", "old-copy");
  mkdirSync(exportsDirectory, { recursive: true });
  mkdirSync(backupsDirectory, { recursive: true });
  const artifact = path.join(exportsDirectory, "operator-export.json");
  const backupArtifact = path.join(backupsDirectory, "atlas.db");
  writeFileSync(artifact, "{}\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(backupArtifact, "backup\n", { encoding: "utf8", mode: 0o600 });
  const canonicalDatabase = path.join(root, ".context-atlas", "atlas.db");
  const auditLedger = path.join(root, ".context-atlas", "ledger.ndjson");
  const canonicalBytes = statSync(canonicalDatabase).size;

  const preview = previewRetention(root, { portableExportsOlderThanDays: 0, backupsOlderThanDays: 0 });
  assert.equal(preview.applied, false);
  assert.equal(preview.deletionSupported, true);
  assert.equal(preview.inventoryComplete, true);
  assert.match(preview.planId, /^[a-f0-9]{64}$/);
  assert.equal(preview.protected.canonicalDatabase, true);
  assert.ok(preview.candidates.find((item) => item.dataClass === "portable-export")?.items);
  assert.equal(existsSync(artifact), true);
  assert.throws(() => previewRetention(root, { portableExportsOlderThanDays: -1 }), /must be an integer/);

  assert.throws(
    () =>
      applyRetention(root, {
        portableExportsOlderThanDays: 0,
        backupsOlderThanDays: 0,
        planId: preview.planId,
        actor: "human:privacy-test",
        reason: "Remove explicit disposable artifacts after verified export handoff.",
        userConfirmed: false as never,
      }),
    /explicit user confirmation/,
  );

  writeFileSync(path.join(exportsDirectory, "changed-after-preview.json"), "{}\n", { encoding: "utf8", mode: 0o600 });
  assert.throws(
    () =>
      applyRetention(root, {
        portableExportsOlderThanDays: 0,
        backupsOlderThanDays: 0,
        planId: preview.planId,
        actor: "human:privacy-test",
        reason: "Remove explicit disposable artifacts after verified export handoff.",
        userConfirmed: true,
      }),
    /changed after preview/,
  );

  const refreshed = previewRetention(root, { portableExportsOlderThanDays: 0, backupsOlderThanDays: 0 });
  const unconfirmedEmptyDirectory = path.join(root, ".context-atlas", "backups", "operator-layout-after-preview");
  mkdirSync(unconfirmedEmptyDirectory, { recursive: true });
  const result = applyRetention(root, {
    portableExportsOlderThanDays: 0,
    backupsOlderThanDays: 0,
    planId: refreshed.planId,
    actor: "human:privacy-test",
    reason: "Remove explicit disposable artifacts after verified export handoff.",
    userConfirmed: true,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.failedItems, 0);
  assert.ok(result.deletedItems >= 3);
  assert.equal(existsSync(artifact), false);
  assert.equal(existsSync(backupArtifact), false);
  assert.equal(existsSync(unconfirmedEmptyDirectory), true);
  assert.equal(existsSync(canonicalDatabase), true);
  assert.equal(statSync(canonicalDatabase).size >= canonicalBytes, true);
  assert.equal(existsSync(auditLedger), true);
  assert.equal(listRetentionTombstones(root)[0]?.status, "completed");
  const database = new AtlasDatabase(root);
  const pendingRunId = `retention_${randomUUID()}_${"b".repeat(16)}`;
  try {
    database.transaction(() =>
      stageLedgerEntry(root, database, {
        kind: "retention_apply_started",
        actionId: "C:\\Users\\private-workspace:started",
        payload: { ignoredMalformedRetentionAction: true },
      }),
    );
    flushLedgerOutbox(root, database);
    database.transaction(() => {
      const started = stageLedgerEntry(root, database, {
        kind: "retention_apply_started",
        actionId: `${pendingRunId}:started`,
        payload: { recoverableHistoryFixture: true },
      });
      stageLedgerEntry(root, database, {
        kind: "retention_apply_completed",
        actionId: `${pendingRunId}:completed`,
        payload: { recoverableHistoryFixture: true, startedLedgerHash: started.hash },
      });
    });
  } finally {
    database.close();
  }
  const tombstones = listRetentionTombstones(root);
  assert.equal(tombstones.length, 2);
  assert.equal(tombstones.find((item) => item.runId === pendingRunId)?.status, "completed");
  const serialized = JSON.stringify({ refreshed, result, tombstones });
  assert.doesNotMatch(serialized, /operator-export|old-copy|changed-after-preview|[A-Z]:\\|\/Users\//i);
});

test("retention confirmation is bound to one physical Atlas store", () => {
  const firstRoot = createFixtureRepository();
  const secondRoot = createFixtureRepository();
  fixtures.push(firstRoot, secondRoot);
  initializeFixture(firstRoot);
  initializeFixture(secondRoot);

  const firstPreview = previewRetention(firstRoot);
  const secondPreview = previewRetention(secondRoot);
  assert.equal(firstPreview.wouldDeleteItems, 0);
  assert.equal(secondPreview.wouldDeleteItems, 0);
  assert.notEqual(firstPreview.planId, secondPreview.planId);
  assert.throws(
    () =>
      applyRetention(secondRoot, {
        planId: firstPreview.planId,
        actor: "human:privacy-test",
        reason: "Confirm that a retention token cannot cross physical project stores.",
        userConfirmed: true,
      }),
    /changed after preview/,
  );
});

test("retention detects a same-size artifact rewrite even when its mtime is restored", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const exportsDirectory = path.join(root, ".context-atlas", "exports");
  mkdirSync(exportsDirectory, { recursive: true });
  const artifact = path.join(exportsDirectory, "replaceable.json");
  writeFileSync(artifact, "alpha\n", { encoding: "utf8", mode: 0o600 });
  const before = statSync(artifact);
  const preview = previewRetention(root, { portableExportsOlderThanDays: 0 });

  writeFileSync(artifact, "bravo\n", { encoding: "utf8", mode: 0o600 });
  utimesSync(artifact, before.atimeMs / 1_000, before.mtimeMs / 1_000);
  assert.equal(statSync(artifact).size, before.size);
  assert.throws(
    () =>
      applyRetention(root, {
        portableExportsOlderThanDays: 0,
        planId: preview.planId,
        actor: "human:privacy-test",
        reason: "Reject an artifact whose bytes changed after the confirmed preview.",
        userConfirmed: true,
      }),
    /changed after preview/,
  );
  assert.equal(readFileSync(artifact, "utf8"), "bravo\n");
});

test("retention refuses to claim deletion for an artifact with another hard link", (context) => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const exportsDirectory = path.join(root, ".context-atlas", "exports");
  mkdirSync(exportsDirectory, { recursive: true });
  const artifact = path.join(exportsDirectory, "linked-export.json");
  const retainedLink = path.join(root, "retained-export-hardlink.json");
  writeFileSync(artifact, "linked export\n", { encoding: "utf8", mode: 0o600 });
  try {
    linkSync(artifact, retainedLink);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
      context.skip(`Hard links are unavailable on this platform (${code}).`);
      return;
    }
    throw error;
  }

  const preview = previewRetention(root, { portableExportsOlderThanDays: 0 });
  assert.equal(preview.inventoryComplete, false);
  assert.match(preview.warnings.join(" "), /unsafe filesystem object/);
  assert.throws(
    () =>
      applyRetention(root, {
        portableExportsOlderThanDays: 0,
        planId: preview.planId,
        actor: "human:privacy-test",
        reason: "Do not claim deletion while another hard link can retain the bytes.",
        userConfirmed: true,
      }),
    /incomplete artifact inventory/,
  );
  assert.equal(existsSync(artifact), true);
  assert.equal(existsSync(retainedLink), true);
});

test("retention refuses a symlinked Atlas storage root", (context) => {
  const root = createFixtureRepository();
  const externalRoot = createFixtureRepository();
  fixtures.push(root, externalRoot);
  initializeFixture(root);
  initializeFixture(externalRoot);
  const atlasRoot = path.join(root, ".context-atlas");
  const preservedAtlasRoot = path.join(root, ".context-atlas-preserved-for-test");
  const externalAtlasRoot = path.join(externalRoot, ".context-atlas");
  const externalExports = path.join(externalAtlasRoot, "exports");
  mkdirSync(externalExports, { recursive: true });
  const externalArtifact = path.join(externalExports, "must-survive.json");
  writeFileSync(externalArtifact, "{}\n", { encoding: "utf8", mode: 0o600 });
  renameSync(atlasRoot, preservedAtlasRoot);
  let linked = false;
  try {
    try {
      symlinkSync(externalAtlasRoot, atlasRoot, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
        context.skip(`Directory links are unavailable on this platform (${code}).`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => previewRetention(root, { portableExportsOlderThanDays: 0 }),
      /regular, non-symlink directory inside the repository/,
    );
    assert.equal(existsSync(externalArtifact), true);
  } finally {
    if (linked && existsSync(atlasRoot)) {
      try {
        unlinkSync(atlasRoot);
      } catch {
        rmdirSync(atlasRoot);
      }
    }
    if (!existsSync(atlasRoot) && existsSync(preservedAtlasRoot)) renameSync(preservedAtlasRoot, atlasRoot);
  }
});
