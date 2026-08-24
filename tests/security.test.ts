import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { assertInside } from "../src/core/util.js";
import { findSecrets, isSensitivePath, redactSecrets, sanitizeText } from "../src/core/security.js";
import { loadAtlasIgnore } from "../src/core/ignore.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";
import { readFileSync, writeFileSync } from "node:fs";
import { initializeConfig, loadConfig } from "../src/core/config.js";
import { getTimeline, searchAtlas } from "../src/core/query.js";
import { buildContextPack } from "../src/core/context-pack.js";

test("secret-like values are detected and redacted", () => {
  const value = "token=sk-abcdefghijklmnopqrstuvwxyz123456";
  const findings = findSecrets(value);
  assert.ok(findings.length >= 1);
  const redacted = redactSecrets(value).value;
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(redacted, /REDACTED/);
  assert.equal(sanitizeText(value).sensitive, true);
});

test("sensitive paths are withheld", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/credentials.json"), true);
  assert.equal(isSensitivePath("certs/server.pem"), true);
  assert.equal(isSensitivePath("src/index.ts"), false);
});

test("repository path containment rejects traversal", () => {
  const root = path.resolve("safe-root");
  assert.throws(() => assertInside(root, path.join(root, "..", "outside.txt")), /escapes repository root/);
});

test(".atlasignore applies ordered local-only glob rules", () => {
  const root = createFixtureRepository();
  try {
    writeFileSync(path.join(root, ".atlasignore"), "generated/**\n*.snapshot\n!important.snapshot\n");
    const ignore = loadAtlasIgnore(root);
    assert.equal(ignore.matches("generated/cache/value.json"), true);
    assert.equal(ignore.matches("src/example.snapshot"), true);
    assert.equal(ignore.matches("important.snapshot"), false);
    assert.equal(ignore.matches("src/index.ts"), false);
    assert.ok(ignore.hash);
  } finally {
    removeFixture(root);
  }
});

test("repository exclusions withhold Git-history paths from timeline, search, and packs", () => {
  const root = createFixtureRepository();
  try {
    writeFileSync(path.join(root, ".atlasignore"), "private/**\n", "utf8");
    commitFile(root, "private/client-list.csv", "CUSTOMER-CANARY\n", "Add restricted dataset");
    initializeFixture(root);

    const timeline = getTimeline(root);
    const search = searchAtlas(root, "private/client-list.csv", 20);
    const pack = buildContextPack(root, "Review the latest restricted dataset change", 8_000);
    const serialized = JSON.stringify({ timeline, search, pack });

    assert.doesNotMatch(serialized, /private[\\/]client-list\.csv/i);
    assert.doesNotMatch(serialized, /CUSTOMER-CANARY/);
    assert.match(serialized, /withheld:[a-f0-9]{10}/);
    assert.equal(
      search.results.some((result) => /private[\\/]client-list\.csv|CUSTOMER-CANARY/i.test(JSON.stringify(result))),
      false,
    );
  } finally {
    removeFixture(root);
  }
});

test("unsafe scan limits in local configuration are rejected", () => {
  const root = createFixtureRepository();
  try {
    initializeConfig(root, "Unsafe Limits Fixture");
    const filePath = path.join(root, ".context-atlas", "config.json");
    const config = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    writeFileSync(filePath, JSON.stringify({ ...config, maxFiles: 50_000_000 }, null, 2));
    assert.throws(() => loadConfig(root), /maxFiles/);
  } finally {
    removeFixture(root);
  }
});
