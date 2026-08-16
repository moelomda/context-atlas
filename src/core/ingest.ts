import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { computeGuidanceDependencyWatermark, effectiveExcludedPaths, loadConfig } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { getCommits, getRepoStatus, listRepositoryFiles } from "./git.js";
import { getHealthReport } from "./health.js";
import { loadAtlasIgnore } from "./ignore.js";
import { flushLedgerOutbox, stageLedgerEntry, verifyLedgerState } from "./ledger.js";
import { findSecrets, isExcludedPath, isSensitivePath, sanitizeText } from "./security.js";
import { getAssertionFromDatabase, recordAssertionRevisionInDatabase } from "./temporal.js";
import type {
  AtlasConfig,
  EntityRecord,
  EvidenceRecord,
  ProposalRecord,
  RelationshipRecord,
  SyncResult,
} from "./types.js";
import { assertInside, newId, nowIso, posixPath, sha256, slugify, stableStringify } from "./util.js";

interface ComponentAccumulator {
  path: string;
  files: string[];
  bytes: number;
  extensions: Map<string, number>;
  manifests: string[];
}

interface ManifestInfo {
  kind: string;
  name: string;
  description: string;
  dependencies: string[];
  developmentDependencyCount: number;
}

export function syncRepository(start = process.cwd()): SyncResult {
  const { root, config } = loadConfig(start);
  const atlasIgnore = loadAtlasIgnore(root);
  const guidanceDependencies = computeGuidanceDependencyWatermark(config, atlasIgnore.patterns);
  const scanExclusions = effectiveExcludedPaths(config);
  const repository = getRepoStatus(root);
  const database = new AtlasDatabase(root);
  flushLedgerOutbox(root, database);
  const ledgerVerification = verifyLedgerState(root, database);
  if (!ledgerVerification.consistent || ledgerVerification.unflushedEntries > 0 || database.countUnledgeredEvents() > 0) {
    database.close();
    throw new Error("Context history integrity check failed. Run `context-atlas health` and recover from a verified backup before synchronizing.");
  }
  const eventIntegrity = getHealthReport(root, database, repository).checks
    .find((item) => item.id === "event-ledger-coverage");
  if (!eventIntegrity || eventIntegrity.status === "critical") {
    database.close();
    throw new Error(`Timeline event integrity check failed before synchronization: ${eventIntegrity?.details ?? "the event integrity check was unavailable"}`);
  }
  const startedAt = nowIso();
  const runId = newId("run");
  database.startIngestionRun(runId, startedAt, repository.head);

  let commitsAdded = 0;
  let componentsObserved = 0;
  let documentsObserved = 0;
  let relationshipsObserved = 0;
  let sensitiveItemsWithheld = 0;
  const proposalsCreated: string[] = [];
  let ingestionCommitted = false;

  try {
    const syncResult = database.transaction(() => {
    database.deactivateObservedState();

    const commitEvidence: string[] = [];
    const commits = getCommits(root, config.maxCommits);
    const truncatedHistory = repository.shallow || repository.reachableCommits > commits.length;
    for (const commit of commits) {
      if (database.hasCommit(commit.hash)) continue;
      const cleanSubject = sanitizeText(commit.subject || "Untitled commit", 500);
      const cleanAuthor = sanitizeText(commit.author || "Unknown author", 200);
      const commitPaths = commit.files.map((file) => ({
        status: file.status,
        path: presentCommitPath(file.path, scanExclusions, atlasIgnore.matches),
        ...(file.previousPath
          ? { previousPath: presentCommitPath(file.previousPath, scanExclusions, atlasIgnore.matches) }
          : {}),
      }));
      const evidence = makeEvidence("git_commit", `git:${commit.hash}`, sha256(commit.hash), startedAt, cleanSubject.sensitive || cleanAuthor.sensitive, {
        commit: commit.hash,
        author: cleanAuthor.value,
        timestamp: commit.timestamp,
        changedFileCount: commit.files.length,
      });
      database.upsertEvidence(evidence);
      const eventId = `event_git_${commit.hash}`;
      const inserted = database.insertEvent({
        id: eventId,
        timestamp: commit.timestamp || startedAt,
        type: "git_commit",
        title: cleanSubject.value,
        summary: summarizeCommit(commit.hash, commitPaths.map((file) => file.path)),
        commit: commit.hash,
        files: commitPaths,
        evidence: [evidence.id],
        ledgerHash: null,
      });
      if (inserted) {
        const ledger = stageLedgerEntry(root, database, {
          kind: "git_commit_observed",
          actionId: eventId,
          timestamp: commit.timestamp || startedAt,
          payload: { commit: commit.hash, evidence: evidence.id },
        });
        database.updateEventLedgerHash(eventId, ledger.hash);
        database.setMeta("ledger_head", ledger.hash);
        commitsAdded += 1;
        commitEvidence.push(evidence.id);
      }
    }

    const listed = listRepositoryFiles(root, config.maxFiles);
    const safeFiles: string[] = [];
    let ignoredFiles = 0;
    for (const relativePath of listed.files) {
      if (isExcludedPath(relativePath, scanExclusions) || atlasIgnore.matches(relativePath)) {
        ignoredFiles += 1;
        continue;
      }
      if (isSensitivePath(relativePath)) {
        sensitiveItemsWithheld += 1;
        const evidence = makeEvidence(
          "withheld_sensitive_path",
          `withheld:${sha256(relativePath).slice(0, 20)}`,
          sha256(relativePath),
          startedAt,
          true,
          { reason: "sensitive-path-policy" },
        );
        database.upsertEvidence(evidence);
        continue;
      }
      const absolutePath = assertInside(root, relativePath);
      try {
        if (lstatSync(absolutePath).isSymbolicLink() || !statSync(absolutePath).isFile()) continue;
      } catch {
        continue;
      }
      safeFiles.push(relativePath);
    }

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
      historyTruncated: truncatedHistory,
      mergeInProgress: repository.mergeInProgress,
      rebaseInProgress: repository.rebaseInProgress,
      sparseCheckout: repository.sparseCheckout,
      submoduleCount: repository.submoduleCount,
      lfsTracked: repository.lfsTracked,
      files: safeFiles,
    }));
    const repositoryEvidence = makeEvidence("repository_snapshot", "repository:current", repositoryDigest, startedAt, false, {
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
      historyTruncated: truncatedHistory,
      mergeInProgress: repository.mergeInProgress,
      rebaseInProgress: repository.rebaseInProgress,
      sparseCheckout: repository.sparseCheckout,
      submoduleCount: repository.submoduleCount,
      lfsTracked: repository.lfsTracked,
      changedFiles: repository.changedFiles,
      scannedFiles: safeFiles.length,
      truncated: listed.truncated,
      ignoredFiles,
      atlasIgnoreHash: atlasIgnore.hash,
      atlasIgnorePolicyHash: guidanceDependencies.atlasIgnorePolicyHash,
      guidanceWatermark: guidanceDependencies.watermark,
      guidanceExtractorVersion: guidanceDependencies.extractorVersion,
      guidanceSchemaVersion: guidanceDependencies.schemaVersion,
    });
    database.upsertEvidence(repositoryEvidence);

    const components = collectComponents(root, safeFiles, config.maxComponentDepth);
    const languageTotals = new Map<string, number>();
    for (const component of components.values()) {
      for (const [extension, count] of component.extensions) {
        languageTotals.set(languageForExtension(extension), (languageTotals.get(languageForExtension(extension)) ?? 0) + count);
      }
    }
    const dominantLanguage = topCount(languageTotals)?.[0] ?? "mixed";
    // Project identity belongs to the repository, not its mutable display
    // name. Reuse the existing repository-bound entity so a projectName policy
    // change can revise (rather than fork) the reviewed overview assertion.
    const existingRepositoryProject = database.listEntities({ types: ["project"], includeRemoved: true })
      .find((entity) => entity.payload.repositoryId === repository.repositoryId);
    const projectId = existingRepositoryProject?.id ?? `project:${slugify(config.projectName)}`;
    const projectEntity: EntityRecord = {
      id: projectId,
      type: "project",
      title: config.projectName,
      summary: `${config.projectName} is on ${repository.branch} with ${safeFiles.length} visible files and ${components.size} mapped components. Dominant language: ${dominantLanguage}.`,
      status: "active",
      confidence: "observed",
      source: "repository",
      firstSeen: existingRepositoryProject?.firstSeen ?? startedAt,
      lastSeen: startedAt,
      staleAfterDays: config.staleAfterDays,
      payload: {
        branch: repository.branch,
        head: repository.head,
        dirty: repository.dirty,
        workingTreeFingerprint: repository.workingTreeFingerprint,
        repositoryId: repository.repositoryId,
        objectFormat: repository.objectFormat,
        defaultBranch: repository.defaultBranch,
        gitCommonDir: repository.gitCommonDir,
        detached: repository.detached,
        shallow: repository.shallow,
        reachableCommits: repository.reachableCommits,
        historyTruncated: truncatedHistory,
        mergeInProgress: repository.mergeInProgress,
        rebaseInProgress: repository.rebaseInProgress,
        sparseCheckout: repository.sparseCheckout,
        submoduleCount: repository.submoduleCount,
        lfsTracked: repository.lfsTracked,
        fileCount: safeFiles.length,
        componentCount: components.size,
        dominantLanguage,
        scanTruncated: listed.truncated,
        ignoredFiles,
        atlasIgnoreHash: atlasIgnore.hash,
        atlasIgnorePolicyHash: guidanceDependencies.atlasIgnorePolicyHash,
        guidanceWatermark: guidanceDependencies.watermark,
        guidanceExtractorVersion: guidanceDependencies.extractorVersion,
        guidanceSchemaVersion: guidanceDependencies.schemaVersion,
      },
      primaryEvidenceId: repositoryEvidence.id,
    };
    database.upsertEntity(projectEntity, [repositoryEvidence.id], "repository scan");

    const componentIds = new Map<string, string>();
    for (const component of [...components.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const evidence = makeEvidence(
        "component_snapshot",
        `component:${component.path}`,
        sha256(stableStringify({ files: component.files, bytes: component.bytes })),
        startedAt,
        false,
        { path: component.path, fileCount: component.files.length, bytes: component.bytes },
      );
      database.upsertEvidence(evidence);
      const componentId = componentIdForPath(component.path);
      componentIds.set(component.path, componentId);
      const languages = [...component.extensions.entries()]
        .map(([extension, count]) => [languageForExtension(extension), count] as const)
        .reduce((totals, [language, count]) => totals.set(language, (totals.get(language) ?? 0) + count), new Map<string, number>());
      const primaryLanguage = topCount(languages)?.[0] ?? "mixed";
      database.upsertEntity({
        id: componentId,
        type: "component",
        title: component.path,
        summary: `${component.files.length} files (${formatBytes(component.bytes)}), primarily ${primaryLanguage}${component.manifests.length ? `; manifests: ${component.manifests.join(", ")}` : ""}.`,
        status: "active",
        confidence: "observed",
        source: "repository",
        firstSeen: startedAt,
        lastSeen: startedAt,
        staleAfterDays: config.staleAfterDays,
        payload: {
          path: component.path,
          fileCount: component.files.length,
          bytes: component.bytes,
          languages: Object.fromEntries(languages),
          manifests: component.manifests,
        },
        primaryEvidenceId: evidence.id,
      }, [evidence.id], "component scan");
      const parentPath = component.path.includes("/") ? component.path.slice(0, component.path.lastIndexOf("/")) : null;
      const relationship = makeRelationship(
        parentPath ? componentIdForPath(parentPath) : projectId,
        componentId,
        "contains",
        evidence.id,
      );
      database.upsertRelationship(relationship);
      componentsObserved += 1;
      relationshipsObserved += 1;
    }

    for (const relativePath of safeFiles.filter(isManifestPath)) {
      const absolutePath = assertInside(root, relativePath);
      const raw = readSmallFile(absolutePath, 1_000_000);
      if (raw === null) continue;
      const findings = findSecrets(raw);
      const digest = sha256(raw);
      const evidence = makeEvidence("manifest", `file:${relativePath}`, digest, startedAt, findings.length > 0, {
        path: relativePath,
        secretFindingKinds: [...new Set(findings.map((finding) => finding.kind))],
      });
      database.upsertEvidence(evidence);
      if (findings.length > 0) {
        sensitiveItemsWithheld += 1;
        continue;
      }
      const manifest = parseManifest(relativePath, raw);
      if (!manifest) continue;
      const manifestId = `manifest:${slugify(relativePath)}-${sha256(relativePath).slice(0, 8)}`;
      database.upsertEntity({
        id: manifestId,
        type: "manifest",
        title: manifest.name,
        summary: `${manifest.kind} manifest with ${manifest.dependencies.length} runtime dependencies${manifest.description ? `: ${manifest.description}` : ""}.`,
        status: "active",
        confidence: "documented",
        source: "repository",
        firstSeen: startedAt,
        lastSeen: startedAt,
        staleAfterDays: config.staleAfterDays,
        payload: {
          path: relativePath,
          kind: manifest.kind,
          dependencies: manifest.dependencies,
          developmentDependencyCount: manifest.developmentDependencyCount,
        },
        primaryEvidenceId: evidence.id,
      }, [evidence.id], "manifest scan");
      const owner = nearestComponent(relativePath, componentIds) ?? projectId;
      database.upsertRelationship(makeRelationship(owner, manifestId, "defines", evidence.id));
      relationshipsObserved += 1;
      for (const dependency of manifest.dependencies.slice(0, 100)) {
        const dependencyId = `dependency:${manifest.kind.toLowerCase()}:${slugify(dependency)}-${sha256(dependency).slice(0, 6)}`;
        database.upsertEntity({
          id: dependencyId,
          type: "dependency",
          title: dependency,
          summary: `External ${manifest.kind} dependency declared by ${manifest.name}.`,
          status: "active",
          confidence: "documented",
          source: "repository",
          firstSeen: startedAt,
          lastSeen: startedAt,
          staleAfterDays: config.staleAfterDays,
          payload: { ecosystem: manifest.kind, declaredBy: relativePath },
          primaryEvidenceId: evidence.id,
        }, [evidence.id], "manifest dependency");
        database.upsertRelationship(makeRelationship(manifestId, dependencyId, "depends_on", evidence.id));
        relationshipsObserved += 1;
      }
    }

    for (const relativePath of safeFiles.filter(isContextDocumentPath)) {
      const absolutePath = assertInside(root, relativePath);
      const raw = readSmallFile(absolutePath, 256_000);
      if (raw === null) continue;
      const sanitized = sanitizeText(raw, 50_000);
      const evidence = makeEvidence("document", `file:${relativePath}`, sha256(raw), startedAt, sanitized.sensitive, {
        path: relativePath,
        secretFindingKinds: [...new Set(sanitized.findings.map((finding) => finding.kind))],
      });
      database.upsertEvidence(evidence);
      const decision = isDecisionDocument(relativePath);
      const extracted = sanitized.sensitive
        ? { title: path.posix.basename(relativePath), summary: "Content withheld because potential secrets were detected." }
        : extractDocumentSummary(relativePath, sanitized.value);
      if (sanitized.sensitive) sensitiveItemsWithheld += 1;
      const documentId = `${decision ? "decision" : "document"}:${slugify(relativePath)}-${sha256(relativePath).slice(0, 8)}`;
      database.upsertEntity({
        id: documentId,
        type: decision ? "decision" : "document",
        title: extracted.title,
        summary: extracted.summary,
        status: "active",
        confidence: "documented",
        source: "document",
        firstSeen: startedAt,
        lastSeen: startedAt,
        staleAfterDays: config.staleAfterDays,
        payload: { path: relativePath, contentWithheld: sanitized.sensitive },
        primaryEvidenceId: evidence.id,
      }, [evidence.id], decision ? "decision document scan" : "documentation scan");
      database.upsertRelationship(makeRelationship(nearestComponent(relativePath, componentIds) ?? projectId, documentId, decision ? "governed_by" : "documented_by", evidence.id));
      documentsObserved += 1;
      relationshipsObserved += 1;
    }

    const previouslySynchronizedHead = database.getMeta("last_synced_head");
    const previouslySynchronizedFingerprint = database.getMeta("last_synced_worktree_fingerprint");
    const previouslySynchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    database.markUnseenObservedEntities(startedAt);

    const approvedNarrative = database.getEntity("narrative:project-overview");
    const synchronizedHeadChanged = (previouslySynchronizedHead ?? "UNBORN") !== (repository.head ?? "UNBORN");
    const synchronizedWorktreeChanged = previouslySynchronizedFingerprint !== repository.workingTreeFingerprint;
    const guidanceDependenciesChanged = previouslySynchronizedGuidanceWatermark !== guidanceDependencies.watermark;
    const reviewedBoundaryChanged = Boolean(approvedNarrative
      && (synchronizedHeadChanged || synchronizedWorktreeChanged || guidanceDependenciesChanged || commitsAdded > 0));
    if (reviewedBoundaryChanged && approvedNarrative) {
      const supportingEvidence = approvedNarrative.primaryEvidenceId ? [approvedNarrative.primaryEvidenceId] : [];
      const assertionId = typeof approvedNarrative.payload.assertionId === "string" ? approvedNarrative.payload.assertionId : null;
      const previousAssertion = assertionId ? getAssertionFromDatabase(database, assertionId) : null;
      const staleReason = guidanceDependenciesChanged
        ? "Extraction-affecting configuration, ignore policy, schema, or extractor behavior changed after this overview was reviewed. Synchronization rebuilt observed state, but human guidance remains stale until the replacement proposal is reviewed."
        : synchronizedHeadChanged
          ? `Repository HEAD changed from ${(previouslySynchronizedHead ?? "UNBORN").slice(0, 12)} to ${(repository.head ?? "UNBORN").slice(0, 12)} after this overview was approved.`
          : commitsAdded > 0
            ? "New reachable Git history was indexed after this overview was approved, so the reviewed guidance must be revalidated."
            : "Repository working-tree content changed after this overview was approved, so synchronization cannot restore settled guidance without human review.";
      const staleAssertion = previousAssertion && (previousAssertion.lifecycle === "accepted" || previousAssertion.lifecycle === "stale")
        ? recordAssertionRevisionInDatabase(database, {
            supersedesId: previousAssertion.id,
            subjectId: previousAssertion.subjectId,
            predicate: previousAssertion.predicate,
            value: previousAssertion.value,
            scope: previousAssertion.scope,
            authority: "derived",
            confidence: "inferred",
            producer: "context-atlas:staleness-v1",
            lifecycle: "stale",
            reviewState: "accepted",
            validFrom: startedAt,
            recordedAt: startedAt,
            evidence: [
              ...previousAssertion.evidence,
              { evidenceId: repositoryEvidence.id, role: "context" as const },
            ],
            actor: "system:sync",
            action: "mark_stale",
            rationale: staleReason,
            metadata: {
              staleReason,
              staleFromHead: previouslySynchronizedHead,
              staleAtHead: repository.head,
              staleFromWorkingTreeFingerprint: previouslySynchronizedFingerprint,
              staleAtWorkingTreeFingerprint: repository.workingTreeFingerprint,
              staleFromGuidanceWatermark: previouslySynchronizedGuidanceWatermark,
              staleAtGuidanceWatermark: guidanceDependencies.watermark,
              ...(typeof previousAssertion.metadata.reviewedGuidanceWatermark === "string"
                ? { reviewedGuidanceWatermark: previousAssertion.metadata.reviewedGuidanceWatermark }
                : {}),
              invalidatedAssertionId: previousAssertion.id,
            },
          }, { transaction: false })
        : previousAssertion;
      database.upsertEntity({
        ...approvedNarrative,
        status: "stale",
        lastSeen: startedAt,
        payload: {
          ...approvedNarrative.payload,
          ...(staleAssertion ? { assertionId: staleAssertion.id, assertionLogicalId: staleAssertion.logicalId } : {}),
          staleReason,
          staleAtHead: repository.head,
          staleAtGuidanceWatermark: guidanceDependencies.watermark,
        },
      }, supportingEvidence, "repository changed after narrative approval");
    }

    if (commitEvidence.length > 0 || reviewedBoundaryChanged) {
      const recent = database.listEvents("", commitsAdded).slice(0, 8);
      const summary = commitEvidence.length > 0
        ? `${projectEntity.summary} Newly observed history: ${recent.map((event) => event.title).join("; ")}.`
        : `${projectEntity.summary} The indexed working-tree content changed without a new commit; re-review this observed snapshot before treating the overview as current guidance.`;
      const proposal = createContextProposal(
        projectId,
        summary,
        commitEvidence.length > 0 ? commitEvidence : [repositoryEvidence.id],
        sensitiveItemsWithheld > 0,
        guidanceDependencies.watermark,
        "Review the updated project overview",
      );
      database.createProposal(proposal);
      appendProposalLedger(root, database, proposal);
      proposalsCreated.push(proposal.id);
    } else if (!database.getEntity("narrative:project-overview") && !database.listProposals("pending").some((proposal) =>
      proposal.kind === "context_update"
      && proposal.payload.observedGuidanceWatermark === guidanceDependencies.watermark)) {
      const proposal = createContextProposal(
        projectId,
        projectEntity.summary,
        [repositoryEvidence.id],
        sensitiveItemsWithheld > 0,
        guidanceDependencies.watermark,
        "Approve the initial project overview",
      );
      database.createProposal(proposal);
      appendProposalLedger(root, database, proposal);
      proposalsCreated.push(proposal.id);
    }

    // Advance the synchronized boundary only after invalidating reviewed
    // guidance and staging its replacement proposal inside this transaction.
    database.setMeta("last_synced_head", repository.head ?? "UNBORN");
    database.setMeta("last_synced_worktree_fingerprint", repository.workingTreeFingerprint);
    database.setMeta("last_synced_guidance_watermark", guidanceDependencies.watermark);
    database.setMeta("last_synced_at", startedAt);

    const completedAt = nowIso();
    const result: SyncResult = {
      runId,
      repository,
      commitsAdded,
      componentsObserved,
      documentsObserved,
      relationshipsObserved,
      proposalsCreated,
      sensitiveItemsWithheld,
      truncatedFileScan: listed.truncated,
      truncatedHistory,
      startedAt,
      completedAt,
    };
    database.completeIngestionRun(runId, "completed", result, null);
    return result;
    });
    ingestionCommitted = true;
    flushLedgerOutbox(root, database);
    database.close();
    return syncResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!ingestionCommitted) database.completeIngestionRun(runId, "failed", {}, message);
    database.close();
    throw error;
  }
}

