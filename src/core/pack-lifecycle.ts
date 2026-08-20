import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { atlasDirectory, getCurrentGuidanceWatermark, loadConfig, type GuidanceDependencyWatermark } from "./config.js";
import { buildContextPack, type ContextPackBuildOptions, type ContextPackWithClaims } from "./context-pack.js";
import { getRepoStatus } from "./git.js";
import { findSecrets } from "./security.js";
import type { RepoStatus } from "./types.js";
import { sha256, stableStringify } from "./util.js";

export const CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const MAX_CONTEXT_PACK_HISTORY = 256;
const DEFAULT_HISTORY_LIMIT = 25;
const MAX_PACK_DIRECTORY_ENTRIES = 1_024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_PACK_IGNORE_BYTES = 1024 * 1024;
const SNAPSHOT_PREFIX = "pack_snapshot_";
const SNAPSHOT_ID_PATTERN = /^pack_snapshot_[a-f0-9]{64}$/;
const PACK_IGNORE_RULE = "packs/";
const POSIX_FILESYSTEM_ROOTS = "(?:Applications|Library|Network|System|Users|Volumes|app|bin|boot|builds|code|data|dev|etc|github|home|lib|lib64|media|mnt|nix|opt|private|proc|project|repo|root|run|runner|sbin|snap|source|src|srv|sys|tmp|usr|var|workspace|workspaces)";
const POSIX_ABSOLUTE_PATH = new RegExp(`^/${POSIX_FILESYSTEM_ROOTS}(?:/|$)`, "i");
const EMBEDDED_POSIX_ABSOLUTE_PATH = new RegExp(`(?:^|[^a-zA-Z0-9])/${POSIX_FILESYSTEM_ROOTS}(?:/|\\b)`, "im");

export interface PackRepositoryMetadata {
  repositoryId: string;
  objectFormat: RepoStatus["objectFormat"];
  defaultBranch: string | null;
  branch: string;
  head: string | null;
  indexedHead: string | null;
  detached: boolean;
  dirty: boolean;
  changedFiles: number;
  workingTreeFingerprint: string;
  synchronized: boolean;
  shallow: boolean;
  reachableCommits: number;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  sparseCheckout: boolean;
  submoduleCount: number;
  lfsTracked: boolean;
}

export interface PackSnapshotMetadata {
  task: {
    text: string;
    digest: string;
  };
  repository: PackRepositoryMetadata;
  policy: {
    contextPack: ContextPackWithClaims["policy"];
    guidance: GuidanceDependencyWatermark;
    overrideId: string | null;
  };
  identity: {
    packId: string;
    packContentHash: string;
    selectionHash: string;
    tokenBudget: number;
  };
}

export interface ContextPackSnapshot {
  schemaVersion: typeof CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  snapshotHash: string;
  semanticHash: string;
  savedAt: string;
  metadata: PackSnapshotMetadata;
  pack: ContextPackWithClaims;
}

export interface ContextPackSnapshotSummary {
  schemaVersion: typeof CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  snapshotHash: string;
  semanticHash: string;
  savedAt: string;
  packId: string;
  packContentHash: string;
  task: string;
  taskDigest: string;
  repository: PackRepositoryMetadata;
  policy: PackSnapshotMetadata["policy"];
  freshness: ContextPackWithClaims["freshness"];
  selectionHash: string;
}

export interface SaveContextPackOptions extends ContextPackBuildOptions {
  tokenBudget?: number;
}

export interface SaveContextPackResult {
  stored: boolean;
  snapshot: ContextPackSnapshot;
  summary: ContextPackSnapshotSummary;
}

export interface ContextPackHistory {
  schemaVersion: typeof CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION;
  limit: number;
  retainedLimit: number;
  totalCount: number;
  count: number;
  snapshots: ContextPackSnapshotSummary[];
}

export interface IdentifierChanges {
  added: string[];
  removed: string[];
  retained: string[];
}

export interface ContextPackDiff {
  schemaVersion: typeof CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION;
  left: ContextPackSnapshotSummary;
  right: ContextPackSnapshotSummary;
  changed: boolean;
  changes: {
    taskChanged: boolean;
    semanticHashChanged: boolean;
    packIdChanged: boolean;
    contentHashChanged: boolean;
    selectionHashChanged: boolean;
    repositoryFields: string[];
    policyFields: string[];
    freshnessFields: string[];
    metadataFields: string[];
    packFields: string[];
    sections: IdentifierChanges;
    changedSections: string[];
    entities: IdentifierChanges;
    relationships: IdentifierChanges;
    assertions: IdentifierChanges;
    events: IdentifierChanges;
    evidence: IdentifierChanges;
    warnings: IdentifierChanges;
  };
}

