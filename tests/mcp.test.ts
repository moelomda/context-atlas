import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createContextPackOverride } from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { queryAssertions, recordAssertionRevision } from "../src/core/temporal.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

interface ToolEnvelope<T> {
  contractVersion?: string;
  snapshot?: { repositoryId?: string };
  data?: T;
  warnings?: string[];
  transport?: {
    scope?: string;
    hardCharacterLimit?: number;
    serializedCharacters?: number;
    estimatedTokens?: number;
    jsonRpcFramingIncluded?: boolean;
  };
}

function toolEnvelope<T>(value: unknown): ToolEnvelope<T> {
  assert.ok(value && typeof value === "object", "MCP tool must return a structured envelope");
  return value as ToolEnvelope<T>;
}

function firstTextBlock(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const first = value[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

test("MCP server exposes only bounded read tools", async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed for MCP temporal-contract verification.", "human:mcp-test");
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pluginRoot = path.join(root, "installed-context-atlas-plugin");
  cpSync(path.join(projectRoot, "plugin", "context-atlas"), pluginRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "run-context-atlas-mcp.mjs")],
    cwd: pluginRoot,
    env: { ...getDefaultEnvironment(), CONTEXT_ATLAS_REPO: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "context-atlas-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "atlas_assertion_evolution", "atlas_assertion_history", "atlas_assertions",
      "atlas_context_pack", "atlas_evidence", "atlas_explain", "atlas_health", "atlas_history",
      "atlas_overview", "atlas_search",
    ]);
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const overview = await client.callTool({ name: "atlas_overview", arguments: { repo: root } });
    assert.equal(overview.isError, undefined);
    assert.match(JSON.stringify(overview.structuredContent), /Fixture Shop/);
    const overviewEnvelope = toolEnvelope<unknown>(overview.structuredContent);
    assert.equal(overviewEnvelope.contractVersion, "1.0.0");
    assert.equal(overviewEnvelope.snapshot?.repositoryId?.startsWith("repo_"), true);

    const assertions = await client.callTool({ name: "atlas_assertions", arguments: { repo: root } });
    const assertionData = toolEnvelope<Array<{ logicalId?: string }>>(assertions.structuredContent).data ?? [];
    assert.equal(assertions.isError, undefined);
    assert.ok(assertionData.length > 0);
    const logicalId = assertionData[0]?.logicalId as string;
    const assertionHistory = await client.callTool({ name: "atlas_assertion_history", arguments: { repo: root, logicalId } });
    assert.match(JSON.stringify(assertionHistory.structuredContent), /human:mcp-test/);
    const assertionEvolution = await client.callTool({ name: "atlas_assertion_evolution", arguments: { repo: root, predicate: "project.overview" } });
    assert.match(JSON.stringify(assertionEvolution.structuredContent), /project\.overview/);

    const pack = await client.callTool({
      name: "atlas_context_pack",
      arguments: { repo: root, task: "change subscription billing retries", tokenBudget: 5_000 },
    });
    assert.equal(pack.isError, undefined);
    const packEnvelope = toolEnvelope<{ schemaVersion?: number; safety?: { scope?: string }; estimatedTokens?: number; evidence?: Array<{ id: string }>; sections?: unknown[]; policy?: { budgetScope?: string; hardCharacterLimit?: number; reservedTransportCharacters?: number } }>(pack.structuredContent);
    const packData = packEnvelope.data;
    assert.ok(packData);
    assert.equal(packData.schemaVersion, 2);
    assert.equal(packData.safety?.scope, "navigation-only");
    assert.ok(Number(packData.estimatedTokens) <= 5_000);
    assert.equal(packData.policy?.budgetScope, "compact-json");
    assert.ok((packData.policy?.reservedTransportCharacters ?? 0) > 0);
    const serializedToolResult = JSON.stringify({ content: pack.content, structuredContent: pack.structuredContent });
    const responseTransport = packEnvelope.transport;
    assert.ok(responseTransport);
    assert.equal(responseTransport.scope, "mcp-tool-result-compact-json");
    assert.equal(responseTransport.serializedCharacters, serializedToolResult.length);
    assert.equal(responseTransport.estimatedTokens, Math.ceil(serializedToolResult.length / 4));
    assert.equal(responseTransport.hardCharacterLimit, 5_000 * 4);
    assert.equal(responseTransport.jsonRpcFramingIncluded, false);
    assert.ok(serializedToolResult.length <= 5_000 * 4);
    assert.doesNotMatch(firstTextBlock(pack.content), /# Context Atlas task pack/);
    assert.equal(packData.sections?.length, 15);
    const evidenceId = packData.evidence?.[0]?.id as string;
    const evidence = await client.callTool({ name: "atlas_evidence", arguments: { repo: root, evidenceId } });
    assert.equal(evidence.isError, undefined);
    const evidenceData = toolEnvelope<{ validation?: { status?: string; outcome?: string }; permittedForCurrentUse?: boolean }>(evidence.structuredContent).data;
    assert.equal(evidenceData?.validation?.status, "verified");
    assert.equal(evidenceData?.validation?.outcome, "verified");
    assert.equal(evidenceData?.permittedForCurrentUse, true);
    assert.match(JSON.stringify(evidence.structuredContent), new RegExp(evidenceId));
    assert.doesNotMatch(JSON.stringify(evidence.structuredContent), /sk-this-must-never-enter-context-storage/);
    assert.doesNotMatch(JSON.stringify(evidence.structuredContent), /context-atlas-test-|atlas-test@example/i);
    assert.doesNotMatch(JSON.stringify(pack.structuredContent), /context-atlas-test-|atlas-test@example/i);

    const faultDatabase = new AtlasDatabase(root);
    faultDatabase.insertEvent({
      id: "event_mcp_override_fault",
      timestamp: new Date().toISOString(),
      type: "test_fault",
      title: "Deliberately unledgered MCP test event",
      summary: "Creates a narrow critical health finding for override warning transport verification.",
      commit: null,
      files: [],
      evidence: [evidenceId],
      ledgerHash: null,
    });
    faultDatabase.close();
    const overrideTask = "inspect MCP override warning presentation";
    const override = createContextPackOverride(root, {
      actor: "human:mcp-test",
      reason: "Temporarily accept the deliberate test-only finding to verify MCP warning prominence.",
      task: overrideTask,
    });
    const overriddenPack = await client.callTool({
      name: "atlas_context_pack",
      arguments: { repo: root, task: overrideTask, tokenBudget: 8_000, overrideId: override.id },
    });
    assert.equal(overriddenPack.isError, undefined);
    assert.match(firstTextBlock(overriddenPack.content), /OVERRIDDEN CRITICAL \/ navigation-only/);
    const overriddenData = toolEnvelope<{ warnings?: string[]; safety?: { override?: { id?: string } } }>(overriddenPack.structuredContent).data;
    assert.ok(overriddenData);
    assert.equal(overriddenData.safety?.override?.id, override.id);
    assert.ok(overriddenData.warnings?.some((warning) => /OVERRIDDEN CRITICAL CONTEXT/i.test(warning)));

    commitFile(root, "src/payments/mcp-stale.ts", "export const changedAfterReview = true;\n", "Change project after MCP overview review");
    const staleOverview = await client.callTool({ name: "atlas_overview", arguments: { repo: root } });
    const staleOverviewEnvelope = toolEnvelope<{
      summary?: string;
      assertions?: { overview?: { status?: string; settled?: boolean; reason?: string; evidence?: unknown[] } };
    }>(staleOverview.structuredContent);
    const staleOverviewData = staleOverviewEnvelope.data;
    assert.ok(staleOverviewData);
    assert.equal(staleOverviewData.assertions?.overview?.status, "stale");
    assert.equal(staleOverviewData.assertions?.overview?.settled, false);
    assert.match(staleOverviewData.assertions?.overview?.reason ?? "", /Repository HEAD changed/);
    assert.ok((staleOverviewData.assertions?.overview?.evidence?.length ?? 0) > 0);
    assert.ok(staleOverviewEnvelope.warnings?.some((warning) => /project\.overview is stale/i.test(warning)));
    const staleAssertions = await client.callTool({ name: "atlas_assertions", arguments: { repo: root, predicate: "project.overview" } });
    const staleAssertionsEnvelope = toolEnvelope<Array<{
      lifecycle?: string;
      presentation?: { status?: string; settled?: boolean; reason?: string; evidence?: unknown[] };
    }>>(staleAssertions.structuredContent);
    const staleAssertionData = staleAssertionsEnvelope.data ?? [];
    assert.equal(staleAssertionData[0]?.lifecycle, "accepted");
    assert.equal(staleAssertionData[0]?.presentation?.status, "stale");
    assert.equal(staleAssertionData[0]?.presentation?.settled, false);
    assert.match(staleAssertionData[0]?.presentation?.reason ?? "", /Repository HEAD changed/);
    assert.ok((staleAssertionData[0]?.presentation?.evidence?.length ?? 0) > 0);
    assert.ok(staleAssertionsEnvelope.warnings?.some((warning) => /project\.overview is stale/i.test(warning)));

    const staleSearch = await client.callTool({
      name: "atlas_search",
      arguments: { repo: root, query: "project overview", limit: 100 },
    });
    const staleSearchEnvelope = toolEnvelope<{
      results: Array<{ id: string; status: string; settled: boolean; reason: string; evidenceIds: string[] }>;
    }>(staleSearch.structuredContent);
    const staleSearchData = staleSearchEnvelope.data;
    assert.ok(staleSearchData);
    const staleNarrative = staleSearchData.results.find((result) => result.id === "narrative:project-overview");
    assert.equal(staleNarrative?.status, "stale");
    assert.equal(staleNarrative?.settled, false);
    assert.ok((staleNarrative?.evidenceIds.length ?? 0) > 0);
    assert.ok(staleSearchEnvelope.warnings?.some((warning) => /narrative:project-overview is stale/i.test(warning)));

    const currentOverview = queryAssertions(root, { predicate: "project.overview" })[0];
    assert.ok(currentOverview);
    recordAssertionRevision(root, {
      subjectId: currentOverview.subjectId,
      predicate: currentOverview.predicate,
      scope: currentOverview.scope,
      value: { summary: "Contradictory MCP-visible overview" },
      authority: "human",
      confidence: "approved",
      producer: "human:mcp-conflict-test",
      lifecycle: "accepted",
      reviewState: "accepted",
      evidence: currentOverview.evidence,
      actor: "human:mcp-conflict-test",
      action: "accept",
      rationale: "Exercise conflict presentation across MCP.",
    });
    const conflictOverview = await client.callTool({ name: "atlas_overview", arguments: { repo: root } });
    const conflictOverviewEnvelope = toolEnvelope<{
      assertions?: { overview?: { status?: string; settled?: boolean } };
    }>(conflictOverview.structuredContent);
    const conflictOverviewData = conflictOverviewEnvelope.data;
    assert.ok(conflictOverviewData);
    assert.equal(conflictOverviewData.assertions?.overview?.status, "conflicting");
    assert.equal(conflictOverviewData.assertions?.overview?.settled, false);
    assert.ok(conflictOverviewEnvelope.warnings?.some((warning) => /project\.overview is conflicting/i.test(warning)));
    const conflictAssertions = await client.callTool({ name: "atlas_assertions", arguments: { repo: root, predicate: "project.overview" } });
    const conflictAssertionData = toolEnvelope<Array<{ presentation?: { status?: string; settled?: boolean } }>>(conflictAssertions.structuredContent).data ?? [];
    assert.equal(conflictAssertionData.length, 2);
    assert.ok(conflictAssertionData.every((assertion) => assertion.presentation?.status === "conflicting" && assertion.presentation.settled === false));

  } finally {
    await client.close();
  }
});
