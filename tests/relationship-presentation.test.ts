import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildContextPack, ContextPackBlockedError } from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { explainEntity, getGraph } from "../src/core/query.js";
import type { PresentedRelationship } from "../src/core/types.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("graph, explain, and packs expose only evidence-verified relationships as settled topology", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed before topology projection verification.", "human:relationship-test");

  const database = new AtlasDatabase(root);
  const relationship = database.listRelationships().find((item) => item.type === "depends_on")
    ?? database.listRelationships()[0];
  database.close();
  assert.ok(relationship?.evidenceId);

  const graph = getGraph(root);
  const edge = graph.edges.find((item) => item.id === relationship.id);
  assert.ok(edge);
  assert.equal(edge.source, relationship.sourceId);
  assert.equal(edge.target, relationship.targetId);
  assert.equal(edge.active, true);
  assert.equal(edge.evidenceId, relationship.evidenceId);
  assert.equal(edge.status, "current");
  assert.equal(edge.settled, true);
  assert.equal(edge.authority, "repository-observation");
  assert.equal(edge.confidence, relationship.confidence);
  assert.deepEqual(edge.evidenceIds, [relationship.evidenceId]);
  assert.equal(edge.evidenceValidation.outcome, "verified");
  assert.equal(edge.evidenceValidation.status, "verified");
  assert.match(edge.reason, /synchronized repository snapshot/i);
  assert.deepEqual(getGraph(root).edges, graph.edges, "relationship presentation order and content must be deterministic");

  const explanation = explainEntity(root, relationship.sourceId);
  const explainedRelationships = explanation.relationships as PresentedRelationship[];
  const explained = explainedRelationships.find((item) => item.id === relationship.id);
  assert.ok(explained);
  assert.equal(explained.status, "current");
  assert.equal(explained.settled, true);
  assert.equal(explained.evidenceValidation.outcome, "verified");
  const explainedEvidence = explanation.evidence as Array<{ id: string }>;
  assert.ok(explainedEvidence.some((item) => item.id === relationship.evidenceId));

  const task = `${relationship.sourceId} ${relationship.type} ${relationship.targetId}`;
  const pack = buildContextPack(root, task, 20_000);
  assert.ok(pack.selection.includedRelationshipIds.includes(relationship.id));
  assert.match(pack.markdown, new RegExp(`\\[relationship ${relationship.id}\\]`));
  assert.match(pack.markdown, /## Interfaces and data flow/);
  assert.match(pack.markdown, /evidence validation: verified\/verified/);
  assert.ok(pack.selection.includedEvidenceIds.includes(relationship.evidenceId));
  const repeat = buildContextPack(root, task, 20_000);
  assert.equal(repeat.selection.selectionHash, pack.selection.selectionHash);
  assert.deepEqual(repeat.selection, pack.selection);
  assert.equal(repeat.contentHash, pack.contentHash);
});

test("missing and policy-denied relationship evidence never becomes current topology", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed before topology evidence failure verification.", "human:relationship-test");

  const database = new AtlasDatabase(root);
  const relationship = database.listRelationships()[0];
  assert.ok(relationship);
  database.upsertRelationship({ ...relationship, evidenceId: null });
  const relationshipCount = database.listRelationships().length;
  const sensitiveEvidence = database.listAllEvidence().find((item) => item.sensitive);
  database.close();
  assert.ok(sensitiveEvidence);

  const graph = getGraph(root);
  const missingEdge = graph.edges.find((item) => item.id === relationship.id);
  assert.ok(missingEdge);
  assert.equal(missingEdge.status, "unknown");
  assert.equal(missingEdge.settled, false);
  assert.equal(missingEdge.evidenceValidation.outcome, "missing");
  assert.equal(missingEdge.evidenceValidation.status, "missing-reference");
  assert.ok(graph.warnings.some((warning) => warning.includes(`relationship:${relationship.id} is unknown`)));

  const pack = buildContextPack(root, `${relationship.sourceId} ${relationship.type} ${relationship.targetId}`, 20_000);
  assert.equal(pack.selection.includedRelationshipIds.includes(relationship.id), false);
  assert.ok(pack.selection.exclusions.some((item) => item.kind === "relationship"
    && item.id === relationship.id
    && item.reason === "unsupported"));
  assert.equal(
    pack.selection.includedRelationshipIds.length
      + pack.selection.excludedRelationshipCount
      + pack.selection.nonMaterialRelationshipCount,
    relationshipCount,
  );

  const deniedDatabase = new AtlasDatabase(root);
  deniedDatabase.upsertRelationship({ ...relationship, evidenceId: sensitiveEvidence.id });
  deniedDatabase.close();
  const deniedEdge = getGraph(root).edges.find((item) => item.id === relationship.id);
  assert.ok(deniedEdge);
  assert.equal(deniedEdge.status, "unknown");
  assert.equal(deniedEdge.settled, false);
  assert.equal(deniedEdge.evidenceValidation.outcome, "not-validated");
  assert.equal(deniedEdge.evidenceValidation.status, "policy-denied");
  assert.throws(
    () => buildContextPack(root, "inspect policy-denied topology", 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );
});
