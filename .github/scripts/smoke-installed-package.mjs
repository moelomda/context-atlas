import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = process.cwd();
const packageRoot = path.join(installRoot, "node_modules", "context-atlas");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const pluginRoot = path.join(packageRoot, "plugin", "context-atlas");
const pluginWrapper = path.join(pluginRoot, "scripts", "run-context-atlas-mcp.mjs");
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
for (const required of [
  cliPath,
  pluginWrapper,
  path.join(pluginRoot, "runtime", "server.mjs"),
  path.join(pluginRoot, "LICENSE"),
  path.join(pluginRoot, "THIRD_PARTY_NOTICES.md"),
  path.join(packageRoot, "dist", "extensions", "index.js"),
  path.join(packageRoot, "dist", "extensions", "index.d.ts"),
  path.join(packageRoot, "dist", "web", "public", "app.js"),
  path.join(packageRoot, "dist", "web", "public", "styles.css"),
]) {
  assert.equal(existsSync(required), true, `Packed install is missing ${required}`);
}

const extensionProbe = JSON.parse(execFileSync(process.execPath, [
  "--input-type=module",
  "--eval",
  [
    "const sdk = await import('context-atlas/extensions');",
    "process.stdout.write(JSON.stringify({",
    "  apiVersion: sdk.EXTENSION_API_VERSION,",
    "  registry: typeof sdk.ExtensionRegistry,",
    "  defineExtension: typeof sdk.defineExtension",
    "}));",
  ].join("\n"),
], {
  cwd: installRoot,
  encoding: "utf8",
  windowsHide: true,
}));
assert.deepEqual(extensionProbe, {
  apiVersion: 1,
  registry: "function",
  defineExtension: "function",
});

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-installed-smoke-"));
let webChild = null;
let mcpClient = null;
try {
  reportPhase("create Git fixture and initialize installed CLI");
  createFixtureRepository(fixtureRoot);
  const secretCanary = "sk-installed-smoke-secret-must-never-escape";
  writeFileSync(path.join(fixtureRoot, ".env"), `OPENAI_API_KEY=${secretCanary}\n`, "utf8");

  const help = runCli(["help"]);
  assert.match(help, /evidence-backed temporal project memory/i);
  parseJson(runCli(["init", fixtureRoot, "--name", "Installed Package Smoke", "--json"]), "init");

  const proposals = parseJson(runCli(["proposals", "pending", "--repo", fixtureRoot]), "pending proposals");
  assert.ok(Array.isArray(proposals) && proposals.length > 0, "Initialization must create a review proposal");
  const proposalId = proposals[0]?.id;
  assert.equal(typeof proposalId, "string");
  parseJson(runCli([
    "approve", proposalId,
    "--repo", fixtureRoot,
    "--actor", "human:installed-smoke",
    "--note", "Reviewed by the installed-package release smoke.",
  ]), "proposal approval");

  reportPhase("preview and import one explicitly selected external source");
  const externalSource = path.join(fixtureRoot, ".context-atlas", "installed-source.md");
  writeFileSync(externalSource, "# Support interview\n\nOperators need a visible billing retry timeline.\n", "utf8");
  const sourceOptions = [
    "--type", "conversation-summary",
    "--origin", "Installed smoke support interview",
    "--authority", "human",
    "--sensitivity", "normal",
    "--purpose", "Verify explicit source consent in the installed package.",
    "--actor", "human:installed-smoke",
    "--title", "Billing retry interview",
    "--repo", fixtureRoot,
  ];
  const sourcePreview = parseJson(runCli(["source-import-preview", externalSource, ...sourceOptions]), "source import preview");
  assert.equal(sourcePreview.operation, "external-import-preview");
  assert.equal(sourcePreview.source?.bodyPersistence, "stored");
  assert.match(sourcePreview.planId ?? "", /^[a-f0-9]{64}$/);
  const importedSource = parseJson(runCli([
    "source-import", externalSource, ...sourceOptions,
    "--plan", sourcePreview.planId, "--confirm", "IMPORT",
  ]), "source import apply");
  assert.equal(importedSource.applied, true);
  assert.match(importedSource.import?.evidenceId ?? "", /^evidence_[a-f0-9]{32}$/);

  const task = "change subscription billing retry behavior";
  const cliPack = parseJson(runCli(["pack", task, "--repo", fixtureRoot, "--budget", "8000", "--json"]), "CLI context pack");
  assert.equal(cliPack.schemaVersion, 2);
  assert.equal(cliPack.safety?.scope, "navigation-only");
  assert.equal(cliPack.sections?.length, 15);
  assert.ok(JSON.stringify(cliPack).length <= 8_000 * 4);
  assertNoPrivateMaterial(cliPack, fixtureRoot, secretCanary, "CLI context pack");
  const savedArchitecture = parseJson(runCli([
    "pack-save", "explain installed architecture", "--repo", fixtureRoot, "--budget", "8000",
  ]), "saved architecture pack");
  const savedRisks = parseJson(runCli([
    "pack-save", "explain installed risks and tests", "--repo", fixtureRoot, "--budget", "8000",
  ]), "saved risk pack");
  const architectureSnapshotId = savedArchitecture.snapshot?.snapshotId;
  const risksSnapshotId = savedRisks.snapshot?.snapshotId;
  assert.match(architectureSnapshotId ?? "", /^pack_snapshot_[a-f0-9]{64}$/);
  assert.match(risksSnapshotId ?? "", /^pack_snapshot_[a-f0-9]{64}$/);

  const privacy = parseJson(runCli(["privacy", "--repo", fixtureRoot]), "privacy report");
  assert.equal(privacy.egress?.remoteProviderCapability, "not-implemented");
  assert.equal(privacy.egress?.defaultNetworkEgress, false);
  assert.equal(privacy.findings?.secretValuesIncludedInReport, false);
  assert.equal(privacy.findings?.storedPotentialSecretMatches, 0);
  assertNoPrivateMaterial(privacy, fixtureRoot, secretCanary, "privacy report");

  reportPhase("exercise installed dashboard and versioned API");
  const web = await startInstalledWebServer(fixtureRoot);
  webChild = web.child;
  const indexResponse = await fetchWithTimeout(`${web.url}/`, HTTP_REQUEST_TIMEOUT_MS);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /Context Atlas/i);
  const overviewEnvelope = await fetchJson(`${web.url}/api/v1/overview`);
  assert.equal(overviewEnvelope.contractVersion, "1.0.0");
  assert.equal(overviewEnvelope.data?.project?.name, "Installed Package Smoke");
  assert.equal(overviewEnvelope.data?.assertions?.overview?.settled, true);
  const projectId = overviewEnvelope.data?.project?.id;
  assert.equal(typeof projectId, "string");
  const graphEnvelope = await fetchJson(`${web.url}/api/v1/graph`);
  assert.ok(Array.isArray(graphEnvelope.data?.nodes) && graphEnvelope.data.nodes.length > 0);
  assert.ok(graphEnvelope.data.nodes.every((node) => typeof node.presentationStatus === "string" && typeof node.settled === "boolean"));
  const searchEnvelope = await fetchJson(`${web.url}/api/v1/search?q=billing&limit=20`);
  assert.ok(Array.isArray(searchEnvelope.data?.results));
  assert.ok(searchEnvelope.data.results.every((item) => typeof item.status === "string" && typeof item.settled === "boolean"));
  const explainEnvelope = await fetchJson(`${web.url}/api/v1/explain?target=${encodeURIComponent(projectId)}`);
  assert.equal(explainEnvelope.data?.presentation?.settled, true);
  assertNoPrivateMaterial({ overviewEnvelope, graphEnvelope, searchEnvelope, explainEnvelope }, fixtureRoot, secretCanary, "web API");

  reportPhase("exercise protected browser-review boundary");
  const reviewEvidenceId = cliPack.evidence?.[0]?.id;
  assert.equal(typeof reviewEvidenceId, "string");
  const browserProposal = parseJson(runCli([
    "propose", "--kind", "decision", "--title", "Keep installed review local",
    "--summary", "The packaged dashboard review path must preserve explicit human attribution.",
    "--evidence", reviewEvidenceId, "--repo", fixtureRoot,
  ]), "browser-review proposal");
  const reviewSession = await postJson(`${web.url}/api/v1/review-session`, {}, { origin: web.url });
  assert.match(reviewSession.data?.token ?? "", /^[a-zA-Z0-9_-]{40,100}$/);
  const browserDecision = await postJson(
    `${web.url}/api/v1/proposals/${encodeURIComponent(browserProposal.id)}/approve`,
    {
      actor: "human:installed-browser-smoke",
      rationale: "Reviewed through the protected installed dashboard boundary.",
    },
    { origin: web.url, "x-context-atlas-session": reviewSession.data.token },
  );
  assert.equal(browserDecision.data?.proposal?.status, "approved");
  const reviewWorkspace = await fetchJson(`${web.url}/api/v1/review-workspace`);
  assert.ok(reviewWorkspace.data?.history?.some((proposal) => proposal.id === browserProposal.id && proposal.status === "approved"));

  reportPhase("connect to installed MCP wrapper and inspect all read-only tools");
  const { Client, StdioClientTransport, getDefaultEnvironment } = await loadInstalledMcpClient(packageRoot, installRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [pluginWrapper],
    cwd: pluginRoot,
    env: { ...getDefaultEnvironment(), CONTEXT_ATLAS_REPO: fixtureRoot },
    stderr: "pipe",
  });
  mcpClient = new Client({ name: "context-atlas-installed-smoke", version: "1.0.0" });
  await mcpClient.connect(transport);
  const tools = await mcpClient.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "atlas_assertion_evolution", "atlas_assertion_history", "atlas_assertions",
    "atlas_context_pack", "atlas_evidence", "atlas_explain", "atlas_health", "atlas_history",
    "atlas_overview", "atlas_pack_diff", "atlas_pack_history", "atlas_pack_snapshot", "atlas_search",
  ]);
  assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));

  reportPhase("exercise installed saved-pack MCP reads");
  const mcpPackHistory = await callMcpTool(mcpClient, {
    name: "atlas_pack_history",
    arguments: { repo: fixtureRoot, limit: 10 },
  });
  assert.equal(mcpPackHistory.isError, undefined);
  assert.equal(mcpPackHistory.structuredContent?.data?.count, 2);
  const mcpPackSnapshot = await callMcpTool(mcpClient, {
    name: "atlas_pack_snapshot",
    arguments: { repo: fixtureRoot, snapshotId: architectureSnapshotId },
  });
  assert.equal(mcpPackSnapshot.structuredContent?.data?.summary?.snapshotId, architectureSnapshotId);
  assert.equal(mcpPackSnapshot.structuredContent?.data?.packIncluded, false);
  const mcpPackDiff = await callMcpTool(mcpClient, {
    name: "atlas_pack_diff",
    arguments: { repo: fixtureRoot, leftSnapshotId: architectureSnapshotId, rightSnapshotId: risksSnapshotId },
  });
  assert.equal(mcpPackDiff.structuredContent?.data?.changed, true);
  assert.equal(mcpPackDiff.structuredContent?.data?.changes?.taskChanged, true);

  reportPhase("exercise installed navigation and evidence MCP reads");
  const mcpOverview = await callMcpTool(mcpClient, { name: "atlas_overview", arguments: { repo: fixtureRoot } });
  assert.equal(mcpOverview.isError, undefined);
  assert.equal(mcpOverview.structuredContent?.contractVersion, "1.0.0");
  const mcpPack = await callMcpTool(mcpClient, {
    name: "atlas_context_pack",
    arguments: { repo: fixtureRoot, task, tokenBudget: 8_000 },
  });
  assert.equal(mcpPack.isError, undefined);
  assert.equal(mcpPack.structuredContent?.data?.schemaVersion, 2);
  assert.equal(mcpPack.structuredContent?.data?.sections?.length, 15);
  assert.ok(JSON.stringify({ content: mcpPack.content, structuredContent: mcpPack.structuredContent }).length <= 8_000 * 4);
  const evidenceId = mcpPack.structuredContent?.data?.evidence?.[0]?.id;
  assert.equal(typeof evidenceId, "string");
  const mcpEvidence = await callMcpTool(mcpClient, { name: "atlas_evidence", arguments: { repo: fixtureRoot, evidenceId } });
  assert.equal(mcpEvidence.isError, undefined);
  assertNoPrivateMaterial({ mcpOverview, mcpPack, mcpEvidence }, fixtureRoot, secretCanary, "MCP reads");

  reportPhase("exercise prominent critical override through installed MCP");
  const { AtlasDatabase } = await import(pathToFileURL(path.join(packageRoot, "dist", "core", "database.js")).href);
  const faultDatabase = new AtlasDatabase(fixtureRoot);
  try {
    assert.equal(faultDatabase.insertEvent({
      id: "event_installed_smoke_unledgered",
      timestamp: new Date().toISOString(),
      type: "release_smoke_fault",
      title: "Deliberately unledgered installed-package event",
      summary: "Exercises prominent override warnings through the packaged MCP wrapper.",
      commit: null,
      files: [],
      evidence: [evidenceId],
      ledgerHash: null,
    }), true);
  } finally {
    faultDatabase.close();
  }
  const overrideTask = "inspect installed MCP override warnings";
  const override = parseJson(runCli([
    "pack-override",
    "--repo", fixtureRoot,
    "--actor", "human:installed-smoke",
    "--reason", "Allow navigation around the deliberate release-smoke finding.",
    "--task", overrideTask,
    "--duration", "5",
  ]), "context-pack override");
  assert.match(override.id ?? "", /^pack_override_[a-f0-9]{24}$/);
  const overridden = await callMcpTool(mcpClient, {
    name: "atlas_context_pack",
    arguments: { repo: fixtureRoot, task: overrideTask, tokenBudget: 8_000, overrideId: override.id },
  });
  assert.equal(overridden.isError, undefined);
  assert.match(firstTextBlock(overridden.content), /OVERRIDDEN CRITICAL \/ navigation-only/);
  assert.equal(overridden.structuredContent?.data?.safety?.override?.id, override.id);
  assert.ok(overridden.structuredContent?.data?.warnings?.some((warning) => /OVERRIDDEN CRITICAL CONTEXT/i.test(warning)));
  assertNoPrivateMaterial(overridden, fixtureRoot, secretCanary, "overridden MCP pack");

  process.stdout.write("Installed tarball CLI, dashboard/API, MCP, override, and privacy smoke passed.\n");
} finally {
  if (mcpClient) await mcpClient.close().catch(() => {});
  if (webChild) await stopChild(webChild);
  const resolved = path.resolve(fixtureRoot);
  const temporaryRoot = path.resolve(tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}context-atlas-installed-smoke-`)) {
    throw new Error(`Refusing to remove unexpected smoke directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function createFixtureRepository(root) {
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Installed Smoke"]);
  runGit(root, ["config", "user.email", "installed-smoke@example.invalid"]);
  mkdirSync(path.join(root, "src", "payments"), { recursive: true });
  mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "installed-smoke", description: "Subscription billing smoke fixture" }, null, 2));
  writeFileSync(path.join(root, "README.md"), "# Installed Package Smoke\n\nA subscription billing service used for release verification.\n");
  writeFileSync(path.join(root, "src", "payments", "billing.js"), "export const charge = (cents) => cents > 0;\n");
  writeFileSync(path.join(root, "docs", "adr", "0001-ledger.md"), "# Use a ledger\n\nStatus: accepted. Preserve review history.\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Create installed-package smoke fixture"]);
}

