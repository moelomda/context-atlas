import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import {
  buildContextPack,
  ContextPackBlockedError,
  createContextPackOverride,
} from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { validateEvidenceLocators } from "../src/core/evidence-validation.js";
import { getHealthReport } from "../src/core/health.js";
import { syncRepository } from "../src/core/ingest.js";
import { approveProposal, createProposal, listProposals } from "../src/core/proposals.js";
import { recordAssertionRevision } from "../src/core/temporal.js";
import type { EvidenceRecord } from "../src/core/types.js";
import { sha256 } from "../src/core/util.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("deleted local evidence blocks packs and cannot be bypassed by an integrity override", () => {
  const { root, evidence } = preparedDecisionFixture();
  rmSync(path.join(root, "docs", "adr", "0001-use-ledger.md"));

  const report = validateEvidenceLocators(root, [evidence]);
  assert.deepEqual(report.invalidEvidenceIds, [evidence.id]);
  assert.equal(report.results[0]?.status, "missing");
  assertEvidenceHealthBlocked(root);
  assertPackBlocked(root, "review the append-only ledger decision");

  const task = "review the append-only ledger decision under an explicit integrity override";
  const override = createContextPackOverride(root, {
    actor: "human:evidence-test",
    reason: "Exercise the narrow override path while preserving local evidence fail-closed behavior.",
    task,
    durationMinutes: 5,
  });
  assert.throws(
    () => buildContextPack(root, task, 20_000, { overrideId: override.id }),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((item) => item.id === "pack-mandatory-entity-evidence-closure"),
  );
});

test("renamed local evidence invalidates the recorded locator and blocks packs", () => {
  const { root, evidence } = preparedDecisionFixture();
  renameSync(
    path.join(root, "docs", "adr", "0001-use-ledger.md"),
    path.join(root, "docs", "adr", "0001-ledger-renamed.md"),
  );

  const report = validateEvidenceLocators(root, [evidence]);
  assert.equal(report.results[0]?.status, "missing");
  assertEvidenceHealthBlocked(root);
  assertPackBlocked(root, "review the append-only ledger decision");
});

test("content drift invalidates the recorded digest and blocks packs", () => {
  const { root, evidence } = preparedDecisionFixture();
  writeFileSync(
    path.join(root, "docs", "adr", "0001-use-ledger.md"),
    "# Replace the ledger\n\nStatus: accepted. This content no longer matches the reviewed evidence.\n",
  );

  const report = validateEvidenceLocators(root, [evidence]);
  assert.equal(report.results[0]?.status, "digest-mismatch");
  assertEvidenceHealthBlocked(root);
  assertPackBlocked(root, "review the append-only ledger decision");
});

test("proposal approval revalidates evidence instead of trusting a stored evidence row", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const evidence = database.listAllEvidence()
    .find((item) => item.locator === "file:docs/adr/0001-use-ledger.md");
  database.close();
  assert.ok(evidence);

  const proposal = createProposal(root, {
    kind: "decision",
    title: "Retain the ledger decision",
    summary: "Keep the append-only ledger as the project audit mechanism.",
    evidenceIds: [evidence.id],
  });
  writeFileSync(
    path.join(root, "docs", "adr", "0001-use-ledger.md"),
    "# Changed after proposal\n\nThis no longer matches the evidence reviewed by the proposal.\n",
  );

  assert.throws(
    () => approveProposal(root, proposal.id, "Attempt approval after evidence drift.", "human:evidence-test"),
    /evidence is no longer current and verified.*digest-mismatch/i,
  );
  assert.equal(listProposals(root, "pending").some((item) => item.id === proposal.id), true);
});

test("an override can acknowledge unrelated integrity risk but cannot render an optional claim with invalid evidence", () => {
  const { root, decisionId, evidence } = preparedDecisionFixture();
  const invalidEvidence = evidenceRecord(
    `evidence_${sha256("optional-invalid-evidence").slice(0, 32)}`,
    evidence.kind,
    evidence.locator,
    sha256("content that is not in the recorded file"),
    new Date().toISOString(),
  );
  const database = new AtlasDatabase(root);
  const decision = database.getEntity(decisionId);
  assert.ok(decision);
  database.upsertEvidence(invalidEvidence);
  database.upsertEntity({ ...decision, primaryEvidenceId: invalidEvidence.id }, [invalidEvidence.id], "adversarial invalid evidence fixture");
  database.close();

  assertEvidenceHealthBlocked(root);
  const task = "review the optional append-only ledger decision";
  const override = createContextPackOverride(root, {
    actor: "human:evidence-test",
    reason: "Acknowledge the disposable fixture integrity finding without trusting the affected claim.",
    task,
    durationMinutes: 5,
  });
  const pack = buildContextPack(root, task, 20_000, { overrideId: override.id });
  assert.equal(pack.selection.includedEntityIds.includes(decisionId), false);
  assert.ok(pack.selection.exclusions.some((item) => item.id === decisionId && item.reason === "unsupported"));
});

test("local validation rejects unsafe and sensitive paths without claiming provider verification", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const observedAt = new Date().toISOString();
  const records: EvidenceRecord[] = [
    canonicalEvidenceRecord("document", "file:../outside.md", sha256("outside"), observedAt),
    canonicalEvidenceRecord("document", "file:.env", sha256("placeholder"), observedAt),
    canonicalEvidenceRecord("external_record", "external:0123456789abcdef", sha256("provider"), observedAt),
  ];

  const report = validateEvidenceLocators(root, records);
  assert.equal(report.results[0]?.status, "unsafe-locator");
  assert.equal(report.results[1]?.status, "policy-denied");
  assert.equal(report.results[2]?.status, "provider-not-validated");
  assert.deepEqual(report.unvalidatedEvidenceIds, [records[2]?.id]);
});

