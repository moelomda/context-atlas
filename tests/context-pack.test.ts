import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildContextPack,
  ContextPackBlockedError,
  ContextPackBudgetError,
  ContextPackInputError,
  createContextPackOverride,
} from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { configPath, initializeConfig } from "../src/core/config.js";
import { syncRepository } from "../src/core/ingest.js";
import { flushLedgerOutbox, stageLedgerEntry, verifyLedger } from "../src/core/ledger.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { getOverview } from "../src/core/query.js";
import { queryAssertions, recordAssertionRevision } from "../src/core/temporal.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

test("pack history bounds all event kinds independently from the Git commit ingestion limit", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeConfig(root, "Pack Event Boundary Fixture");
  const file = configPath(root);
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...config, maxCommits: 1 }, null, 2)}\n`, "utf8");
  syncRepository(root);
  approveProposal(
    root,
    listProposals(root, "pending")[0]?.id as string,
    "Reviewed at the one-commit ingestion boundary.",
    "human:pack-events",
  );

  const database = new AtlasDatabase(root);
  assert.ok(database.countEvents() > 1, "the fixture must contain Git and review events");
  database.close();
  const pack = buildContextPack(root, "Explain the current project history", 8_000);
  assert.ok(pack.selection.includedEventIds.length > 0);
});

test("pack selection preserves evidence roles and excludes claims with active contradicting evidence", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(
    root,
    listProposals(root, "pending")[0]?.id as string,
    "Reviewed before exercising evidence-role packing.",
    "human:pack-roles",
  );
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const support = project?.primaryEvidenceId ? database.getEvidence(project.primaryEvidenceId) : null;
  const context = database.listAllEvidence().find((item) => item.kind === "document" && item.id !== support?.id);
  database.close();
  assert.ok(project && support && context);

  const contextual = recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.evidence-role-context",
    value: { summary: "Use every evidence role when constructing a context pack." },
    authority: "human",
    confidence: "approved",
    producer: "human:pack-roles",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [
      { evidenceId: support.id, role: "support" },
      { evidenceId: context.id, role: "context" },
    ],
    actor: "human:pack-roles",
    action: "accept",
    rationale: "Exercise role-complete evidence rendering.",
  });
  const contradicted = recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.evidence-role-contradiction",
    value: { summary: "This assertion must not become settled pack guidance." },
    authority: "human",
    confidence: "approved",
    producer: "human:pack-roles",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [
      { evidenceId: support.id, role: "support" },
      { evidenceId: context.id, role: "contradict" },
    ],
    actor: "human:pack-roles",
    action: "accept",
    rationale: "Exercise active contradicting evidence exclusion.",
  });

  const pack = buildContextPack(root, "Review evidence role context contradiction decisions", 20_000);
  assert.ok(pack.selection.includedAssertionIds.includes(contextual.id));
  assert.equal(pack.selection.includedAssertionIds.includes(contradicted.id), false);
  assert.ok(pack.selection.exclusions.some((item) => item.id === contradicted.id && item.reason === "conflict"));
  assert.match(pack.markdown, new RegExp(`support:${support.id}`));
  assert.match(pack.markdown, new RegExp(`context:${context.id}`));
  assert.doesNotMatch(pack.markdown, new RegExp(`\\[assertion ${contradicted.id}\\]`));
});

test("whole-item pack allocation preserves mandatory sections, evidence closure, and exact selection parity", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed for pack allocation verification.", "human:pack-test");

  const database = new AtlasDatabase(root);
  const entityCount = database.listEntities().length;
  const relationshipCount = database.listRelationships().length;
  const project = database.listEntities({ types: ["project"] })[0];
  const evidence = project?.primaryEvidenceId ? database.getEvidence(project.primaryEvidenceId) : null;
  database.close();
  assert.ok(project && evidence);

  for (let index = 0; index < 24; index += 1) {
    recordAssertionRevision(root, {
      subjectId: project.id,
      predicate: `decision.pack-contract-${String(index).padStart(2, "0")}`,
      value: { summary: `Accepted pack decision ${index}`, ordinal: index },
      authority: "human",
      confidence: "approved",
      producer: "human:pack-test",
      lifecycle: "accepted",
      reviewState: "accepted",
      evidence: [{ evidenceId: evidence.id, role: "support" }],
      actor: "human:pack-test",
      action: "accept",
      rationale: "Creates a deterministic high-cardinality pack selection fixture.",
    });
  }
  const materialTail = `UNIQUE-MATERIAL-TAIL-${"z".repeat(32)}`;
  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.long-pack-contract",
    value: { summary: `${"long decision context ".repeat(40)}${materialTail}` },
    authority: "human",
    confidence: "approved",
    producer: "human:pack-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:pack-test",
    action: "accept",
    rationale: "Proves whole-item rendering never silently substring-truncates a selected claim.",
  });
  const eventDatabase = new AtlasDatabase(root);
  const tiedTimestamp = "2025-01-01T00:00:00.000Z";
  const insertLedgeredEvent = (event: Parameters<AtlasDatabase["insertEvent"]>[0]): void => {
    const ledger = stageLedgerEntry(root, eventDatabase, {
      kind: "pack_test_event",
      actionId: event.id,
      timestamp: event.timestamp,
      payload: { eventId: event.id, evidence: event.evidence },
    });
    assert.equal(eventDatabase.insertEvent({ ...event, ledgerHash: ledger.hash }), true);
  };
  insertLedgeredEvent({
    id: "event_tie_z",
    timestamp: tiedTimestamp,
    type: "commit",
    title: "Tie Z",
    summary: "Tie ordering fixture",
    commit: null,
    files: [],
    evidence: [evidence.id],
    ledgerHash: null,
  });
  insertLedgeredEvent({
    id: "event_tie_a",
    timestamp: tiedTimestamp,
    type: "commit",
    title: "Tie A",
    summary: "Tie ordering fixture",
    commit: null,
    files: [],
    evidence: [evidence.id],
    ledgerHash: null,
  });
  for (let index = 0; index < 101; index += 1) {
    insertLedgeredEvent({
      id: `event_history_${String(index).padStart(3, "0")}`,
      timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 100 - index)).toISOString(),
      type: "commit",
      title: index === 100 ? "Legacy webhook needle" : `Ambient history ${index}`,
      summary:
        index === 100 ? "legacy-webhook-needle is relevant despite being older than one hundred events" : "ambient unrelated history",
      commit: null,
      files: [],
      evidence: [evidence.id],
      ledgerHash: null,
    });
  }
  assert.deepEqual(
    eventDatabase.listEvents("Tie ordering fixture", 10).map((event) => event.id),
    ["event_tie_a", "event_tie_z"],
  );
  flushLedgerOutbox(root, eventDatabase);
  eventDatabase.close();

  const task = "change subscription billing retry decisions legacy-webhook-needle";

  const defaultPack = buildContextPack(root, task);
  assert.equal(defaultPack.tokenBudget, 8_000);
  assert.ok(JSON.stringify(defaultPack).length <= 8_000 * 4);
  assert.equal(defaultPack.sections.length, 15);

  for (const budget of [500, 501, 800, 1_000, 1_500, 2_000]) {
    try {
      const pack = buildContextPack(root, task, budget);
      const serialized = JSON.stringify(pack);
      assert.ok(serialized.length <= budget * 4);
      assert.equal(pack.policy.budgetScope, "compact-json");
      assert.equal(pack.policy.serializedCharacters, serialized.length);
      assert.equal(pack.estimatedTokens, Math.ceil(serialized.length / 4));
      assert.equal(pack.sections.length, 15);
      assert.ok(pack.sections.every((section) => section.required));
    } catch (error) {
      assert.ok(error instanceof ContextPackBudgetError);
      assert.equal(error.requestedBudget, budget);
      assert.ok(error.minimumRequiredTokens > budget);
      assert.equal(error.requiredSections.length, 15);
    }
  }

  const pack = buildContextPack(root, task, 20_000);
  const serializedPack = JSON.stringify(pack);
  assert.doesNotMatch(serializedPack, /context-atlas-test-/i);
  assert.doesNotMatch(serializedPack, /atlas-test@example/i);
  assert.doesNotMatch(serializedPack, /sk-this-must-never-enter-context-storage/i);
  assert.equal(pack.selection.includedAssertionIds.length, 26, "overview plus every decision assertion must render");
  assert.match(pack.markdown, new RegExp(`Pack ID: ${pack.packId}`));
  assert.match(pack.markdown, new RegExp(`Generated at: ${pack.generatedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(pack.markdown, new RegExp(`Content hash \\(canonical section body\\): ${pack.contentHash}`));
  assert.match(pack.markdown, new RegExp(`Selection manifest: ${pack.selection.selectionHash}`));
  assert.match(pack.markdown, /Format: schema 2; selector section-reserved-v2; renderer markdown-v2/);
  assert.match(pack.markdown, /Budget: compact JSON/);
  assert.match(pack.markdown, /Freshness:/);
  assert.ok(pack.markdown.includes(materialTail));
  assert.ok(pack.selection.includedEventIds.includes("event_history_100"));
  assert.ok(pack.markdown.includes("legacy-webhook-needle"));
  assert.ok(pack.selection.nonMaterialEventCount >= 98);
  assert.equal(new Set(pack.selection.includedAssertionIds).size, pack.selection.includedAssertionIds.length);
  assert.equal(new Set(pack.selection.includedEntityIds).size, pack.selection.includedEntityIds.length);
  assert.equal(new Set(pack.selection.includedRelationshipIds).size, pack.selection.includedRelationshipIds.length);
  assert.equal(new Set(pack.selection.includedEventIds).size, pack.selection.includedEventIds.length);
  assert.equal(new Set(pack.selection.includedEvidenceIds).size, pack.selection.includedEvidenceIds.length);
  assert.deepEqual(
    pack.selection.includedEvidenceIds,
    pack.evidence.map((item) => item.id),
  );
  assert.equal(pack.selection.excludedEntityCount, pack.selection.exclusions.filter((item) => item.kind === "entity").length);
  assert.equal(pack.selection.excludedRelationshipCount, pack.selection.exclusions.filter((item) => item.kind === "relationship").length);
  assert.ok(pack.selection.includedEntityIds.includes("narrative:project-overview"));
  assert.equal(
    pack.selection.includedEntityIds.length + pack.selection.excludedEntityCount + pack.selection.nonMaterialEntityCount,
    entityCount,
  );
  assert.equal(
    pack.selection.includedRelationshipIds.length + pack.selection.excludedRelationshipCount + pack.selection.nonMaterialRelationshipCount,
    relationshipCount,
  );
  assert.ok(pack.selection.includedRelationshipIds.length > 0);
  assert.match(pack.markdown, /## Interfaces and data flow/);

  const partitions = new Set<string>();
  for (const id of pack.selection.includedEntityIds) {
    assert.ok(pack.markdown.includes(`[entity ${id}]`));
    assert.equal(partitions.has(`entity:${id}`), false);
    partitions.add(`entity:${id}`);
  }
  for (const id of pack.selection.includedAssertionIds) {
    assert.ok(pack.markdown.includes(`[assertion ${id}]`));
    assert.equal(partitions.has(`assertion:${id}`), false);
    partitions.add(`assertion:${id}`);
  }
  for (const id of pack.selection.includedRelationshipIds) {
    assert.ok(pack.markdown.includes(`[relationship ${id}]`));
    assert.equal(partitions.has(`relationship:${id}`), false);
    partitions.add(`relationship:${id}`);
  }
  for (const id of pack.selection.includedEventIds) {
    assert.ok(pack.markdown.includes(`[event ${id}]`));
    assert.equal(partitions.has(`event:${id}`), false);
    partitions.add(`event:${id}`);
  }
  for (const exclusion of pack.selection.exclusions) {
    const key = `${exclusion.kind}:${exclusion.id}`;
    assert.equal(partitions.has(key), false, `${key} cannot be both included and excluded`);
    partitions.add(key);
    assert.ok(pack.markdown.includes(`${key} -> ${exclusion.reason}`));
  }
  for (const id of pack.selection.includedEvidenceIds) {
    assert.ok(pack.markdown.includes(`[evidence ${id}]`));
  }

  const repeat = buildContextPack(root, task, 20_000);
  const withoutGenerationTime = (markdown: string): string => markdown.replace(/^Generated at: .*$/m, "Generated at: <time>");
  assert.equal(withoutGenerationTime(repeat.markdown), withoutGenerationTime(pack.markdown));
  assert.equal(repeat.contentHash, pack.contentHash);
  assert.equal(repeat.packId, pack.packId);
  assert.deepEqual(repeat.sections, pack.sections);
  assert.deepEqual(repeat.selection, pack.selection);
});

