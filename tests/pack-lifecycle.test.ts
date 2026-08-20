import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { syncRepository } from "../src/core/ingest.js";
import {
  MAX_CONTEXT_PACK_HISTORY,
  diffContextPackSnapshots,
  listContextPackHistory,
  readContextPackSnapshot,
  refreshContextPack,
  saveContextPack,
} from "../src/core/pack-lifecycle.js";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { commitFile, createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

function createReviewedFixture(): string {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(
    root,
    listProposals(root, "pending")[0]?.id as string,
    "Reviewed before exercising durable context-pack lifecycle behavior.",
    "human:pack-lifecycle",
  );
  return root;
}

test("pack saves are immutable, content-addressed, idempotent, and bounded on read", () => {
  const root = createReviewedFixture();
  const atlasIgnore = path.join(root, ".context-atlas", ".gitignore");
  const legacyIgnore = readFileSync(atlasIgnore, "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "packs/")
    .join("\n");
  writeFileSync(atlasIgnore, legacyIgnore.endsWith("\n") ? legacyIgnore : `${legacyIgnore}\n`, "utf8");
  assert.doesNotMatch(readFileSync(atlasIgnore, "utf8"), /^packs\/$/m);
  const first = saveContextPack(root, "Explain the billing architecture and its decisions", { tokenBudget: 8_000 });
  assert.equal(first.stored, true);
  assert.match(readFileSync(atlasIgnore, "utf8"), /^packs\/$/m);
  assert.match(first.snapshot.snapshotId, /^pack_snapshot_[a-f0-9]{64}$/);
  assert.equal(first.snapshot.snapshotId, `pack_snapshot_${first.snapshot.snapshotHash}`);
  assert.equal(first.snapshot.metadata.task.text, "Explain the billing architecture and its decisions");
  assert.equal(first.snapshot.metadata.repository.head, first.snapshot.pack.repository.head);
  assert.deepEqual(first.snapshot.metadata.policy.contextPack, first.snapshot.pack.policy);
  assert.equal(Object.isFrozen(first.snapshot), true);

  const snapshotFile = path.join(root, ".context-atlas", "packs", `${first.snapshot.snapshotId}.json`);
  const beforeBytes = readFileSync(snapshotFile, "utf8");
  const beforeModified = statSync(snapshotFile).mtimeMs;
  const repeated = saveContextPack(root, "Explain the billing architecture and its decisions", { tokenBudget: 8_000 });
  assert.equal(repeated.stored, false);
  assert.equal(repeated.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal(readFileSync(snapshotFile, "utf8"), beforeBytes);
  assert.equal(statSync(snapshotFile).mtimeMs, beforeModified);
  assert.equal(listContextPackHistory(root).totalCount, 1);
  assert.equal(listContextPackHistory(root, { limit: 1 }).count, 1);
  assert.throws(
    () => listContextPackHistory(root, { limit: MAX_CONTEXT_PACK_HISTORY + 1 }),
    /history limit must be an integer/,
  );

  const second = saveContextPack(root, "Explain tests and operational risks", { tokenBudget: 8_000 });
  assert.equal(second.stored, true);
  const diff = diffContextPackSnapshots(root, first.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.equal(diff.changed, true);
  assert.equal(diff.changes.taskChanged, true);
  assert.equal(diff.changes.packIdChanged, true);
  assert.equal(listContextPackHistory(root, { limit: 1 }).totalCount, 2);
  assert.equal(listContextPackHistory(root, { limit: 1 }).count, 1);

  // Every accepted envelope field is covered by the content address. An
  // extension cannot ride beside the hashed unsigned material unnoticed.
  chmodSync(snapshotFile, 0o600);
  const extended = JSON.parse(beforeBytes) as Record<string, unknown>;
  extended.unhashedExtension = "must-be-rejected";
  writeFileSync(snapshotFile, `${JSON.stringify(extended, null, 2)}\n`, "utf8");
  assert.throws(
    () => readContextPackSnapshot(root, first.snapshot.snapshotId),
    /unexpected or missing lifecycle envelope fields/,
  );

  // A corrupt file at an immutable address is never repaired by overwrite.
  writeFileSync(snapshotFile, "{}\n", "utf8");
  assert.throws(
    () => saveContextPack(root, "Explain the billing architecture and its decisions", { tokenBudget: 8_000 }),
    /unexpected or missing lifecycle envelope fields/,
  );
  assert.equal(readFileSync(snapshotFile, "utf8"), "{}\n");
});

test("refresh compares a stale historical pack with newly reviewed repository state", () => {
  const root = createReviewedFixture();
  const original = saveContextPack(root, "Explain current billing behavior", {
    tokenBudget: 8_000,
    transportCharacterReserve: 256,
  });
  const originalHead = original.snapshot.metadata.repository.head;

  const unchanged = refreshContextPack(root, original.snapshot.snapshotId);
  assert.equal(unchanged.stored, false);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.snapshot.snapshotId, original.snapshot.snapshotId);
  assert.equal(unchanged.snapshot.pack.policy.reservedTransportCharacters, 256);

  commitFile(root, "src/payments/retry.ts", "export const retryLimit = 3;\n", "Add bounded billing retries");
  syncRepository(root);
  for (const proposal of listProposals(root, "pending")) {
    approveProposal(
      root,
      proposal.id,
      "Reviewed the changed repository before refreshing its durable context pack.",
      "human:pack-lifecycle",
    );
  }

  const refreshed = refreshContextPack(root, original.snapshot.snapshotId);
  assert.equal(refreshed.stored, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.previousSnapshotId, original.snapshot.snapshotId);
  assert.notEqual(refreshed.snapshot.snapshotId, original.snapshot.snapshotId);
  assert.notEqual(refreshed.snapshot.metadata.repository.head, originalHead);
  assert.equal(refreshed.snapshot.pack.policy.reservedTransportCharacters, 256);
  assert.ok(refreshed.diff.changes.repositoryFields.includes("head"));
  assert.ok(refreshed.diff.changes.metadataFields.includes("repository.head"));
  assert.equal(refreshed.diff.changes.semanticHashChanged, true);
  assert.equal(refreshed.diff.right.snapshotId, refreshed.snapshot.snapshotId);
  assert.equal(listContextPackHistory(root).totalCount, 2);
});

test("a blocked refresh never persists a snapshot", () => {
  const root = createReviewedFixture();
  const original = saveContextPack(root, "Explain the current project state", { tokenBudget: 8_000 });
  const ledgerPath = path.join(root, ".context-atlas", "ledger.ndjson");
  appendFileSync(ledgerPath, "{\"tampered\":true}\n", "utf8");

  assert.throws(
    () => refreshContextPack(root, original.snapshot.snapshotId),
    /blocked|integrity|ledger/i,
  );
  const history = listContextPackHistory(root);
  assert.equal(history.totalCount, 1);
  assert.equal(history.snapshots[0]?.snapshotId, original.snapshot.snapshotId);
});

test("snapshot identifiers refuse traversal and pack storage refuses symlinks", (context) => {
  const root = createReviewedFixture();
  assert.throws(
    () => readContextPackSnapshot(root, "../pack_snapshot_" + "a".repeat(64)),
    /Invalid context-pack snapshot identifier/,
  );
  assert.throws(
    () => diffContextPackSnapshots(root, "..\\escape", `pack_snapshot_${"a".repeat(64)}`),
    /Invalid context-pack snapshot identifier/,
  );

  const target = path.join(root, ".context-atlas", "pack-target");
  const link = path.join(root, ".context-atlas", "packs");
  mkdirSync(target);
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
      context.skip(`This filesystem does not permit test symlinks (${code}).`);
      return;
    }
    throw error;
  }
  assert.throws(
    () => saveContextPack(root, "Explain billing architecture", { tokenBudget: 8_000 }),
    /symbolic link/,
  );
  assert.deepEqual(readdirSync(target), []);
});

test("pack storage refuses a hard-linked ignore file before writing through the alias", (context) => {
  const root = createReviewedFixture();
  const outsideDirectory = `${root}-pack-hardlink-target`;
  mkdirSync(outsideDirectory);
  fixtures.push(outsideDirectory);
  const outsideTarget = path.join(outsideDirectory, "operator-managed-ignore.txt");
  const ignorePath = path.join(root, ".context-atlas", ".gitignore");
  const original = readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "packs/")
    .join("\n");
  writeFileSync(outsideTarget, original.endsWith("\n") ? original : `${original}\n`, "utf8");
  unlinkSync(ignorePath);
  try {
    linkSync(outsideTarget, ignorePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(code)) {
      context.skip(`This filesystem does not permit the hard-link test (${code}).`);
      return;
    }
    throw error;
  }
  const before = readFileSync(outsideTarget, "utf8");
  assert.throws(
    () => saveContextPack(root, "Explain billing architecture", { tokenBudget: 8_000 }),
    /multiple hard links/,
  );
  assert.equal(readFileSync(outsideTarget, "utf8"), before);
  assert.doesNotMatch(before, /^packs\/$/m);
});

