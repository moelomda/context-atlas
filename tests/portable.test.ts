import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import path from "node:path";
import { initializeConfig } from "../src/core/config.js";
import { AtlasDatabase } from "../src/core/database.js";
import { validateEvidenceLocators } from "../src/core/evidence-validation.js";
import { applyExternalImport, EXTERNAL_IMPORT_EXTRACTOR_VERSION, previewExternalImport } from "../src/core/external-import.js";
import {
  createBackup,
  createRebuildVerificationReport,
  importPortableExport,
  previewPortableImport,
  restoreBackup,
  verifyBackup,
  verifyPortableExport,
  writePortableExport,
} from "../src/core/portable.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { getHealthReport } from "../src/core/health.js";
import { syncRepository } from "../src/core/ingest.js";
import { queryAssertions, recordAssertionRevision } from "../src/core/temporal.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("portable exports are checksummed and contain no withheld secret", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const destination = path.join(root, ".context-atlas", "exports", "knowledge.json");
  const exported = writePortableExport(root, destination);
  assert.equal(verifyPortableExport(destination).valid, true);
  const serialized = readFileSync(destination, "utf8");
  assert.doesNotMatch(serialized, /sk-this-must-never-enter-context-storage/);
  assert.equal(serialized.toLowerCase().includes(root.toLowerCase()), false);
  assert.ok(exported.checksum.length === 64);
  appendFileSync(destination, "tampered");
  assert.equal(verifyPortableExport(destination).valid, false);
});

test("backup verification and recoverable restore preserve approved knowledge", async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string);
  const backupDirectory = path.join(root, ".context-atlas", "backups", "known-good");
  await createBackup(root, backupDirectory);
  assert.equal(verifyBackup(backupDirectory).valid, true);
  await assert.rejects(restoreBackup(root, backupDirectory, "yes"), /exact confirmation token RESTORE/);

  commitFile(root, "src/payments/experimental.ts", "export const unsafeExperiment = true;\n", "Add experimental payment path");
  const restored = await restoreBackup(root, backupDirectory, "RESTORE");
  assert.equal(restored.restored, true);
  assert.match(restored.recoveryBackup, /pre-restore/);
  const health = getHealthReport(root);
  assert.equal(health.checks.find((item) => item.id === "ledger-integrity")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "repository-sync")?.status, "warning");
});

test("portable v2 import plans before writes and atomically transfers reviewed canonical knowledge to a clone", () => {
  const source = createFixtureRepository();
  fixtures.push(source);
  initializeFixture(source);
  const approved = approveProposal(source, listProposals(source, "pending")[0]?.id as string);
  const sourceDatabase = new AtlasDatabase(source, { readOnly: true });
  const project = sourceDatabase.listEntities({ types: ["project"] })[0];
  sourceDatabase.close();
  assert.ok(project);
  const assertion = recordAssertionRevision(source, {
    subjectId: project.id,
    predicate: "project.portability-policy",
    value: { rule: "Reviewed knowledge must survive clone recovery." },
    authority: "human",
    confidence: "approved",
    producer: "human:atlas-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    actor: "human:atlas-test",
    action: "accept",
    evidence: [],
  });
  const sourceFile = path.join(source, ".context-atlas", "exports", "canonical-v2.json");
  const exported = writePortableExport(source, sourceFile);
  assert.equal(exported.schemaVersion, 2);

  const target = cloneRepository(source);
  fixtures.push(target);
  initializeConfig(target, "Fixture Shop");
  syncRepository(target);
  const before = canonicalCounts(target);
  const plan = previewPortableImport(target, sourceFile);
  assert.equal(plan.valid, true, plan.errors.join(" "));
  assert.equal(plan.repositoryMatch, true);
  assert.equal(plan.sourceHeadPresent, true);
  assert.ok(plan.collections.proposals.insert >= 1);
  assert.ok(plan.collections.assertions.insert >= 1);
  assert.ok(plan.excludedDerived.events >= 1);

  const dryRun = importPortableExport(target, sourceFile, { dryRun: true });
  assert.equal(dryRun.applied, false);
  assert.deepEqual(canonicalCounts(target), before);

  const imported = importPortableExport(target, sourceFile);
  assert.equal(imported.applied, true);
  assert.equal(listProposals(target).some((item) => item.id === approved.id && item.status === "approved"), true);
  assert.equal(queryAssertions(target, { predicate: assertion.predicate }).some((item) => item.id === assertion.id), true);
  const secondPlan = previewPortableImport(target, sourceFile);
  assert.equal(secondPlan.valid, true);
  assert.equal(secondPlan.writesPlanned, 0);
  const verification = createRebuildVerificationReport(target, sourceFile);
  assert.equal(verification.derivedRebuildPerformed, false);
  assert.equal(verification.repositoryMatch, true);

  const targetDatabase = new AtlasDatabase(target);
  targetDatabase.db.prepare("UPDATE proposals SET summary = ? WHERE id = ?").run("Locally divergent reviewed record", approved.id);
  targetDatabase.close();
  const beforeCollisionAttempt = canonicalCounts(target);
  const collisionPlan = previewPortableImport(target, sourceFile);
  assert.equal(collisionPlan.valid, false);
  assert.equal(collisionPlan.collisions.some((item) => item.collection === "proposals" && item.id === approved.id), true);
  assert.throws(() => importPortableExport(target, sourceFile), /refused before writes/);
  assert.deepEqual(canonicalCounts(target), beforeCollisionAttempt);
});

