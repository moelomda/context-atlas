#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArguments, requiredOption } from "./common.mjs";
import { BENCHMARK_SCHEMA_VERSION, scenarioNames } from "./scenarios.mjs";

const options = parseArguments(process.argv.slice(2));
const filePath = path.resolve(requiredOption(options, "file"));
if (!existsSync(filePath)) throw new Error(`Benchmark report does not exist: ${filePath}`);
const report = JSON.parse(readFileSync(filePath, "utf8"));

assert(report.schemaVersion === BENCHMARK_SCHEMA_VERSION, "Unexpected benchmark report schema version.");
assert(report.benchmarkVersion === "1", "Unexpected benchmark implementation version.");
assert(typeof report.generatedAt === "string" && Number.isFinite(Date.parse(report.generatedAt)), "Invalid generatedAt timestamp.");
assert(typeof report.source?.commit === "string" && /^[0-9a-f]{40}$/.test(report.source.commit), "Invalid source commit.");
assert(typeof report.source?.dirty === "boolean", "Invalid source dirty-state field.");
assert(scenarioNames().includes(report.scenario?.name), "Unknown benchmark scenario.");
assert(typeof report.scenario?.configHash === "string" && /^[0-9a-f]{64}$/.test(report.scenario.configHash), "Invalid scenario hash.");
assert(Array.isArray(report.operations) && report.operations.length === 8, "Expected eight benchmark operations.");

const expectedOperations = ["cold-init", "incremental-sync", "overview", "graph", "timeline", "search", "health", "context-pack"];
assert(
  report.operations.map((operation) => operation.name).join("\n") === expectedOperations.join("\n"),
  "Benchmark operations are missing or out of order.",
);
for (const operation of report.operations) {
  assert(Array.isArray(operation.samples) && operation.samples.length > 0, `Operation ${operation.name} has no samples.`);
  for (const sample of operation.samples) {
    assert(Number.isFinite(sample.durationMs) && sample.durationMs >= 0, `Operation ${operation.name} has an invalid duration.`);
    assert(Number.isInteger(sample.gitProcessCount) && sample.gitProcessCount >= 0, `Operation ${operation.name} has an invalid Git count.`);
    assert(Number.isInteger(sample.outputBytes) && sample.outputBytes > 0, `Operation ${operation.name} has an invalid output size.`);
    assert(sample.peakRssBytes === null || (Number.isInteger(sample.peakRssBytes) && sample.peakRssBytes > 0), `Operation ${operation.name} has invalid RSS.`);
  }
  assert(Number.isFinite(operation.summary?.p50Ms), `Operation ${operation.name} has no p50.`);
  assert(Number.isFinite(operation.summary?.p95Ms), `Operation ${operation.name} has no p95.`);
}
assert(report.artifacts?.databaseBytes === null || Number.isInteger(report.artifacts.databaseBytes), "Invalid database size.");
assert(Array.isArray(report.limitations) && report.limitations.length > 0, "Benchmark limitations must remain explicit.");
process.stdout.write(`Validated benchmark report ${filePath}\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
