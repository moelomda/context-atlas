import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepository, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("CLI init preview is read-only and status exposes repository identity", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(projectRoot, "dist", "cli.js");

  const preview = runJson(cli, ["init", root, "--dry-run"]);
  assert.equal(preview.operation, "init-preview");
  assert.equal((preview.preview as { trackedProjectFilesModified: boolean }).trackedProjectFilesModified, false);
  assert.ok((preview.preview as { writes: unknown[] }).writes.length >= 4);
  assert.equal(existsSync(path.join(root, ".context-atlas")), false);

  runJson(cli, ["init", root, "--name", "CLI Fixture", "--json"]);
  const status = runJson(cli, ["status", "--repo", root]);
  const repository = status.repository as Record<string, unknown>;
  assert.match(String(repository.repositoryId), /^repo_[a-f0-9]{32}$/);
  assert.equal(repository.objectFormat, "sha1");
  assert.equal(repository.defaultBranch, "main");
  assert.equal(repository.detached, false);
  assert.equal(repository.shallow, false);
  assert.equal((status.health as { checks: unknown[] }).checks.length > 0, true);

  const proposals = runJson(cli, ["proposals", "pending", "--repo", root]) as unknown as Array<{ id: string }>;
  assert.equal(proposals.length, 1);
  assert.throws(() => execFileSync(process.execPath, [cli, "approve", proposals[0]?.id as string, "--repo", root], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  }), /requires an attributed --actor/);
  runJson(cli, ["approve", proposals[0]?.id as string, "--actor", "human:cli-test", "--note", "Reviewed through the packaged command boundary.", "--repo", root]);
  const assertions = runJson(cli, ["assertions", "--predicate", "project.overview", "--repo", root]) as unknown as Array<{ logicalId: string }>;
  assert.equal(assertions.length, 1);
  const history = runJson(cli, ["assertion-history", assertions[0]?.logicalId as string, "--repo", root]);
  assert.match(JSON.stringify(history), /human:cli-test/);
  const packOutput = runText(cli, ["pack", "change billing retries", "--budget", "5000", "--json", "--repo", root]);
  assert.ok(packOutput.length <= 5_000 * 4);
  assert.doesNotMatch(packOutput, /\n\s+"/);
  const pack = JSON.parse(packOutput) as { estimatedTokens: number; policy: { serializedCharacters: number; budgetScope: string } };
  assert.equal(pack.policy.budgetScope, "compact-json");
  assert.equal(pack.policy.serializedCharacters, packOutput.length);
  assert.equal(pack.estimatedTokens, Math.ceil(packOutput.length / 4));

  const savedArchitecture = runJson(cli, ["pack-save", "explain billing architecture", "--budget", "8000", "--repo", root]);
  const architectureSnapshotId = String((savedArchitecture.snapshot as { snapshotId?: string }).snapshotId);
  assert.match(architectureSnapshotId, /^pack_snapshot_[a-f0-9]{64}$/);
  const savedRisks = runJson(cli, ["pack-save", "explain billing risks and tests", "--budget", "8000", "--repo", root]);
  const risksSnapshotId = String((savedRisks.snapshot as { snapshotId?: string }).snapshotId);
  const packHistory = runJson(cli, ["pack-history", "--limit", "10", "--repo", root]);
  assert.equal(packHistory.count, 2);
  const packDiff = runJson(cli, ["pack-diff", architectureSnapshotId, risksSnapshotId, "--repo", root]);
  assert.equal(packDiff.changed, true);
  assert.equal((packDiff.changes as { taskChanged?: boolean }).taskChanged, true);
  const refreshedPack = runJson(cli, ["pack-refresh", architectureSnapshotId, "--repo", root]);
  assert.equal(refreshedPack.changed, false);
  assert.throws(() => runText(cli, ["pack-history", "unexpected", "--repo", root]), /exactly 0 positional arguments/);
  assert.throws(() => runText(cli, ["pack-history", "--limit", "--repo", root]), /--limit requires a value/);
  assert.throws(() => runText(cli, ["pack-save", "task", "--budget", "--repo", root]), /--budget requires a value/);

  const privacy = runJson(cli, ["privacy", "--repo", root]);
  assert.equal((privacy.egress as { remoteProviderCapability: string }).remoteProviderCapability, "not-implemented");

  const exportsRoot = path.join(root, ".context-atlas", "exports");
  const disposableExport = path.join(exportsRoot, "cli-retention-fixture.json");
  mkdirSync(exportsRoot, { recursive: true });
  writeFileSync(disposableExport, "{}\n", { encoding: "utf8", mode: 0o600 });
  const retentionPreview = runJson(cli, ["retention-preview", "--exports-days", "0", "--repo", root]);
  assert.match(String(retentionPreview.planId), /^[a-f0-9]{64}$/);
  assert.equal(existsSync(disposableExport), true);
  assert.throws(() => runText(cli, [
    "retention-apply", "--exports-days", "0", "--plan", String(retentionPreview.planId),
    "--actor", "human:cli-test", "--reason", "Delete the disposable CLI retention fixture after review.",
    "--confirm", "APPLY", "--dry-run", "--repo", root,
  ]), /does not accept --dry-run/);
  assert.equal(existsSync(disposableExport), true);
  assert.throws(() => runText(cli, [
    "retention-apply", "--exports-days", "0", "--plan", String(retentionPreview.planId),
    "--actor", "human:cli-test", "--reason", "Delete the disposable CLI retention fixture after review.", "--repo", root,
  ]), /--confirm APPLY/);
  const retention = runJson(cli, [
    "retention-apply", "--exports-days", "0", "--plan", String(retentionPreview.planId),
    "--actor", "human:cli-test", "--reason", "Delete the disposable CLI retention fixture after review.",
    "--confirm", "APPLY", "--repo", root,
  ]);
  assert.equal(retention.status, "completed");
  assert.equal(existsSync(disposableExport), false);
  const retentionHistory = runJson(cli, ["retention-history", "--repo", root]);
  assert.equal((retentionHistory.tombstones as Array<{ status: string }>)[0]?.status, "completed");
});

function runJson(cli: string, args: string[]): Record<string, unknown> {
  return JSON.parse(runText(cli, args)) as Record<string, unknown>;
}

function runText(cli: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}