test("an overview revision without supporting evidence is never settled or packed", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed initial overview.", "human:pack-test");

  const current = queryAssertions(root, { predicate: "project.overview" })[0];
  assert.ok(current);
  recordAssertionRevision(root, {
    logicalId: current.logicalId,
    supersedesId: current.id,
    subjectId: current.subjectId,
    predicate: current.predicate,
    scope: current.scope,
    value: { summary: "Unsupported replacement overview" },
    authority: "human",
    confidence: "approved",
    producer: "human:pack-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [],
    actor: "human:pack-test",
    action: "edit_accept",
    rationale: "Exercise the downstream fail-closed evidence boundary.",
  });

  const overview = getOverview(root);
  const claim = (overview.assertions as { overview: { status: string; settled: boolean; reason: string } }).overview;
  assert.equal(claim.status, "unknown");
  assert.equal(claim.settled, false);
  assert.match(claim.reason, /no supporting evidence/i);
  assert.notEqual(overview.summary, "Unsupported replacement overview");
  assert.throws(
    () => buildContextPack(root, "change billing retries", 20_000),
    (error: unknown) =>
      error instanceof ContextPackBlockedError && error.criticalChecks.some((check) => check.id === "pack-overview-evidence-closure"),
  );
});

test("pre-review packs remain explicit unknowns while sensitive-only material evidence blocks", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);

  const preReview = buildContextPack(root, "understand the project before review", 20_000);
  assert.equal(preReview.claims.overview.status, "unknown");
  assert.equal(preReview.claims.overview.settled, false);
  assert.match(preReview.markdown, /No settled human-reviewed overview exists/i);

  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed initial overview.", "human:pack-test");
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const sensitiveEvidence = database.listAllEvidence().find((item) => item.sensitive);
  database.close();
  assert.ok(project && sensitiveEvidence);
  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.sensitive-only",
    value: { summary: "A claim whose only support is policy-withheld" },
    authority: "human",
    confidence: "approved",
    producer: "human:pack-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: sensitiveEvidence.id, role: "support" }],
    actor: "human:pack-test",
    action: "accept",
    rationale: "Exercise the context-pack privacy boundary.",
  });

  assert.throws(
    () => buildContextPack(root, "review the sensitive-only decision", 20_000),
    (error: unknown) =>
      error instanceof ContextPackBlockedError && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );
});

