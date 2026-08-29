import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { configPath, getCurrentGuidanceWatermark } from "../src/core/config.js";
import { AtlasDatabase } from "../src/core/database.js";
import { syncRepository } from "../src/core/ingest.js";
import { getHealthReport } from "../src/core/health.js";
import { getGraph, getOverview } from "../src/core/query.js";
import { approveProposal, listProposals, rejectProposal } from "../src/core/proposals.js";
import { queryPresentedAssertions } from "../src/core/claim-status.js";
import { recordAssertionRevision } from "../src/core/temporal.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

interface OverviewClaim {
  status: string;
  settled: boolean;
  reason: string;
  assertionId: string | null;
  repository: {
    synchronized: boolean;
    currentGuidanceWatermark: string;
    reviewedGuidanceWatermark: string | null;
  };
}

function overviewClaim(root: string): OverviewClaim {
  return (getOverview(root).assertions as { overview: OverviewClaim }).overview;
}

function editConfig(root: string, edit: (config: Record<string, unknown>) => void): void {
  const file = configPath(root);
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(config);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

test("guidance watermark hashes effective extraction policy but excludes runtime-only settings", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const initial = getCurrentGuidanceWatermark(root);
    assert.match(initial.watermark, /^[a-f0-9]{64}$/);
    assert.equal(initial.effectiveScanConfig.excludedPaths.includes(".context-atlas"), true);

    editConfig(root, (config) => {
      config.defaultTokenBudget = 9_000;
    });
    assert.equal(
      getCurrentGuidanceWatermark(root).watermark,
      initial.watermark,
      "token budgets do not affect extraction or reviewed guidance",
    );

    writeFileSync(path.join(root, ".atlasignore"), "# comment only\n", "utf8");
    assert.equal(getCurrentGuidanceWatermark(root).watermark, initial.watermark, "comments do not alter the effective ignore policy");

    writeFileSync(path.join(root, ".atlasignore"), "generated/**\n", "utf8");
    assert.notEqual(getCurrentGuidanceWatermark(root).watermark, initial.watermark);
  } finally {
    removeFixture(root);
  }
});

