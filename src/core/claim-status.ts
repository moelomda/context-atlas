import { getCurrentGuidanceWatermark } from "./config.js";
import { AtlasDatabase } from "./database.js";
import { validateEvidenceLocators } from "./evidence-validation.js";
import { getRepoStatus } from "./git.js";
import { detectAssertionConflicts, getAssertion, queryAssertions, type AssertionQuery, type AssertionRecord } from "./temporal.js";
import type { EntityRecord, RepoStatus } from "./types.js";
import { daysBetween } from "./util.js";

export type ClaimProjectionStatus = "current" | "stale" | "conflicting" | "unknown";
export type AssertionPresentationStatus = ClaimProjectionStatus | "historical" | "proposed" | "rejected" | "superseded" | "withdrawn";

export interface AssertionPresentation {
  status: AssertionPresentationStatus;
  settled: boolean;
  reason: string;
  evidence: AssertionRecord["evidence"];
  scope: "current" | "as-of" | "history";
}

export type PresentedAssertion = AssertionRecord & { presentation: AssertionPresentation };

export function getCanonicalProjectEntity(database: AtlasDatabase): EntityRecord | null {
  const activeProjects = database.listEntities({ types: ["project"] });
  return activeProjects.length === 1 ? (activeProjects[0] as EntityRecord) : null;
}

export function isCanonicalProjectOverviewAssertion(
  assertion: Pick<AssertionRecord, "subjectId" | "predicate" | "scope">,
  canonicalProjectId: string | null,
): boolean {
  return (
    canonicalProjectId !== null &&
    assertion.subjectId === canonicalProjectId &&
    assertion.predicate === "project.overview" &&
    assertion.scope === "project"
  );
}

/**
 * A presentation-safe view of the reviewed project overview. The immutable
 * assertion remains available in `value`, but consumers must use `status` and
 * `settled` before presenting that value as current project guidance.
 */
export interface ProjectOverviewClaimProjection {
  predicate: "project.overview";
  status: ClaimProjectionStatus;
  settled: boolean;
  reason: string;
  assertionId: string | null;
  logicalId: string | null;
  revision: number | null;
  authority: AssertionRecord["authority"] | null;
  confidence: AssertionRecord["confidence"] | null;
  lifecycle: AssertionRecord["lifecycle"] | null;
  reviewState: AssertionRecord["reviewState"] | null;
  validFrom: string | null;
  recordedAt: string | null;
  evidence: AssertionRecord["evidence"];
  value: unknown;
  repository: {
    synchronized: boolean;
    synchronizedHead: string | null;
    currentHead: string | null;
    synchronizedGuidanceWatermark: string | null;
    currentGuidanceWatermark: string;
    reviewedGuidanceWatermark: string | null;
  };
}