test("oversized task input is refused instead of silently changing relevance", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  const oversizedTask = `${"a".repeat(2_000)}material-tail`;
  assert.throws(
    () => buildContextPack(root, oversizedTask, 20_000),
    (error: unknown) =>
      error instanceof ContextPackInputError &&
      error.code === "context_pack_invalid_input" &&
      /refused rather than silently truncated/i.test(error.message),
  );
});

test("accepted inferred assertions remain explicitly excluded from current guidance", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed initial overview.", "human:pack-test");
  const database = new AtlasDatabase(root, { readOnly: true });
  const project = database.listEntities({ types: ["project"] })[0];
  const evidence = project?.primaryEvidenceId ? database.getEvidence(project.primaryEvidenceId) : null;
  database.close();
  assert.ok(project && evidence);
  const assertion = recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.inferred-not-guidance",
    value: { summary: "Inferred retry policy that must not become accepted guidance" },
    authority: "inferred",
    confidence: "inferred",
    producer: "system:pack-authority-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:pack-test",
    action: "accept",
    rationale: "Verify that row acceptance cannot upgrade inferred authority into settled guidance.",
  });

  const pack = buildContextPack(root, "change the inferred retry policy", 20_000);
  assert.equal(pack.selection.includedAssertionIds.includes(assertion.id), false);
  assert.ok(pack.selection.exclusions.some((item) => item.kind === "assertion" && item.id === assertion.id && item.reason === "unsettled"));
  assert.doesNotMatch(pack.markdown, new RegExp(`\\[assertion ${assertion.id}\\]`));
  assert.match(pack.markdown, new RegExp(`assertion:${assertion.id} -> unsettled`));
  assert.match(pack.markdown, /## Decision records/);
  assert.doesNotMatch(pack.markdown, /## Accepted decisions/);
});