test("evidence validation binds IDs and typed kinds to their locator providers", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const observedAt = new Date().toISOString();
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const mismatchedKind = canonicalEvidenceRecord("repository_snapshot", "file:README.md", sha256(readme), observedAt);
  const validDocument = canonicalEvidenceRecord("document", "file:README.md", sha256(readme), observedAt);
  const forgedId = { ...validDocument, id: `evidence_${"0".repeat(32)}` };

  const report = validateEvidenceLocators(root, [mismatchedKind, forgedId, validDocument]);
  assert.equal(report.results[0]?.status, "invalid-record");
  assert.equal(report.results[1]?.status, "invalid-record");
  assert.equal(report.results[2]?.status, "verified");
});

test("corrupt digests fail before provider dispatch and unreachable Git evidence blocks current guidance", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const reachable = database.listAllEvidence().find((item) => item.kind === "git_commit");
  database.close();
  assert.ok(project && reachable);

  const corrupt = validateEvidenceLocators(root, [{ ...reachable, digest: reachable.digest.slice(0, 40) }]);
  assert.equal(corrupt.results[0]?.status, "invalid-digest");

  const tree = runGit(root, ["rev-parse", "HEAD^{tree}"]);
  const unreachableCommit = runGit(root, ["commit-tree", tree, "-m", "Create unreachable evidence object"]);
  const unreachable = evidenceRecord(
    `evidence_${sha256(`git_commit\0git:${unreachableCommit}\0${sha256(unreachableCommit)}`).slice(0, 32)}`,
    "git_commit",
    `git:${unreachableCommit}`,
    sha256(unreachableCommit),
    new Date().toISOString(),
  );
  const unreachableReport = validateEvidenceLocators(root, [unreachable]);
  assert.equal(unreachableReport.results[0]?.status, "unreachable");

  const writeDatabase = new AtlasDatabase(root);
  writeDatabase.upsertEvidence(unreachable);
  writeDatabase.close();
  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.unreachable-evidence",
    value: { summary: "This claim must never become current guidance." },
    authority: "human",
    confidence: "approved",
    producer: "human:evidence-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: unreachable.id, role: "support" }],
    actor: "human:evidence-test",
    action: "accept",
    rationale: "Exercise unreachable Git evidence validation.",
  });
  assertEvidenceHealthBlocked(root);
  assertPackBlocked(root, "review the unreachable evidence decision");
});

test("ordinary edit commit and synchronization replace current evidence without invalidating immutable history", () => {
  const { root, decisionId, evidence: previousEvidence } = preparedDecisionFixture();
  commitFile(
    root,
    "docs/adr/0001-use-ledger.md",
    "# Use an append-only ledger\n\nStatus: accepted. Preserve history with a verified recovery path.\n",
    "Clarify ledger recovery decision",
  );
  syncRepository(root);

  const database = new AtlasDatabase(root);
  const decision = database.getEntity(decisionId);
  const currentEvidence = decision?.primaryEvidenceId ? database.getEvidence(decision.primaryEvidenceId) : null;
  const historicalEvidence = database.getEvidence(previousEvidence.id);
  database.close();
  assert.ok(decision && currentEvidence && historicalEvidence);
  assert.notEqual(currentEvidence.id, previousEvidence.id);
  assert.equal(currentEvidence.locator, previousEvidence.locator);

  const health = getHealthReport(root);
  assert.equal(health.checks.find((item) => item.id === "evidence-locator-integrity")?.status, "pass");
  const pack = buildContextPack(root, "review the append-only ledger recovery decision", 20_000);
  assert.ok(pack.selection.includedEntityIds.includes(decisionId));
  assert.ok(pack.selection.includedEvidenceIds.includes(currentEvidence.id));
  assert.equal(pack.selection.includedEvidenceIds.includes(previousEvidence.id), false);
});

function preparedDecisionFixture(): { root: string; decisionId: string; evidence: EvidenceRecord } {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(
    root,
    listProposals(root, "pending")[0]?.id as string,
    "Reviewed the synchronized fixture before testing locator drift.",
    "human:evidence-test",
  );
  const database = new AtlasDatabase(root);
  const decision = database.listEntities({ types: ["decision"] })
    .find((item) => item.title === "Use an append-only ledger");
  const evidence = database.listAllEvidence()
    .find((item) => item.locator === "file:docs/adr/0001-use-ledger.md");
  database.close();
  assert.ok(decision && evidence);
  return { root, decisionId: decision.id, evidence };
}

function assertEvidenceHealthBlocked(root: string): void {
  const health = getHealthReport(root);
  const locatorCheck = health.checks.find((item) => item.id === "evidence-locator-integrity");
  assert.equal(locatorCheck?.status, "critical");
  assert.equal(health.safeToUse, false);
}

function assertPackBlocked(root: string, task: string): void {
  assert.throws(
    () => buildContextPack(root, task, 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((item) => item.id === "evidence-locator-integrity"),
  );
}

function evidenceRecord(
  id: string,
  kind: string,
  locator: string,
  digest: string,
  observedAt: string,
): EvidenceRecord {
  return { id, kind, locator, digest, observedAt, sensitive: false, metadata: {} };
}

function canonicalEvidenceRecord(
  kind: string,
  locator: string,
  digest: string,
  observedAt: string,
): EvidenceRecord {
  return evidenceRecord(
    `evidence_${sha256(`${kind}\0${locator}\0${digest}`).slice(0, 32)}`,
    kind,
    locator,
    digest,
    observedAt,
  );
}

function runGit(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
