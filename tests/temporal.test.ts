import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AtlasDatabase } from "../src/core/database.js";
import { getHealthReport } from "../src/core/health.js";
import {
  detectAssertionConflicts,
  getAssertionEvolution,
  getAssertionHistory,
  getAssertionReviewHistory,
  queryAssertions,
  recordAssertionRevision,
} from "../src/core/temporal.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

test("immutable assertion revisions support valid-time and recorded-time queries", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const evidence = database.listAllEvidence().find((item) => item.kind === "document") ?? database.listAllEvidence()[0];
  database.close();
  assert.ok(project && evidence);

  const first = recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "product.billing.retry-limit",
    value: 3,
    authority: "human",
    confidence: "approved",
    producer: "human:maintainer",
    lifecycle: "accepted",
    reviewState: "accepted",
    validFrom: "2025-01-01T00:00:00Z",
    recordedAt: "2025-01-02T00:00:00Z",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:maintainer",
    action: "accept",
    rationale: "Matches the accepted billing policy.",
  });
  const revised = recordAssertionRevision(root, {
    logicalId: first.logicalId,
    supersedesId: first.id,
    subjectId: project.id,
    predicate: "product.billing.retry-limit",
    value: 5,
    authority: "human",
    confidence: "approved",
    producer: "human:maintainer",
    lifecycle: "accepted",
    reviewState: "accepted",
    validFrom: "2025-02-01T00:00:00Z",
    recordedAt: "2025-03-01T00:00:00Z",
    evidence: [{ evidenceId: evidence.id }],
    actor: "human:maintainer",
    action: "edit_accept",
    rationale: "The February policy raised the bounded retry limit.",
  });

  assert.equal(
    queryAssertions(root, {
      validAt: "2025-01-15T00:00:00Z",
      recordedAt: "2025-04-01T00:00:00Z",
      predicate: "product.billing.retry-limit",
    })[0]?.value,
    3,
  );
  assert.equal(
    queryAssertions(root, {
      validAt: "2025-02-15T00:00:00Z",
      recordedAt: "2025-02-20T00:00:00Z",
      predicate: "product.billing.retry-limit",
    })[0]?.value,
    3,
  );
  assert.equal(
    queryAssertions(root, {
      validAt: "2025-02-15T00:00:00Z",
      recordedAt: "2025-04-01T00:00:00Z",
      predicate: "product.billing.retry-limit",
    })[0]?.value,
    5,
  );
  assert.deepEqual(
    getAssertionHistory(root, first.logicalId).map((item) => item.id),
    [first.id, revised.id],
  );
  assert.deepEqual(
    getAssertionEvolution(root, {
      predicate: "product.billing.retry-limit",
      recordedFrom: "2025-02-01T00:00:00Z",
      recordedTo: "2025-04-01T00:00:00Z",
    }).map((item) => item.id),
    [revised.id],
  );
  assert.deepEqual(
    getAssertionReviewHistory(root, first.logicalId).map((item) => item.action),
    ["accept", "edit_accept"],
  );

  const immutable = new AtlasDatabase(root);
  assert.throws(() => immutable.db.prepare("UPDATE assertions SET value_json='4' WHERE id=?").run(first.id), /immutable/);
  immutable.close();
});

test("assertion invariants reject unsupported facts and preserve incompatible claims", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const evidence = database.listAllEvidence()[0];
  database.close();
  assert.ok(project && evidence);

  assert.throws(
    () =>
      recordAssertionRevision(root, {
        subjectId: project.id,
        predicate: "architecture.database",
        value: "unknown-db",
        authority: "inferred",
        confidence: "inferred",
        producer: "model:test",
        evidence: [],
      }),
    /supporting evidence/,
  );
  assert.throws(
    () =>
      recordAssertionRevision(root, {
        subjectId: project.id,
        predicate: "architecture.database",
        value: "sqlite",
        authority: "human",
        confidence: "approved",
        producer: "human:maintainer",
        lifecycle: "accepted",
        validFrom: "2025-03-02T00:00:00Z",
        validTo: "2025-03-01T00:00:00Z",
        evidence: [{ evidenceId: evidence.id }],
        actor: "human:maintainer",
      }),
    /validTo/,
  );

  for (const value of ["sqlite", "postgres"] as const) {
    recordAssertionRevision(root, {
      subjectId: project.id,
      predicate: "architecture.database",
      value,
      authority: "human",
      confidence: "approved",
      producer: `human:${value}-advocate`,
      lifecycle: "accepted",
      reviewState: "accepted",
      validFrom: "2025-01-01T00:00:00Z",
      recordedAt: "2025-02-01T00:00:00Z",
      evidence: [{ evidenceId: evidence.id }],
      actor: `human:${value}-advocate`,
    });
  }
  for (const value of ["Keep the local ledger", "Keep evidence locators"] as const) {
    recordAssertionRevision(root, {
      subjectId: project.id,
      predicate: "decision.record",
      value,
      scope: "project",
      authority: "human",
      confidence: "approved",
      producer: "human:maintainer",
      lifecycle: "accepted",
      reviewState: "accepted",
      validFrom: "2025-01-01T00:00:00Z",
      recordedAt: "2025-02-01T00:00:00Z",
      evidence: [{ evidenceId: evidence.id }],
      actor: "human:maintainer",
    });
  }
  const conflicts = detectAssertionConflicts(root, {
    validAt: "2025-03-01T00:00:00Z",
    recordedAt: "2025-03-01T00:00:00Z",
  });
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0]?.values), new Set(["sqlite", "postgres"]));
  const conflictedHealth = getHealthReport(root);
  assert.equal(conflictedHealth.checks.find((item) => item.id === "assertion-conflicts")?.status, "critical");
  assert.equal(conflictedHealth.verdict, "blocked");
  assert.equal(conflictedHealth.safeToUse, false);
  assert.ok(conflictedHealth.criticalCount > 0);
  assert.ok(conflictedHealth.score <= 39);
});
