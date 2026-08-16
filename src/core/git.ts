import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { CommitFile, GitCommit, RepoStatus } from "./types.js";
import { posixPath, sanitizeForGitArgument } from "./internal.js";

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
  const facts = runGit(root, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format", "--is-shallow-repository"], true)
    .trim().split(/\r?\n/);
  const canonicalRoot = path.resolve(facts[0] || root);
  const rawGitDir = facts[1] ?? ".git";
  const rawCommonDir = facts[2] ?? rawGitDir;
  const gitDir = path.resolve(canonicalRoot, rawGitDir);
  const gitCommonDir = path.resolve(canonicalRoot, rawCommonDir);
  const rawObjectFormat = facts[3] ?? "";
  const objectFormat = rawObjectFormat === "sha1" || rawObjectFormat === "sha256" ? rawObjectFormat : "unknown";
  const shallow = facts[4] === "true";
  const head = runGit(root, ["rev-parse", "HEAD"], true).trim() || null;
  const currentBranch = runGit(root, ["branch", "--show-current"], true).trim();
  const branch = currentBranch || "detached";
  // Local derived state is never source content. .atlasignore is tracked by
  // the effective guidance-policy watermark instead, so comments/formatting do
  // not masquerade as code drift while semantic rule changes still invalidate.
  const sourcePathspec = [".", ":(exclude).context-atlas/**", ":(exclude).atlasignore"];
  const porcelain = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...sourcePathspec], true);
  const changedFiles = porcelain ? porcelain.split("\0").filter(Boolean).length : 0;
  const trackedDiff = head
    ? runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", ...sourcePathspec], true)
    : runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--", ...sourcePathspec], true);
  const untrackedPaths = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...sourcePathspec], true)
    .split("\0").filter(Boolean).sort();
  const untrackedContentFingerprint = hashUntrackedContent(canonicalRoot, untrackedPaths);
  const workingTreeFingerprint = createHash("sha256")
    .update(porcelain)
    .update("\0")
    .update(trackedDiff)
    .update("\0")
    .update(untrackedContentFingerprint)
    .digest("hex");
  const count = Number.parseInt(runGit(root, ["rev-list", "--count", "HEAD"], true).trim(), 10);
  const reachableCommits = Number.isFinite(count) ? count : 0;
  const remoteDefault = runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true).trim();
  const configuredDefault = currentBranch ? "" : runGit(root, ["config", "--get", "init.defaultBranch"], true).trim();
  const defaultBranch = remoteDefault.replace(/^origin\//, "") || currentBranch || configuredDefault || null;
  const initialCommits = runGit(root, ["rev-list", "--max-parents=0", "HEAD"], true).trim().split(/\r?\n/).filter(Boolean).sort();
  const repositoryId = `repo_${createHash("sha256").update(`${objectFormat}\0${initialCommits.join("\0") || "unborn"}`).digest("hex").slice(0, 32)}`;
  const mergeInProgress = existsSync(path.join(gitDir, "MERGE_HEAD"));
  const rebaseInProgress = existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"));
  const sparseCheckout = runGit(root, ["config", "--bool", "core.sparseCheckout"], true).trim() === "true";
  const gitmodules = path.join(canonicalRoot, ".gitmodules");
  const submoduleCount = (readSafeRootMetadata(gitmodules).match(/^\s*path\s*=/gm) ?? []).length;
  const attributes = path.join(canonicalRoot, ".gitattributes");
  const lfsTracked = /filter\s*=\s*lfs|filter=lfs/i.test(readSafeRootMetadata(attributes));
  return {
    root: canonicalRoot,
    canonicalRoot,
    gitCommonDir,
    repositoryId,
    objectFormat,
    defaultBranch,
    head,
    branch,
    detached: !currentBranch,
    dirty: changedFiles > 0,
    changedFiles,
    workingTreeFingerprint,
    shallow,
    reachableCommits,
    mergeInProgress,
    rebaseInProgress,
    sparseCheckout,
    submoduleCount,
    lfsTracked,
  };
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
  for (let index = 0; index < fields.length;) {
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
