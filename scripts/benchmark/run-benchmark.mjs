#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  fixtureManifestName,
  integerOption,
  parseArguments,
  percentile,
  projectRoot,
  readJson,
  roundMilliseconds,
  scenarioRoot,
  sha256,
  stableStringify,
  verifyFixtureOwnership,
} from "./common.mjs";
import { BENCHMARK_SCHEMA_VERSION, getScenario } from "./scenarios.mjs";

const options = parseArguments(process.argv.slice(2));
const scenario = getScenario(typeof options.get("scenario") === "string" ? options.get("scenario") : "smoke");
const root = scenarioRoot(scenario.name);
const manifest = readJson(path.join(root, fixtureManifestName));
const repoRoot = verifyFixtureOwnership(manifest.repoRoot, scenario.name);
const samples = integerOption(options, "samples", scenario.readSamples, 1, 50);
const cliPath = path.join(projectRoot, "dist", "cli.js");
if (!existsSync(cliPath)) throw new Error("The benchmark requires a built CLI. Run `npm run build` first.");
if (manifest.configHash !== sha256(stableStringify(scenario))) {
  throw new Error(`Fixture ${scenario.name} does not match the current scenario definition. Regenerate it with --clean.`);
}

resetFixture();
const operations = [];
const parsedOutputs = new Map();
const contextPackTask = "understand component dependencies";

operations.push(await measureOperation("cold-init", ["init", "--repo", repoRoot, "--json"], 1));
createIncrementalCommit();
operations.push(await measureOperation("incremental-sync", ["sync", "--repo", repoRoot, "--json"], 1));
operations.push(await measureOperation("overview", ["overview", "--repo", repoRoot, "--json"], samples));
operations.push(await measureOperation("graph", ["map", "--repo", repoRoot], samples));
operations.push(await measureOperation("timeline", ["timeline", "--repo", repoRoot, "--limit", "200"], samples));
operations.push(await measureOperation("search", ["search", "component", "--repo", repoRoot, "--limit", "20"], samples));
operations.push(await measureOperation("health", ["health", "--repo", repoRoot], samples));
const contextPackOverride = createBenchmarkContextPackOverride(contextPackTask);
operations.push(
  await measureOperation(
    "context-pack",
    ["pack", contextPackTask, "--repo", repoRoot, "--budget", "8000", "--override", contextPackOverride.id, "--json"],
    samples,
  ),
);

const databasePath = path.join(repoRoot, ".context-atlas", "atlas.db");
const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"], projectRoot).trim();
const sourceDirty = commandOutput("git", ["status", "--porcelain"], projectRoot).trim().length > 0;
const report = {
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  benchmarkVersion: "1",
  generatedAt: new Date().toISOString(),
  source: { commit: sourceCommit, dirty: sourceDirty },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    npmVersion: commandOutput(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], projectRoot).trim(),
    gitVersion: commandOutput("git", ["--version"], projectRoot).trim(),
  },
  scenario: {
    name: scenario.name,
    description: scenario.description,
    configHash: manifest.configHash,
    configuration: scenario,
    fixtureHead: manifest.fixtureHead,
    trackedFileCount: manifest.trackedFileCount,
    untrackedFileCount: manifest.untrackedFileCount,
  },
  setup: {
    contextPackOverride: {
      id: contextPackOverride.id,
      actor: contextPackOverride.actor,
      expiresAt: contextPackOverride.expiresAt,
      taskScoped: true,
    },
  },
  operations,
  artifacts: {
    databaseBytes: existsSync(databasePath) ? statSync(databasePath).size : null,
  },
  observedCounts: summarizeOutputs(parsedOutputs),
  limitations: [
    "Synthetic fixtures do not represent every real repository layout or filesystem.",
    "Peak RSS samples the Context Atlas Node.js process only and is unavailable when the host does not expose /proc process status.",
    "Git process count is derived from GIT_TRACE2_EVENT start records and excludes fixture-generation Git commands.",
    "Context Pack timing uses an explicit five-minute, task-scoped human:benchmark override when the synthetic fixture has critical proposal conflicts; the override remains visible in the returned pack.",
    "A single runner result is a reference baseline, not a production-scale claim or service-level objective.",
  ],
};

