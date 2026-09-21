import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { buildContextPack } from "../src/core/context-pack.js";
import { AtlasDatabase } from "../src/core/database.js";
import { matchingComponentFiles, taskRelevance } from "../src/core/task-relevance.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

test("task matching separates identifiers and paths without substring false positives", () => {
  assert.equal(taskRelevance("Git history", ".github/workflows"), 0);
  assert.ok(taskRelevance("history extraction", "extractHistory") > 0);
  assert.ok(taskRelevance("session_expiry", "session-expiry.test.ts") > 0);
  assert.equal(taskRelevance("the code", "the code"), 0);
  assert.deepEqual(matchingComponentFiles("git", undefined), []);
  assert.deepEqual(
    matchingComponentFiles("git", [".github/workflows/ci.yml", "tests/git.test.ts", "src/core/git.ts", "src/core/git.ts", null]).map(
      (file) => file.path,
    ),
    ["src/core/git.ts", "tests/git.test.ts"],
  );
});

test("default pack selects implementation and tests ahead of broad unrelated components", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  const files: Record<string, string> = {
    "src/core/git.ts": "export const extractHistory = () => [];\n",
    "tests/git-history.test.ts": "// Test rename and merge history.\n",
    ".github/workflows/check.yml": "name: checks\n",
    "src/private/git-credentials.ts": "export const localOnly = true;\n",
    "src/core/git-sk-seeded-filename-secret-1234567890.ts": "export const localOnly = true;\n",
    ".atlasignore": "src/private/\n",
    "CONTRIBUTING.md": "# Contributing\n\nUse Git branches when changing history extraction.\n",
  };
  for (let index = 0; index < 12; index += 1) {
    files[`modules/module-${index}/index.ts`] = "export const unrelated = true;\n";
  }
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-C", root, "add", "."], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "Add modules and checks"], { windowsHide: true, stdio: "ignore" });
  initializeFixture(root);

  const pack = buildContextPack(root, "Bound Git history extraction without losing rename or merge behavior", 8_000);
  const database = new AtlasDatabase(root);
  const entities = database.listEntities();
  const selected = entities.filter((entity) => pack.selection.includedEntityIds.includes(entity.id));
  database.close();
  assert.doesNotMatch(JSON.stringify(entities), /sk-seeded-filename-secret/);
  assert.ok(selected.some((entity) => entity.payload.path === "src/core"));
  const tests = selected.find((entity) => entity.payload.path === "tests");
  assert.ok(tests);
  assert.ok(pack.sections.find((section) => section.id === "tests")?.includedItemIds.includes(tests.id));
  assert.match(pack.markdown, /"src\/core\/git\.ts"/);
  assert.match(pack.markdown, /"tests\/git-history\.test\.ts"/);
  assert.doesNotMatch(JSON.stringify(pack), /git-credentials|src\/private|sk-seeded-filename-secret/);
  assert.equal(pack.safety.override, null);
  assert.equal(pack.repository.synchronized, true);
  assert.ok(JSON.stringify(pack).length <= 8_000 * 4);
  assert.deepEqual(pack.sections.find((section) => section.id === "exclusions")?.includedItemIds, []);
  for (const exclusion of pack.selection.exclusions) {
    assert.ok(pack.markdown.includes(`${exclusion.kind}:${exclusion.id} -> ${exclusion.reason}`));
  }

  const billing = buildContextPack(root, "Change billing", 8_000);
  assert.match(billing.markdown, /"src\/payments\/billing\.ts"/);
  assert.notEqual(billing.selection.selectionHash, pack.selection.selectionHash);
});
