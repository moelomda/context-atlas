import { getCurrentGuidanceWatermark } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { validateEvidenceLocators } from "./evidence-validation.js";
import {
  getCanonicalProjectEntity,
  isCanonicalProjectOverviewAssertion,
  projectOverviewClaimProjection,
  projectOverviewWarning,
  queryPresentedAssertions,
} from "./claim-status.js";
import { getRepoStatus } from "./git.js";
import { getHealthReport } from "./health.js";
import { detectAssertionConflicts, queryAssertions } from "./temporal.js";
import type { EntityRecord, EvidenceRecord, GraphNode, GraphSnapshot, TimelineEvent } from "./types.js";
import { daysBetween, nowIso, relevanceScore } from "./util.js";

export interface SearchResult {
  id: string;
  kind: "entity" | "event";
  type: string;
  title: string;
  summary: string;
  score: number;
  status: "current" | "stale" | "conflicting" | "unknown" | "removed" | "historical";
  settled: boolean;
  reason: string;
  authority: string;
  evidenceIds: string[];
}

type EntityPresentationStatus = "current" | "stale" | "conflicting" | "removed" | "unknown";

function entityPresentationStatus(
  entity: EntityRecord,
  repositorySynchronized: boolean,
  unusableEvidenceIds: ReadonlySet<string>,
): EntityPresentationStatus {
  if (entity.status === "removed") return "removed";
  if (!entity.primaryEvidenceId || unusableEvidenceIds.has(entity.primaryEvidenceId)) return "unknown";
  if (!repositorySynchronized || entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays) return "stale";
  return "current";
}

function entityPresentationReason(
  entity: EntityRecord,
  repositorySynchronized: boolean,
  unusableEvidenceIds: ReadonlySet<string>,
): string {
  const status = entityPresentationStatus(entity, repositorySynchronized, unusableEvidenceIds);
  if (status === "current") return "Entity is evidence-backed and current for the synchronized repository snapshot; this is not proof of runtime correctness.";
  if (status === "removed") return "Entity is retained only as historical context because it is no longer in the current projection.";
  if (status === "unknown") return "Entity primary evidence is missing, invalid, policy-denied, or not locally validated.";
  return "Entity or repository freshness differs from the synchronized snapshot; treat this content as historical until revalidated.";
}

function canonicalOverviewAssertion(repoRoot: string, canonicalProjectId: string | null) {
  if (!canonicalProjectId) return undefined;
  return queryAssertions(repoRoot, { subjectId: canonicalProjectId, predicate: "project.overview" })
    .find((assertion) => isCanonicalProjectOverviewAssertion(assertion, canonicalProjectId));
}

function canonicalOverviewConflictIds(repoRoot: string, canonicalProjectId: string | null): Set<string> {
  if (!canonicalProjectId) return new Set();
  return new Set(detectAssertionConflicts(repoRoot, {
    subjectId: canonicalProjectId,
    predicate: "project.overview",
  })
    .filter((conflict) => conflict.scope === "project")
    .flatMap((conflict) => conflict.assertionIds));
}

