import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { buildContextPack, ContextPackBlockedError } from "../src/core/context-pack.js";
import { queryPresentedAssertions } from "../src/core/claim-status.js";
import { AtlasDatabase } from "../src/core/database.js";
import { getHealthReport } from "../src/core/health.js";
import { syncRepository } from "../src/core/ingest.js";
import { approveProposal, createProposal, listProposals } from "../src/core/proposals.js";
import { explainEntity, getGraph, getOverview, searchAtlas } from "../src/core/query.js";
import { getAssertionHistory, queryAssertions, recordAssertionRevision } from "../src/core/temporal.js";
import { startWebServer } from "../src/web/server.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

interface OverviewClaim {
  status: "current" | "stale" | "conflicting" | "unknown";
  settled: boolean;
  reason: string;
  assertionId: string;
  logicalId: string;
  revision: number;
  lifecycle: string;
  evidence: Array<{ evidenceId: string; role: string }>;
  value: { summary?: string };
  repository: { synchronized: boolean; synchronizedHead: string | null; currentHead: string | null };
}

function overviewClaim(value: Record<string, unknown>): OverviewClaim {
  return ((value.assertions as { overview: OverviewClaim }).overview);
}

async function withWebServer<T>(root: string, run: (url: string) => Promise<T>): Promise<T> {
  const { server, url } = await startWebServer(root, { port: 0 });
  try { return await run(url); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("a new HEAD makes reviewed overview prose visibly stale until a fresh reviewed revision replaces it", async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(
    root,
    listProposals(root, "pending")[0]?.id as string,
    "Reviewed against the founding repository snapshot.",
    "human:stale-test",
  );

  const freshBefore = getOverview(root);
  const acceptedSummary = String(freshBefore.summary);
  const firstClaim = overviewClaim(freshBefore);
  assert.equal(firstClaim.status, "current");
  assert.equal(firstClaim.settled, true);
  assert.equal(firstClaim.lifecycle, "accepted");
  assert.ok(firstClaim.evidence.length > 0);
  assert.equal(freshBefore.summaryAuthority, "human-reviewed");

  commitFile(root, "src/payments/retry.ts", "export const retryLimit = 3;\n", "Add bounded billing retries");

  // The live projection must fail safe before sync mutates any stored state.
  const staleBeforeSync = getOverview(root);
  const liveClaim = overviewClaim(staleBeforeSync);
  assert.equal(liveClaim.status, "stale");
  assert.equal(liveClaim.settled, false);
  assert.equal(liveClaim.lifecycle, "accepted", "the immutable stored revision is still accepted before sync");
  assert.equal(liveClaim.repository.synchronized, false);
  assert.match(liveClaim.reason, /Repository HEAD changed from .* to .*/);
  assert.ok(liveClaim.evidence.length > 0);
  assert.notEqual(staleBeforeSync.summary, acceptedSummary);
  assert.equal(staleBeforeSync.summaryAuthority, "unknown");
  assert.match(String(staleBeforeSync.summary), /withheld because the repository changed/i);
  assert.ok((staleBeforeSync.warnings as string[]).some((warning) => /project\.overview is stale/i.test(warning)));
  assert.equal(liveClaim.value.summary, acceptedSummary, "history stays available only inside the explicitly stale claim projection");
  const staleHealth = getHealthReport(root);
  assert.equal(staleHealth.checks.find((item) => item.id === "repository-sync")?.status, "warning");
  assert.equal(staleHealth.checks.find((item) => item.id === "approved-overview")?.status, "warning");
  assert.ok(staleHealth.components.every((component) => component.status !== "current"));
  const staleGraphNode = getGraph(root).nodes.find((node) => node.id === "narrative:project-overview");
  assert.ok(staleGraphNode);
  assert.notEqual(staleGraphNode.presentationStatus, "current");
  assert.equal(staleGraphNode.settled, false);
  const staleExplanation = explainEntity(root, "narrative:project-overview") as {
    presentation: { status: string; settled: boolean; reason: string };
    warnings: string[];
  };
  assert.notEqual(staleExplanation.presentation.status, "current");
  assert.equal(staleExplanation.presentation.settled, false);
  assert.ok(staleExplanation.warnings.some((warning) => /narrative:project-overview/i.test(warning)));

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cliOverview = JSON.parse(execFileSync(process.execPath, [path.join(projectRoot, "dist", "cli.js"), "overview", "--repo", root, "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })) as Record<string, unknown>;
  assert.equal(overviewClaim(cliOverview).status, "stale");
  assert.notEqual(cliOverview.summary, acceptedSummary);
  const cliAssertions = JSON.parse(execFileSync(process.execPath, [path.join(projectRoot, "dist", "cli.js"), "assertions", "--predicate", "project.overview", "--repo", root], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })) as Array<{ lifecycle: string; presentation: { status: string; settled: boolean; reason: string; evidence: unknown[] } }>;
  assert.equal(cliAssertions[0]?.lifecycle, "accepted", "CLI preserves the immutable lifecycle");
  assert.equal(cliAssertions[0]?.presentation.status, "stale");
  assert.equal(cliAssertions[0]?.presentation.settled, false);
  assert.match(cliAssertions[0]?.presentation.reason ?? "", /Repository HEAD changed/);
  assert.ok((cliAssertions[0]?.presentation.evidence.length ?? 0) > 0);

  assert.throws(
    () => buildContextPack(root, "change billing retries", 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );

  await withWebServer(root, async (url) => {
    const staleResponse = await fetch(`${url}/api/v1/overview`);
    const staleEnvelope = await staleResponse.json() as {
      warnings: string[];
      data: Record<string, unknown>;
    };
    assert.equal(staleResponse.status, 200);
    assert.equal(overviewClaim(staleEnvelope.data).status, "stale");
    assert.notEqual(staleEnvelope.data.summary, acceptedSummary);
    assert.ok(staleEnvelope.warnings.some((warning) => /project\.overview is stale/i.test(warning)));
    const staleAssertionsResponse = await fetch(`${url}/api/v1/assertions?predicate=project.overview`);
    const staleAssertionsEnvelope = await staleAssertionsResponse.json() as {
      warnings: string[];
      data: Array<{ lifecycle: string; presentation: { status: string; settled: boolean; reason: string; evidence: unknown[] } }>;
    };
    assert.equal(staleAssertionsEnvelope.data[0]?.lifecycle, "accepted");
    assert.equal(staleAssertionsEnvelope.data[0]?.presentation.status, "stale");
    assert.equal(staleAssertionsEnvelope.data[0]?.presentation.settled, false);
    assert.ok(staleAssertionsEnvelope.warnings.some((warning) => /project\.overview is stale/i.test(warning)));
    const graphEnvelope = await (await fetch(`${url}/api/v1/graph`)).json() as {
      warnings: string[];
      data: { nodes: Array<{ id: string; presentationStatus: string; settled: boolean }> };
    };
    const graphNarrative = graphEnvelope.data.nodes.find((node) => node.id === "narrative:project-overview");
    assert.notEqual(graphNarrative?.presentationStatus, "current");
    assert.equal(graphNarrative?.settled, false);
    assert.ok(graphEnvelope.warnings.some((warning) => /narrative:project-overview/i.test(warning)));
    const explainEnvelope = await (await fetch(`${url}/api/v1/explain?target=narrative%3Aproject-overview`)).json() as {
      warnings: string[];
      data: { presentation: { status: string; settled: boolean } };
    };
    assert.notEqual(explainEnvelope.data.presentation.status, "current");
    assert.equal(explainEnvelope.data.presentation.settled, false);
    assert.ok(explainEnvelope.warnings.some((warning) => /narrative:project-overview/i.test(warning)));
  });

  syncRepository(root);
    const staleAfterSync = getOverview(root);
    const persistedStaleClaim = overviewClaim(staleAfterSync);
    assert.equal(persistedStaleClaim.status, "stale");
    assert.equal(persistedStaleClaim.lifecycle, "stale");
    assert.equal(persistedStaleClaim.repository.synchronized, true);
    assert.match(persistedStaleClaim.reason, /Repository HEAD changed/);
    assert.ok(persistedStaleClaim.evidence.some((item) => item.role === "context"));
    const stalePack = buildContextPack(root, "change billing retries", 20_000);
    assert.equal(stalePack.claims.overview.status, "stale");
    assert.equal(stalePack.claims.overview.settled, false);
    assert.equal(stalePack.repository.head, persistedStaleClaim.repository.currentHead);
    assert.equal(stalePack.repository.indexedHead, persistedStaleClaim.repository.synchronizedHead);
    assert.equal(stalePack.repository.head, stalePack.repository.indexedHead);
    assert.equal(stalePack.repository.synchronized, true);
    assert.ok(stalePack.warnings.some((warning) => /project\.overview is stale/i.test(warning)));
    assert.match(stalePack.markdown, /STALE — HISTORICAL ONLY, NOT CURRENT GUIDANCE/);
    assert.match(stalePack.markdown, /Reason: Repository HEAD changed/);
    const staleSearch = searchAtlas(root, "project overview", 100);
    const staleNarrativeResult = staleSearch.results.find((result) => result.id === "narrative:project-overview");
    assert.ok(staleNarrativeResult);
    assert.equal(staleNarrativeResult.status, "stale");
    assert.equal(staleNarrativeResult.settled, false);
    assert.match(staleNarrativeResult.reason, /Repository HEAD changed|freshness boundary/i);
    assert.ok(staleNarrativeResult.evidenceIds.length > 0);
    assert.ok(staleSearch.warnings.some((warning) => /narrative:project-overview is stale/i.test(warning)));

    await withWebServer(root, async (url) => {
      const staleSearchResponse = await fetch(`${url}/api/v1/search?q=project%20overview&limit=100`);
      const staleSearchEnvelope = await staleSearchResponse.json() as {
        warnings: string[];
        data: { results: Array<{ id: string; status: string; settled: boolean }> };
      };
      const apiNarrative = staleSearchEnvelope.data.results.find((result) => result.id === "narrative:project-overview");
      assert.equal(apiNarrative?.status, "stale");
      assert.equal(apiNarrative?.settled, false);
      assert.ok(staleSearchEnvelope.warnings.some((warning) => /narrative:project-overview is stale/i.test(warning)));
    });
    const staleHistory = getAssertionHistory(root, firstClaim.logicalId);
    assert.deepEqual(staleHistory.map((revision) => revision.lifecycle), ["accepted", "stale"]);

    const revisionProposal = listProposals(root, "pending")[0];
    assert.ok(revisionProposal, "synchronization must create a reviewable replacement overview");
    approveProposal(
      root,
      revisionProposal.id,
      "Reviewed the changed HEAD and accepted this replacement overview.",
      "human:stale-test",
    );

    const freshAfterReview = getOverview(root);
    const refreshedClaim = overviewClaim(freshAfterReview);
    assert.equal(refreshedClaim.status, "current");
    assert.equal(refreshedClaim.settled, true);
    assert.equal(refreshedClaim.lifecycle, "accepted");
    assert.equal(refreshedClaim.revision, 3);
    assert.equal(refreshedClaim.repository.synchronized, true);
    assert.match(refreshedClaim.reason, /validated against repository HEAD/);
    assert.equal(freshAfterReview.summaryAuthority, "human-reviewed");
    assert.equal(freshAfterReview.summary, refreshedClaim.value.summary);
    assert.notEqual(freshAfterReview.summary, acceptedSummary);
    assert.deepEqual(
      getAssertionHistory(root, firstClaim.logicalId).map((revision) => revision.lifecycle),
      ["accepted", "stale", "accepted"],
    );
    assert.equal(queryAssertions(root, { predicate: "project.overview" })[0]?.id, refreshedClaim.assertionId);

    const freshPack = buildContextPack(root, "change billing retries", 20_000);
    assert.equal(freshPack.claims.overview.status, "current");
    assert.equal(freshPack.repository.head, freshPack.repository.indexedHead);
    assert.equal(freshPack.repository.synchronized, true);
    assert.doesNotMatch(freshPack.markdown, /STALE — HISTORICAL ONLY, NOT CURRENT GUIDANCE/);
    assert.equal(freshPack.warnings.some((warning) => /project\.overview is stale/i.test(warning)), false);

  await withWebServer(root, async (url) => {
    const freshResponse = await fetch(`${url}/api/v1/overview`);
    const freshEnvelope = await freshResponse.json() as { warnings: string[]; data: Record<string, unknown> };
    assert.equal(overviewClaim(freshEnvelope.data).status, "current");
    assert.equal(freshEnvelope.warnings.some((warning) => /project\.overview is stale/i.test(warning)), false);
    const freshAssertionsEnvelope = await (await fetch(`${url}/api/v1/assertions?predicate=project.overview`)).json() as {
      warnings: string[];
      data: Array<{ presentation: { status: string; settled: boolean } }>;
    };
    assert.equal(freshAssertionsEnvelope.data[0]?.presentation.status, "current");
    assert.equal(freshAssertionsEnvelope.data[0]?.presentation.settled, true);
    assert.equal(freshAssertionsEnvelope.warnings.length, 0);
  });
});

test("an accepted non-human overview revision cannot masquerade as human-reviewed guidance", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed founding overview.", "human:stale-test");

  const current = queryAssertions(root, { predicate: "project.overview" })[0];
  assert.ok(current);
  const derivedSummary = "System-authored replacement that must remain unsettled";
  recordAssertionRevision(root, {
    logicalId: current.logicalId,
    supersedesId: current.id,
    subjectId: current.subjectId,
    predicate: current.predicate,
    scope: current.scope,
    value: { summary: derivedSummary },
    authority: "derived",
    confidence: "inferred",
    producer: "system:authority-regression",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: current.evidence,
    actor: "human:stale-test",
    action: "edit_accept",
    rationale: "Exercise the presentation authority boundary.",
  });

  const overview = getOverview(root);
  const claim = overviewClaim(overview);
  assert.equal(claim.status, "unknown");
  assert.equal(claim.settled, false);
  assert.match(claim.reason, /not attributed human authority/i);
  assert.notEqual(overview.summary, derivedSummary);
  assert.notEqual(overview.summaryAuthority, "human-reviewed");
  assert.equal(getHealthReport(root).checks.find((item) => item.id === "approved-overview")?.status, "warning");
});

test("only the canonical project subject can supply the global project overview", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed founding overview.", "human:subject-boundary");

  const canonicalOverview = getOverview(root);
  const canonicalClaim = overviewClaim(canonicalOverview);
  const canonicalSummary = String(canonicalOverview.summary);
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const component = database.listEntities({ types: ["component"] })[0];
  const evidence = component?.primaryEvidenceId
    ? database.listEvidence([component.primaryEvidenceId])[0]
    : null;
  const guidanceWatermark = database.getMeta("last_synced_guidance_watermark");
  database.close();
  assert.ok(project && component && evidence && guidanceWatermark);

  assert.throws(
    () => createProposal(root, {
      kind: "context_update",
      title: "Component-scoped overview hijack",
      summary: "This component must never replace the project overview.",
      targetId: component.id,
      evidenceIds: [evidence.id],
    }),
    /only the canonical project entity/i,
  );
  assert.equal(listProposals(root, "pending").some((proposal) => proposal.title === "Component-scoped overview hijack"), false);

  const legacyProposalId = "proposal_noncanonical_overview_regression";
  const legacyDatabase = new AtlasDatabase(root);
  legacyDatabase.createProposal({
    id: legacyProposalId,
    kind: "context_update",
    targetId: component.id,
    title: "Legacy malformed component overview",
    summary: "A defensive approval boundary must reject this persisted malformed proposal.",
    payload: { observedGuidanceWatermark: guidanceWatermark },
    evidenceIds: [evidence.id],
    riskFlags: ["requires-human-review"],
    status: "pending",
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewNote: null,
    conflictGroup: null,
  });
  legacyDatabase.close();
  assert.throws(
    () => approveProposal(root, legacyProposalId, "This malformed target must be refused.", "human:subject-boundary"),
    /only the canonical project entity/i,
  );
  assert.equal(listProposals(root, "pending").some((proposal) => proposal.id === legacyProposalId), true);

  const noncanonicalSummary = "Component subject hijack must remain noncanonical";
  const noncanonical = recordAssertionRevision(root, {
    subjectId: component.id,
    predicate: "project.overview",
    scope: "project",
    value: { summary: noncanonicalSummary },
    authority: "human",
    confidence: "approved",
    producer: "human:subject-boundary",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:subject-boundary",
    action: "accept",
    rationale: "Exercise the reserved overview subject boundary.",
  });

  const presented = queryPresentedAssertions(root, { predicate: "project.overview" });
  const noncanonicalPresented = presented.find((assertion) => assertion.id === noncanonical.id);
  assert.equal(noncanonicalPresented?.presentation.status, "unknown");
  assert.equal(noncanonicalPresented?.presentation.settled, false);
  assert.match(noncanonicalPresented?.presentation.reason ?? "", /reserved for the sole active project subject/i);

  const overview = getOverview(root);
  assert.equal(overview.summary, canonicalSummary);
  assert.equal(overviewClaim(overview).assertionId, canonicalClaim.assertionId);
  assert.equal(overviewClaim(overview).status, "current");

  const graphNarrative = getGraph(root).nodes.find((node) => node.id === "narrative:project-overview");
  assert.equal(graphNarrative?.summary, canonicalSummary);
  assert.equal(graphNarrative?.presentationStatus, "current");
  assert.equal(graphNarrative?.settled, true);

  const searchNarrative = searchAtlas(root, "project overview component boundary", 100).results
    .find((result) => result.id === "narrative:project-overview");
  assert.equal(searchNarrative?.summary, canonicalSummary);
  assert.equal(searchNarrative?.status, "current");
  assert.equal(searchNarrative?.settled, true);

  const explanation = explainEntity(root, "narrative:project-overview") as {
    entity: { summary: string };
    presentation: { status: string; settled: boolean };
  };
  assert.equal(explanation.entity.summary, canonicalSummary);
  assert.equal(explanation.presentation.status, "current");
  assert.equal(explanation.presentation.settled, true);

  const pack = buildContextPack(root, "project overview component subject hijack", 20_000);
  assert.equal(pack.claims.overview.assertionId, canonicalClaim.assertionId);
  assert.equal(pack.claims.overview.status, "current");
  assert.equal(pack.selection.includedAssertionIds.includes(noncanonical.id), false);
  assert.ok(pack.selection.exclusions.some((item) => item.kind === "assertion"
    && item.id === noncanonical.id
    && item.reason === "unsettled"));
  assert.doesNotMatch(pack.markdown, new RegExp(noncanonicalSummary, "i"));
  assert.equal(getHealthReport(root).checks.find((item) => item.id === "approved-overview")?.status, "pass");
});

test("uncommitted tracked changes invalidate settled overview guidance", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed founding overview.", "human:stale-test");
  const acceptedSummary = String(getOverview(root).summary);

  writeFileSync(path.join(root, "README.md"), "# Fixture Shop\n\nUncommitted working-tree change.\n");

  const overview = getOverview(root);
  const claim = overviewClaim(overview);
  assert.equal(claim.status, "stale");
  assert.equal(claim.settled, false);
  assert.equal(claim.repository.synchronized, false);
  assert.match(claim.reason, /working tree differs/i);
  assert.notEqual(overview.summary, acceptedSummary);
  assert.notEqual(overview.summaryAuthority, "human-reviewed");
  assert.ok((overview.warnings as string[]).some((warning) => /project\.overview is stale/i.test(warning)));
  const health = getHealthReport(root);
  assert.equal(health.checks.find((item) => item.id === "repository-sync")?.status, "warning");
  assert.equal(health.checks.find((item) => item.id === "approved-overview")?.status, "warning");
  assert.ok(health.components.every((component) => component.status !== "current"));

  assert.throws(
    () => buildContextPack(root, "understand the uncommitted change", 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );

  syncRepository(root);
  const afterSameHeadSync = getOverview(root);
  const persistedClaim = overviewClaim(afterSameHeadSync);
  assert.equal(persistedClaim.repository.synchronized, true);
  assert.equal(persistedClaim.status, "stale", "same-HEAD sync must not make changed content current without review");
  assert.equal(persistedClaim.settled, false);
  assert.equal(persistedClaim.lifecycle, "stale");
  assert.match(persistedClaim.reason, /working-tree content changed/i);
  assert.notEqual(afterSameHeadSync.summary, acceptedSummary);
  assert.notEqual(afterSameHeadSync.summaryAuthority, "human-reviewed");
  assert.ok(listProposals(root, "pending").some((proposal) => /updated project overview/i.test(proposal.title)));
});

test("multiple active overview logical claims are all presented as conflicting", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed founding overview.", "human:stale-test");
  const current = queryAssertions(root, { predicate: "project.overview" })[0];
  assert.ok(current);
  const contradictorySummary = "A contradictory human overview on a second logical claim";
  recordAssertionRevision(root, {
    subjectId: current.subjectId,
    predicate: current.predicate,
    scope: current.scope,
    value: { summary: contradictorySummary },
    authority: "human",
    confidence: "approved",
    producer: "human:conflict-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: current.evidence,
    actor: "human:conflict-test",
    action: "accept",
    rationale: "Exercise multi-logical overview conflict presentation.",
  });

  const overview = getOverview(root);
  const claim = overviewClaim(overview);
  assert.equal(claim.status, "conflicting");
  assert.equal(claim.settled, false);
  assert.notEqual(overview.summary, contradictorySummary);
  assert.notEqual(overview.summaryAuthority, "human-reviewed");
  assert.ok((overview.warnings as string[]).some((warning) => /project\.overview is conflicting/i.test(warning)));
  assert.equal((overview.assertions as { current: number }).current, 0);
  const presented = queryPresentedAssertions(root, { predicate: "project.overview" });
  assert.equal(presented.length, 2);
  assert.ok(presented.every((assertion) => assertion.presentation.status === "conflicting" && !assertion.presentation.settled));
  const graphNarrative = getGraph(root).nodes.find((node) => node.id === "narrative:project-overview");
  assert.equal(graphNarrative?.presentationStatus, "conflicting");
  assert.equal(graphNarrative?.settled, false);
  const explanation = explainEntity(root, "narrative:project-overview") as {
    presentation: { status: string; settled: boolean };
    warnings: string[];
  };
  assert.equal(explanation.presentation.status, "conflicting");
  assert.equal(explanation.presentation.settled, false);
  assert.ok(explanation.warnings.some((warning) => /conflicting/i.test(warning)));
  assert.equal(getHealthReport(root).checks.find((item) => item.id === "approved-overview")?.status, "warning");
});

test("editing an already-indexed untracked source file changes the authority fingerprint", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  const notePath = path.join(root, "docs", "working-note.md");
  writeFileSync(notePath, "Initial untracked design note.\n");
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed including the untracked note.", "human:stale-test");
  assert.equal(overviewClaim(getOverview(root)).status, "current");

  writeFileSync(notePath, "Changed untracked design note.\n");

  const overview = getOverview(root);
  const claim = overviewClaim(overview);
  assert.equal(claim.status, "stale");
  assert.equal(claim.settled, false);
  assert.match(claim.reason, /working tree differs/i);
  const search = searchAtlas(root, "project overview", 100);
  assert.equal(search.results.find((result) => result.id === "narrative:project-overview")?.status, "stale");
  assert.throws(
    () => buildContextPack(root, "use the working note", 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );
});

test("non-overview assertion presentation enforces authority, evidence, conflicts, and repository freshness", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const database = new AtlasDatabase(root);
  const project = database.listEntities({ types: ["project"] })[0];
  const evidence = database.listAllEvidence().find((item) => !item.sensitive);
  database.close();
  assert.ok(project && evidence);

  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.derived-supported",
    value: { summary: "Evidence-backed derived decision" },
    authority: "derived",
    confidence: "documented",
    producer: "system:presentation-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:presentation-test",
    action: "accept",
    rationale: "Accept an evidence-backed derived claim.",
  });
  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.inferred-unsettled",
    value: { summary: "Inference cannot masquerade as settled" },
    authority: "inferred",
    confidence: "inferred",
    producer: "system:inference-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: evidence.id, role: "support" }],
    actor: "human:presentation-test",
    action: "accept",
    rationale: "Exercise inferred authority presentation.",
  });
  recordAssertionRevision(root, {
    subjectId: project.id,
    predicate: "decision.contradicted-unsettled",
    value: { summary: "Contradicting evidence prevents settled guidance" },
    authority: "human",
    confidence: "approved",
    producer: "human:presentation-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [
      { evidenceId: evidence.id, role: "support" },
      { evidenceId: evidence.id, role: "contradict" },
    ],
    actor: "human:presentation-test",
    action: "accept",
    rationale: "Exercise active contradicting evidence presentation.",
  });
  for (const value of ["five", "ten"]) {
    recordAssertionRevision(root, {
      subjectId: project.id,
      predicate: "constraint.scalar-limit",
      value: { limit: value },
      authority: "human",
      confidence: "approved",
      producer: "human:presentation-test",
      lifecycle: "accepted",
      reviewState: "accepted",
      evidence: [{ evidenceId: evidence.id, role: "support" }],
      actor: "human:presentation-test",
      action: "accept",
      rationale: "Exercise scalar conflict presentation.",
    });
  }

  const current = queryPresentedAssertions(root);
  assert.equal(current.find((assertion) => assertion.predicate === "decision.derived-supported")?.presentation.status, "current");
  assert.equal(current.find((assertion) => assertion.predicate === "decision.inferred-unsettled")?.presentation.status, "unknown");
  const contradicted = current.find((assertion) => assertion.predicate === "decision.contradicted-unsettled");
  assert.equal(contradicted?.presentation.status, "conflicting");
  assert.equal(contradicted?.presentation.settled, false);
  assert.match(contradicted?.presentation.reason ?? "", /contradicting evidence/i);
  assert.ok(current.filter((assertion) => assertion.predicate === "constraint.scalar-limit")
    .every((assertion) => assertion.presentation.status === "conflicting" && !assertion.presentation.settled));

  commitFile(root, "src/payments/presentation-drift.ts", "export const drift = true;\n", "Change repository after assertion review");
  const stale = queryPresentedAssertions(root, { predicate: "decision.derived-supported" })[0];
  assert.equal(stale?.presentation.status, "stale");
  assert.equal(stale?.presentation.settled, false);
});