export interface RefreshContextPackResult extends SaveContextPackResult {
  previousSnapshotId: string;
  changed: boolean;
  diff: ContextPackDiff;
}

/**
 * Builds a valid navigation pack before touching lifecycle storage, then saves
 * it as an immutable, content-addressed local snapshot. A blocked or unsafe
 * pack therefore cannot create even an empty packs directory.
 */
export function saveContextPack(
  start: string,
  task: string,
  options: SaveContextPackOptions = {},
): SaveContextPackResult {
  const { root } = loadConfig(start);
  const material = buildPreparedSnapshot(root, task, options.tokenBudget, buildOptions(options));
  return persistPreparedSnapshot(root, material);
}

/** Lists a bounded, newest-first view without creating or modifying storage. */
export function listContextPackHistory(
  start: string,
  options: { limit?: number } = {},
): ContextPackHistory {
  const { root } = loadConfig(start);
  const limit = validateHistoryLimit(options.limit ?? DEFAULT_HISTORY_LIMIT);
  const packsRoot = resolvePacksDirectory(root, false);
  const retained = packsRoot ? readAllSnapshots(root, packsRoot) : [];
  const snapshots = retained.slice(0, limit);
  return {
    schemaVersion: CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION,
    limit,
    retainedLimit: MAX_CONTEXT_PACK_HISTORY,
    totalCount: retained.length,
    count: snapshots.length,
    snapshots: snapshots.map(summarizeContextPackSnapshot),
  };
}

/** Reads and verifies one immutable snapshot; the identifier is never a path. */
export function readContextPackSnapshot(start: string, snapshotId: string): ContextPackSnapshot {
  const { root } = loadConfig(start);
  assertSnapshotId(snapshotId);
  const packsRoot = resolvePacksDirectory(root, false);
  if (!packsRoot) throw new Error(`Unknown context-pack snapshot: ${snapshotId}`);
  return readSnapshotFile(root, packsRoot, snapshotId);
}

/** Produces a read-only structural diff of two verified local snapshots. */
export function diffContextPackSnapshots(start: string, leftId: string, rightId: string): ContextPackDiff {
  const left = readContextPackSnapshot(start, leftId);
  const right = readContextPackSnapshot(start, rightId);
  return diffSnapshots(left, right);
}

/**
 * Rebuilds the original task and budget against current repository state. The
 * old override is deliberately not inherited: any critical state requires a
 * newly explicit --override. Persistence occurs only after the builder and all
 * snapshot invariants succeed.
 */
export function refreshContextPack(
  start: string,
  snapshotId: string,
  options: ContextPackBuildOptions = {},
): RefreshContextPackResult {
  const { root } = loadConfig(start);
  const previous = readContextPackSnapshot(root, snapshotId);
  const currentRepository = getRepoStatus(root);
  if (currentRepository.repositoryId !== previous.metadata.repository.repositoryId) {
    throw new Error("Refusing to refresh a context-pack snapshot that belongs to a different repository identity.");
  }
  const refreshOptions: ContextPackBuildOptions = {
    ...(options.overrideId ? { overrideId: options.overrideId } : {}),
    transportCharacterReserve: options.transportCharacterReserve
      ?? previous.pack.policy.reservedTransportCharacters,
  };
  const prepared = buildPreparedSnapshot(
    root,
    previous.metadata.task.text,
    previous.pack.tokenBudget,
    refreshOptions,
  );
  if (prepared.metadata.repository.repositoryId !== previous.metadata.repository.repositoryId) {
    throw new Error("Refusing to refresh a context-pack snapshot after the repository identity changed during the rebuild.");
  }
  const preparedDiff = diffSnapshots(previous, prepared);
  const saved = persistPreparedSnapshot(root, prepared);
  const diff = saved.snapshot.snapshotId === prepared.snapshotId
    ? preparedDiff
    : diffSnapshots(previous, saved.snapshot);
  return {
    ...saved,
    previousSnapshotId: previous.snapshotId,
    changed: diff.changed,
    diff,
  };
}