export function getOverview(repoRoot: string): Record<string, unknown> {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entities = database.listEntities();
    const project = getCanonicalProjectEntity(database);
    const narrative = database.getEntity("narrative:project-overview");
    const acceptedAssertions = queryAssertions(repoRoot);
    const overviewAssertion = canonicalOverviewAssertion(repoRoot, project?.id ?? null);
    const overviewValue = overviewAssertion?.value && typeof overviewAssertion.value === "object" && !Array.isArray(overviewAssertion.value)
      ? overviewAssertion.value as Record<string, unknown>
      : null;
    const canonicalSummary = typeof overviewValue?.summary === "string" ? overviewValue.summary : null;
    const repository = getRepoStatus(repoRoot);
    const health = getHealthReport(repoRoot, database, repository);
    const overviewConflictIds = canonicalOverviewConflictIds(repoRoot, project?.id ?? null);
    const currentEvidenceIds = [
      ...(overviewAssertion?.evidence.map((item) => item.evidenceId) ?? []),
      ...entities.flatMap((entity) => entity.primaryEvidenceId ? [entity.primaryEvidenceId] : []),
    ];
    const unusableEvidenceIds = findUnusableEvidenceIds(repoRoot, database, currentEvidenceIds);
    const synchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    const overviewClaim = projectOverviewClaimProjection(
      overviewAssertion,
      narrative,
      database.getMeta("last_synced_head"),
      repository,
      database.getMeta("last_synced_worktree_fingerprint"),
      overviewConflictIds,
      unusableEvidenceIds,
      synchronizedGuidanceWatermark,
      project?.id ?? null,
    );
    const overviewWarning = projectOverviewWarning(overviewClaim);
    const projectPresentationStatus = project
      ? entityPresentationStatus(project, overviewClaim.repository.synchronized, unusableEvidenceIds)
      : "unknown";
    const projectPresentationReason = project
      ? entityPresentationReason(project, overviewClaim.repository.synchronized, unusableEvidenceIds)
      : "No current project entity is available.";
    const summary = overviewClaim.status === "current" && canonicalSummary
      ? canonicalSummary
      : overviewClaim.repository.synchronized && projectPresentationStatus === "current"
        ? project?.summary ?? "No project snapshot is available. Run Context Atlas sync."
        : projectPresentationStatus === "unknown"
          ? "Current project summary withheld because its primary evidence is missing, invalid, policy-denied, or not locally validated."
          : "Current project summary withheld because the repository changed after the last Context Atlas synchronization.";
    const currentAssertionCount = queryPresentedAssertions(repoRoot)
      .filter((assertion) => assertion.presentation.status === "current" && assertion.presentation.settled).length;
    const byType = Object.fromEntries(
      [...new Set(entities.map((entity) => entity.type))]
        .sort()
        .map((type) => [type, entities.filter((entity) => entity.type === type).length]),
    );
    const documents = entities.filter((entity) => entity.type === "document");
    const readme = documents.find((entity) => /readme/i.test(String(entity.payload.path ?? entity.title))) ?? documents[0];
    const components = entities.filter((entity) => entity.type === "component").slice(0, 12);
    const decisions = entities.filter((entity) => entity.type === "decision").slice(0, 10);
    const manifests = entities.filter((entity) => entity.type === "manifest").slice(0, 8);
    const unknowns: string[] = [];
    if (!readme) unknowns.push("Project purpose is not documented in a recognized README or project document.");
    if (decisions.length === 0) unknowns.push("No architectural decision records were found; rationale should be treated as unknown.");
    if (components.length === 0) unknowns.push("No component boundaries were inferred from repository directories.");
    unknowns.push("Runtime correctness and production behavior are not established by repository structure alone.");
    return {
      project: project ? {
        id: project.id,
        name: project.title,
        branch: repository.branch,
        head: repository.head,
        indexedHead: project.payload.head,
        dirty: repository.dirty,
        synchronized: overviewClaim.repository.synchronized,
        repositoryId: project.payload.repositoryId,
        objectFormat: project.payload.objectFormat,
        defaultBranch: project.payload.defaultBranch,
        detached: project.payload.detached,
        shallow: project.payload.shallow,
        historyTruncated: project.payload.historyTruncated,
        confidence: overviewClaim.status === "current" ? overviewAssertion?.confidence ?? narrative?.confidence ?? project.confidence : project.confidence,
        primaryEvidenceId: overviewClaim.status === "current"
          ? overviewAssertion?.evidence.find((item) => item.role === "support")?.evidenceId ?? narrative?.primaryEvidenceId ?? project.primaryEvidenceId
          : project.primaryEvidenceId,
        presentationStatus: projectPresentationStatus,
        settled: projectPresentationStatus === "current",
        reason: projectPresentationReason,
        authority: project.source,
        evidenceIds: project.primaryEvidenceId ? [project.primaryEvidenceId] : [],
      } : null,
      generatedAt: nowIso(),
      stats: { entities: entities.length, byType, healthScore: health.score, pendingProposals: health.pendingProposals },
      summary,
      summaryAuthority: overviewClaim.status === "current"
        ? "human-reviewed"
        : overviewClaim.repository.synchronized && projectPresentationStatus === "current" ? "observed" : "unknown",
      summaryReason: overviewClaim.status === "current"
        ? overviewClaim.reason
        : overviewClaim.repository.synchronized && projectPresentationStatus === "current"
          ? "The reviewed overview is unsettled, so this summary is limited to the synchronized observed repository snapshot."
          : projectPresentationStatus === "unknown" ? projectPresentationReason : overviewClaim.reason,
      warnings: [
        ...(overviewWarning ? [overviewWarning] : []),
        ...(project && projectPresentationStatus !== "current"
          ? [`project:${project.id} is ${projectPresentationStatus}: ${projectPresentationReason}`]
          : []),
      ],
      assertions: {
        current: currentAssertionCount,
        reviewed: acceptedAssertions.length,
        overview: { id: overviewClaim.assertionId, ...overviewClaim },
      },
      orientation: {
        purpose: readme ? {
          text: readme.summary,
          entityId: readme.id,
          confidence: readme.confidence,
          evidenceId: readme.primaryEvidenceId,
          status: entityPresentationStatus(readme, overviewClaim.repository.synchronized, unusableEvidenceIds),
          settled: entityPresentationStatus(readme, overviewClaim.repository.synchronized, unusableEvidenceIds) === "current",
          reason: entityPresentationReason(readme, overviewClaim.repository.synchronized, unusableEvidenceIds),
          authority: readme.source,
        } : null,
        architecture: components.map((component) => ({
          id: component.id,
          title: component.title,
          summary: component.summary,
          confidence: component.confidence,
          evidenceId: component.primaryEvidenceId,
          status: entityPresentationStatus(component, overviewClaim.repository.synchronized, unusableEvidenceIds),
          settled: entityPresentationStatus(component, overviewClaim.repository.synchronized, unusableEvidenceIds) === "current",
          reason: entityPresentationReason(component, overviewClaim.repository.synchronized, unusableEvidenceIds),
          authority: component.source,
        })),
        decisions: decisions.map((decision) => ({
          id: decision.id,
          title: decision.title,
          summary: decision.summary,
          confidence: decision.confidence,
          evidenceId: decision.primaryEvidenceId,
          status: entityPresentationStatus(decision, overviewClaim.repository.synchronized, unusableEvidenceIds),
          settled: entityPresentationStatus(decision, overviewClaim.repository.synchronized, unusableEvidenceIds) === "current",
          reason: entityPresentationReason(decision, overviewClaim.repository.synchronized, unusableEvidenceIds),
          authority: decision.source,
        })),
        setupSources: manifests.map((manifest) => ({
          id: manifest.id,
          title: manifest.title,
          summary: manifest.summary,
          evidenceId: manifest.primaryEvidenceId,
          status: entityPresentationStatus(manifest, overviewClaim.repository.synchronized, unusableEvidenceIds),
          settled: entityPresentationStatus(manifest, overviewClaim.repository.synchronized, unusableEvidenceIds) === "current",
          reason: entityPresentationReason(manifest, overviewClaim.repository.synchronized, unusableEvidenceIds),
          authority: manifest.source,
        })),
        unknowns,
        recommendedEntryPoints: [readme, ...manifests, ...components.slice(0, 4)].filter(Boolean).map((entity) => ({
          id: (entity as EntityRecord).id,
          title: (entity as EntityRecord).title,
          type: (entity as EntityRecord).type,
        })),
      },
      risks: health.checks.filter((item) => item.status === "warning" || item.status === "critical"),
      recentEvents: database.listEvents("", 10),
      authorityNotice: "Context Atlas explains supported project history and structure. It does not prove code correctness, and unknown rationale remains explicitly unknown.",
    };
  } finally {
    database.close();
  }
}