export function projectOverviewClaimProjection(
  assertion: AssertionRecord | undefined,
  narrative: EntityRecord | null,
  synchronizedHead: string | null,
  repository: RepoStatus,
  synchronizedWorkingTreeFingerprint: string | null,
  conflictingAssertionIds: ReadonlySet<string> = new Set(),
  unusableEvidenceIds: ReadonlySet<string> = new Set(),
  synchronizedGuidanceWatermark: string | null = null,
  canonicalProjectId: string | null = null,
): ProjectOverviewClaimProjection {
  const canonicalAssertion = assertion && isCanonicalProjectOverviewAssertion(assertion, canonicalProjectId) ? assertion : undefined;
  const storedHead = synchronizedHead === "UNBORN" ? null : synchronizedHead;
  const currentHead = repository.head;
  const headSynchronized = (synchronizedHead ?? "UNBORN") === (currentHead ?? "UNBORN");
  const workingTreeSynchronized =
    synchronizedWorkingTreeFingerprint !== null && synchronizedWorkingTreeFingerprint === repository.workingTreeFingerprint;
  const currentGuidanceWatermark = getCurrentGuidanceWatermark(repository.root).watermark;
  const guidanceSynchronized = synchronizedGuidanceWatermark !== null && synchronizedGuidanceWatermark === currentGuidanceWatermark;
  const reviewedGuidanceWatermark = canonicalAssertion
    ? assertionGuidanceWatermark(canonicalAssertion)
    : entityGuidanceWatermark(narrative);
  const synchronized = headSynchronized && workingTreeSynchronized && guidanceSynchronized;
  const evidence =
    canonicalAssertion?.evidence ??
    (narrative?.primaryEvidenceId ? [{ evidenceId: narrative.primaryEvidenceId, role: "support" as const }] : []);
  const supportingEvidenceIds = evidence.filter((item) => item.role === "support").map((item) => item.evidenceId);
  const contradictingEvidenceIds = evidence.filter((item) => item.role === "contradict").map((item) => item.evidenceId);
  const hasActiveContradictingEvidence = canonicalAssertion?.lifecycle === "accepted" && contradictingEvidenceIds.length > 0;
  const hasSupportingEvidence = supportingEvidenceIds.length > 0 && supportingEvidenceIds.every((id) => !unusableEvidenceIds.has(id));

  let status: ClaimProjectionStatus = "unknown";
  let reason = "No human-reviewed project overview is available; only observed repository structure may be shown.";

  if (canonicalAssertion) {
    if (canonicalAssertion.lifecycle === "conflicting" || conflictingAssertionIds.has(canonicalAssertion.id)) {
      status = "conflicting";
      reason =
        metadataReason(canonicalAssertion) ??
        "Multiple active reviewed overview assertions disagree; no member of the conflict may be treated as settled project guidance.";
    } else if (hasActiveContradictingEvidence) {
      status = "conflicting";
      reason = `The reviewed overview has ${contradictingEvidenceIds.length} active contradicting evidence link${contradictingEvidenceIds.length === 1 ? "" : "s"}; it cannot be treated as settled project guidance.`;
    } else if (!reviewedGuidanceWatermark) {
      status = "unknown";
      reason =
        "This accepted overview predates guidance dependency tracking. Synchronize and complete a new human review before treating it as current.";
    } else if (reviewedGuidanceWatermark !== currentGuidanceWatermark) {
      status = "stale";
      reason =
        "Extraction-affecting configuration, ignore policy, configuration-schema version, or extractor behavior differs from the boundary reviewed for this overview. Review the synchronized replacement before relying on it.";
    } else if (!guidanceSynchronized) {
      status = "stale";
      reason =
        "The current guidance dependency watermark has not been synchronized. Synchronize and review affected guidance before relying on it.";
    } else if (!headSynchronized) {
      status = "stale";
      reason = `Repository HEAD changed from ${shortHead(storedHead)} to ${shortHead(currentHead)} after this overview was validated. Synchronize and review a new revision before relying on it.`;
    } else if (!workingTreeSynchronized) {
      status = "stale";
      reason =
        synchronizedWorkingTreeFingerprint === null
          ? "No synchronized working-tree fingerprint exists for this overview. Synchronize and review a new revision before relying on it."
          : `The working tree differs from the reviewed repository snapshot (${repository.changedFiles} current changed file${repository.changedFiles === 1 ? "" : "s"}). Commit or discard those changes, synchronize, and review the affected context before relying on this overview.`;
    } else if (canonicalAssertion.lifecycle === "stale" || narrative?.status === "stale" || entityExpired(narrative)) {
      status = "stale";
      reason =
        metadataReason(canonicalAssertion) ??
        entityReason(narrative) ??
        "The reviewed overview is outside its known freshness boundary and requires a new human-reviewed revision.";
    } else if (canonicalAssertion.authority !== "human") {
      status = "unknown";
      reason = `The latest overview revision has '${canonicalAssertion.authority}' authority, not attributed human authority, and cannot be presented as human-reviewed project guidance.`;
    } else if (!hasSupportingEvidence) {
      status = "unknown";
      reason = "The latest overview revision has no supporting evidence and cannot be presented as settled project guidance.";
    } else if (
      canonicalAssertion.lifecycle === "accepted" &&
      canonicalAssertion.reviewState === "accepted" &&
      narrative?.status === "active"
    ) {
      status = "current";
      reason = `Human-reviewed revision ${canonicalAssertion.revision} is validated against repository HEAD ${shortHead(currentHead)}.`;
    } else {
      reason = `The latest overview revision has lifecycle '${canonicalAssertion.lifecycle}' and cannot be presented as settled project guidance.`;
    }
  }

  return {
    predicate: "project.overview",
    status,
    settled: status === "current",
    reason,
    assertionId: canonicalAssertion?.id ?? null,
    logicalId: canonicalAssertion?.logicalId ?? null,
    revision: canonicalAssertion?.revision ?? null,
    authority: canonicalAssertion?.authority ?? null,
    confidence: canonicalAssertion?.confidence ?? null,
    lifecycle: canonicalAssertion?.lifecycle ?? null,
    reviewState: canonicalAssertion?.reviewState ?? null,
    validFrom: canonicalAssertion?.validFrom ?? null,
    recordedAt: canonicalAssertion?.recordedAt ?? null,
    evidence,
    value: canonicalAssertion?.value ?? null,
    repository: {
      synchronized,
      synchronizedHead: storedHead,
      currentHead,
      synchronizedGuidanceWatermark,
      currentGuidanceWatermark,
      reviewedGuidanceWatermark,
    },
  };
}

export function projectOverviewWarning(claim: ProjectOverviewClaimProjection): string | null {
  if (claim.status === "current") return null;
  return `project.overview is ${claim.status}: ${claim.reason}`;
}

