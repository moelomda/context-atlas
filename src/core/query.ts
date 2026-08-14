import { AtlasDatabase } from "./database.js";
import { getHealthReport } from "./health.js";
import { queryAssertions } from "./temporal.js";
import type { EntityRecord, EvidenceRecord, GraphNode, GraphSnapshot, TimelineEvent } from "./types.js";
import { daysBetween, nowIso, relevanceScore } from "./util.js";

export interface SearchResult {
  id: string;
  kind: "entity" | "event";
  type: string;
  title: string;
  summary: string;
  score: number;
}

export function getOverview(repoRoot: string): Record<string, unknown> {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entities = database.listEntities();
    const project = entities.find((entity) => entity.type === "project");
    const narrative = database.getEntity("narrative:project-overview");
    const acceptedAssertions = queryAssertions(repoRoot);
    const overviewAssertion = acceptedAssertions.find((assertion) => assertion.predicate === "project.overview");
    const overviewValue = overviewAssertion?.value && typeof overviewAssertion.value === "object" && !Array.isArray(overviewAssertion.value)
      ? overviewAssertion.value as Record<string, unknown>
      : null;
    const canonicalSummary = typeof overviewValue?.summary === "string" ? overviewValue.summary : null;
    const health = getHealthReport(repoRoot, database);
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
        branch: project.payload.branch,
        head: project.payload.head,
        dirty: project.payload.dirty,
        repositoryId: project.payload.repositoryId,
        objectFormat: project.payload.objectFormat,
        defaultBranch: project.payload.defaultBranch,
        detached: project.payload.detached,
        shallow: project.payload.shallow,
        historyTruncated: project.payload.historyTruncated,
        confidence: overviewAssertion?.confidence ?? narrative?.confidence ?? project.confidence,
        primaryEvidenceId: overviewAssertion?.evidence.find((item) => item.role === "support")?.evidenceId ?? narrative?.primaryEvidenceId ?? project.primaryEvidenceId,
      } : null,
      generatedAt: nowIso(),
      stats: { entities: entities.length, byType, healthScore: health.score, pendingProposals: health.pendingProposals },
      summary: canonicalSummary ?? narrative?.summary ?? project?.summary ?? "No project snapshot is available. Run Context Atlas sync.",
      assertions: {
        current: acceptedAssertions.length,
        overview: overviewAssertion ? {
          id: overviewAssertion.id,
          logicalId: overviewAssertion.logicalId,
          revision: overviewAssertion.revision,
          authority: overviewAssertion.authority,
          confidence: overviewAssertion.confidence,
          lifecycle: overviewAssertion.lifecycle,
          validFrom: overviewAssertion.validFrom,
          recordedAt: overviewAssertion.recordedAt,
          evidence: overviewAssertion.evidence,
        } : null,
      },
      orientation: {
        purpose: readme ? {
          text: readme.summary,
          entityId: readme.id,
          confidence: readme.confidence,
          evidenceId: readme.primaryEvidenceId,
        } : null,
        architecture: components.map((component) => ({
          id: component.id,
          title: component.title,
          summary: component.summary,
          confidence: component.confidence,
          evidenceId: component.primaryEvidenceId,
        })),
        decisions: decisions.map((decision) => ({
          id: decision.id,
          title: decision.title,
          summary: decision.summary,
          confidence: decision.confidence,
          evidenceId: decision.primaryEvidenceId,
        })),
        setupSources: manifests.map((manifest) => ({ id: manifest.id, title: manifest.title, summary: manifest.summary, evidenceId: manifest.primaryEvidenceId })),
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
    const normalizedLimit = Number.isFinite(requestedNodeLimit) ? Math.floor(requestedNodeLimit) : 750;
    const nodeLimit = Math.max(1, Math.min(2_000, normalizedLimit));
    const entities = [...allEntities]
      .sort((left, right) => graphPriority(left.type) - graphPriority(right.type)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id))
      .slice(0, nodeLimit);
    const nodes: GraphNode[] = entities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      summary: entity.summary,
      status: entity.status,
      confidence: entity.confidence,
      stale: entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays,
      evidenceCount: database.entityEvidenceCount(entity.id),
    }));
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

export function searchAtlas(repoRoot: string, query: string, limit = 20): { results: SearchResult[]; generatedAt: string } {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entityResults = database.listEntities({ includeRemoved: true }).map((entity) => ({
      id: entity.id,
      kind: "entity" as const,
      type: entity.type,
      title: entity.title,
      summary: entity.summary,
      score: relevanceScore(query, entity.title, entity.summary, JSON.stringify(entity.payload)),
    }));
    const eventResults = database.listEvents("", 1_000).map((event) => ({
      id: event.id,
      kind: "event" as const,
      type: event.type,
      title: event.title,
      summary: event.summary,
      score: relevanceScore(query, event.title, event.summary, event.files.map((file) => file.path).join(" ")),
    }));
    const results = [...entityResults, ...eventResults]
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, Math.max(1, Math.min(100, limit)));
    return { results, generatedAt: nowIso() };
  } finally {
    database.close();
  }
}

export function explainEntity(repoRoot: string, target: string): Record<string, unknown> {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const entities = database.listEntities({ includeRemoved: true });
    const entity = database.getEntity(target) ?? findBestEntity(entities, target);
    if (!entity) throw new Error(`No entity matches: ${target}`);
    const relationships = database.listRelationships().filter((relationship) => relationship.sourceId === entity.id || relationship.targetId === entity.id);
    const relatedIds = new Set(relationships.flatMap((relationship) => [relationship.sourceId, relationship.targetId]));
    relatedIds.delete(entity.id);
    const related = entities.filter((candidate) => relatedIds.has(candidate.id)).map(compactEntity);
    const evidenceIds = new Set<string>();
    if (entity.primaryEvidenceId) evidenceIds.add(entity.primaryEvidenceId);
    for (const version of database.listEntityVersions(entity.id)) for (const id of version.evidenceIds) evidenceIds.add(id);
    const pathHint = typeof entity.payload.path === "string" ? entity.payload.path : entity.title;
    const history = database.listEvents("", 1_000).filter((event) =>
      event.title.toLowerCase().includes(target.toLowerCase())
      || event.files.some((file) => file.path.startsWith(pathHint)),
    ).slice(0, 50);
    return {
      entity,
      evidence: database.listEvidence([...evidenceIds]).map((item) => item.sensitive ? { ...item, metadata: { withheld: true } } : item),
      relationships,
      related,
      versions: database.listEntityVersions(entity.id),
      history,
      authorityNotice: "Observed and documented claims are evidence-backed but not guarantees of runtime correctness. Pending proposals are excluded.",
    };
  } finally {
    database.close();
  }
}

export function getEvidenceRecord(repoRoot: string, evidenceId: string): EvidenceRecord {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const evidence = database.getEvidence(evidenceId);
    if (!evidence) throw new Error(`Unknown evidence: ${evidenceId}`);
    return evidence.sensitive
      ? { ...evidence, locator: "[withheld]", metadata: { withheld: true } }
      : evidence;
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

function compactEntity(entity: EntityRecord): Record<string, unknown> {
  return { id: entity.id, type: entity.type, title: entity.title, summary: entity.summary, status: entity.status, confidence: entity.confidence };
}