test("saved snapshots contain neither repository absolute paths nor secrets", () => {
  const root = createReviewedFixture();
  const saved = saveContextPack(root, "Explain the project without private material", { tokenBudget: 8_000 });
  const snapshotFile = path.join(root, ".context-atlas", "packs", `${saved.snapshot.snapshotId}.json`);
  const bytes = readFileSync(snapshotFile, "utf8");
  assert.doesNotMatch(bytes, /sk-this-must-never-enter-context-storage/);
  assert.equal(bytes.toLowerCase().includes(root.toLowerCase()), false);
  assert.equal(bytes.toLowerCase().includes(root.replaceAll("\\", "/").toLowerCase()), false);

  assert.throws(
    () => saveContextPack(root, `Explain files under ${root}`, { tokenBudget: 8_000 }),
    /absolute local filesystem path/,
  );
  assert.throws(
    () => saveContextPack(root, "Explain files under /srv/private/context-atlas", { tokenBudget: 8_000 }),
    /absolute local filesystem path/,
  );
  assert.throws(
    () => saveContextPack(root, "Explain files under /nix/store/private-context", { tokenBudget: 8_000 }),
    /absolute local filesystem path/,
  );
  assert.throws(
    () => saveContextPack(root, "Use sk-abcdefghijklmnopqrstuvwxyz123456 while explaining billing", { tokenBudget: 8_000 }),
    /sensitive data|secret-shaped material/,
  );
  assert.equal(listContextPackHistory(root).totalCount, 1);
});
