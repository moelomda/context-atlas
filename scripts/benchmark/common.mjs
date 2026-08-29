import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const benchmarkRoot = path.join(tmpdir(), "context-atlas-benchmarks-v1");
export const benchmarkRootMarker = ".context-atlas-benchmark-root.json";
export const fixtureMarker = ".context-atlas-benchmark-fixture.json";
export const fixtureManifestName = "fixture-manifest.json";

export function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) throw new Error(`Unexpected positional argument: ${String(value)}.`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return options;
}

export function requiredOption(options, key) {
  const value = options.get(key);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required --${key} value.`);
  return value;
}

export function integerOption(options, key, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = options.get(key);
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`--${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${key} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function scenarioRoot(name) {
  const candidate = path.resolve(benchmarkRoot, name);
  assertInsideBenchmarkRoot(candidate);
  return candidate;
}

export function assertInsideBenchmarkRoot(candidate) {
  const resolved = path.resolve(candidate);
  const base = path.resolve(benchmarkRoot);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Refusing benchmark filesystem operation outside ${base}: ${resolved}`);
  }
  return resolved;
}

export function removeGeneratedScenario(candidate, expectedScenario) {
  const resolved = assertInsideBenchmarkRoot(candidate);
  if (!existsSync(resolved)) return;
  const markerPath = path.join(resolved, benchmarkRootMarker);
  if (!existsSync(markerPath)) throw new Error(`Refusing to remove unmarked benchmark directory: ${resolved}`);
  const marker = readJson(markerPath);
  if (marker.schemaVersion !== 1 || marker.scenario !== expectedScenario) {
    throw new Error(`Refusing to remove benchmark directory with an unexpected marker: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export function verifyFixtureOwnership(repoRoot, expectedScenario) {
  const resolved = assertInsideBenchmarkRoot(repoRoot);
  const markerPath = path.join(resolved, fixtureMarker);
  if (!existsSync(markerPath)) throw new Error(`Synthetic benchmark fixture marker is missing: ${markerPath}`);
  const marker = readJson(markerPath);
  if (marker.schemaVersion !== 1 || marker.scenario !== expectedScenario) {
    throw new Error(`Synthetic benchmark fixture marker does not match scenario ${expectedScenario}.`);
  }
  return resolved;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortValue(item)]));
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[rank] ?? null;
}

export function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}
