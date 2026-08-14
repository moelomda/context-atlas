import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { generatePrivacyReport, previewRetention } from "../src/core/privacy.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

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
  assert.equal(report.retention.applied, false);
  assert.doesNotMatch(serialized, /sk-this-must-never-enter-context-storage/);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY=/);
  assert.doesNotMatch(serialized, /[A-Z]:\\|\/Users\//i);
});

test("retention preview inventories aggregate candidates but cannot delete protected or operator-managed data", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const exportsDirectory = path.join(root, ".context-atlas", "exports");
  mkdirSync(exportsDirectory, { recursive: true });
  const artifact = path.join(exportsDirectory, "operator-export.json");
  writeFileSync(artifact, "{}\n", { encoding: "utf8", mode: 0o600 });

  const preview = previewRetention(root, { portableExportsOlderThanDays: 0, backupsOlderThanDays: 0 });
  assert.equal(preview.applied, false);
  assert.equal(preview.deletionSupported, false);
  assert.equal(preview.protected.canonicalDatabase, true);
  assert.ok(preview.candidates.find((item) => item.dataClass === "portable-export")?.items);
  assert.equal(existsSync(artifact), true);
  assert.throws(() => previewRetention(root, { portableExportsOlderThanDays: -1 }), /must be an integer/);
});
