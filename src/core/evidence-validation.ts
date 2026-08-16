import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { effectiveExcludedPaths, loadConfig } from "./config.js";
import { getRepoStatus, listRepositoryFiles } from "./git.js";
import { loadAtlasIgnore, type AtlasIgnore } from "./ignore.js";
import { findSecrets, isExcludedPath, isSensitivePath } from "./security.js";
import type { AtlasConfig, EvidenceRecord, RepoStatus } from "./types.js";
import { assertInside, posixPath, sha256, stableStringify } from "./util.js";

export type EvidenceLocatorValidationStatus =
  | "verified"
  | "missing"
  | "unreachable"
  | "digest-mismatch"
  | "policy-denied"
  | "unsafe-locator"
  | "not-regular-file"
  | "unreadable"
  | "invalid-digest"
  | "invalid-record"
  | "provider-not-validated";

export interface EvidenceLocatorValidation {
  evidenceId: string;
  locatorKind: "file" | "provider";
  outcome: "verified" | "invalid" | "not-validated";
  status: EvidenceLocatorValidationStatus;
  details: string;
}

export interface EvidenceLocatorValidationReport {
  results: EvidenceLocatorValidation[];
  verifiedEvidenceIds: string[];
  verifiedLocalEvidenceIds: string[];
  verifiedProviderEvidenceIds: string[];
  invalidEvidenceIds: string[];
  policyDeniedEvidenceIds: string[];
  unvalidatedEvidenceIds: string[];
}

interface ValidationContext {
  repoRoot: string;
  config: AtlasConfig;
  excludedPaths: string[];
  atlasIgnore: AtlasIgnore | null;
  policyLoadFailed: boolean;
  repository?: RepoStatus;
  observation?: CurrentRepositoryObservation;
}

interface CurrentRepositoryObservation {
  repository: RepoStatus;
  safeFiles: string[];
  repositoryDigest: string;
  components: Map<string, { files: string[]; bytes: number }>;
}

const MAX_VALIDATED_FILE_BYTES = 1_000_000;

/**
 * Revalidates the explicitly supplied evidence records. Callers are responsible
 * for supplying current-projection records rather than every immutable historical
 * row. Unknown locator providers are reported as not validated and must not be
 * treated as verified evidence by authoritative consumers.
 */
export function validateEvidenceLocators(
  repoRoot: string,
  records: readonly EvidenceRecord[],
): EvidenceLocatorValidationReport {
  const { config } = loadConfig(repoRoot);
  let atlasIgnore: AtlasIgnore | null = null;
  let policyLoadFailed = false;
  try {
    atlasIgnore = loadAtlasIgnore(repoRoot);
  } catch {
    policyLoadFailed = true;
  }
  const context: ValidationContext = {
    repoRoot,
    config,
    excludedPaths: effectiveExcludedPaths(config),
    atlasIgnore,
    policyLoadFailed,
  };
  const results = records.map((record) => validateEvidenceRecord(record, context));
  return {
    results,
    verifiedEvidenceIds: results.filter((item) => item.outcome === "verified").map((item) => item.evidenceId),
    verifiedLocalEvidenceIds: results.filter((item) => item.outcome === "verified" && item.locatorKind === "file").map((item) => item.evidenceId),
    verifiedProviderEvidenceIds: results.filter((item) => item.outcome === "verified" && item.locatorKind === "provider").map((item) => item.evidenceId),
    invalidEvidenceIds: results.filter((item) => item.outcome === "invalid").map((item) => item.evidenceId),
    policyDeniedEvidenceIds: results.filter((item) => item.status === "policy-denied").map((item) => item.evidenceId),
    unvalidatedEvidenceIds: results.filter((item) => item.outcome === "not-validated").map((item) => item.evidenceId),
  };
}