test("malformed override actors are rejected before any audit mutation", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const beforeLedger = verifyLedger(root);
  const beforeDatabase = new AtlasDatabase(root, { readOnly: true });
  const beforeOverrides = Number(
    (beforeDatabase.db.prepare("SELECT COUNT(*) AS count FROM context_pack_overrides").get() as { count: number }).count,
  );
  const beforeOutbox = Number((beforeDatabase.db.prepare("SELECT COUNT(*) AS count FROM ledger_outbox").get() as { count: number }).count);
  beforeDatabase.close();

  assert.throws(
    () =>
      createContextPackOverride(root, {
        actor: "human:Alice Smith",
        reason: "This malformed identity must be rejected without writing any audit state.",
      }),
    /matching human:<id>/i,
  );

  const afterDatabase = new AtlasDatabase(root, { readOnly: true });
  const afterOverrides = Number(
    (afterDatabase.db.prepare("SELECT COUNT(*) AS count FROM context_pack_overrides").get() as { count: number }).count,
  );
  const afterOutbox = Number((afterDatabase.db.prepare("SELECT COUNT(*) AS count FROM ledger_outbox").get() as { count: number }).count);
  afterDatabase.close();
  assert.equal(afterOverrides, beforeOverrides);
  assert.equal(afterOutbox, beforeOutbox);
  assert.deepEqual(verifyLedger(root), beforeLedger);
});