/** Presentation contract for CLI/API/MCP assertion reads. Immutable lifecycle
 * fields remain untouched; `presentation` is the mandatory current-use state. */
export function queryPresentedAssertions(repoRoot: string, query: AssertionQuery = {}): PresentedAssertion[] {
  const assertions = queryAssertions(repoRoot, query);
  if (query.validAt || query.recordedAt) {
    return assertions.map((assertion) => ({
      ...assertion,
      presentation: historicalPresentation(assertion, "as-of"),
    }));
  }

  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const repository = getRepoStatus(repoRoot);
    const synchronizedHead = database.getMeta("last_synced_head");
    const synchronizedFingerprint = database.getMeta("last_synced_worktree_fingerprint");
    const synchronizedGuidanceWatermark = database.getMeta("last_synced_guidance_watermark");
    const currentGuidanceWatermark = getCurrentGuidanceWatermark(repoRoot).watermark;
    const repositoryCurrent =
      (synchronizedHead ?? "UNBORN") === (repository.head ?? "UNBORN") &&
      synchronizedFingerprint !== null &&
      synchronizedFingerprint === repository.workingTreeFingerprint &&
      synchronizedGuidanceWatermark !== null &&
      synchronizedGuidanceWatermark === currentGuidanceWatermark;
    const conflictIds = new Set(detectAssertionConflicts(repoRoot).flatMap((conflict) => conflict.assertionIds));
    const evidenceIds = [...new Set(assertions.flatMap((assertion) => assertion.evidence.map((item) => item.evidenceId)))];
    const evidenceRecords = database.listEvidence(evidenceIds);
    const resolvedEvidenceIds = new Set(evidenceRecords.map((item) => item.id));
    const validation = validateEvidenceLocators(repoRoot, evidenceRecords);
    const unusableEvidenceIds = new Set([
      ...evidenceIds.filter((id) => !resolvedEvidenceIds.has(id)),
      ...validation.invalidEvidenceIds,
      ...validation.policyDeniedEvidenceIds,
      ...validation.unvalidatedEvidenceIds,
    ]);
    const canonicalProject = getCanonicalProjectEntity(database);
    const canonicalProjectId = canonicalProject?.id ?? null;
    const overviewAssertion = assertions.find((assertion) => isCanonicalProjectOverviewAssertion(assertion, canonicalProjectId));
    const overviewProjection = overviewAssertion
      ? projectOverviewClaimProjection(
          overviewAssertion,
          database.getEntity("narrative:project-overview"),
          synchronizedHead,
          repository,
          synchronizedFingerprint,
          conflictIds,
          unusableEvidenceIds,
          synchronizedGuidanceWatermark,
          canonicalProjectId,
        )
      : null;

    return assertions.map((assertion) => {
      if (assertion.predicate === "project.overview" && !isCanonicalProjectOverviewAssertion(assertion, canonicalProjectId)) {
        return {
          ...assertion,
          presentation: {
            status: "unknown",
            settled: false,
            reason:
              "The project.overview predicate is reserved for the sole active project subject with project scope; this assertion cannot become global current guidance.",
            evidence: assertion.evidence,
            scope: "current",
          },
        };
      }
      if (isCanonicalProjectOverviewAssertion(assertion, canonicalProjectId) && conflictIds.has(assertion.id)) {
        return {
          ...assertion,
          presentation: {
            status: "conflicting",
            settled: false,
            reason:
              "Multiple active reviewed overview assertions disagree; no member of the conflict may be treated as settled project guidance.",
            evidence: assertion.evidence,
            scope: "current",
          },
        };
      }
      if (assertion.id === overviewProjection?.assertionId) {
        return {
          ...assertion,
          presentation: {
            status: overviewProjection.status,
            settled: overviewProjection.settled,
            reason: overviewProjection.reason,
            evidence: overviewProjection.evidence,
            scope: "current",
          },
        };
      }
      return {
        ...assertion,
        presentation: lifecyclePresentation(assertion, repositoryCurrent, conflictIds, unusableEvidenceIds, currentGuidanceWatermark),
      };
    });
  } finally {
    database.close();
  }
}

export function getPresentedAssertion(repoRoot: string, assertionId: string): PresentedAssertion | null {
  const assertion = getAssertion(repoRoot, assertionId);
  if (!assertion) return null;
  const current = queryPresentedAssertions(repoRoot, {
    subjectId: assertion.subjectId,
    predicate: assertion.predicate,
  }).find((candidate) => candidate.logicalId === assertion.logicalId);
  return current?.id === assertion.id ? current : { ...assertion, presentation: historicalPresentation(assertion, "history") };
}

