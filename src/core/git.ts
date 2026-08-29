import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { CommitFile, GitCommit, RepoStatus } from "./types.js";
import { posixPath, sanitizeForGitArgument } from "./internal.js";

const repositorySnapshotStorage = new AsyncLocalStorage<ReadonlyMap<string, RepoStatus>>();

function runGit(root: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed: ${message}`);
  }
}

export function findGitRoot(candidate = process.cwd()): string {
  const resolved = path.resolve(candidate);
  const start = existsSync(resolved) && statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
  const root = runGit(start, ["rev-parse", "--show-toplevel"], true).trim();
  if (!root) throw new Error(`Not a Git repository: ${candidate}`);
  return path.resolve(root);
}

export function getRepoStatus(root: string): RepoStatus {
  const scoped = repositorySnapshotStorage.getStore()?.get(repositorySnapshotKey(root));
  return scoped ?? getFreshRepoStatus(root);
}

/**
 * Reads live repository state even when the caller is inside a stable-read
 * scope. Snapshot guards use this before and after a response so request-local
 * memoization can never hide a concurrent repository change.
 */
export function getFreshRepoStatus(root: string): RepoStatus {
  const core = readCoreRepoStatus(root);
  const count = Number.parseInt(runGit(root, ["rev-list", "--count", "HEAD"], true).trim(), 10);
  const reachableCommits = Number.isFinite(count) ? count : 0;
  const remoteDefault = runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true).trim();
  const configuredDefault = core.currentBranch ? "" : runGit(root, ["config", "--get", "init.defaultBranch"], true).trim();
  const defaultBranch = remoteDefault.replace(/^origin\//, "") || core.currentBranch || configuredDefault || null;
  const initialCommits = runGit(root, ["rev-list", "--max-parents=0", "HEAD"], true).trim().split(/\r?\n/).filter(Boolean).sort();
  const repositoryId = `repo_${createHash("sha256")
    .update(`${core.objectFormat}\0${initialCommits.join("\0") || "unborn"}`)
    .digest("hex")
    .slice(0, 32)}`;
  const sparseCheckout = runGit(root, ["config", "--bool", "core.sparseCheckout"], true).trim() === "true";
  const gitmodules = path.join(core.canonicalRoot, ".gitmodules");
  const submoduleCount = (readSafeRootMetadata(gitmodules).match(/^\s*path\s*=/gm) ?? []).length;
  const attributes = path.join(core.canonicalRoot, ".gitattributes");
  const lfsTracked = /filter\s*=\s*lfs|filter=lfs/i.test(readSafeRootMetadata(attributes));
  return {
    root: core.canonicalRoot,
    canonicalRoot: core.canonicalRoot,
    gitCommonDir: core.gitCommonDir,
    repositoryId,
    objectFormat: core.objectFormat,
    defaultBranch,
    head: core.head,
    branch: core.branch,
    detached: !core.currentBranch,
    dirty: core.changedFiles > 0,
    changedFiles: core.changedFiles,
    workingTreeFingerprint: core.workingTreeFingerprint,
    shallow: core.shallow,
    reachableCommits,
    mergeInProgress: core.mergeInProgress,
    rebaseInProgress: core.rebaseInProgress,
    sparseCheckout,
    submoduleCount,
    lfsTracked,
  };
}

export interface RepositoryReadBoundary {
  repositoryId: string;
  objectFormat: RepoStatus["objectFormat"];
  branch: string;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changedFiles: number;
  workingTreeFingerprint: string;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
}

export function repositoryReadBoundary(repository: RepoStatus): RepositoryReadBoundary {
  return {
    repositoryId: repository.repositoryId,
    objectFormat: repository.objectFormat,
    branch: repository.branch,
    head: repository.head,
    detached: repository.detached,
    dirty: repository.dirty,
    changedFiles: repository.changedFiles,
    workingTreeFingerprint: repository.workingTreeFingerprint,
    mergeInProgress: repository.mergeInProgress,
    rebaseInProgress: repository.rebaseInProgress,
  };
}

/** Reads only the live fields used by the post-operation stability check. */
export function getFreshRepositoryReadBoundary(root: string, before: RepoStatus): RepositoryReadBoundary {
  const core = readCoreRepoStatus(root);
  return {
    // A content-addressed HEAD fixes its reachable history. If HEAD and object
    // format are unchanged, recomputing root commits cannot change this ID; if
    // either differs, the explicit fields below already reject the snapshot.
    repositoryId: before.repositoryId,
    objectFormat: core.objectFormat,
    branch: core.branch,
    head: core.head,
    detached: !core.currentBranch,
    dirty: core.changedFiles > 0,
    changedFiles: core.changedFiles,
    workingTreeFingerprint: core.workingTreeFingerprint,
    mergeInProgress: core.mergeInProgress,
    rebaseInProgress: core.rebaseInProgress,
  };
}

/**
 * Reuses one immutable repository observation for all nested synchronous and
 * asynchronous reads in an operation. The enclosing stable-snapshot guard is
 * responsible for comparing this observation with a fresh post-read value.
 */
export function withRepoStatusSnapshot<T>(root: string, repository: RepoStatus, operation: () => T): T {
  const snapshots = new Map(repositorySnapshotStorage.getStore());
  snapshots.set(repositorySnapshotKey(root), repository);
  snapshots.set(repositorySnapshotKey(repository.root), repository);
  return repositorySnapshotStorage.run(snapshots, operation);
}

function repositorySnapshotKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface CoreRepoStatus {
  canonicalRoot: string;
  gitCommonDir: string;
  objectFormat: RepoStatus["objectFormat"];
  shallow: boolean;
  head: string | null;
  currentBranch: string;
  branch: string;
  changedFiles: number;
  workingTreeFingerprint: string;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
}

function readCoreRepoStatus(root: string): CoreRepoStatus {
  const combined = runGit(
    root,
    [
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-object-format",
      "--is-shallow-repository",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ],
    true,
  )
    .trim()
    .split(/\r?\n/);
  const hasCombinedHead = combined.length >= 7;
  const facts = hasCombinedHead
    ? combined
    : runGit(
        root,
        ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format", "--is-shallow-repository"],
        true,
      )
        .trim()
        .split(/\r?\n/);
  const canonicalRoot = path.resolve(facts[0] || root);
  const rawGitDir = facts[1] ?? ".git";
  const rawCommonDir = facts[2] ?? rawGitDir;
  const gitDir = path.resolve(canonicalRoot, rawGitDir);
  const gitCommonDir = path.resolve(canonicalRoot, rawCommonDir);
  const rawObjectFormat = facts[3] ?? "";
  const objectFormat = rawObjectFormat === "sha1" || rawObjectFormat === "sha256" ? rawObjectFormat : "unknown";
  const shallow = facts[4] === "true";
  const head = (hasCombinedHead ? facts[5] : runGit(root, ["rev-parse", "HEAD"], true).trim()) || null;
  const rawBranch = hasCombinedHead ? (facts[6] ?? "") : runGit(root, ["branch", "--show-current"], true).trim();
  const currentBranch = rawBranch === "HEAD" ? "" : rawBranch;
  const branch = currentBranch || "detached";
  // Local derived state is never source content. .atlasignore is tracked by
  // the effective guidance-policy watermark instead, so comments/formatting do
  // not masquerade as code drift while semantic rule changes still invalidate.
  const sourcePathspec = [".", ":(exclude).context-atlas/**", ":(exclude).atlasignore"];
  const porcelain = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...sourcePathspec], true);
  const porcelainFields = porcelain.split("\0").filter(Boolean);
  const changedFiles = porcelain ? porcelainFields.length : 0;
  const trackedDiff = head
    ? runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", ...sourcePathspec], true)
    : runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--", ...sourcePathspec], true);
  const untrackedContentFingerprint = hashUntrackedContent(canonicalRoot, untrackedPathsFromPorcelain(porcelainFields));
  const workingTreeFingerprint = createHash("sha256")
    .update(porcelain)
    .update("\0")
    .update(trackedDiff)
    .update("\0")
    .update(untrackedContentFingerprint)
    .digest("hex");
  return {
    canonicalRoot,
    gitCommonDir,
    objectFormat,
    shallow,
    head,
    currentBranch,
    branch,
    changedFiles,
    workingTreeFingerprint,
    mergeInProgress: existsSync(path.join(gitDir, "MERGE_HEAD")),
    rebaseInProgress: existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply")),
  };
}

function untrackedPathsFromPorcelain(fields: string[]): string[] {
  const untracked: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.startsWith("?? ")) untracked.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) index += 1;
  }
  return untracked.sort();
}

function hashUntrackedContent(root: string, relativePaths: string[]): string {
  const combined = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const relativePath of relativePaths) {
    const normalized = posixPath(relativePath);
    const absolutePath = path.resolve(root, ...normalized.split("/"));
    combined.update(normalized).update("\0");
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      combined.update("unsafe-path\0");
      continue;
    }
    try {
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        combined.update(metadata.isSymbolicLink() ? "symlink\0" : "not-regular\0");
        continue;
      }
      const content = createHash("sha256");
      const descriptor = openSync(absolutePath, "r");
      try {
        for (;;) {
          const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          content.update(buffer.subarray(0, bytesRead));
        }
      } finally {
        closeSync(descriptor);
      }
      combined.update(content.digest("hex")).update("\0");
    } catch {
      combined.update("unreadable\0");
    }
  }
  return combined.digest("hex");
}

function readSafeRootMetadata(filePath: string): string {
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_000_000) return "";
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function getCommits(root: string, maximum: number): GitCommit[] {
  if (!runGit(root, ["rev-parse", "--verify", "HEAD"], true).trim()) return [];
  const format = "%H%x1f%aI%x1f%an%x1f%s%x1e";
  const output = runGit(root, ["log", `--max-count=${Math.max(1, maximum)}`, "--reverse", `--format=${format}`], true);
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", timestamp = "", author = "", subject = ""] = record.split("\x1f");
      return { hash, timestamp, author, subject, files: getCommitFiles(root, hash) };
    })
    .filter((commit) => /^[a-f0-9]{40,64}$/i.test(commit.hash));
}

export function getCommitFiles(root: string, commitHash: string): CommitFile[] {
  sanitizeForGitArgument(commitHash);
  const output = runGit(root, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", commitHash], true);
  if (!output) return [];
  const fields = output.split("\0").filter(Boolean);
  const files: CommitFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = posixPath(fields[index++] ?? "");
      const currentPath = posixPath(fields[index++] ?? "");
      files.push({ status, path: currentPath, previousPath });
    } else {
      files.push({ status, path: posixPath(fields[index++] ?? "") });
    }
  }
  return files.filter((file) => file.path.length > 0);
}

export function listRepositoryFiles(root: string, maximum: number): { files: string[]; truncated: boolean } {
  const output = runGit(root, ["ls-files", "-co", "--exclude-standard", "-z"], true);
  const all = output.split("\0").filter(Boolean).map(posixPath).sort();
  return { files: all.slice(0, maximum), truncated: all.length > maximum };
}

export function getGitHeadTimestamp(root: string): string | null {
  return runGit(root, ["log", "-1", "--format=%aI"], true).trim() || null;
}