export function getGraph(repoRoot: string, requestedNodeLimit = 750): GraphSnapshot {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const allEntities = database.listEntities();
    const project = getCanonicalProjectEntity(database);
    const repository = getRepoStatus(repoRoot);
    const synchronizedHead = database.getMeta("last_synced_head");
    const synchronizedFingerprint = database.getMeta("last_synced_worktree_fingerprint");
    const synchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    const currentGuidanceWatermark = getCurrentGuidanceWatermark(repoRoot).watermark;
    const repositorySynchronized = (synchronizedHead ?? "UNBORN") === (repository.head ?? "UNBORN")
      && synchronizedFingerprint !== null
      && synchronizedFingerprint === repository.workingTreeFingerprint
      && synchronizedGuidanceWatermark !== null
      && synchronizedGuidanceWatermark === currentGuidanceWatermark;
    const narrative = allEntities.find((entity) => entity.id === "narrative:project-overview") ?? null;
    const overviewAssertion = canonicalOverviewAssertion(repoRoot, project?.id ?? null);
    const overviewConflictIds = canonicalOverviewConflictIds(repoRoot, project?.id ?? null);
    const unusableEvidenceIds = findUnusableEvidenceIds(
      repoRoot,
      database,
      [
        ...allEntities.flatMap((entity) => entity.primaryEvidenceId ? [entity.primaryEvidenceId] : []),
        ...(overviewAssertion?.evidence.map((item) => item.evidenceId) ?? []),
      ],
    );
    const overviewClaim = projectOverviewClaimProjection(
      overviewAssertion,
      narrative,
      synchronizedHead,
      repository,
      synchronizedFingerprint,
      overviewConflictIds,
      unusableEvidenceIds,
      synchronizedGuidanceWatermark,
      project?.id ?? null,
    );
    const normalizedLimit = Number.isFinite(requestedNodeLimit) ? Math.floor(requestedNodeLimit) : 750;
    const nodeLimit = Math.max(1, Math.min(2_000, normalizedLimit));
    const entities = [...allEntities]
      .sort((left, right) => graphPriority(left.type) - graphPriority(right.type)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id))
      .slice(0, nodeLimit);
    const nodes: GraphNode[] = entities.map((entity) => {
      const presentationStatus = entity.id === narrative?.id
        ? overviewClaim.status
        : entityPresentationStatus(entity, repositorySynchronized, unusableEvidenceIds);
      const reason = entity.id === narrative?.id
        ? overviewClaim.reason
        : entityPresentationReason(entity, repositorySynchronized, unusableEvidenceIds);
      return {
        id: entity.id,
        type: entity.type,
        title: entity.title,
        summary: entity.summary,
        status: entity.status,
        presentationStatus,
        settled: presentationStatus === "current",
        reason,
        authority: entity.id === narrative?.id ? overviewClaim.authority ?? entity.source : entity.source,
        evidenceIds: entity.id === narrative?.id
          ? overviewClaim.evidence.map((item) => item.evidenceId)
          : entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [],
        confidence: entity.confidence,
        stale: presentationStatus !== "current",
        evidenceCount: database.entityEvidenceCount(entity.id),
      };
    });
    const valid = new Set(nodes.map((node) => node.id));
    const allRelationships = database.listRelationships();
    const edges = allRelationships
      .filter((relationship) => valid.has(relationship.sourceId) && valid.has(relationship.targetId))
      .map((relationship) => ({ source: relationship.sourceId, target: relationship.targetId, type: relationship.type }));
    return {
      nodes,
      edges,
      generatedAt: nowIso(),
      nodeLimit,
      totalNodes: allEntities.length,
      totalEdges: allRelationships.length,
      truncated: entities.length < allEntities.length,
      warnings: nodes
        .filter((node) => !node.settled)
        .map((node) => `entity:${node.id} is ${node.presentationStatus}: ${node.reason}`),
    };
  } finally {
    database.close();
  }
}