export function summarizeContextPackSnapshot(snapshot: ContextPackSnapshot): ContextPackSnapshotSummary {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    semanticHash: snapshot.semanticHash,
    savedAt: snapshot.savedAt,
    packId: snapshot.pack.packId,
    packContentHash: snapshot.pack.contentHash,
    task: snapshot.metadata.task.text,
    taskDigest: snapshot.metadata.task.digest,
    repository: snapshot.metadata.repository,
    policy: snapshot.metadata.policy,
    freshness: snapshot.pack.freshness,
    selectionHash: snapshot.pack.selection.selectionHash,
  };
}

interface UnsignedSnapshot {
  schemaVersion: typeof CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION;
  semanticHash: string;
  savedAt: string;
  metadata: PackSnapshotMetadata;
  pack: ContextPackWithClaims;
}

function buildPreparedSnapshot(
  root: string,
  task: string,
  tokenBudget: number | undefined,
  options: ContextPackBuildOptions,
): ContextPackSnapshot {
  const repositoryBefore = getRepoStatus(root);
  const guidanceBefore = getCurrentGuidanceWatermark(root);
  const pack = buildContextPack(root, task, tokenBudget, options);
  const repositoryAfter = getRepoStatus(root);
  const guidanceAfter = getCurrentGuidanceWatermark(root);
  if (stableStringify(repositoryBefore) !== stableStringify(repositoryAfter)) {
    throw new Error(
      "Repository state changed while the context pack was being built; retry the save against a stable HEAD, branch, and worktree.",
    );
  }
  if (stableStringify(guidanceBefore) !== stableStringify(guidanceAfter)) {
    throw new Error(
      "Context guidance policy changed while the context pack was being built; retry the save against a stable configuration and ignore policy.",
    );
  }
  return prepareSnapshotMaterial(root, pack, repositoryAfter, guidanceAfter);
}

