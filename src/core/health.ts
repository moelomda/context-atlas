import { AtlasDatabase } from "./database.js";
import {
  getCanonicalProjectEntity,
  isCanonicalProjectOverviewAssertion,
  projectOverviewClaimProjection,
} from "./claim-status.js";
import { validateEvidenceLocators } from "./evidence-validation.js";
import { getCurrentGuidanceWatermark, loadConfig } from "./config.js";
import { getRepoStatus } from "./git.js";
import { readVerifiedLedgerStateEntries, verifyLedgerState } from "./ledger.js";
import { detectAssertionConflicts, queryAssertions } from "./temporal.js";
import type { ComponentHealth, HealthCheck, HealthReport, RepoStatus } from "./types.js";
import { daysBetween, nowIso, safeJsonParse, sha256 } from "./util.js";

export function getHealthReport(repoRoot: string, database?: AtlasDatabase, knownRepository?: RepoStatus): HealthReport {
  const ownsDatabase = !database;
  const db = database ?? new AtlasDatabase(repoRoot, { readOnly: true });
  const checks: HealthCheck[] = [];

  const quickCheck = db.quickCheck();
  checks.push(check(
    "database-integrity",
    "Knowledge database integrity",
    quickCheck === "ok" ? "pass" : "critical",
    quickCheck === "ok" ? 0 : 3,
    quickCheck === "ok" ? "SQLite integrity check passed." : `SQLite reported: ${quickCheck}`,
    quickCheck === "ok" ? "No action required." : "Restore from a known-good copy and rerun synchronization.",
  ));

  const ledger = verifyLedgerState(repoRoot, db);
  const ledgerMatches = ledger.valid && ledger.consistent;
  checks.push(check(
    "ledger-integrity",
    "Append-only history integrity",
    ledgerMatches ? "pass" : "critical",
    ledgerMatches ? 0 : 3,
    ledgerMatches
      ? `${ledger.entries} durable hash-chained ledger entries verified${ledger.unflushedEntries > 0 ? `; ${ledger.unflushedEntries} recoverable outbox entr${ledger.unflushedEntries === 1 ? "y is" : "ies are"} awaiting reconciliation` : ""}.`
      : ledger.error ?? `Ledger head ${ledger.head.slice(0, 12)} does not match expected head ${ledger.expectedHead.slice(0, 12)}.`,
    ledgerMatches ? "Commit the ledger with the project so future changes remain reviewable." : "Stop context updates, preserve both files, and investigate tampering or an interrupted write.",
  ));

  const outboxRecoveryBlocked = ledger.unflushedEntries > 0 && !ledger.consistent;
  checks.push(check(
    "ledger-outbox",
    "Audit outbox recovery",
    ledger.unflushedEntries === 0 ? "pass" : "warning",
    ledger.unflushedEntries === 0 ? 0 : 2,
    ledger.unflushedEntries === 0
      ? "No committed audit entries are waiting for durable ledger reconciliation."
      : outboxRecoveryBlocked
        ? `${ledger.unflushedEntries} committed audit entr${ledger.unflushedEntries === 1 ? "y remains" : "ies remain"} in the outbox, but automatic reconciliation is blocked by inconsistent ledger state.`
        : `${ledger.unflushedEntries} committed audit entr${ledger.unflushedEntries === 1 ? "y has" : "ies have"} a flush receipt pending; ${ledger.physicallyPendingEntries} still require a file append.`,
    ledger.unflushedEntries === 0
      ? "No action required."
      : outboxRecoveryBlocked
        ? "Do not retry or edit either file automatically; preserve the database and ledger for interrupted-write or tamper investigation."
        : "Run `context-atlas recover-ledger` before another handoff; do not edit the ledger manually.",
  ));

  const eventAnchors = db.listEventIntegrityRecords();
  let invalidEventAnchors: Array<{ id: string; reason: string }> = [];
  if (ledgerMatches) {
    try {
      const ledgerEntries = readVerifiedLedgerStateEntries(repoRoot, db);
      const entryByHash = new Map(ledgerEntries.map((entry) => [entry.hash, entry]));
      const anchorUseCount = new Map<string, number>();
      for (const event of eventAnchors) {
        if (event.ledgerHash) anchorUseCount.set(event.ledgerHash, (anchorUseCount.get(event.ledgerHash) ?? 0) + 1);
      }
      invalidEventAnchors = eventAnchors.flatMap((event) => {
        if (!event.contentDigest || event.contentDigest !== event.computedContentDigest) {
          return [{ id: event.id, reason: "content-digest mismatch" }];
        }
        if (!event.ledgerHash) return [{ id: event.id, reason: "missing ledger link" }];
        if (!event.bindingDigest || event.bindingDigest !== event.computedBindingDigest) {
          return [{ id: event.id, reason: "content/ledger binding mismatch" }];
        }
        const entry = entryByHash.get(event.ledgerHash);
        if (!entry) return [{ id: event.id, reason: "unknown ledger link" }];
        if (entry.actionId !== event.id) return [{ id: event.id, reason: "action-ID mismatch" }];
        if (anchorUseCount.get(event.ledgerHash) !== 1) return [{ id: event.id, reason: "reused ledger link" }];
        if (!eventLedgerKindMatches(event.id, event.type, entry.kind)) {
          return [{ id: event.id, reason: `ledger kind '${entry.kind}' is invalid for '${event.type}'` }];
        }
        return [];
      });
    } catch {
      invalidEventAnchors = eventAnchors.map((event) => ({ id: event.id, reason: "ledger state could not be verified" }));
    }
  } else {
    invalidEventAnchors = eventAnchors.map((event) => ({ id: event.id, reason: "ledger state is inconsistent" }));
  }
  const invalidEventAnchorPreview = invalidEventAnchors.slice(0, 8)
    .map((event) => `${event.id} (${event.reason})`)
    .join(", ");
  checks.push(check(
    "event-ledger-coverage",
    "Timeline content and ledger integrity",
    invalidEventAnchors.length === 0 ? "pass" : "critical",
    invalidEventAnchors.length === 0 ? 0 : 3,
    invalidEventAnchors.length === 0
      ? `Every one of ${eventAnchors.length} timeline event${eventAnchors.length === 1 ? "" : "s"} has immutable content, a matching content/ledger binding, and one domain-correct verified ledger action.`
      : `${invalidEventAnchors.length} timeline event${invalidEventAnchors.length === 1 ? " has" : "s have"} invalid content or ledger semantics: ${invalidEventAnchorPreview}${invalidEventAnchors.length > 8 ? `, plus ${invalidEventAnchors.length - 8} more` : ""}.`,
    invalidEventAnchors.length === 0 ? "No action required." : "Stop synchronization; preserve the database and ledger, then recover from a verified backup or investigate an interrupted/tampered write.",
  ));

  const repository = knownRepository ?? getRepoStatus(repoRoot);
  const maxCommits = loadConfig(repoRoot).config.maxCommits;
  const syncedHead = db.getMeta("last_synced_head");
  const synchronizedWorkingTreeFingerprint = db.getMeta("last_synced_worktree_fingerprint");
  const currentHead = repository.head ?? "UNBORN";
  const synchronizedGuidanceWatermark = db.getMeta("last_synced_guidance_watermark");
  const currentGuidanceWatermark = getCurrentGuidanceWatermark(repoRoot).watermark;
  const headSynchronized = syncedHead === currentHead;
  const guidanceSynchronized = synchronizedGuidanceWatermark !== null
    && synchronizedGuidanceWatermark === currentGuidanceWatermark;
  const workingTreeSynchronized = synchronizedWorkingTreeFingerprint !== null
    && synchronizedWorkingTreeFingerprint === repository.workingTreeFingerprint;
  const synchronized = headSynchronized && workingTreeSynchronized && guidanceSynchronized;
  checks.push(check(
    "repository-sync",
    "Repository synchronization",
    synchronized ? "pass" : "warning",
    synchronized ? 0 : 2,
    synchronized
      ? `Knowledge is synchronized to ${currentHead.slice(0, 12)} with the current extraction-policy watermark.`
      : !headSynchronized
        ? `Repository is at ${currentHead.slice(0, 12)}, but Context Atlas recorded ${syncedHead?.slice(0, 12) ?? "no sync"}.`
        : !workingTreeSynchronized
          ? "Repository HEAD matches the index, but working-tree content differs from the synchronized guidance boundary."
        : "Repository HEAD matches the index, but extraction-affecting configuration, ignore policy, schema, or extractor behavior differs from the synchronized guidance boundary.",
    synchronized ? "Run sync after meaningful commits." : "Run `context-atlas sync` before relying on generated context.",
  ));

  checks.push(check(
    "working-tree",
    "Uncommitted changes",
    repository.dirty ? "info" : "pass",
    0,
    repository.dirty ? `${repository.changedFiles} uncommitted path${repository.changedFiles === 1 ? " is" : "s are"} outside the immutable Git history.` : "Working tree is clean.",
    repository.dirty ? "Commit or explicitly describe unfinished work before handing the project to another person or model." : "No action required.",
  ));

  const historyIncomplete = repository.shallow || repository.reachableCommits > maxCommits;
  checks.push(check(
    "history-completeness",
    "Reachable history completeness",
    historyIncomplete ? "warning" : "pass",
    historyIncomplete ? 2 : 0,
    repository.shallow
      ? "The repository is a shallow clone, so its founding history may be unavailable."
      : historyIncomplete
        ? `${repository.reachableCommits} commits are reachable, above the configured ${maxCommits}-commit ingestion limit.`
        : `All ${repository.reachableCommits} reachable commits fit within the configured ingestion limit.`,
    historyIncomplete
      ? "Fetch full history or raise maxCommits deliberately, then resynchronize before claiming a start-to-now timeline."
      : "No action required.",
  ));

  const entities = db.listEntities();
  const stale = entities.filter((entity) => entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays);
  checks.push(check(
    "stale-context",
    "Stale context",
    stale.length === 0 ? "pass" : "warning",
    stale.length === 0 ? 0 : 2,
    stale.length === 0 ? "All active items are within their freshness window." : `${stale.length} active item${stale.length === 1 ? " is" : "s are"} older than the configured freshness window.`,
    stale.length === 0 ? "No action required." : "Synchronize, review the affected entities, and supersede obsolete decisions.",
  ));

  const missingEvidence = db.countMissingPrimaryEvidence();
  checks.push(check(
    "evidence-coverage",
    "Claim evidence coverage",
    missingEvidence === 0 ? "pass" : "critical",
    missingEvidence === 0 ? 0 : 3,
    missingEvidence === 0 ? "Every active entity has primary evidence." : `${missingEvidence} active item${missingEvidence === 1 ? " has" : "s have"} no valid primary evidence.`,
    missingEvidence === 0 ? "Keep evidence attached to every accepted claim." : "Do not present unsupported items as project truth; attach evidence or supersede them.",
  ));

  const currentAssertionEvidence = db.db.prepare(`
    SELECT DISTINCT ae.evidence_id
    FROM assertion_evidence ae
    JOIN assertions a ON a.id = ae.assertion_id
    WHERE a.lifecycle IN ('accepted', 'conflicting')
      AND NOT EXISTS (SELECT 1 FROM assertions successor WHERE successor.supersedes_id = a.id)
  `).all() as Array<{ evidence_id: string }>;
  const currentEvidenceIds = [...new Set([
    ...entities
      .filter((entity) => entity.status !== "removed" && entity.status !== "superseded" && entity.status !== "stale")
      .map((entity) => entity.primaryEvidenceId)
      .filter((id): id is string => Boolean(id)),
    ...db.listRelationships().filter((relationship) => relationship.active && relationship.evidenceId)
      .map((relationship) => relationship.evidenceId as string),
    ...currentAssertionEvidence.map((row) => String(row.evidence_id)),
  ])];
  const currentEvidenceRecords = db.listEvidence(currentEvidenceIds);
  const resolvedCurrentEvidenceIds = new Set(currentEvidenceRecords.map((item) => item.id));
  const evidenceValidation = validateEvidenceLocators(repoRoot, currentEvidenceRecords);
  const unusableCurrentEvidenceIds = new Set([
    ...currentEvidenceIds.filter((id) => !resolvedCurrentEvidenceIds.has(id)),
    ...evidenceValidation.invalidEvidenceIds,
    ...evidenceValidation.policyDeniedEvidenceIds,
    ...evidenceValidation.unvalidatedEvidenceIds,
  ]);
  const invalidCurrentEvidence = evidenceValidation.results.filter((item) => item.outcome !== "verified");
  const validationSummary = invalidCurrentEvidence
    .slice(0, 8)
    .map((item) => `${item.evidenceId} (${item.status})`)
    .join(", ");
  checks.push(check(
    "evidence-locator-integrity",
    "Current evidence locator and digest integrity",
    invalidCurrentEvidence.length === 0 ? "pass" : "critical",
    invalidCurrentEvidence.length === 0 ? 0 : 3,
    invalidCurrentEvidence.length === 0
      ? `${evidenceValidation.verifiedEvidenceIds.length} evidence record${evidenceValidation.verifiedEvidenceIds.length === 1 ? "" : "s"} reachable from the current projection passed file, Git, repository, or component validation. Immutable historical rows outside the current projection were not compared with today's working tree.`
      : `${invalidCurrentEvidence.length} current-projection evidence record${invalidCurrentEvidence.length === 1 ? " is" : "s are"} missing, changed, unreachable, unsafe, unreadable, policy-denied, or unsupported: ${validationSummary}${invalidCurrentEvidence.length > 8 ? `, plus ${invalidCurrentEvidence.length - 8} more` : ""}.`,
    invalidCurrentEvidence.length === 0
      ? "Resynchronize after repository changes; use provider-specific validators before introducing a new locator kind."
      : "Do not rely on affected claims or generate authoritative context. Pre-change stores with legacy non-SHA-256 evidence digests require rebuilding the derived index or an explicit migration; an ordinary sync cannot make a legacy digest valid. Otherwise restore the exact source or synchronize and review replacement evidence.",
  ));

  const assertionIntegrity = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM assertions a
    WHERE (a.authority <> 'human' AND NOT EXISTS (
      SELECT 1 FROM assertion_evidence ae WHERE ae.assertion_id = a.id AND ae.role = 'support'
    ))
    OR (a.authority = 'human' AND NOT EXISTS (
      SELECT 1 FROM review_actions ra WHERE ra.assertion_id = a.id AND ra.actor LIKE 'human:%'
    ))
    OR (a.lifecycle = 'proposed' AND a.review_state <> 'unreviewed')
    OR (a.lifecycle <> 'proposed' AND a.review_state = 'unreviewed')
  `).get() as Record<string, unknown>;
  const invalidAssertions = Number(assertionIntegrity.count ?? 0);
  checks.push(check(
    "assertion-integrity",
    "Canonical assertion integrity",
    invalidAssertions === 0 ? "pass" : "critical",
    invalidAssertions === 0 ? 0 : 3,
    invalidAssertions === 0
      ? "Every canonical assertion satisfies its evidence, authority, lifecycle, and review invariants."
      : `${invalidAssertions} canonical assertion revision${invalidAssertions === 1 ? " violates" : "s violate"} evidence or review invariants.`,
    invalidAssertions === 0 ? "No action required." : "Stop authoritative projection and repair or import a verified canonical assertion history.",
  ));

  const currentAcceptedAssertionMetadata = db.db.prepare(`
    SELECT a.id, a.metadata_json
    FROM assertions a
    WHERE a.lifecycle = 'accepted' AND a.review_state = 'accepted'
      AND NOT EXISTS (SELECT 1 FROM assertions successor WHERE successor.supersedes_id = a.id)
    ORDER BY a.id
  `).all() as Array<{ id: string; metadata_json: string }>;
  const invalidGuidanceBoundaries = currentAcceptedAssertionMetadata.filter((row) => {
    const metadata = safeJsonParse<Record<string, unknown>>(row.metadata_json, {});
    return typeof metadata.reviewedGuidanceWatermark !== "string"
      || !/^[a-f0-9]{64}$/.test(metadata.reviewedGuidanceWatermark)
      || metadata.reviewedGuidanceWatermark !== currentGuidanceWatermark;
  });
  checks.push(check(
    "assertion-guidance-boundary",
    "Reviewed assertion guidance boundary",
    invalidGuidanceBoundaries.length === 0 ? "pass" : "critical",
    invalidGuidanceBoundaries.length === 0 ? 0 : 3,
    invalidGuidanceBoundaries.length === 0
      ? `${currentAcceptedAssertionMetadata.length} current accepted assertion${currentAcceptedAssertionMetadata.length === 1 ? "" : "s"} carry the current reviewed guidance dependency watermark.`
      : `${invalidGuidanceBoundaries.length} current accepted assertion${invalidGuidanceBoundaries.length === 1 ? " is" : "s are"} missing or mismatched against the current extraction-policy watermark: ${invalidGuidanceBoundaries.slice(0, 8).map((row) => row.id).join(", ")}${invalidGuidanceBoundaries.length > 8 ? `, plus ${invalidGuidanceBoundaries.length - 8} more` : ""}.`,
    invalidGuidanceBoundaries.length === 0
      ? "No action required."
      : "Treat these assertions as stale or unknown; synchronize and record new reviewed revisions before authoritative use.",
  ));

  const assertionConflicts = detectAssertionConflicts(repoRoot);
  checks.push(check(
    "assertion-conflicts",
    "Incompatible active assertions",
    assertionConflicts.length === 0 ? "pass" : "critical",
    assertionConflicts.length === 0 ? 0 : 3,
    assertionConflicts.length === 0
      ? "No incompatible accepted scalar assertions overlap at the current valid and recorded time."
      : `${assertionConflicts.length} subject/predicate scope${assertionConflicts.length === 1 ? " has" : "s have"} incompatible accepted values.`,
    assertionConflicts.length === 0 ? "No action required." : "Preserve both claims, inspect their evidence, and record an explicit temporal or scope resolution.",
  ));

  const overrideRows = db.db.prepare("SELECT id, actor, reason, reason_digest, critical_digest, created_at, expires_at FROM context_pack_overrides")
    .all() as Array<Record<string, unknown>>;
  const invalidOverrides = overrideRows.filter((row) => !/^pack_override_[a-f0-9]{24}$/.test(String(row.id))
    || !/^human:[a-zA-Z0-9._@-]{1,200}$/.test(String(row.actor))
    || sha256(String(row.reason)) !== String(row.reason_digest)
    || !/^[a-f0-9]{64}$/.test(String(row.critical_digest))
    || !Number.isFinite(Date.parse(String(row.created_at)))
    || Date.parse(String(row.expires_at)) <= Date.parse(String(row.created_at)));
  checks.push(check(
    "pack-override-integrity",
    "Context-pack override integrity",
    invalidOverrides.length === 0 ? "pass" : "critical",
    invalidOverrides.length === 0 ? 0 : 3,
    invalidOverrides.length === 0
      ? `${overrideRows.length} immutable context-pack override${overrideRows.length === 1 ? "" : "s"} passed actor, rationale-digest, and interval checks.`
      : `${invalidOverrides.length} context-pack override${invalidOverrides.length === 1 ? " is" : "s are"} malformed or inconsistent.`,
    invalidOverrides.length === 0 ? "No action required." : "Do not use overrides; preserve the database and investigate corruption or tampering.",
  ));

  const sensitiveEvidence = db.countSensitiveEvidence();
  checks.push(check(
    "sensitive-content",
    "Sensitive-content containment",
    sensitiveEvidence === 0 ? "pass" : "warning",
    sensitiveEvidence === 0 ? 0 : 1,
    sensitiveEvidence === 0 ? "No potential secrets were encountered." : `${sensitiveEvidence} evidence record${sensitiveEvidence === 1 ? " was" : "s were"} flagged; raw content was not stored.`,
    sensitiveEvidence === 0 ? "Continue excluding credentials and local environment files." : "Inspect the source repository, rotate exposed credentials if necessary, and keep flagged content withheld.",
  ));

  const pending = db.listProposals("pending");
  const conflictGroups = new Set(pending.map((proposal) => proposal.conflictGroup).filter(Boolean));
  checks.push(check(
    "proposal-conflicts",
    "Conflicting proposed context",
    conflictGroups.size === 0 ? "pass" : "critical",
    conflictGroups.size === 0 ? 0 : 3,
    conflictGroups.size === 0 ? "No proposal conflicts are waiting for resolution." : `${conflictGroups.size} conflicting proposal group${conflictGroups.size === 1 ? " requires" : "s require"} human resolution.`,
    conflictGroups.size === 0 ? "No action required." : "Compare evidence and reject obsolete proposals before approving one version.",
  ));

  const approvedNarrative = db.getEntity("narrative:project-overview");
  const canonicalProject = getCanonicalProjectEntity(db);
  const conflictIds = new Set(assertionConflicts.flatMap((conflict) => conflict.assertionIds));
  const overviewAssertion = queryAssertions(repoRoot, canonicalProject
    ? { subjectId: canonicalProject.id, predicate: "project.overview" }
    : { predicate: "project.overview" })
    .find((assertion) => isCanonicalProjectOverviewAssertion(assertion, canonicalProject?.id ?? null));
  const approvedOverviewProjection = projectOverviewClaimProjection(
    overviewAssertion,
    approvedNarrative,
    syncedHead,
    repository,
    synchronizedWorkingTreeFingerprint,
    conflictIds,
    unusableCurrentEvidenceIds,
    synchronizedGuidanceWatermark,
    canonicalProject?.id ?? null,
  );
  const approvedNarrativeCurrent = approvedOverviewProjection.status === "current"
    && approvedOverviewProjection.settled;
  checks.push(check(
    "approved-overview",
    "Human-approved project overview",
    approvedNarrativeCurrent ? "pass" : "warning",
    approvedNarrativeCurrent ? 0 : 1,
    approvedNarrativeCurrent
      ? "A human-approved overview is available, versioned, and within the synchronized guidance dependency boundary."
      : approvedNarrative
        ? `A stored overview exists but is not settled current guidance: ${approvedOverviewProjection.reason}`
        : "Only observed structure is available; no narrative has been approved.",
    approvedNarrativeCurrent
      ? "Review it after major architectural or extraction-policy changes."
      : approvedNarrative
        ? "Synchronize and review the replacement overview before treating narrative guidance as current."
        : "Review a pending proposal with `context-atlas proposals`, then approve it explicitly.",
  ));

  const project = canonicalProject ?? entities.find((entity) => entity.type === "project");
  const truncated = project?.payload.scanTruncated === true;
  checks.push(check(
    "scan-completeness",
    "Repository scan completeness",
    truncated ? "warning" : "pass",
    truncated ? 2 : 0,
    truncated ? "The configured file limit truncated the repository scan." : "The repository scan completed within its configured file limit.",
    truncated ? "Raise maxFiles deliberately or narrow excluded paths, then resynchronize." : "No action required.",
  ));

  const rawScore = Math.max(0, 100 - checks.reduce((penalty, item) => {
    if (item.status === "critical") return penalty + item.severity * 10;
    if (item.status === "warning") return penalty + item.severity * 5;
    return penalty;
  }, 0));
  const criticalCount = checks.filter((item) => item.status === "critical").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  const verdict = criticalCount > 0 ? "blocked" : warningCount > 0 ? "degraded" : "healthy";
  // Keep the compatibility score subordinate to the categorical verdict. A critical
  // finding must never be visually rounded up into a healthy-looking aggregate.
  const score = verdict === "blocked" ? Math.min(rawScore, 39) : verdict === "degraded" ? Math.min(rawScore, 79) : rawScore;
  const components = componentHealth(entities, synchronized, unusableCurrentEvidenceIds);
  if (ownsDatabase) db.close();
  return {
    verdict,
    safeToUse: verdict !== "blocked",
    criticalCount,
    warningCount,
    score,
    checks,
    components,
    pendingProposals: pending.length,
    generatedAt: nowIso(),
  };
}

function componentHealth(
  entities: ReturnType<AtlasDatabase["listEntities"]>,
  repositoryBoundarySynchronized: boolean,
  unusableEvidenceIds: ReadonlySet<string>,
): ComponentHealth[] {
  return entities
    .filter((entity) => entity.type === "component" && entity.status !== "removed")
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .map((entity) => {
      const evidenceIds = entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [];
      const stale = !repositoryBoundarySynchronized || entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays;
      if (evidenceIds.length === 0 || evidenceIds.some((id) => unusableEvidenceIds.has(id))) {
        return {
          id: entity.id,
          title: entity.title,
          status: "unsupported" as const,
          reason: evidenceIds.length === 0
            ? "No primary evidence is attached to this component snapshot."
            : "The component's primary evidence is missing, changed, unsafe, policy-denied, or unsupported for current use.",
          evidenceIds,
          lastSeen: entity.lastSeen,
        };
      }
      if (stale) {
        return {
          id: entity.id,
          title: entity.title,
          status: "stale" as const,
          reason: !repositoryBoundarySynchronized
            ? "Repository history or extraction-affecting configuration, ignore policy, schema, or extractor behavior differs from the synchronized component projection."
            : `The component was last observed at ${entity.lastSeen} and is outside its ${entity.staleAfterDays}-day freshness window.`,
          evidenceIds,
          lastSeen: entity.lastSeen,
        };
      }
      return {
        id: entity.id,
        title: entity.title,
        status: "current" as const,
        reason: `Observed at ${entity.lastSeen} with primary repository evidence.`,
        evidenceIds,
        lastSeen: entity.lastSeen,
      };
    });
}

function eventLedgerKindMatches(eventId: string, eventType: string, ledgerKind: string): boolean {
  if (eventType === "git_commit") {
    return eventId.startsWith("event_git_") && ledgerKind === "git_commit_observed";
  }
  if (eventType === "context_approval") {
    return eventId.startsWith("event_approval_") && ledgerKind === "proposal_approved";
  }
  if (eventType === "context_rejection") {
    return eventId.startsWith("event_rejection_") && ledgerKind === "proposal_rejected";
  }
  // Extension/test event kinds must be explicitly event-shaped. This preserves
  // local adapters without allowing proposal, override, restore, or other
  // non-event audit actions to masquerade as timeline anchors.
  return ledgerKind.endsWith("_event");
}

function check(
  id: string,
  label: string,
  status: HealthCheck["status"],
  severity: number,
  details: string,
  recommendation: string,
): HealthCheck {
  return { id, label, status, severity, details, recommendation };
}