test("a scoped override stays prominent in structured and Markdown pack warnings", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed initial overview.", "human:pack-test");
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  assert.ok(project?.primaryEvidenceId);
  database.insertEvent({
    id: "event_unledgered_override_fixture",
    timestamp: new Date().toISOString(),
    type: "test_fault",
    title: "Deliberately unledgered test event",
    summary: "Creates a narrow critical health finding for override presentation testing.",
    commit: null,
    files: [],
    evidence: [project.primaryEvidenceId],
    ledgerHash: null,
  });
  database.close();
  const task = "inspect override warning presentation";
  const override = createContextPackOverride(root, {
    actor: "human:pack-test",
    reason: "Temporarily accept the deliberate test-only ledger finding for navigation output verification.",
    task,
  });
  const pack = buildContextPack(root, task, 20_000, { overrideId: override.id });
  assert.ok(pack.safety.override);
  assert.ok(pack.safety.criticalChecks.some((check) => check.id === "event-ledger-coverage"));
  assert.ok(pack.warnings.some((warning) => /OVERRIDDEN CRITICAL CONTEXT/i.test(warning)));
  assert.match(pack.markdown, /OVERRIDDEN CRITICAL CONTEXT WARNING/i);
});

test("an integrity override cannot bypass mandatory entity evidence closure", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed initial overview.", "human:pack-test");

  const database = new AtlasDatabase(root);
  database.db.prepare("UPDATE entities SET primary_evidence_id = NULL WHERE id = ?").run("narrative:project-overview");
  database.close();
  const task = "inspect the project overview";
  const override = createContextPackOverride(root, {
    actor: "human:pack-test",
    reason: "Reproduce an evidence-closure bypass attempt under an otherwise valid integrity override.",
    task,
  });

  assert.throws(
    () => buildContextPack(root, task, 20_000, { overrideId: override.id }),
    (error: unknown) =>
      error instanceof ContextPackBlockedError &&
      error.criticalChecks.some((check) => check.id === "pack-mandatory-entity-evidence-closure"),
  );
});