function prepareSnapshotMaterial(
  root: string,
  pack: ContextPackWithClaims,
  repository: RepoStatus,
  guidance: GuidanceDependencyWatermark,
): ContextPackSnapshot {
  assertPersistablePack(root, pack);
  if (repository.head !== pack.repository.head || repository.branch !== pack.repository.branch) {
    throw new Error("Repository HEAD or branch changed while the context pack was being built; retry the save against a stable repository snapshot.");
  }
  const metadataBase: PackSnapshotMetadata = {
    task: {
      text: pack.task,
      digest: sha256(pack.task),
    },
    repository: safeRepositoryMetadata(repository, pack),
    policy: {
      contextPack: pack.policy,
      guidance,
      overrideId: pack.safety.override?.id ?? null,
    },
    identity: {
      packId: pack.packId,
      packContentHash: pack.contentHash,
      selectionHash: pack.selection.selectionHash,
      tokenBudget: pack.tokenBudget,
    },
  };
  const semanticHash = computeSemanticHash(pack, metadataBase);
  const unsigned: UnsignedSnapshot = {
    schemaVersion: CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION,
    semanticHash,
    savedAt: pack.generatedAt,
    metadata: metadataBase,
    pack,
  };
  const snapshotHash = sha256(stableStringify(unsigned));
  const snapshot: ContextPackSnapshot = {
    ...unsigned,
    snapshotId: `${SNAPSHOT_PREFIX}${snapshotHash}`,
    snapshotHash,
  };
  assertNoPrivateMaterial(root, snapshot);
  const bytes = Buffer.byteLength(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Context-pack snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte lifecycle storage limit.`);
  }
  return snapshot;
}

function persistPreparedSnapshot(root: string, prepared: ContextPackSnapshot): SaveContextPackResult {
  // The ignore rule must be durable before the directory, lock, or temporary
  // file can exist. This ordering protects initialized stores created by older
  // versions that did not include packs/ in their default local ignore rules.
  ensurePackStorageIgnored(root);
  const packsRoot = resolvePacksDirectory(root, true) as string;
  return withStorageLock(root, packsRoot, () => {
    const existing = readAllSnapshots(root, packsRoot);
    const semanticMatch = existing.find((item) => item.semanticHash === prepared.semanticHash);
    if (semanticMatch) {
      if (stableStringify(semanticMaterial(semanticMatch.pack, semanticMatch.metadata))
        !== stableStringify(semanticMaterial(prepared.pack, prepared.metadata))) {
        throw new Error(`Context-pack semantic hash collision detected for ${prepared.semanticHash}.`);
      }
      return {
        stored: false,
        snapshot: semanticMatch,
        summary: summarizeContextPackSnapshot(semanticMatch),
      };
    }

    const finalPath = snapshotPath(packsRoot, prepared.snapshotId);
    if (existsSync(finalPath)) {
      const exact = readSnapshotFile(root, packsRoot, prepared.snapshotId);
      if (stableStringify(exact) !== stableStringify(prepared)) {
        throw new Error(`Refusing to replace immutable context-pack snapshot ${prepared.snapshotId}.`);
      }
      return { stored: false, snapshot: exact, summary: summarizeContextPackSnapshot(exact) };
    }
    if (existing.length >= MAX_CONTEXT_PACK_HISTORY) {
      throw new Error(
        `Context-pack history already retains the immutable limit of ${MAX_CONTEXT_PACK_HISTORY} snapshots. `
        + "No snapshot was deleted or written. This alpha has no automated pack-retention action; archive or remove a verified snapshot only through a separately audited operator workflow.",
      );
    }
    atomicCreateSnapshot(root, packsRoot, prepared);
    const written = readSnapshotFile(root, packsRoot, prepared.snapshotId);
    return { stored: true, snapshot: written, summary: summarizeContextPackSnapshot(written) };
  });
}

function safeRepositoryMetadata(repository: RepoStatus, pack: ContextPackWithClaims): PackRepositoryMetadata {
  return {
    repositoryId: repository.repositoryId,
    objectFormat: repository.objectFormat,
    defaultBranch: repository.defaultBranch,
    branch: repository.branch,
    head: repository.head,
    indexedHead: pack.repository.indexedHead,
    detached: repository.detached,
    dirty: repository.dirty,
    changedFiles: repository.changedFiles,
    workingTreeFingerprint: repository.workingTreeFingerprint,
    synchronized: pack.repository.synchronized,
    shallow: repository.shallow,
    reachableCommits: repository.reachableCommits,
    mergeInProgress: repository.mergeInProgress,
    rebaseInProgress: repository.rebaseInProgress,
    sparseCheckout: repository.sparseCheckout,
    submoduleCount: repository.submoduleCount,
    lfsTracked: repository.lfsTracked,
  };
}

function buildOptions(options: SaveContextPackOptions): ContextPackBuildOptions {
  return {
    ...(options.overrideId ? { overrideId: options.overrideId } : {}),
    ...(options.transportCharacterReserve !== undefined
      ? { transportCharacterReserve: options.transportCharacterReserve }
      : {}),
  };
}

function assertPersistablePack(root: string, pack: ContextPackWithClaims): void {
  if (!pack.safety.safeToUse) throw new Error("Blocked or unsafe context packs cannot be persisted.");
  if (pack.safety.scope !== "navigation-only" || pack.safety.notProofOfCorrectness !== true) {
    throw new Error("Context-pack safety contract is invalid; refusing lifecycle persistence.");
  }
  if (!/^pack_[a-f0-9]{24}$/.test(pack.packId)
    || !/^[a-f0-9]{64}$/.test(pack.contentHash)
    || !/^[a-f0-9]{64}$/.test(pack.selection.selectionHash)) {
    throw new Error("Context-pack identity hashes are invalid; refusing lifecycle persistence.");
  }
  if (!Number.isFinite(Date.parse(pack.generatedAt))) {
    throw new Error("Context-pack generation timestamp is invalid; refusing lifecycle persistence.");
  }
  assertNoPrivateMaterial(root, pack);
}

function computeSemanticHash(pack: ContextPackWithClaims, metadata: PackSnapshotMetadata): string {
  return sha256(stableStringify(semanticMaterial(pack, metadata)));
}

function semanticMaterial(pack: ContextPackWithClaims, metadata: PackSnapshotMetadata): unknown {
  return { metadata, pack: normalizedPackForSemanticDiff(pack) };
}

function readAllSnapshots(root: string, packsRoot: string): ContextPackSnapshot[] {
  assertSafeDirectory(root, packsRoot, "Context Atlas packs directory");
  const entries = readdirSync(packsRoot, { withFileTypes: true });
  if (entries.length > MAX_PACK_DIRECTORY_ENTRIES) {
    throw new Error(`Context-pack storage has more than ${MAX_PACK_DIRECTORY_ENTRIES} entries; refusing an unbounded directory scan.`);
  }
  const snapshots: ContextPackSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(SNAPSHOT_PREFIX) || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    assertSnapshotId(id);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Refusing non-regular context-pack snapshot entry: ${entry.name}`);
    }
    snapshots.push(readSnapshotFile(root, packsRoot, id));
  }
  if (snapshots.length > MAX_CONTEXT_PACK_HISTORY) {
    throw new Error(
      `Context-pack storage contains ${snapshots.length} snapshots, exceeding the immutable retained limit of ${MAX_CONTEXT_PACK_HISTORY}. `
      + "Refusing to silently truncate or delete history.",
    );
  }
  return snapshots.sort((left, right) => right.savedAt.localeCompare(left.savedAt)
    || right.snapshotId.localeCompare(left.snapshotId));
}

