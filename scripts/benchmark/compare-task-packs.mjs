#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArguments, requiredOption, sha256 } from "./common.mjs";

const options = parseArguments(process.argv.slice(2));
const source = path.resolve(requiredOption(options, "repo"));
const output = path.resolve(requiredOption(options, "output"));
const casesPath = path.resolve(requiredOption(options, "cases"));
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
if (!/^[a-f0-9]{40,64}$/.test(cases.revision) || !Array.isArray(cases.tasks) || cases.tasks.length === 0) {
  throw new Error("Cases require a pinned full revision and at least one task.");
}
const ids = new Set();
for (const task of cases.tasks) {
  if (!/^[a-z0-9-]+$/.test(task.id) || ids.has(task.id) || typeof task.task !== "string" || !task.task.trim()) {
    throw new Error("Task IDs must be unique safe filenames and task text must be nonempty.");
  }
  ids.add(task.id);
  for (const key of ["expectedFiles", "expectedComponents"]) {
    if (!Array.isArray(task[key]) || task[key].length === 0 || task[key].some((value) => typeof value !== "string" || !value)) {
      throw new Error(`Task ${task.id} needs nonempty ${key}.`);
    }
  }
}
// An existing output directory is refused; no repository or previous evidence is deleted.
mkdirSync(output);
const report = {
  schemaVersion: 1,
  kind: "development-navigation-comparison",
  description: cases.description,
  startedAt: new Date().toISOString(),
  source,
  revision: cases.revision,
  casesSha256: sha256(readFileSync(casesPath)),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  tokenBudget: 8000,
  tokenMeasure: "characters-divided-by-four estimate; not model tokens",
  overridesCreated: 0,
  approvalsCreated: 0,
  arms: [],
};
const save = () => writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
save();

function run(label, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(path.join(output, `${label}.stdout.txt`), result.stdout ?? "");
  writeFileSync(path.join(output, `${label}.stderr.txt`), result.stderr ?? "");
  return { exitCode: result.status, error: result.error?.message ?? null, signal: result.signal, stdout: result.stdout ?? "" };
}

function requireSuccess(result) {
  if (result.exitCode !== 0 || result.error) throw new Error(`Setup failed: ${result.error ?? result.exitCode}; inspect raw logs.`);
}

function runtimeDigest(directory) {
  const records = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) records.push([path.relative(directory, file).replaceAll("\\", "/"), sha256(readFileSync(file))]);
      else throw new Error(`Unexpected runtime entry: ${file}`);
    }
  }
  visit(directory);
  return sha256(JSON.stringify(records));
}

try {
  for (const name of ["baseline", "candidate"]) {
    const cli = path.resolve(requiredOption(options, `${name}-cli`));
    const repo = path.join(output, `${name}-repo`);
    const arm = { name, cli, runtimeSha256: runtimeDigest(path.dirname(cli)), setup: [], tasks: [] };
    report.arms.push(arm);
    for (const [step, command, args, cwd] of [
      ["clone", "git", ["clone", "--local", "--no-hardlinks", source, repo], output],
      ["checkout", "git", ["checkout", "--detach", cases.revision], repo],
      ["init", process.execPath, [cli, "init", "--repo", repo, "--json"], repo],
    ]) {
      const result = run(`${name}-${step}`, command, args, cwd);
      arm.setup.push({ step, ...result });
      save();
      requireSuccess(result);
    }
    for (const task of cases.tasks) {
      const result = run(
        `${name}-${task.id}`,
        process.execPath,
        [cli, "pack", task.task, "--repo", repo, "--budget", "8000", "--json"],
        repo,
      );
      let pack = null;
      let parseError = null;
      if (result.exitCode === 0 && !result.error) {
        try {
          pack = JSON.parse(result.stdout);
        } catch (error) {
          parseError = String(error);
        }
      }
      const usable = Boolean(
        pack?.repository?.synchronized && pack?.safety?.safeToUse && pack?.freshness?.safeToUse && !pack?.safety?.override,
      );
      const fileHits = task.expectedFiles.filter((file) => usable && pack.markdown.includes(JSON.stringify(file)));
      const componentHits = task.expectedComponents.filter(
        (component) => usable && pack.evidence.some((item) => item.locator === `component:${component}`),
      );
      arm.tasks.push({
        ...task,
        exitCode: result.exitCode,
        error: result.error ?? parseError,
        usable,
        fileHits,
        componentHits,
        fileRecall: fileHits.length / task.expectedFiles.length,
        componentRecall: componentHits.length / task.expectedComponents.length,
        serializedCharacters: pack ? JSON.stringify(pack).length : null,
        estimatedTokens: pack?.estimatedTokens ?? null,
        withinCharacterBudget: pack ? JSON.stringify(pack).length <= 8000 * 4 : false,
        selection: pack?.selection ?? null,
      });
      save();
      process.stdout.write(
        `${name}/${task.id}: usable=${usable}, files=${fileHits.length}/${task.expectedFiles.length}, components=${componentHits.length}/${task.expectedComponents.length}\n`,
      );
    }
  }
  const candidate = report.arms.find((arm) => arm.name === "candidate");
  report.candidateAcceptancePassed = candidate.tasks.every(
    (task) => task.usable && task.withinCharacterBudget && task.fileRecall === 1 && task.componentRecall === 1,
  );
  if (!report.candidateAcceptancePassed) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
}
