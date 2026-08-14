import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { buildContextPack, ContextPackBlockedError, createContextPackOverride } from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { getHealthReport } from "../src/core/health.js";
import { syncRepository } from "../src/core/ingest.js";
import { approveProposal, createProposal, listProposals, rejectProposal } from "../src/core/proposals.js";
import { explainEntity, getGraph, getOverview, getTimeline, searchAtlas } from "../src/core/query.js";
import { queryAssertions } from "../src/core/temporal.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("repository history becomes an evidence-backed map without retaining secrets", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  assert.match(readFileSync(path.join(root, ".context-atlas", ".gitignore"), "utf8"), /atlas\.db/);

  const overview = getOverview(root);
  assert.equal((overview.project as Record<string, unknown>).name, "Fixture Shop");
  const orientation = overview.orientation as {
    purpose: { text: string };
    architecture: Array<{ title: string }>;
    decisions: Array<{ title: string }>;
    unknowns: string[];
    recommendedEntryPoints: unknown[];
  };
  assert.match(orientation.purpose.text, /subscription service/i);
  assert.ok(orientation.architecture.some((component) => component.title === "src"));
  assert.ok(orientation.decisions.some((decision) => /append-only ledger/i.test(decision.title)));
  assert.ok(orientation.unknowns.some((item) => /runtime correctness/i.test(item)));
  assert.ok(orientation.recommendedEntryPoints.length >= 3);
  const graph = getGraph(root);
  assert.ok(graph.nodes.some((node) => node.type === "component" && node.title === "src"));
  assert.ok(graph.nodes.some((node) => node.type === "decision"));
  assert.ok(graph.edges.some((edge) => edge.type === "depends_on"));
  const boundedGraph = getGraph(root, 3);
  assert.equal(boundedGraph.nodes.length, 3);
  assert.equal(boundedGraph.truncated, true);
  assert.ok(boundedGraph.totalNodes > boundedGraph.nodes.length);
  assert.ok(boundedGraph.nodes.some((node) => node.type === "project"));
  assert.equal(getTimeline(root).events[0]?.title, "Create subscription service foundation");
  assert.ok(searchAtlas(root, "billing").results.length > 0);
  assert.equal(explainEntity(root, "src/payments").entity !== null, true);

  const databaseBytes = readFileSync(path.join(root, ".context-atlas", "atlas.db")).toString("utf8");
  const ledger = readFileSync(path.join(root, ".context-atlas", "ledger.ndjson"), "utf8");
  assert.doesNotMatch(databaseBytes, /sk-this-must-never-enter-context-storage/);
  assert.doesNotMatch(ledger, /sk-this-must-never-enter-context-storage/);

  const pending = listProposals(root, "pending");
  assert.equal(pending.length, 1);
  approveProposal(root, pending[0]?.id as string, "Reviewed against the initial commit.");
  assert.equal(listProposals(root, "approved").length, 1);
  assert.match(String(getOverview(root).summary), /Fixture Shop is on main/);

  const pack = buildContextPack(root, "change subscription billing retries", 800);
  assert.ok(pack.estimatedTokens <= 800);
  assert.match(pack.markdown, /Authority boundary/);
  assert.match(pack.markdown, /Evidence index|Evidence IDs retained/);
  assert.ok(pack.evidence.length > 0);
  assert.doesNotMatch(JSON.stringify(pack), /sk-this-must-never-enter-context-storage/);
  assert.throws(() => buildContextPack(root, "change subscription billing retries", 1), /minimum safe envelope|between 500 and 20000/);
  const minimumPack = buildContextPack(root, "change subscription billing retries", 500);
  assert.ok(minimumPack.estimatedTokens <= 500);
  if (minimumPack.truncated) {
    assert.match(minimumPack.markdown, /Truncation and safety/);
    assert.match(minimumPack.markdown, /Safety verdict/);
    assert.match(minimumPack.markdown, /Evidence IDs retained/);
  }

  const health = getHealthReport(root);
  assert.equal(health.checks.find((item) => item.id === "ledger-integrity")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "evidence-coverage")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "sensitive-content")?.status, "warning");
  assert.equal(health.checks.find((item) => item.id === "history-completeness")?.status, "pass");
  assert.equal(health.verdict, "degraded");
  assert.equal(health.safeToUse, true);
  assert.ok(health.warningCount > 0);
  assert.ok(health.components.length > 0);
  assert.ok(health.components.every((component) => component.reason && component.evidenceIds.length > 0));
});