function readSnapshotFile(root: string, packsRoot: string, snapshotId: string): ContextPackSnapshot {
  assertSnapshotId(snapshotId);
  const filePath = snapshotPath(packsRoot, snapshotId);
  const before = assertSafeRegularFile(root, filePath, "context-pack snapshot");
  const descriptor = openSync(filePath, "r");
  let serialized: string;
  try {
    const opened = fstatSync(descriptor);
    const currentPath = assertSafeRegularFile(root, filePath, "context-pack snapshot");
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, currentPath)) {
      throw new Error(`Context-pack snapshot ${snapshotId} changed identity while it was being opened.`);
    }
    if (opened.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`Context-pack snapshot ${snapshotId} exceeds the safe read limit.`);
    }
    serialized = readBoundedDescriptor(descriptor, MAX_SNAPSHOT_BYTES, `Context-pack snapshot ${snapshotId}`);
    const after = fstatSync(descriptor);
    if (!sameFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || after.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`Context-pack snapshot ${snapshotId} changed while it was being read.`);
    }
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`Context-pack snapshot ${snapshotId} is not valid JSON.`);
  }
  const snapshot = validateSnapshotShape(parsed, snapshotId);
  assertNoPrivateMaterial(root, snapshot);
  return deepFreeze(snapshot);
}

function validateSnapshotShape(value: unknown, expectedId: string): ContextPackSnapshot {
  if (!isRecord(value)) throw new Error(`Context-pack snapshot ${expectedId} is not an object.`);
  if (!hasExactKeys(value, [
    "metadata",
    "pack",
    "savedAt",
    "schemaVersion",
    "semanticHash",
    "snapshotHash",
    "snapshotId",
  ])) {
    throw new Error(`Context-pack snapshot ${expectedId} has unexpected or missing lifecycle envelope fields.`);
  }
  const snapshot = value as unknown as ContextPackSnapshot;
  if (snapshot.schemaVersion !== CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION
    || snapshot.snapshotId !== expectedId
    || !SNAPSHOT_ID_PATTERN.test(snapshot.snapshotId)
    || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)
    || !/^[a-f0-9]{64}$/.test(snapshot.semanticHash)
    || !Number.isFinite(Date.parse(snapshot.savedAt))
    || !isRecord(snapshot.metadata)
    || !isRecord(snapshot.pack)) {
    throw new Error(`Context-pack snapshot ${expectedId} has an invalid lifecycle envelope.`);
  }
  const unsigned: UnsignedSnapshot = {
    schemaVersion: snapshot.schemaVersion,
    semanticHash: snapshot.semanticHash,
    savedAt: snapshot.savedAt,
    metadata: snapshot.metadata,
    pack: snapshot.pack,
  };
  const expectedHash = sha256(stableStringify(unsigned));
  if (snapshot.snapshotHash !== expectedHash || snapshot.snapshotId !== `${SNAPSHOT_PREFIX}${expectedHash}`) {
    throw new Error(`Context-pack snapshot ${expectedId} failed its content-addressed integrity check.`);
  }
  validateMetadataCongruence(snapshot);
  const expectedSemanticHash = computeSemanticHash(snapshot.pack, snapshot.metadata);
  if (snapshot.semanticHash !== expectedSemanticHash) {
    throw new Error(`Context-pack snapshot ${expectedId} failed its semantic integrity check.`);
  }
  return snapshot;
}