function graphPriority(type: string): number {
  return {
    project: 0,
    narrative: 1,
    decision: 2,
    document: 3,
    manifest: 4,
    component: 5,
    dependency: 9,
  }[type] ?? 6;
}

export function getTimeline(repoRoot: string, query = "", limit = 200): { events: TimelineEvent[]; generatedAt: string } {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    return { events: database.listEvents(query, limit), generatedAt: nowIso() };
  } finally {
    database.close();
  }
}

export function searchAtlas(repoRoot: string, query: string, limit = 20): { results: SearchResult[]; warnings: string[]; generatedAt: string } {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entities = database.listEntities({ includeRemoved: true });
    const project = getCanonicalProjectEntity(database);
    const narrative = entities.find((entity) => entity.id === "narrative:project-overview") ?? null;
    const repository = getRepoStatus(repoRoot);
    const synchronizedHead = database.getMeta("last_synced_head");
    const synchronizedFingerprint = database.getMeta("last_synced_worktree_fingerprint");
    const synchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    const currentGuidanceWatermark = getCurrentGuidanceWatermark(repoRoot).watermark;
    const repositoryCurrent = (synchronizedHead ?? "UNBORN") === (repository.head ?? "UNBORN")
      && synchronizedFingerprint !== null
      && synchronizedFingerprint === repository.workingTreeFingerprint
      && synchronizedGuidanceWatermark !== null
      && synchronizedGuidanceWatermark === currentGuidanceWatermark;
    const overviewAssertion = canonicalOverviewAssertion(repoRoot, project?.id ?? null);
    const overviewConflictIds = canonicalOverviewConflictIds(repoRoot, project?.id ?? null);
    const unusableEvidenceIds = findUnusableEvidenceIds(
      repoRoot,
      database,
      [
        ...(overviewAssertion?.evidence.map((item) => item.evidenceId) ?? []),
        ...entities.flatMap((entity) => entity.primaryEvidenceId ? [entity.primaryEvidenceId] : []),
      ],
    );
    const overviewClaim = projectOverviewClaimProjection(
      overviewAssertion,
      narrative,
      synchronizedHead,
      repository,
      synchronizedFingerprint,
      overviewConflictIds,
      unusableEvidenceIds,
      synchronizedGuidanceWatermark,
      project?.id ?? null,
    );
    const entityResults: SearchResult[] = entities.map((entity) => {
      const expired = daysBetween(entity.lastSeen) > entity.staleAfterDays;
      const evidenceUnusable = !entity.primaryEvidenceId || unusableEvidenceIds.has(entity.primaryEvidenceId);
      const baseStatus: SearchResult["status"] = entity.status === "removed"
        ? "removed"
        : evidenceUnusable
          ? "unknown"
        : entity.status === "stale" || expired || !repositoryCurrent
          ? "stale"
          : "current";
      const status = entity.id === narrative?.id ? overviewClaim.status : baseStatus;
      const settled = status === "current";
      const reason = entity.id === narrative?.id
        ? overviewClaim.reason
        : status === "current"
          ? "Observed entity is current for the synchronized repository snapshot; this is not proof of runtime correctness."
          : status === "removed"
            ? "Entity is retained for history but is no longer present in the current observed projection."
            : status === "unknown" && evidenceUnusable
              ? "Entity primary evidence is missing, invalid, policy-denied, or not locally validated; this result is not settled."
            : !repositoryCurrent
              ? "Repository HEAD or working-tree content differs from the synchronized snapshot; treat this result as historical until synchronization."
              : "Entity freshness or lifecycle marks this result as unsettled historical context.";
      return {
        id: entity.id,
        kind: "entity" as const,
        type: entity.type,
        title: entity.title,
        summary: entity.summary,
        score: relevanceScore(query, entity.title, entity.summary, JSON.stringify(entity.payload)),
        status,
        settled,
        reason,
        authority: entity.id === narrative?.id ? overviewClaim.authority ?? entity.source : entity.source,
        evidenceIds: entity.id === narrative?.id
          ? overviewClaim.evidence.map((item) => item.evidenceId)
          : entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [],
      };
    });
    const eventResults = database.listEvents("", 1_000).map((event) => ({
      id: event.id,
      kind: "event" as const,
      type: event.type,
      title: event.title,
      summary: event.summary,
      score: relevanceScore(query, event.title, event.summary, event.files.map((file) => file.path).join(" ")),
      status: "historical" as const,
      settled: false,
      reason: "Immutable timeline evidence; historical events are not current-state guidance.",
      authority: "git-history",
      evidenceIds: [...event.evidence],
    }));
    const results = [...entityResults, ...eventResults]
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, Math.max(1, Math.min(100, limit)));
    const warnings = results
      .filter((result) => !result.settled || result.status !== "current")
      .map((result) => `${result.kind}:${result.id} is ${result.status}: ${result.reason}`);
    return { results, warnings, generatedAt: nowIso() };
  } finally {
    database.close();
  }
}