test("new commits create reviewable proposals and conflicting narratives cannot be approved", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string);

  commitFile(root, "src/payments/retry.ts", "export const retryLimit = 3;\n", "Add bounded billing retries");
  const sync = syncRepository(root);
  assert.equal(sync.commitsAdded, 1);
  assert.equal(sync.proposalsCreated.length, 1);
  assert.match(getTimeline(root).events[0]?.title ?? "", /Add bounded billing retries/);
  const completeReachableHistory = getTimeline(root, "", 100).events;
  assert.ok(completeReachableHistory.some((event) => event.title === "Create subscription service foundation"));
  assert.ok(completeReachableHistory.some((event) => event.title === "Add bounded billing retries"));
  assert.equal(getHealthReport(root).checks.find((item) => item.id === "stale-context")?.status, "warning");

  const database = new AtlasDatabase(root);
  const evidenceId = database.listEvents("Add bounded", 1)[0]?.evidence[0] as string;
  const projectId = database.listEntities({ types: ["project"] })[0]?.id as string;
  database.close();
  const first = createProposal(root, {
    kind: "context_update",
    title: "Describe retry policy A",
    summary: "Billing retries stop after three attempts.",
    targetId: projectId,
    evidenceIds: [evidenceId],
  });
  const second = createProposal(root, {
    kind: "context_update",
    title: "Describe retry policy B",
    summary: "Billing retries stop after a configurable limit.",
    targetId: projectId,
    evidenceIds: [evidenceId],
  });
  assert.ok(first.id && second.id);
  assert.throws(
    () => buildContextPack(root, "change billing retry policy", 800),
    (error: unknown) => error instanceof ContextPackBlockedError && error.criticalChecks.some((item) => item.id === "proposal-conflicts"),
  );
  const packOverride = createContextPackOverride(root, {
    actor: "human:test-maintainer",
    reason: "Testing the explicit fail-closed escape hatch against a disposable fixture.",
    task: "change billing retry policy",
    durationMinutes: 5,
  });
  const overriddenPack = buildContextPack(root, "change billing retry policy", 800, { overrideId: packOverride.id });
  assert.equal(overriddenPack.safety.safeToUse, true);
  assert.equal(overriddenPack.safety.scope, "navigation-only");
  assert.equal(overriddenPack.safety.override?.actor, "human:test-maintainer");
  assert.match(overriddenPack.markdown, /OVERRIDDEN CRITICAL CONTEXT WARNING/);
  assert.ok(overriddenPack.warnings.some((warning) => /Stale context/i.test(warning)));
  assert.throws(() => buildContextPack(root, "unrelated task", 800, { overrideId: packOverride.id }), /different task/);
  const overrideDatabase = new AtlasDatabase(root);
  assert.throws(() => overrideDatabase.db.prepare("UPDATE context_pack_overrides SET actor='human:other' WHERE id=?").run(packOverride.id), /immutable/);
  overrideDatabase.close();
  assert.throws(() => approveProposal(root, second.id), /Resolve the conflicting pending proposals/);
  for (const proposal of listProposals(root, "pending")) {
    if (proposal.id !== second.id) rejectProposal(root, proposal.id, "Resolve competing narrative.");
  }
  approveProposal(root, second.id, "Accepted the configurable retry summary after comparing the competing evidence.");
  assert.equal(listProposals(root, "approved").length, 2);
  const currentOverviews = queryAssertions(root, { predicate: "project.overview" });
  assert.equal(currentOverviews.length, 1);
  assert.equal((currentOverviews[0]?.value as { summary?: string }).summary, "Billing retries stop after a configurable limit.");
  assert.equal(getOverview(root).summary, "Billing retries stop after a configurable limit.");

  const configPath = path.join(root, ".context-atlas", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, maxCommits: 1 }, null, 2));
  assert.equal(getHealthReport(root).checks.find((item) => item.id === "history-completeness")?.status, "warning");
});

test("unsupported proposals cannot become truth without evidence", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const proposal = createProposal(root, {
    kind: "decision",
    title: "Unverified technology decision",
    summary: "Use an unsupported database.",
    evidenceIds: [],
  });
  assert.ok(proposal.riskFlags.includes("missing-evidence"));
  assert.throws(() => approveProposal(root, proposal.id), /without valid evidence/);
});

test("failed synchronization rolls database changes back and leaves integrity checks green", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const before = getGraph(root).nodes.map((node) => ({ id: node.id, status: node.status }));

  writeFileSync(path.join(root, ".atlasignore"), "sk-abcdefghijklmnopqrstuvwxyz123456\n");
  assert.throws(() => syncRepository(root), /.atlasignore appears to contain a secret/);

  const after = getGraph(root).nodes.map((node) => ({ id: node.id, status: node.status }));
  assert.deepEqual(after, before);
  const health = getHealthReport(root);
  assert.equal(health.checks.find((item) => item.id === "database-integrity")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "ledger-integrity")?.status, "pass");
  assert.equal(health.checks.find((item) => item.id === "event-ledger-coverage")?.status, "pass");
});
