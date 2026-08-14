import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

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
    assert.equal(overview.structuredContent?.contractVersion, "1.0.0");
    assert.equal((overview.structuredContent?.snapshot as { repositoryId?: string }).repositoryId?.startsWith("repo_"), true);

    const assertions = await client.callTool({ name: "atlas_assertions", arguments: { repo: root } });
    const assertionData = assertions.structuredContent?.data as Array<{ logicalId?: string }>;
    assert.equal(assertions.isError, undefined);
    assert.ok(assertionData.length > 0);
    const logicalId = assertionData[0]?.logicalId as string;
    const assertionHistory = await client.callTool({ name: "atlas_assertion_history", arguments: { repo: root, logicalId } });
    assert.match(JSON.stringify(assertionHistory.structuredContent), /human:mcp-test/);
    const assertionEvolution = await client.callTool({ name: "atlas_assertion_evolution", arguments: { repo: root, predicate: "project.overview" } });
    assert.match(JSON.stringify(assertionEvolution.structuredContent), /project\.overview/);

    const pack = await client.callTool({
      name: "atlas_context_pack",
      arguments: { repo: root, task: "change subscription billing retries", tokenBudget: 500 },
    });
    assert.equal(pack.isError, undefined);
    const packData = pack.structuredContent?.data as { safety?: { scope?: string }; estimatedTokens?: number; evidence?: Array<{ id: string }> };
    assert.equal(packData.safety?.scope, "navigation-only");
    assert.ok(Number(packData.estimatedTokens) <= 500);
    const evidenceId = packData.evidence?.[0]?.id as string;
    const evidence = await client.callTool({ name: "atlas_evidence", arguments: { repo: root, evidenceId } });
    assert.equal(evidence.isError, undefined);
    assert.match(JSON.stringify(evidence.structuredContent), new RegExp(evidenceId));
    assert.doesNotMatch(JSON.stringify(evidence.structuredContent), /sk-this-must-never-enter-context-storage/);

  } finally {
    await client.close();
  }
});
