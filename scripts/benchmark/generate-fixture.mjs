#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  benchmarkRootMarker,
  fixtureManifestName,
  fixtureMarker,
  parseArguments,
  readJson,
  removeGeneratedScenario,
  scenarioRoot,
  sha256,
  stableStringify,
  verifyFixtureOwnership,
} from "./common.mjs";
import { FIXTURE_SCHEMA_VERSION, getScenario } from "./scenarios.mjs";

const options = parseArguments(process.argv.slice(2));
const scenario = getScenario(typeof options.get("scenario") === "string" ? options.get("scenario") : "smoke");
const root = scenarioRoot(scenario.name);
const repoRoot = path.join(root, "repo");
const manifestPath = path.join(root, fixtureManifestName);
const configHash = sha256(stableStringify(scenario));

if (options.has("clean")) removeGeneratedScenario(root, scenario.name);

try {
  const existing = readJson(manifestPath);
  verifyFixtureOwnership(repoRoot, scenario.name);
  if (existing.configHash !== configHash) {
    throw new Error(`Existing ${scenario.name} fixture uses a different configuration. Regenerate it with --clean.`);
  }
  process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  if (!options.has("clean") && error instanceof Error && !error.message.includes("ENOENT")) throw error;
}

mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
writeJson(path.join(root, benchmarkRootMarker), {
  schemaVersion: 1,
  scenario: scenario.name,
  purpose: "Context Atlas deterministic synthetic benchmark data",
});
writeJson(path.join(repoRoot, fixtureMarker), {
  schemaVersion: FIXTURE_SCHEMA_VERSION,
  scenario: scenario.name,
  seedDigest: sha256(scenario.seed),
});

runGit(["init", "-b", "main"]);
runGit(["config", "user.name", "Context Atlas Benchmark"]);
runGit(["config", "user.email", "benchmark@example.invalid"]);
runGit(["config", "commit.gpgsign", "false"]);

const componentNames = Array.from({ length: scenario.componentCount }, (_, index) => `component-${String(index).padStart(4, "0")}`);
const rootManifest = {
  name: `context-atlas-benchmark-${scenario.name}`,
  version: "1.0.0",
  private: true,
  description: `Deterministic synthetic ${scenario.name} benchmark fixture`,
  workspaces: ["packages/*"],
};
writeJson(path.join(repoRoot, "package.json"), rootManifest);
writeFileSync(
  path.join(repoRoot, "README.md"),
  `# Synthetic ${scenario.name} benchmark\n\nGenerated deterministically for Context Atlas performance measurement.\n`,
  "utf8",
);
mkdirSync(path.join(repoRoot, "docs", "adr"), { recursive: true });
writeFileSync(
  path.join(repoRoot, "docs", "adr", "0001-synthetic-boundary.md"),
  "# Synthetic architecture boundary\n\nComponents use explicit workspace dependencies so relationship extraction can be measured.\n",
  "utf8",
);

const mutationTargets = [];
for (let index = 0; index < componentNames.length; index += 1) {
  const name = componentNames[index];
  const componentRoot = path.join(repoRoot, "packages", name);
  mkdirSync(path.join(componentRoot, "src"), { recursive: true });
  const dependencies = {};
  for (let offset = 1; offset <= scenario.dependenciesPerComponent; offset += 1) {
    const dependency = componentNames[(index + offset) % componentNames.length];
    if (dependency && dependency !== name) dependencies[`@benchmark/${dependency}`] = "workspace:*";
  }
  writeJson(path.join(componentRoot, "package.json"), {
    name: `@benchmark/${name}`,
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
  });
  const sourcePath = path.join(componentRoot, "src", "index.ts");
  writeModule(sourcePath, scenario, index, 0, `export function ${identifier(name)}Value(input: number): number`);
  mutationTargets.push(sourcePath);
}

const genericFileCount = Math.max(0, scenario.fileCount - mutationTargets.length);
for (let index = 0; index < genericFileCount; index += 1) {
  const group = `group-${String(index % Math.max(1, Math.ceil(Math.sqrt(genericFileCount)))).padStart(4, "0")}`;
  const sourcePath = path.join(repoRoot, "src", group, `module-${String(index).padStart(6, "0")}.ts`);
  writeModule(sourcePath, scenario, index + componentNames.length, 0, `export function module${index}Value(input: number): number`);
  mutationTargets.push(sourcePath);
}

runGit(["add", "--all"]);
runGit(["commit", "-m", "benchmark: create deterministic synthetic repository"], commitEnvironment(0));

for (let revision = 1; revision < scenario.commitCount; revision += 1) {
  const changed = [];
  for (let offset = 0; offset < scenario.filesChangedPerCommit; offset += 1) {
    const targetIndex = (revision * scenario.filesChangedPerCommit + offset) % mutationTargets.length;
    const target = mutationTargets[targetIndex];
    if (!target) continue;
    const relative = path.relative(repoRoot, target).split(path.sep).join("/");
    const previous = readFileSync(target, "utf8").replace(/\n\/\/ revision \d+\n?$/, "");
    writeFileSync(target, `${previous}\n// revision ${revision}\n`, "utf8");
    changed.push(relative);
  }
  runGit(["add", "--", ...changed]);
  runGit(["commit", "-m", `benchmark: deterministic revision ${String(revision).padStart(5, "0")}`], commitEnvironment(revision));
}

for (let index = 0; index < scenario.untrackedFileCount; index += 1) {
  const filePath = path.join(repoRoot, "scratch", `generated-${String(index).padStart(6, "0")}.txt`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, sizedText(`untracked:${scenario.seed}:${index}`, scenario.untrackedBytesPerFile), "utf8");
}

const trackedFiles = runGit(["ls-files", "-z"], undefined, "buffer").toString("utf8").split("\0").filter(Boolean);
const manifest = {
  schemaVersion: FIXTURE_SCHEMA_VERSION,
  scenario: scenario.name,
  configHash,
  configuration: scenario,
  repoRoot,
  fixtureHead: runGit(["rev-parse", "HEAD"]).trim(),
  trackedFileCount: trackedFiles.length,
  untrackedFileCount: scenario.untrackedFileCount,
  mutationTarget: path.relative(repoRoot, mutationTargets[0]).split(path.sep).join("/"),
};
writeJson(manifestPath, manifest);
verifyFixtureOwnership(repoRoot, scenario.name);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

function writeModule(filePath, activeScenario, index, revision, signature) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const body = `${signature} {\n  return input + ${index % 97};\n}\n\nexport const syntheticLabel = ${JSON.stringify(
    `${activeScenario.name}:${index}`,
  )};\n// revision ${revision}\n`;
  writeFileSync(filePath, sizedText(`${activeScenario.seed}:${index}`, activeScenario.bytesPerFile, body), "utf8");
}

function sizedText(seed, targetBytes, prefix = "") {
  const digest = sha256(seed);
  let value = prefix;
  while (Buffer.byteLength(value, "utf8") < targetBytes) value += `// synthetic ${digest}\n`;
  return value;
}

function identifier(value) {
  return value.replace(/[^a-zA-Z0-9]+(.)/g, (_, character) => String(character).toUpperCase());
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commitEnvironment(revision) {
  const timestamp = new Date(Date.UTC(2020, 0, 1, 0, revision, 0)).toISOString();
  return { GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp };
}

function runGit(args, extraEnvironment, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnvironment },
  });
}