export function assertionPresentationWarnings(assertions: PresentedAssertion[]): string[] {
  return assertions
    .filter((assertion) => assertion.presentation.scope === "current" && !assertion.presentation.settled)
    .map((assertion) => `${assertion.predicate} is ${assertion.presentation.status}: ${assertion.presentation.reason}`);
}

function lifecyclePresentation(
  assertion: AssertionRecord,
  repositoryCurrent: boolean,
  conflictingAssertionIds: ReadonlySet<string>,
  unusableEvidenceIds: ReadonlySet<string>,
  currentGuidanceWatermark: string,
): AssertionPresentation {
  const supportEvidenceIds = assertion.evidence.filter((item) => item.role === "support").map((item) => item.evidenceId);
  const contradictingEvidenceIds = assertion.evidence.filter((item) => item.role === "contradict").map((item) => item.evidenceId);
  const hasActiveContradictingEvidence = assertion.lifecycle === "accepted" && contradictingEvidenceIds.length > 0;
  const unsupported = supportEvidenceIds.length === 0 || supportEvidenceIds.some((id) => unusableEvidenceIds.has(id));
  const reviewedGuidanceWatermark = assertionGuidanceWatermark(assertion);
  const status: AssertionPresentationStatus =
    conflictingAssertionIds.has(assertion.id) || assertion.lifecycle === "conflicting" || hasActiveContradictingEvidence
      ? "conflicting"
      : assertion.lifecycle !== "accepted"
        ? assertion.lifecycle
        : !reviewedGuidanceWatermark
          ? "unknown"
          : reviewedGuidanceWatermark !== currentGuidanceWatermark || !repositoryCurrent
            ? "stale"
            : assertion.authority === "inferred" || unsupported || assertion.reviewState !== "accepted"
              ? "unknown"
              : "current";
  const reason =
    status === "current"
      ? `Accepted revision ${assertion.revision} has ${assertion.authority} authority, resolved supporting evidence, and matches the synchronized repository snapshot; this is not proof of code correctness.`
      : status === "conflicting"
        ? hasActiveContradictingEvidence
          ? `The assertion has ${contradictingEvidenceIds.length} active contradicting evidence link${contradictingEvidenceIds.length === 1 ? "" : "s"}; it cannot be settled current guidance.`
          : "Multiple active assertions disagree for this scalar claim; no member is settled current guidance."
        : status === "stale" && assertion.lifecycle === "accepted"
          ? reviewedGuidanceWatermark !== currentGuidanceWatermark
            ? "Extraction-affecting configuration, ignore policy, schema, or extractor behavior differs from this assertion's reviewed boundary; re-review it before use."
            : "Repository HEAD, working-tree content, or guidance dependencies differ from the synchronized snapshot; this accepted revision is historical until revalidated."
          : status === "unknown" && !reviewedGuidanceWatermark
            ? "This accepted assertion predates guidance dependency tracking and is unsettled until it is re-reviewed."
            : status === "unknown" && assertion.authority === "inferred"
              ? "An inferred assertion cannot become settled current guidance merely because its row is marked accepted."
              : status === "unknown" && unsupported
                ? "The assertion lacks resolved, policy-permitted supporting evidence and cannot be settled."
                : (metadataReason(assertion) ??
                  `The selected revision has lifecycle '${assertion.lifecycle}' and is not settled current guidance.`);
  return {
    status,
    settled: status === "current",
    reason,
    evidence: assertion.evidence,
    scope: "current",
  };
}

function historicalPresentation(assertion: AssertionRecord, scope: "as-of" | "history"): AssertionPresentation {
  return {
    status: "historical",
    settled: false,
    reason:
      scope === "as-of"
        ? "This assertion was selected by an explicit temporal as-of query and must not be presented as current project guidance."
        : `This is immutable revision ${assertion.revision} retained for history; inspect the current projection before relying on it.`,
    evidence: assertion.evidence,
    scope,
  };
}

function metadataReason(assertion: AssertionRecord): string | null {
  const value = assertion.metadata.staleReason ?? assertion.metadata.conflictReason;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertionGuidanceWatermark(assertion: AssertionRecord | undefined): string | null {
  const value = assertion?.metadata.reviewedGuidanceWatermark;
  return isGuidanceWatermark(value) ? value : null;
}

function entityGuidanceWatermark(entity: EntityRecord | null): string | null {
  const value = entity?.payload.reviewedGuidanceWatermark;
  return isGuidanceWatermark(value) ? value : null;
}

function isGuidanceWatermark(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function entityReason(entity: EntityRecord | null): string | null {
  const value = entity?.payload.staleReason;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function entityExpired(entity: EntityRecord | null): boolean {
  return Boolean(entity && daysBetween(entity.lastSeen) > entity.staleAfterDays);
}

function shortHead(head: string | null): string {
  return head ? head.slice(0, 12) : "UNBORN";
}