function runGit(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
}

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: installRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Installed ${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function startInstalledWebServer(repoRoot) {
  const child = spawn(process.execPath, [cliPath, "serve", "--repo", repoRoot, "--host", "127.0.0.1", "--port", "0"], {
    cwd: installRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out starting installed web server. ${stderr}`)), 15_000);
    const poll = setInterval(() => {
      const match = stdout.match(/Context Atlas is available at (http:\/\/[^\s]+)/);
      if (match?.[1]) finish(null, match[1]);
    }, 25);
    const onExit = (code, signal) => finish(new Error(`Installed web server exited before readiness: code=${String(code)} signal=${String(signal)} ${stderr}`));
    const onError = (error) => finish(error);
    function finish(error, value) {
      clearTimeout(timeout);
      clearInterval(poll);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    }
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return { child, url };
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (timedOut || error?.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs} ms fetching ${url}`, { cause: error });
    }
    throw error;
  }
  finally { clearTimeout(timeout); }
}

async function callMcpTool(client, request) {
  try {
    return await client.callTool(request);
  } catch (error) {
    throw new Error(`Installed MCP tool ${request.name} failed`, { cause: error });
  }
}

function reportPhase(label) {
  process.stdout.write(`[installed-smoke] ${label}\n`);
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, HTTP_REQUEST_TIMEOUT_MS);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body, headers = {}) {
  const response = await fetchWithTimeout(url, HTTP_REQUEST_TIMEOUT_MS, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function loadInstalledMcpClient(installedPackageRoot, root) {
  const candidates = [
    path.join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
    path.join(installedPackageRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
  ];
  const sdkRoot = candidates.find((candidate) => existsSync(path.join(candidate, "client", "index.js")));
  assert.ok(sdkRoot, "Installed MCP SDK dependency was not found");
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
    import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")).href),
  ]);
  return { Client, StdioClientTransport, getDefaultEnvironment };
}

function firstTextBlock(content) {
  if (!Array.isArray(content)) return "";
  const first = content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function assertNoPrivateMaterial(value, repoRoot, secret, label) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(secret), false, `${label} leaked the secret canary`);
  assert.equal(serialized.includes(repoRoot), false, `${label} leaked the absolute fixture path`);
  assert.doesNotMatch(serialized, /installed-smoke@example\.invalid/i, `${label} leaked the fixture author email`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000, "timeout"));
  if (await Promise.race([exited, timeout]) === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