test("unknown-provider evidence cannot settle a reviewed overview in any primary read surface", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed founding overview.", "human:stale-test");
  const current = queryAssertions(root, { predicate: "project.overview" })[0];
  assert.ok(current);
  const database = new AtlasDatabase(root);
  database.upsertEvidence({
    id: "evidence_unknown_provider_regression",
    kind: "custom_provider",
    locator: "custom:opaque",
    digest: "a".repeat(64),
    observedAt: new Date().toISOString(),
    sensitive: false,
    metadata: {},
  });
  database.close();
  const unsupportedSummary = "Human prose backed only by an unvalidated provider";
  recordAssertionRevision(root, {
    logicalId: current.logicalId,
    supersedesId: current.id,
    subjectId: current.subjectId,
    predicate: current.predicate,
    scope: current.scope,
    value: { summary: unsupportedSummary },
    authority: "human",
    confidence: "approved",
    producer: "human:provider-test",
    lifecycle: "accepted",
    reviewState: "accepted",
    evidence: [{ evidenceId: "evidence_unknown_provider_regression", role: "support" }],
    actor: "human:provider-test",
    action: "edit_accept",
    rationale: "Exercise unknown evidence-provider fail-closed presentation.",
  });

  const overview = getOverview(root);
  assert.equal(overviewClaim(overview).status, "unknown");
  assert.equal(overviewClaim(overview).settled, false);
  assert.notEqual(overview.summary, unsupportedSummary);
  const presented = queryPresentedAssertions(root, { predicate: "project.overview" })[0];
  assert.equal(presented?.presentation.status, "unknown");
  assert.equal(presented?.presentation.settled, false);
  const search = searchAtlas(root, "project overview", 100);
  assert.equal(search.results.find((result) => result.id === "narrative:project-overview")?.status, "unknown");
  assert.throws(
    () => buildContextPack(root, "use the project overview", 20_000),
    (error: unknown) => error instanceof ContextPackBlockedError
      && error.criticalChecks.some((check) => check.id === "evidence-locator-integrity"),
  );
});