function validateEvidenceRecord(record: EvidenceRecord, context: ValidationContext): EvidenceLocatorValidation {
  const locatorKind = record.locator.startsWith("file:") ? "file" : "provider";
  if (!/^[a-f0-9]{64}$/.test(record.digest)) {
    return invalid(record.id, locatorKind, "invalid-digest",
      "The stored evidence digest is not a canonical SHA-256 value; pre-migration stores must be resynchronized.");
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    return invalid(record.id, locatorKind, "invalid-record", "The evidence observation time is not a valid ISO-compatible timestamp.");
  }
  const expectedId = `evidence_${sha256(`${record.kind}\0${record.locator}\0${record.digest}`).slice(0, 32)}`;
  if (record.id !== expectedId) {
    return invalid(record.id, locatorKind, "invalid-record", "The evidence ID does not match its kind, locator, and digest.");
  }
  if (record.sensitive) {
    return result(record.id, locatorKind, "not-validated", "policy-denied",
      "The evidence record is withheld by the sensitive-content policy.");
  }
  if (record.locator.startsWith("file:")) {
    if (!new Set(["document", "manifest"]).has(record.kind)) {
      return invalid(record.id, "file", "invalid-record", "A file locator is paired with an evidence kind that is not produced by the file or manifest extractors.");
    }
    return validateFileEvidence(record, context);
  }
  if (record.locator.startsWith("git:")) {
    if (record.kind !== "git_commit") {
      return invalid(record.id, "provider", "invalid-record", "A Git locator is paired with an evidence kind other than git_commit.");
    }
    return validateGitEvidence(record, context);
  }
  if (record.locator === "repository:current") return validateRepositoryEvidence(record, context);
  if (record.locator.startsWith("component:")) return validateComponentEvidence(record, context);
  return result(record.id, "provider", "not-validated", "provider-not-validated",
    "This locator requires a provider-specific validator and was not verified by this boundary.");
}

function validateFileEvidence(record: EvidenceRecord, context: ValidationContext): EvidenceLocatorValidation {
  const relativePath = parseSafeRelativePath(record.locator.slice("file:".length));
  if (!relativePath) {
    return invalid(record.id, "file", "unsafe-locator", "The file locator is not a canonical repository-relative path.");
  }
  if (context.policyLoadFailed) {
    return invalid(record.id, "file", "policy-denied", "The current repository ignore policy could not be loaded safely.");
  }
  if (isSensitivePath(relativePath)
    || isExcludedPath(relativePath, context.excludedPaths)
    || Boolean(context.atlasIgnore?.matches(relativePath))) {
    return invalid(record.id, "file", "policy-denied", "The current repository policy withholds this file path.");
  }
  const absolutePath = safeAbsolutePath(context.repoRoot, relativePath);
  if (!absolutePath) {
    return invalid(record.id, "file", "unsafe-locator", "The file locator resolves outside the repository root.");
  }
  try {
    const fileStatus = lstatSync(absolutePath);
    if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
      return invalid(record.id, "file", "not-regular-file", "The local evidence path is not a non-symlink regular file.");
    }
    if (fileStatus.size > MAX_VALIDATED_FILE_BYTES) {
      return invalid(record.id, "file", "unreadable", "The local evidence file exceeds the bounded validation size.");
    }
  } catch (error) {
    return isMissingFileError(error)
      ? invalid(record.id, "file", "missing", "The local evidence file no longer exists at its recorded path.")
      : invalid(record.id, "file", "unreadable", "The local evidence file could not be inspected safely.");
  }
  const canonicalPath = canonicalFileInsideRoot(context.repoRoot, absolutePath);
  if (!canonicalPath) {
    return invalid(record.id, "file", "unsafe-locator", "The file locator resolves through a path outside the canonical repository root.");
  }
  let raw: Buffer;
  try {
    raw = readFileSync(canonicalPath);
  } catch {
    return invalid(record.id, "file", "unreadable", "The local evidence file could not be read safely.");
  }
  if (raw.includes(0)) {
    return invalid(record.id, "file", "unreadable", "The local evidence file is no longer valid bounded text evidence.");
  }
  const text = raw.toString("utf8");
  if (findSecrets(text).length > 0) {
    return invalid(record.id, "file", "policy-denied", "The current local evidence content is withheld by the sensitive-content policy.");
  }
  if (sha256(text) !== record.digest) {
    return invalid(record.id, "file", "digest-mismatch", "The current local evidence content no longer matches its recorded digest.");
  }
  return result(record.id, "file", "verified", "verified",
    "The canonical repository-relative file exists and matches its recorded SHA-256 digest.");
}