test("portable import rejects foreign repository lineage before any mutation", () => {
  const source = createFixtureRepository();
  fixtures.push(source);
  initializeFixture(source);
  const sourceFile = path.join(source, ".context-atlas", "exports", "foreign.json");
  writePortableExport(source, sourceFile);

  const target = createFixtureRepository();
  fixtures.push(target);
  initializeFixture(target);
  const before = canonicalCounts(target);
  const plan = previewPortableImport(target, sourceFile);
  assert.equal(plan.repositoryMatch, false);
  assert.equal(plan.valid, false);
  assert.match(plan.errors.join(" "), /does not match target repository/);
  assert.throws(() => importPortableExport(target, sourceFile), /refused before writes/);
  assert.deepEqual(canonicalCounts(target), before);
});

test("portable v2 preserves explicit external imports with new local audit bindings", () => {
  const source = createFixtureRepository();
  fixtures.push(source);
  initializeFixture(source);
  const sourceDirectory = mkdtempSync(path.join(tmpdir(), "context-atlas-test-external-"));
  fixtures.push(sourceDirectory);
  const selectedFile = path.join(sourceDirectory, "architecture-notes.md");
  writeFileSync(selectedFile, "The worker boundary owns retries and must remain idempotent.\n", "utf8");
  const request = {
    sourceKind: "external_document" as const,
    originLabel: "Selected architecture review",
    declaredAuthority: "documented" as const,
    sensitivityLabel: "normal" as const,
    purpose: "Preserve reviewed external project context during repository transfer.",
    actor: "human:portable-test",
    title: "Architecture review notes",
    sourceObservedAt: "2026-08-23T10:00:00.000Z",
  };
  const preview = previewExternalImport(source, selectedFile, request);
  applyExternalImport(source, selectedFile, { ...request, planId: preview.planId, confirmation: "IMPORT" });
  const exportFile = path.join(source, ".context-atlas", "exports", "external-import.json");
  const exported = writePortableExport(source, exportFile);
  assert.equal(exported.payload.externalImports?.length, 1);
  assert.equal(exported.payload.externalImports?.[0]?.canonicalText?.includes("worker boundary"), true);

  const target = cloneRepository(source);
  fixtures.push(target);
  initializeConfig(target, "Fixture Shop");
  syncRepository(target);
  const plan = previewPortableImport(target, exportFile);
  assert.equal(plan.valid, true, plan.errors.join(" "));
  assert.equal(plan.collections.externalImports.insert, 1);
  const result = importPortableExport(target, exportFile);
  assert.equal(result.applied, true);

  const database = new AtlasDatabase(target, { readOnly: true });
  const restored = database.listExternalImports()[0];
  database.close();
  assert.ok(restored);
  assert.equal(restored.id, preview.planned.importId);
  assert.notEqual(restored.ledgerHash, exported.payload.audit.at(-1)?.hash ?? null);
  const evidence = validateEvidenceLocators(target, [{
    id: restored.evidenceId,
    kind: restored.sourceKind,
    locator: `atlas-import:${restored.id}`,
    digest: restored.contentDigest,
    observedAt: restored.importedAt,
    sensitive: false,
    metadata: {
      importId: restored.id,
      sourceKind: restored.sourceKind,
      declaredAuthority: restored.declaredAuthority,
      sensitivityLabel: restored.sensitivityLabel,
      consentId: restored.consentId,
      policyVersion: restored.policyVersion,
      extractorVersion: EXTERNAL_IMPORT_EXTRACTOR_VERSION,
      untrustedExternalInput: true,
      bodyPersistence: "stored",
    },
  }]);
  assert.deepEqual(evidence.verifiedImportedEvidenceIds, [restored.evidenceId]);
  assert.equal(getHealthReport(target).checks.find((item) => item.id === "event-ledger-coverage")?.status, "pass");
  assert.equal(previewPortableImport(target, exportFile).writesPlanned, 0);
});

function cloneRepository(source: string): string {
  const target = mkdtempSync(path.join(tmpdir(), "context-atlas-test-"));
  execFileSync("git", ["clone", "--quiet", source, target], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", target, "config", "user.name", "Atlas Test"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", target, "config", "user.email", "atlas-test@example.invalid"], { stdio: "ignore", windowsHide: true });
  return target;
}

function canonicalCounts(root: string): Record<string, number> {
  const database = new AtlasDatabase(root, { readOnly: true });
  try {
    return {
      entities: Number((database.db.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number }).count),
      evidence: Number((database.db.prepare("SELECT COUNT(*) AS count FROM evidence").get() as { count: number }).count),
      proposals: Number((database.db.prepare("SELECT COUNT(*) AS count FROM proposals").get() as { count: number }).count),
      assertions: Number((database.db.prepare("SELECT COUNT(*) AS count FROM assertions").get() as { count: number }).count),
      reviews: Number((database.db.prepare("SELECT COUNT(*) AS count FROM review_actions").get() as { count: number }).count),
      externalImports: database.countExternalImports(),
    };
  } finally {
    database.close();
  }
}