function collectComponents(root: string, files: string[], maxDepth: number): Map<string, ComponentAccumulator> {
  const components = new Map<string, ComponentAccumulator>();
  for (const relativePath of files) {
    const directory = posixPath(path.posix.dirname(relativePath));
    if (directory === ".") continue;
    const segments = directory.split("/");
    let bytes = 0;
    try { bytes = statSync(assertInside(root, relativePath)).size; } catch { /* file changed during scan */ }
    for (let depth = 1; depth <= Math.min(maxDepth, segments.length); depth += 1) {
      const componentPath = segments.slice(0, depth).join("/");
      const component = components.get(componentPath) ?? {
        path: componentPath,
        files: [],
        bytes: 0,
        extensions: new Map<string, number>(),
        manifests: [],
      };
      component.files.push(relativePath);
      component.bytes += bytes;
      const extension = path.posix.extname(relativePath).toLowerCase() || "[none]";
      component.extensions.set(extension, (component.extensions.get(extension) ?? 0) + 1);
      if (isManifestPath(relativePath)) component.manifests.push(path.posix.basename(relativePath));
      components.set(componentPath, component);
    }
  }
  return components;
}

function makeEvidence(
  kind: string,
  locator: string,
  digest: string,
  observedAt: string,
  sensitive: boolean,
  metadata: Record<string, unknown>,
): EvidenceRecord {
  return {
    id: `evidence_${sha256(`${kind}\0${locator}\0${digest}`).slice(0, 32)}`,
    kind,
    locator,
    digest,
    observedAt,
    sensitive,
    metadata,
  };
}