function validateMetadataCongruence(snapshot: ContextPackSnapshot): void {
  const { metadata, pack } = snapshot;
  if (!isRecord(metadata.task)
    || !isRecord(metadata.repository)
    || !isRecord(metadata.policy)
    || !isRecord(metadata.identity)
    || metadata.task.text !== pack.task
    || metadata.task.digest !== sha256(pack.task)
    || metadata.repository.branch !== pack.repository.branch
    || metadata.repository.head !== pack.repository.head
    || metadata.repository.indexedHead !== pack.repository.indexedHead
    || metadata.repository.synchronized !== pack.repository.synchronized
    || stableStringify(metadata.policy.contextPack) !== stableStringify(pack.policy)
    || metadata.policy.overrideId !== (pack.safety.override?.id ?? null)
    || metadata.identity.packId !== pack.packId
    || metadata.identity.packContentHash !== pack.contentHash
    || metadata.identity.selectionHash !== pack.selection.selectionHash
    || metadata.identity.tokenBudget !== pack.tokenBudget
    || snapshot.savedAt !== pack.generatedAt) {
    throw new Error(`Context-pack snapshot ${snapshot.snapshotId} metadata does not match its immutable pack.`);
  }
  assertPersistablePackMetadata(pack);
}

function assertPersistablePackMetadata(pack: ContextPackWithClaims): void {
  if (pack.safety.safeToUse !== true
    || pack.safety.scope !== "navigation-only"
    || pack.safety.notProofOfCorrectness !== true
    || !/^pack_[a-f0-9]{24}$/.test(pack.packId)
    || !/^[a-f0-9]{64}$/.test(pack.contentHash)
    || !/^[a-f0-9]{64}$/.test(pack.selection.selectionHash)) {
    throw new Error("Stored context pack violates the persistence safety contract.");
  }
}

function atomicCreateSnapshot(root: string, packsRoot: string, snapshot: ContextPackSnapshot): void {
  const finalPath = snapshotPath(packsRoot, snapshot.snapshotId);
  const temporaryPath = path.join(packsRoot, `.${snapshot.snapshotId}.${randomUUID()}.tmp`);
  assertContained(packsRoot, temporaryPath);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try { chmodSync(temporaryPath, 0o400); } catch { /* best effort on non-POSIX filesystems */ }
    // A hard-link publication is atomic and fails if the immutable destination
    // already exists; unlike rename, it cannot silently replace an old file.
    linkSync(temporaryPath, finalPath);
    unlinkSync(temporaryPath);
    fsyncDirectoryBestEffort(packsRoot);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) {
      assertSafeRegularFile(root, temporaryPath, "temporary context-pack snapshot");
      try { chmodSync(temporaryPath, 0o600); } catch { /* best effort */ }
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function resolvePacksDirectory(root: string, create: boolean): string | null {
  const resolvedRoot = path.resolve(root);
  const rootStats = lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Refusing context-pack storage through a non-directory or symbolic-link repository root.");
  }
  const atlasRoot = atlasDirectory(resolvedRoot);
  assertContained(resolvedRoot, atlasRoot);
  assertSafeDirectory(resolvedRoot, atlasRoot, "Context Atlas directory");
  const packsRoot = path.join(atlasRoot, "packs");
  assertContained(atlasRoot, packsRoot);
  if (!existsSync(packsRoot)) {
    if (!create) return null;
    mkdirSync(packsRoot, { mode: 0o700 });
  }
  assertSafeDirectory(resolvedRoot, packsRoot, "Context Atlas packs directory");
  return packsRoot;
}