function validateGitEvidence(record: EvidenceRecord, context: ValidationContext): EvidenceLocatorValidation {
  const objectId = record.locator.slice("git:".length);
  const repository = currentRepository(context);
  const expectedLength = repository.objectFormat === "sha256" ? 64 : repository.objectFormat === "sha1" ? 40 : 0;
  if (!/^[a-f0-9]{40,64}$/.test(objectId) || (expectedLength > 0 && objectId.length !== expectedLength)) {
    return invalid(record.id, "provider", "unsafe-locator", "The Git locator is not a canonical object ID for this repository.");
  }
  if (sha256(objectId) !== record.digest) {
    return invalid(record.id, "provider", "digest-mismatch", "The Git evidence digest does not match its canonical object-ID observation.");
  }
  if (!isReachableCommit(context.repoRoot, objectId)) {
    return invalid(record.id, "provider", "unreachable", "The recorded Git commit is not reachable from the current repository HEAD.");
  }
  return result(record.id, "provider", "verified", "verified",
    "The canonical Git commit object is reachable from the current repository HEAD and matches its evidence digest.");
}

function validateRepositoryEvidence(record: EvidenceRecord, context: ValidationContext): EvidenceLocatorValidation {
  if (record.kind !== "repository_snapshot") {
    return invalid(record.id, "provider", "unsafe-locator", "The repository locator is paired with an unexpected evidence kind.");
  }
  if (context.policyLoadFailed) {
    return invalid(record.id, "provider", "policy-denied", "The current repository ignore policy could not be loaded safely.");
  }
  const observation = currentObservation(context);
  if (observation.repositoryDigest !== record.digest) {
    return invalid(record.id, "provider", "digest-mismatch", "The live repository observation no longer matches the indexed snapshot digest.");
  }
  return result(record.id, "provider", "verified", "verified",
    "The live repository identity, state, and bounded file observation match the indexed snapshot digest.");
}

function validateComponentEvidence(record: EvidenceRecord, context: ValidationContext): EvidenceLocatorValidation {
  if (record.kind !== "component_snapshot") {
    return invalid(record.id, "provider", "unsafe-locator", "The component locator is paired with an unexpected evidence kind.");
  }
  if (context.policyLoadFailed) {
    return invalid(record.id, "provider", "policy-denied", "The current repository ignore policy could not be loaded safely.");
  }
  const componentPath = parseSafeRelativePath(record.locator.slice("component:".length));
  if (!componentPath || isSensitivePath(componentPath) || isExcludedPath(componentPath, context.excludedPaths)) {
    return invalid(record.id, "provider", "unsafe-locator", "The component locator is not a permitted canonical repository-relative path.");
  }
  const component = currentObservation(context).components.get(componentPath);
  if (!component) {
    return invalid(record.id, "provider", "missing", "The indexed component no longer exists in the current bounded repository observation.");
  }
  const digest = sha256(stableStringify({ files: component.files, bytes: component.bytes }));
  if (digest !== record.digest) {
    return invalid(record.id, "provider", "digest-mismatch", "The current component membership or byte count no longer matches its indexed digest.");
  }
  return result(record.id, "provider", "verified", "verified",
    "The current component membership and byte count match the indexed snapshot digest.");
}

function currentRepository(context: ValidationContext): RepoStatus {
  context.repository ??= getRepoStatus(context.repoRoot);
  return context.repository;
}