function makeRelationship(sourceId: string, targetId: string, type: string, evidenceId: string | null): RelationshipRecord {
  return {
    id: `relationship_${sha256(`${sourceId}\0${targetId}\0${type}`).slice(0, 32)}`,
    sourceId,
    targetId,
    type,
    confidence: "observed",
    evidenceId,
    active: true,
  };
}

function componentIdForPath(componentPath: string): string {
  return `component:${slugify(componentPath)}-${sha256(componentPath).slice(0, 8)}`;
}

function nearestComponent(relativePath: string, componentIds: Map<string, string>): string | null {
  let directory = posixPath(path.posix.dirname(relativePath));
  while (directory !== ".") {
    const found = componentIds.get(directory);
    if (found) return found;
    const parent = posixPath(path.posix.dirname(directory));
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function createContextProposal(
  projectId: string,
  summary: string,
  evidenceIds: string[],
  redactionsPresent: boolean,
  observedGuidanceWatermark: string,
  title = "Review newly observed project history",
): ProposalRecord {
  return {
    id: newId("proposal"),
    kind: "context_update",
    targetId: projectId,
    title,
    summary: sanitizeText(summary, 2_000).value,
    payload: {
      proposedNarrative: sanitizeText(summary, 2_000).value,
      observedGuidanceWatermark,
    },
    evidenceIds,
    riskFlags: ["requires-human-review", ...(redactionsPresent ? ["sensitive-content-withheld"] : [])],
    status: "pending",
    createdAt: nowIso(),
    reviewedAt: null,
    reviewNote: null,
    conflictGroup: null,
  };
}

function appendProposalLedger(root: string, database: AtlasDatabase, proposal: ProposalRecord): void {
  stageLedgerEntry(root, database, {
    kind: "proposal_created",
    actionId: proposal.id,
    payload: { kind: proposal.kind, targetId: proposal.targetId, evidenceIds: proposal.evidenceIds },
  });
}

function summarizeCommit(hash: string, files: string[]): string {
  const visible = files.filter((file) => !file.startsWith("[withheld:"));
  const displayed = visible.slice(0, 8);
  const withheld = files.length - visible.length;
  return `Commit ${hash.slice(0, 12)} changed ${files.length} file${files.length === 1 ? "" : "s"}${displayed.length ? ` (${displayed.join(", ")}${visible.length > displayed.length ? ", …" : ""})` : ""}${withheld > 0 ? `; ${withheld} path${withheld === 1 ? " was" : "s were"} withheld by policy` : ""}.`;
}

function presentCommitPath(
  relativePath: string,
  scanExclusions: string[],
  matchesAtlasIgnore: (relativePath: string) => boolean,
): string {
  const normalized = posixPath(relativePath);
  if (
    isSensitivePath(normalized)
    || isExcludedPath(normalized, scanExclusions)
    || matchesAtlasIgnore(normalized)
  ) {
    return `[withheld:${sha256(normalized).slice(0, 10)}]`;
  }
  return normalized;
}

function readSmallFile(filePath: string, maximumBytes: number): string | null {
  try {
    if (statSync(filePath).size > maximumBytes) return null;
    const buffer = readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function isManifestPath(relativePath: string): boolean {
  const base = path.posix.basename(posixPath(relativePath)).toLowerCase();
  return base === "package.json"
    || base === "cargo.toml"
    || base === "pyproject.toml"
    || base === "go.mod"
    || /^requirements(?:-[a-z0-9_.-]+)?\.txt$/.test(base);
}

function parseManifest(relativePath: string, raw: string): ManifestInfo | null {
  const base = path.posix.basename(posixPath(relativePath)).toLowerCase();
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const dependencies = parsed.dependencies && typeof parsed.dependencies === "object"
        ? Object.keys(parsed.dependencies as Record<string, unknown>).sort()
        : [];
      const developmentDependencyCount = parsed.devDependencies && typeof parsed.devDependencies === "object"
        ? Object.keys(parsed.devDependencies as Record<string, unknown>).length
        : 0;
      return {
        kind: "npm",
        name: typeof parsed.name === "string" ? sanitizeText(parsed.name, 200).value : relativePath,
        description: typeof parsed.description === "string" ? sanitizeText(parsed.description, 500).value : "",
        dependencies,
        developmentDependencyCount,
      };
    } catch { return null; }
  }
  if (base === "cargo.toml") {
    return parseSectionManifest("Cargo", relativePath, raw, /^\[(?:dependencies|workspace\.dependencies)\]$/m);
  }
  if (base === "go.mod") {
    const name = raw.match(/^module\s+([^\s]+)$/m)?.[1] ?? relativePath;
    const dependencies = [...raw.matchAll(/^\s*([\w./-]+)\s+v\d[^\s]*/gm)].map((match) => match[1] ?? "").filter(Boolean);
    return { kind: "Go", name, description: "", dependencies: [...new Set(dependencies)].sort(), developmentDependencyCount: 0 };
  }
  if (base.startsWith("requirements")) {
    const dependencies = raw.split(/\r?\n/)
      .map((line) => line.trim().split(/[<>=!~\[;]/)[0]?.trim() ?? "")
      .filter((line) => Boolean(line) && !line.startsWith("#") && !line.startsWith("-"));
    return { kind: "Python", name: relativePath, description: "", dependencies: [...new Set(dependencies)].sort(), developmentDependencyCount: 0 };
  }
  if (base === "pyproject.toml") {
    const name = raw.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? relativePath;
    const dependenciesBlock = raw.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
    const dependencies = [...dependenciesBlock.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((match) => match[1] ?? "").filter(Boolean);
    return { kind: "Python", name, description: "", dependencies: [...new Set(dependencies)].sort(), developmentDependencyCount: 0 };
  }
  return null;
}

function parseSectionManifest(kind: string, relativePath: string, raw: string, sectionPattern: RegExp): ManifestInfo {
  const name = raw.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? relativePath;
  const sectionMatch = sectionPattern.exec(raw);
  const sectionStart = sectionMatch ? (sectionMatch.index + sectionMatch[0].length) : raw.length;
  const section = raw.slice(sectionStart).split(/^\[/m)[0] ?? "";
  const dependencies = [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1] ?? "").filter(Boolean);
  return { kind, name, description: "", dependencies: [...new Set(dependencies)].sort(), developmentDependencyCount: 0 };
}

function isContextDocumentPath(relativePath: string): boolean {
  const normalized = posixPath(relativePath).toLowerCase();
  const base = path.posix.basename(normalized);
  return /^(readme|project|architecture|contributing|roadmap)(\.[a-z0-9_-]+)?\.md$/.test(base)
    || /(^|\/)docs\/(adr|adrs|decisions)\//.test(normalized)
    || /(^|\/)adr[-_]?\d+.*\.md$/.test(normalized);
}

function isDecisionDocument(relativePath: string): boolean {
  const normalized = posixPath(relativePath).toLowerCase();
  return /(^|\/)docs\/(adr|adrs|decisions)\//.test(normalized) || /(^|\/)adr[-_]?\d+/.test(normalized);
}

function extractDocumentSummary(relativePath: string, markdown: string): { title: string; summary: string } {
  const title = markdown.match(/^#{1,2}\s+(.+)$/m)?.[1]?.replace(/[*_`]/g, "").trim()
    || path.posix.basename(relativePath);
  const lines = markdown.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("![") || trimmed.startsWith("[![") || trimmed.startsWith("```")) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed.replace(/^[-*>]+\s*/, ""));
    if (paragraph.join(" ").length >= 400) break;
  }
  return { title: sanitizeText(title, 300).value, summary: sanitizeText(paragraph.join(" ") || `Documentation at ${relativePath}.`, 700).value };
}

function languageForExtension(extension: string): string {
  return LANGUAGE_BY_EXTENSION[extension] ?? (extension === "[none]" ? "extensionless" : extension.slice(1) || "unknown");
}

function topCount(map: Map<string, number>): [string, number] | undefined {
  return [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift",
  ".cs": "C#", ".cpp": "C++", ".c": "C", ".h": "C/C++", ".rb": "Ruby", ".php": "PHP",
  ".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".sql": "SQL", ".sh": "Shell", ".ps1": "PowerShell",
};