test("policy-only changes stale reviewed guidance across reads and synchronization until re-review", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const initialProposal = listProposals(root, "pending")[0];
    assert.ok(initialProposal);
    approveProposal(root, initialProposal.id, "Reviewed the initial extraction boundary.", "human:watermark-test");
    assert.equal(getHealthReport(root).checks.find((check) => check.id === "event-ledger-coverage")?.status, "pass");

    const before = overviewClaim(root);
    assert.equal(before.status, "current");
    assert.equal(before.settled, true);
    assert.equal(before.repository.reviewedGuidanceWatermark, before.repository.currentGuidanceWatermark);
    const firstWatermark = before.repository.currentGuidanceWatermark;

    const project = new AtlasDatabase(root, { readOnly: true });
    const projectEntity = project.listEntities({ types: ["project"] })[0];
    const projectEvidenceId = projectEntity?.primaryEvidenceId;
    project.close();
    assert.ok(projectEntity && projectEvidenceId);
    const generic = recordAssertionRevision(root, {
      logicalId: "claim:watermark:generic",
      subjectId: projectEntity.id,
      predicate: "project.guidance-watermark-test",
      value: { mode: "reviewed" },
      scope: "project",
      authority: "derived",
      confidence: "documented",
      producer: "test:watermark",
      lifecycle: "accepted",
      reviewState: "accepted",
      evidence: [{ evidenceId: projectEvidenceId, role: "support" }],
      actor: "human:watermark-test",
      action: "accept",
    });
    assert.equal(generic.metadata.reviewedGuidanceWatermark, firstWatermark);
    assert.equal(queryPresentedAssertions(root, { predicate: generic.predicate })[0]?.presentation.status, "current");

    editConfig(root, (config) => {
      config.maxComponentDepth = Number(config.maxComponentDepth) + 1;
    });
    const changedWatermark = getCurrentGuidanceWatermark(root).watermark;
    assert.notEqual(changedWatermark, firstWatermark);

    const beforeSync = overviewClaim(root);
    assert.equal(beforeSync.status, "stale");
    assert.equal(beforeSync.settled, false);
    assert.match(beforeSync.reason, /configuration|ignore policy|schema|extractor/i);
    assert.equal(beforeSync.repository.synchronized, false);
    assert.equal(queryPresentedAssertions(root, { predicate: generic.predicate })[0]?.presentation.status, "stale");
    const preSyncGraph = getGraph(root);
    assert.equal(preSyncGraph.nodes.find((node) => node.type === "project")?.presentationStatus, "stale");
    assert.equal(preSyncGraph.nodes.find((node) => node.id === "narrative:project-overview")?.presentationStatus, "stale");
    const preSyncHealth = getHealthReport(root);
    assert.equal(preSyncHealth.checks.find((check) => check.id === "repository-sync")?.status, "warning");
    assert.ok(preSyncHealth.components.every((component) => component.status !== "current"));
    assert.equal(preSyncHealth.checks.find((check) => check.id === "approved-overview")?.status, "warning");

    const sync = syncRepository(root);
    assert.ok(sync.proposalsCreated.length > 0, "policy-only sync must create a replacement review proposal");
    const afterSync = overviewClaim(root);
    assert.equal(afterSync.status, "stale", "advancing sync metadata must not restore old reviewed prose");
    assert.equal(afterSync.settled, false);
    assert.equal(afterSync.repository.synchronized, true);
    assert.equal(afterSync.repository.reviewedGuidanceWatermark, firstWatermark);
    assert.equal(afterSync.repository.currentGuidanceWatermark, changedWatermark);
    assert.equal(
      queryPresentedAssertions(root, { predicate: generic.predicate })[0]?.presentation.status,
      "stale",
      "generic accepted claims retain their own reviewed dependency boundary after sync advances",
    );
    const policySyncHealth = getHealthReport(root);
    assert.equal(policySyncHealth.checks.find((check) => check.id === "approved-overview")?.status, "warning");
    assert.equal(policySyncHealth.checks.find((check) => check.id === "assertion-guidance-boundary")?.status, "critical");

    const refreshedGeneric = recordAssertionRevision(root, {
      supersedesId: generic.id,
      subjectId: generic.subjectId,
      predicate: generic.predicate,
      value: generic.value,
      scope: generic.scope,
      authority: "derived",
      confidence: "documented",
      producer: "test:watermark",
      lifecycle: "accepted",
      reviewState: "accepted",
      evidence: [{ evidenceId: projectEvidenceId, role: "support" }],
      actor: "human:watermark-test",
      action: "edit_accept",
      rationale: "Re-reviewed this assertion under the synchronized extraction policy.",
    });
    assert.equal(refreshedGeneric.metadata.reviewedGuidanceWatermark, changedWatermark);
    assert.equal(queryPresentedAssertions(root, { predicate: generic.predicate })[0]?.presentation.status, "current");

    const replacement = listProposals(root, "pending").find((proposal) => sync.proposalsCreated.includes(proposal.id));
    assert.ok(replacement);
    assert.equal(replacement.payload.observedGuidanceWatermark, changedWatermark);
    approveProposal(root, replacement.id, "Reviewed the new extraction policy and replacement overview.", "human:watermark-test");
    assert.equal(getHealthReport(root).checks.find((check) => check.id === "event-ledger-coverage")?.status, "pass");

    const refreshed = overviewClaim(root);
    assert.equal(refreshed.status, "current");
    assert.equal(refreshed.settled, true);
    assert.equal(refreshed.repository.reviewedGuidanceWatermark, changedWatermark);
    assert.equal(getHealthReport(root).checks.find((check) => check.id === "approved-overview")?.status, "pass");
    assert.equal(getHealthReport(root).checks.find((check) => check.id === "assertion-guidance-boundary")?.status, "pass");
    const refreshedAssertion = queryPresentedAssertions(root, { predicate: "project.overview" })[0];
    assert.equal(refreshedAssertion?.metadata.reviewedGuidanceWatermark, changedWatermark);
    const refreshedValue = refreshedAssertion?.value as { payload?: { observedGuidanceWatermark?: string } };
    assert.equal(refreshedValue.payload?.observedGuidanceWatermark, changedWatermark);

    editConfig(root, (config) => {
      config.defaultTokenBudget = Number(config.defaultTokenBudget) - 500;
    });
    const runtimeOnlySync = syncRepository(root);
    assert.equal(runtimeOnlySync.proposalsCreated.length, 0);
    assert.equal(overviewClaim(root).status, "current");

    editConfig(root, (config) => {
      config.projectName = "Fixture Shop Renamed";
    });
    const renameSync = syncRepository(root);
    const renameStaleAssertion = queryPresentedAssertions(root, { predicate: "project.overview" })[0];
    assert.ok(renameStaleAssertion);
    assert.equal(
      new Set(renameStaleAssertion.evidence.map((item) => item.evidenceId)).size,
      renameStaleAssertion.evidence.length,
      "staleness revisions must not duplicate an unchanged snapshot under a second evidence role",
    );
    const renameProposal = listProposals(root, "pending").find((proposal) => renameSync.proposalsCreated.includes(proposal.id));
    assert.ok(renameProposal);
    approveProposal(
      root,
      renameProposal.id,
      "Reviewed the renamed project identity under the new guidance boundary.",
      "human:watermark-test",
    );
    assert.equal(overviewClaim(root).status, "current");
    const renamedDatabase = new AtlasDatabase(root, { readOnly: true });
    assert.equal(renamedDatabase.listEntities({ types: ["project"] }).length, 1, "display-name changes must not fork repository identity");
    renamedDatabase.close();
  } finally {
    removeFixture(root);
  }
});