export function explainEntity(repoRoot: string, target: string): Record<string, unknown> {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entities = database.listEntities({ includeRemoved: true });
    const project = getCanonicalProjectEntity(database);
    const entity = database.getEntity(target) ?? findBestEntity(entities, target);
    if (!entity) throw new Error(`No entity matches: ${target}`);
    const relationships = database.listRelationships().filter((relationship) => relationship.sourceId === entity.id || relationship.targetId === entity.id);
    const relatedIds = new Set(relationships.flatMap((relationship) => [relationship.sourceId, relationship.targetId]));
    relatedIds.delete(entity.id);
    const relatedEntities = entities.filter((candidate) => relatedIds.has(candidate.id));
    const repository = getRepoStatus(repoRoot);
    const synchronizedHead = database.getMeta("last_synced_head");
    const synchronizedFingerprint = database.getMeta("last_synced_worktree_fingerprint");
    const synchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    const currentGuidanceWatermark = getCurrentGuidanceWatermark(repoRoot).watermark;
    const repositorySynchronized = (synchronizedHead ?? "UNBORN") === (repository.head ?? "UNBORN")
      && synchronizedFingerprint !== null
      && synchronizedFingerprint === repository.workingTreeFingerprint
      && synchronizedGuidanceWatermark !== null
      && synchronizedGuidanceWatermark === currentGuidanceWatermark;
    const narrative = entities.find((candidate) => candidate.id === "narrative:project-overview") ?? null;
    const overviewAssertion = canonicalOverviewAssertion(repoRoot, project?.id ?? null);
    const overviewConflictIds = canonicalOverviewConflictIds(repoRoot, project?.id ?? null);
    const currentEvidenceIds = [entity, ...relatedEntities]
      .flatMap((candidate) => candidate.primaryEvidenceId ? [candidate.primaryEvidenceId] : []);
    currentEvidenceIds.push(...(overviewAssertion?.evidence.map((item) => item.evidenceId) ?? []));
    const unusableEvidenceIds = findUnusableEvidenceIds(repoRoot, database, currentEvidenceIds);
    const overviewClaim = projectOverviewClaimProjection(
      overviewAssertion,
      narrative,
      synchronizedHead,
      repository,
      synchronizedFingerprint,
      overviewConflictIds,
      unusableEvidenceIds,
      synchronizedGuidanceWatermark,
      project?.id ?? null,
    );
    const presentationStatus = entity.id === narrative?.id
      ? overviewClaim.status
      : entityPresentationStatus(entity, repositorySynchronized, unusableEvidenceIds);
    const presentation = {
      status: presentationStatus,
      settled: presentationStatus === "current",
      reason: entity.id === narrative?.id
        ? overviewClaim.reason
        : entityPresentationReason(entity, repositorySynchronized, unusableEvidenceIds),
      authority: entity.id === narrative?.id ? overviewClaim.authority ?? entity.source : entity.source,
      evidenceIds: entity.id === narrative?.id
        ? overviewClaim.evidence.map((item) => item.evidenceId)
        : entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [],
    };
    const related = relatedEntities.map((candidate) => compactEntity(candidate, repositorySynchronized, unusableEvidenceIds));
    const evidenceIds = new Set<string>();
    if (entity.primaryEvidenceId) evidenceIds.add(entity.primaryEvidenceId);
    for (const version of database.listEntityVersions(entity.id)) for (const id of version.evidenceIds) evidenceIds.add(id);
    const pathHint = typeof entity.payload.path === "string" ? entity.payload.path : entity.title;
    const history = database.listEvents("", 1_000).filter((event) =>
      event.title.toLowerCase().includes(target.toLowerCase())
      || event.files.some((file) => file.path.startsWith(pathHint)),
    ).slice(0, 50);
    return {
      entity: { ...safePublicEntity(entity), presentation },
      presentation,
      evidence: database.listEvidence([...evidenceIds]).map(safeQueryEvidence),
      relationships,
      related,
      versions: database.listEntityVersions(entity.id).map((version) => ({
        ...version,
        snapshot: safePublicValue(version.snapshot),
      })),
      history,
      warnings: [
        ...(presentation.settled ? [] : [`entity:${entity.id} is ${presentation.status}: ${presentation.reason}`]),
        ...related
          .filter((candidate) => candidate.presentationStatus !== "current")
          .map((candidate) => `related entity:${String(candidate.id)} is ${String(candidate.presentationStatus)}: ${String(candidate.reason)}`),
      ],
      authorityNotice: "Observed and documented claims are evidence-backed but not guarantees of runtime correctness. Pending proposals are excluded.",
    };
  } finally {
    database.close();
  }
}