const outputOption = options.get("output");
const outputPath =
  typeof outputOption === "string"
    ? path.resolve(outputOption)
    : path.join(root, "results", `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
printSummary(report, outputPath);

async function measureOperation(name, args, repeat) {
  const operationSamples = [];
  for (let index = 0; index < repeat; index += 1) {
    const tracePath = path.join(root, "traces", `${name}-${index}.jsonl`);
    mkdirSync(path.dirname(tracePath), { recursive: true });
    if (existsSync(tracePath)) unlinkSync(tracePath);
    const result = await executeCli(args, tracePath);
    const parsed = parseJsonOutput(result.stdout, name);
    parsedOutputs.set(name, parsed);
    operationSamples.push({
      sample: index + 1,
      durationMs: roundMilliseconds(result.durationMs),
      peakRssBytes: result.peakRssBytes,
      gitProcessCount: countGitProcesses(tracePath),
      outputBytes: Buffer.byteLength(result.stdout, "utf8"),
    });
  }
  const durations = operationSamples.map((item) => item.durationMs);
  const memorySamples = operationSamples.map((item) => item.peakRssBytes).filter((value) => typeof value === "number");
  const gitCounts = operationSamples.map((item) => item.gitProcessCount);
  return {
    name,
    samples: operationSamples,
    summary: {
      minimumMs: Math.min(...durations),
      maximumMs: Math.max(...durations),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      peakRssBytes: memorySamples.length > 0 ? Math.max(...memorySamples) : null,
      totalGitProcesses: gitCounts.reduce((total, value) => total + value, 0),
      maximumGitProcessesPerSample: Math.max(...gitCounts),
    },
  };
}

function executeCli(args, tracePath) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1", GIT_TRACE2_EVENT: tracePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let peakRssBytes = null;
    const sampleMemory = () => {
      if (process.platform !== "linux" || !child.pid) return;
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (match) peakRssBytes = Math.max(peakRssBytes ?? 0, Number(match[1]) * 1024);
      } catch {
        // The process may exit between the poll and the read.
      }
    };
    const memoryTimer = setInterval(sampleMemory, 10);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 64 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > 8 * 1024 * 1024) child.kill();
    });
    child.once("error", (error) => {
      clearInterval(memoryTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      sampleMemory();
      clearInterval(memoryTimer);
      const durationMs = performance.now() - startedAt;
      if (code !== 0) {
        reject(
          new Error(
            `Benchmark command failed (${args.join(" ")}) with code ${String(code)} signal ${String(signal)}:\n${stderr.slice(-4_000)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, durationMs, peakRssBytes });
    });
  });
}

function countGitProcesses(tracePath) {
  if (!existsSync(tracePath)) return 0;
  let count = 0;
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.event === "start") count += 1;
    } catch {
      throw new Error(`Malformed Git trace record in ${tracePath}.`);
    }
  }
  unlinkSync(tracePath);
  return count;
}

function parseJsonOutput(stdout, operation) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Benchmark operation ${operation} did not return JSON: ${String(error)}`);
  }
}

function summarizeOutputs(outputs) {
  const graph = outputs.get("graph");
  const timeline = outputs.get("timeline");
  const search = outputs.get("search");
  const pack = outputs.get("context-pack");
  const includedKeys = ["includedEntityIds", "includedAssertionIds", "includedRelationshipIds", "includedEventIds", "includedEvidenceIds"];
  return {
    graphNodes: arrayLength(graph?.nodes),
    graphEdges: arrayLength(graph?.edges),
    timelineEvents: arrayLength(Array.isArray(timeline) ? timeline : timeline?.events),
    searchResults: arrayLength(Array.isArray(search) ? search : search?.results),
    contextPackSelected: includedKeys.reduce((total, key) => total + arrayLength(pack?.[key]), 0),
    contextPackExcluded: arrayLength(pack?.exclusions),
    contextPackBudgetExcluded: Array.isArray(pack?.exclusions)
      ? pack.exclusions.filter((item) => /budget|truncat/i.test(String(item?.reason))).length
      : 0,
  };
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function createBenchmarkContextPackOverride(task) {
  const output = commandOutput(
    process.execPath,
    [
      cliPath,
      "pack-override",
      "--repo",
      repoRoot,
      "--actor",
      "human:benchmark",
      "--reason",
      "Synthetic benchmark operator acknowledges pending proposal conflicts for navigation-only performance measurement.",
      "--task",
      task,
      "--duration",
      "5",
    ],
    repoRoot,
    { NODE_NO_WARNINGS: "1" },
  );
  const override = parseJsonOutput(output, "context-pack-override");
  if (
    typeof override?.id !== "string" ||
    override.actor !== "human:benchmark" ||
    typeof override.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(override.expiresAt))
  ) {
    throw new Error("Context Pack benchmark override returned an invalid contract.");
  }
  return override;
}

function createIncrementalCommit() {
  const target = path.join(repoRoot, manifest.mutationTarget);
  const previous = readFileSync(target, "utf8").replace(/\n\/\/ benchmark incremental mutation\n?$/, "");
  writeFileSync(target, `${previous}\n// benchmark incremental mutation\n`, "utf8");
  commandOutput("git", ["add", "--", manifest.mutationTarget], repoRoot);
  commandOutput("git", ["commit", "-m", "benchmark: incremental synchronization mutation"], repoRoot, {
    GIT_AUTHOR_DATE: "2030-01-01T00:00:00.000Z",
    GIT_COMMITTER_DATE: "2030-01-01T00:00:00.000Z",
  });
}

function resetFixture() {
  commandOutput("git", ["reset", "--hard", manifest.fixtureHead], repoRoot);
  const atlasRoot = path.join(repoRoot, ".context-atlas");
  if (existsSync(atlasRoot)) rmSync(atlasRoot, { recursive: true, force: true });
}

function commandOutput(command, args, cwd, extraEnvironment = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnvironment },
  });
}

function printSummary(value, outputPath) {
  process.stdout.write(`Context Atlas benchmark: ${value.scenario.name}\n`);
  process.stdout.write(`Environment: ${value.environment.platform}/${value.environment.architecture} ${value.environment.nodeVersion}\n`);
  for (const operation of value.operations) {
    process.stdout.write(
      `${operation.name.padEnd(18)} p50=${String(operation.summary.p50Ms).padStart(9)} ms p95=${String(operation.summary.p95Ms).padStart(
        9,
      )} ms git=${operation.summary.totalGitProcesses}\n`,
    );
  }
  process.stdout.write(`Database: ${String(value.artifacts.databaseBytes)} bytes\n`);
  process.stdout.write(`Report: ${outputPath}\n`);
}