test("legacy accepted assertions without a reviewed watermark fail closed", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const proposal = listProposals(root, "pending")[0];
    assert.ok(proposal);
    approveProposal(root, proposal.id, "Reviewed before simulating a legacy row.", "human:watermark-test");
    const accepted = queryPresentedAssertions(root, { predicate: "project.overview" })[0];
    assert.ok(accepted);

    const database = new AtlasDatabase(root);
    try {
      database.transaction(() => {
        // Simulate a row created by the pre-watermark schema without leaving
        // the current immutable-assertion guard disabled, even if setup fails.
        database.db.exec("DROP TRIGGER assertions_no_update");
        database.db.prepare("UPDATE assertions SET metadata_json = '{}' WHERE id = ?").run(accepted.id);
        database.db.exec(`
          CREATE TRIGGER assertions_no_update
          BEFORE UPDATE ON assertions BEGIN
            SELECT RAISE(ABORT, 'assertions are immutable; create a revision');
          END
        `);
        const narrative = database.getEntity("narrative:project-overview");
        assert.ok(narrative);
        const legacyPayload = { ...narrative.payload };
        delete legacyPayload.reviewedGuidanceWatermark;
        database.db.prepare("UPDATE entities SET payload_json = ? WHERE id = ?").run(JSON.stringify(legacyPayload), narrative.id);
      });
      assert.equal(database.inspectReadSchemaIntegrity().valid, true, "legacy fixture setup must restore immutable guards");
    } finally {
      database.close();
    }

    const legacy = queryPresentedAssertions(root, { predicate: "project.overview" })[0];
    assert.equal(legacy?.presentation.status, "unknown");
    assert.equal(legacy?.presentation.settled, false);
    assert.match(legacy?.presentation.reason ?? "", /predates guidance dependency tracking|re-review/i);
    assert.equal(overviewClaim(root).status, "unknown");
    assert.equal(getHealthReport(root).checks.find((check) => check.id === "assertion-guidance-boundary")?.status, "critical");
  } finally {
    removeFixture(root);
  }
});

test("proposal rejection events retain a one-to-one ledger action link", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const proposal = listProposals(root, "pending")[0];
    assert.ok(proposal);
    rejectProposal(root, proposal.id, "The generated summary needs revision.", "human:watermark-test");
    const coverage = getHealthReport(root).checks.find((check) => check.id === "event-ledger-coverage");
    assert.equal(coverage?.status, "pass");
  } finally {
    removeFixture(root);
  }
});

test("synchronization replaces a legacy pending overview proposal with a watermarked candidate", () => {
  const root = createFixtureRepository();
  try {
    initializeFixture(root);
    const legacyProposal = listProposals(root, "pending")[0];
    assert.ok(legacyProposal);
    const legacyPayload = { ...legacyProposal.payload };
    delete legacyPayload.observedGuidanceWatermark;
    const database = new AtlasDatabase(root);
    database.db.prepare("UPDATE proposals SET payload_json = ? WHERE id = ?").run(JSON.stringify(legacyPayload), legacyProposal.id);
    database.close();

    const synchronized = syncRepository(root);
    const replacement = listProposals(root, "pending").find((proposal) => synchronized.proposalsCreated.includes(proposal.id));
    assert.ok(replacement);
    assert.equal(replacement.payload.observedGuidanceWatermark, getCurrentGuidanceWatermark(root).watermark);
  } finally {
    removeFixture(root);
  }
});