export function getEvidenceRecord(repoRoot: string, evidenceId: string) {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const evidence = database.getEvidence(evidenceId);
    if (!evidence) throw new Error(`Unknown evidence: ${evidenceId}`);
    const validation = validateEvidenceLocators(repoRoot, [evidence]).results[0];
    if (!validation) throw new Error(`Evidence validation produced no result: ${evidenceId}`);
    return {
      ...safeQueryEvidence(evidence),
      validation,
      permittedForCurrentUse: validation.outcome === "verified",
    };
  } finally {
    database.close();
  }
}

function findBestEntity(entities: EntityRecord[], target: string): EntityRecord | null {
  const normalized = target.toLowerCase();
  return entities
    .map((entity) => ({ entity, score: relevanceScore(normalized, entity.title, entity.id, String(entity.payload.path ?? "")) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entity ?? null;
}

function compactEntity(
  entity: EntityRecord,
  repositorySynchronized: boolean,
  unusableEvidenceIds: ReadonlySet<string>,
): Record<string, unknown> {
  const status = entityPresentationStatus(entity, repositorySynchronized, unusableEvidenceIds);
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    summary: entity.summary,
    status: entity.status,
    presentationStatus: status,
    settled: status === "current",
    reason: entityPresentationReason(entity, repositorySynchronized, unusableEvidenceIds),
    authority: entity.source,
    evidenceIds: entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [],
    confidence: entity.confidence,
  };
}

function safeQueryEvidence(evidence: EvidenceRecord): EvidenceRecord {
  return evidence.sensitive
    ? { ...evidence, locator: "[withheld]", metadata: { withheld: true } }
    : { ...evidence, metadata: {} };
}

function safePublicEntity(entity: EntityRecord): EntityRecord {
  return { ...entity, payload: safePublicValue(entity.payload) as Record<string, unknown> };
}

function safePublicValue(value: unknown): unknown {
  if (typeof value === "string") {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\")
      ? "[withheld:absolute-path]"
      : value;
  }
  if (Array.isArray(value)) return value.map(safePublicValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /^(?:gitCommonDir|canonicalRoot|repositoryRoot)$/i.test(key) ? "[withheld:absolute-path]" : safePublicValue(child),
    ]));
  }
  return value;
}

function findUnusableEvidenceIds(repoRoot: string, database: AtlasDatabase, evidenceIds: string[]): Set<string> {
  const uniqueIds = [...new Set(evidenceIds)];
  const records = database.listEvidence(uniqueIds);
  const resolved = new Set(records.map((item) => item.id));
  const validation = validateEvidenceLocators(repoRoot, records);
  return new Set([
    ...uniqueIds.filter((id) => !resolved.has(id)),
    ...validation.invalidEvidenceIds,
    ...validation.policyDeniedEvidenceIds,
    ...validation.unvalidatedEvidenceIds,
  ]);
}