function ensurePackStorageIgnored(root: string): void {
  const ignorePath = path.join(atlasDirectory(root), ".gitignore");
  const before = assertSafeRegularFile(root, ignorePath, "Context Atlas .gitignore");
  const descriptor = openSync(ignorePath, "a+", 0o600);
  try {
    const opened = fstatSync(descriptor);
    const currentPath = assertSafeRegularFile(root, ignorePath, "Context Atlas .gitignore");
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, currentPath)) {
      throw new Error("Context Atlas .gitignore changed identity while pack storage was being prepared; refusing the update.");
    }
    if (opened.size > MAX_PACK_IGNORE_BYTES) {
      throw new Error(`Context Atlas .gitignore exceeds the ${MAX_PACK_IGNORE_BYTES}-byte safe update limit.`);
    }
    const current = readBoundedDescriptor(
      descriptor,
      MAX_PACK_IGNORE_BYTES,
      "Context Atlas .gitignore",
    );
    const lines = current.replace(/\r\n/g, "\n").split("\n");
    if (lines.includes(PACK_IGNORE_RULE)) return;
    const beforeWrite = fstatSync(descriptor);
    const writePath = assertSafeRegularFile(root, ignorePath, "Context Atlas .gitignore");
    if (!sameFileIdentity(opened, beforeWrite) || !sameFileIdentity(beforeWrite, writePath)) {
      throw new Error("Context Atlas .gitignore changed identity before the pack ignore rule could be written.");
    }
    assertSingleLink(beforeWrite, "Context Atlas .gitignore");
    assertSingleLink(writePath, "Context Atlas .gitignore");
    const prefix = current.length === 0 || /\r?\n$/.test(current) ? "" : "\n";
    writeFileSync(descriptor, `${prefix}${PACK_IGNORE_RULE}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function withStorageLock<T>(root: string, packsRoot: string, operation: () => T): T {
  const lockPath = path.join(packsRoot, ".write.lock");
  assertContained(packsRoot, lockPath);
  const token = `${process.pid}:${randomUUID()}`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "unknown";
    throw new Error(`Context-pack storage is locked by another writer (${code}); retry after that operation completes.`);
  }
  try {
    try {
      writeFileSync(descriptor, `${token}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return operation();
  } finally {
    if (existsSync(lockPath)) {
      assertSafeRegularFile(root, lockPath, "context-pack write lock");
      const storedToken = readFileSync(lockPath, "utf8").trim();
      if (storedToken !== token) {
        throw new Error("Context-pack write lock changed during the operation; refusing to remove an unowned lock.");
      }
      unlinkSync(lockPath);
    }
  }
}

function snapshotPath(packsRoot: string, snapshotId: string): string {
  assertSnapshotId(snapshotId);
  const candidate = path.join(packsRoot, `${snapshotId}.json`);
  assertContained(packsRoot, candidate);
  return candidate;
}

function assertSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("Invalid context-pack snapshot identifier; expected pack_snapshot_<64 lowercase hex characters>.");
  }
}

function assertContained(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (resolvedCandidate === resolvedRoot) return;
    throw new Error(`Context-pack storage path escapes its trusted root: ${candidate}`);
  }
}

function assertSafeDirectory(root: string, candidate: string, label: string): void {
  assertContained(root, candidate);
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing ${label} because it is not a regular directory or is a symbolic link.`);
  }
}

function assertSafeRegularFile(
  root: string,
  candidate: string,
  label: string,
): Stats {
  assertContained(root, candidate);
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Refusing ${label} because it is not a regular file or is a symbolic link.`);
  }
  return stats;
}

function assertSingleLink(stats: Stats, label: string): void {
  if (stats.nlink !== 1) {
    throw new Error(`Refusing ${label} because it has multiple hard links and could alias storage outside its trusted path.`);
  }
}

function sameFileIdentity(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs);
}

function readBoundedDescriptor(descriptor: number, maximumBytes: number, label: string): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
  let total = 0;
  for (;;) {
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) throw new Error(`${label} exceeds the safe read limit of ${maximumBytes} bytes.`);
    const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maximumBytes) throw new Error(`${label} exceeds the safe read limit of ${maximumBytes} bytes.`);
  return Buffer.concat(chunks, total).toString("utf8");
}

function assertNoPrivateMaterial(root: string, value: unknown): void {
  const resolvedRoot = path.resolve(root);
  const rootVariants = new Set([
    resolvedRoot,
    resolvedRoot.replaceAll("\\", "/"),
    resolvedRoot.replaceAll("/", "\\"),
  ].map((item) => item.toLowerCase()));
  walkStrings(value, (text) => {
    if (findSecrets(text).length > 0) {
      throw new Error("Context-pack snapshot contains secret-shaped material and was refused before persistence.");
    }
    const lower = text.toLowerCase();
    if ([...rootVariants].some((variant) => variant.length > 2 && lower.includes(variant))
      || containsAbsoluteFilesystemPath(text)) {
      throw new Error("Context-pack snapshot contains an absolute local filesystem path and was refused before persistence.");
    }
  });
}