function currentObservation(context: ValidationContext): CurrentRepositoryObservation {
  if (context.observation) return context.observation;
  const repository = currentRepository(context);
  const listed = listRepositoryFiles(context.repoRoot, context.config.maxFiles);
  const safeFiles: string[] = [];
  for (const relativePath of listed.files) {
    if (isExcludedPath(relativePath, context.excludedPaths)
      || context.atlasIgnore?.matches(relativePath)
      || isSensitivePath(relativePath)) continue;
    const absolutePath = safeAbsolutePath(context.repoRoot, relativePath);
    if (!absolutePath) continue;
    try {
      const fileStatus = lstatSync(absolutePath);
      if (fileStatus.isSymbolicLink() || !fileStatus.isFile() || !canonicalFileInsideRoot(context.repoRoot, absolutePath)) continue;
    } catch {
      continue;
    }
    safeFiles.push(relativePath);
  }
  const historyTruncated = repository.shallow || repository.reachableCommits > context.config.maxCommits;
  const repositoryDigest = sha256(stableStringify({
    head: repository.head,
    branch: repository.branch,
    dirty: repository.dirty,
    workingTreeFingerprint: repository.workingTreeFingerprint,
    repositoryId: repository.repositoryId,
    objectFormat: repository.objectFormat,
    defaultBranch: repository.defaultBranch,
    gitCommonDir: repository.gitCommonDir,
    detached: repository.detached,
    shallow: repository.shallow,
    reachableCommits: repository.reachableCommits,
    historyTruncated,
    mergeInProgress: repository.mergeInProgress,
    rebaseInProgress: repository.rebaseInProgress,
    sparseCheckout: repository.sparseCheckout,
    submoduleCount: repository.submoduleCount,
    lfsTracked: repository.lfsTracked,
    files: safeFiles,
  }));
  const components = new Map<string, { files: string[]; bytes: number }>();
  for (const relativePath of safeFiles) {
    const directory = posixPath(path.posix.dirname(relativePath));
    if (directory === ".") continue;
    const segments = directory.split("/");
    let bytes = 0;
    try { bytes = statSync(assertInside(context.repoRoot, relativePath)).size; } catch { /* changed during bounded scan */ }
    for (let depth = 1; depth <= Math.min(context.config.maxComponentDepth, segments.length); depth += 1) {
      const componentPath = segments.slice(0, depth).join("/");
      const component = components.get(componentPath) ?? { files: [], bytes: 0 };
      component.files.push(relativePath);
      component.bytes += bytes;
      components.set(componentPath, component);
    }
  }
  context.observation = { repository, safeFiles, repositoryDigest, components };
  return context.observation;
}

function isReachableCommit(repoRoot: string, objectId: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${objectId}^{commit}`], {
      stdio: "ignore", windowsHide: true,
    });
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", objectId, "HEAD"], {
      stdio: "ignore", windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function parseSafeRelativePath(relativePath: string): string | null {
  if (!relativePath
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || /^[a-zA-Z]:/.test(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)) return null;
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === "." || normalized.split("/").includes("..")) return null;
  return normalized;
}

function safeAbsolutePath(repoRoot: string, relativePath: string): string | null {
  try { return assertInside(repoRoot, relativePath); } catch { return null; }
}

function canonicalFileInsideRoot(repoRoot: string, absolutePath: string): string | null {
  try {
    const canonicalRoot = realpathSync(repoRoot);
    const canonicalPath = realpathSync(absolutePath);
    assertInside(canonicalRoot, canonicalPath);
    return canonicalPath;
  } catch {
    return null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && ["ENOENT", "ENOTDIR"].includes(String((error as { code: unknown }).code)));
}

function invalid(
  evidenceId: string,
  locatorKind: EvidenceLocatorValidation["locatorKind"],
  status: Exclude<EvidenceLocatorValidationStatus, "verified" | "provider-not-validated">,
  details: string,
): EvidenceLocatorValidation {
  return result(evidenceId, locatorKind, "invalid", status, details);
}

function result(
  evidenceId: string,
  locatorKind: EvidenceLocatorValidation["locatorKind"],
  outcome: EvidenceLocatorValidation["outcome"],
  status: EvidenceLocatorValidationStatus,
  details: string,
): EvidenceLocatorValidation {
  return { evidenceId, locatorKind, outcome, status, details };
}