function containsAbsoluteFilesystemPath(value: string): boolean {
  const trimmed = value.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\]/.test(trimmed)) return true;
  if (POSIX_ABSOLUTE_PATH.test(trimmed)) return true;
  if (/(?:^|[^a-zA-Z0-9])(?:[a-zA-Z]:[\\/]|\\\\[^\\\s])/m.test(value)) return true;
  return EMBEDDED_POSIX_ABSOLUTE_PATH.test(value);
}

function walkStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      walkStrings(item, visit);
    }
  }
}

function diffSnapshots(left: ContextPackSnapshot, right: ContextPackSnapshot): ContextPackDiff {
  const sections = identifierChanges(
    left.pack.sections.map((item) => item.id),
    right.pack.sections.map((item) => item.id),
  );
  const leftSections = new Map<string, ContextPackWithClaims["sections"][number]>(
    left.pack.sections.map((item) => [item.id, item]),
  );
  const rightSections = new Map<string, ContextPackWithClaims["sections"][number]>(
    right.pack.sections.map((item) => [item.id, item]),
  );
  const changedSections = sections.retained.filter((id) => stableStringify(leftSections.get(id)) !== stableStringify(rightSections.get(id)));
  const changes: ContextPackDiff["changes"] = {
    taskChanged: left.metadata.task.digest !== right.metadata.task.digest,
    semanticHashChanged: left.semanticHash !== right.semanticHash,
    packIdChanged: left.pack.packId !== right.pack.packId,
    contentHashChanged: left.pack.contentHash !== right.pack.contentHash,
    selectionHashChanged: left.pack.selection.selectionHash !== right.pack.selection.selectionHash,
    repositoryFields: changedFieldPaths(left.metadata.repository, right.metadata.repository),
    policyFields: changedFieldPaths(left.metadata.policy, right.metadata.policy),
    freshnessFields: changedFieldPaths(left.pack.freshness, right.pack.freshness),
    metadataFields: changedFieldPaths(left.metadata, right.metadata),
    packFields: changedFieldPaths(normalizedPackForSemanticDiff(left.pack), normalizedPackForSemanticDiff(right.pack)),
    sections,
    changedSections,
    entities: identifierChanges(left.pack.selection.includedEntityIds, right.pack.selection.includedEntityIds),
    relationships: identifierChanges(left.pack.selection.includedRelationshipIds, right.pack.selection.includedRelationshipIds),
    assertions: identifierChanges(left.pack.selection.includedAssertionIds, right.pack.selection.includedAssertionIds),
    events: identifierChanges(left.pack.selection.includedEventIds, right.pack.selection.includedEventIds),
    evidence: identifierChanges(left.pack.selection.includedEvidenceIds, right.pack.selection.includedEvidenceIds),
    warnings: identifierChanges(left.pack.warnings, right.pack.warnings),
  };
  const changed = Object.entries(changes).some(([, value]) => {
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.length > 0;
    return value.added.length > 0 || value.removed.length > 0;
  });
  return {
    schemaVersion: CONTEXT_PACK_SNAPSHOT_SCHEMA_VERSION,
    left: summarizeContextPackSnapshot(left),
    right: summarizeContextPackSnapshot(right),
    changed,
    changes,
  };
}

function identifierChanges(left: readonly string[], right: readonly string[]): IdentifierChanges {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    added: [...rightSet].filter((item) => !leftSet.has(item)).sort(),
    removed: [...leftSet].filter((item) => !rightSet.has(item)).sort(),
    retained: [...leftSet].filter((item) => rightSet.has(item)).sort(),
  };
}

function changedFieldPaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (stableStringify(left) === stableStringify(right)) return [];
  if (!isRecord(left) || !isRecord(right)) return [prefix || "value"];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => changedFieldPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function normalizedPackForSemanticDiff(pack: ContextPackWithClaims): ContextPackWithClaims {
  const normalized = structuredClone(pack);
  normalized.generatedAt = "[volatile-generation-time]";
  normalized.markdown = normalized.markdown.replace(
    /^Generated at: .*$/m,
    "Generated at: [volatile-generation-time]",
  );
  return normalized;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validateHistoryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_PACK_HISTORY) {
    throw new Error(`Context-pack history limit must be an integer from 1 to ${MAX_CONTEXT_PACK_HISTORY}.`);
  }
  return limit;
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported by every platform/filesystem. File data
    // itself was fsynced before atomic publication.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
