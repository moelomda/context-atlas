import { AtlasDatabase } from "./database.js";
import { loadConfig } from "./config.js";
import { getRepoStatus } from "./git.js";
import { verifyLedgerState } from "./ledger.js";
import { detectAssertionConflicts } from "./temporal.js";
import type { ComponentHealth, HealthCheck, HealthReport, RepoStatus } from "./types.js";
import { daysBetween, nowIso, sha256 } from "./util.js";

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

  checks.push(check(
    "ledger-outbox",
    "Audit outbox recovery",
    ledger.unflushedEntries === 0 ? "pass" : "warning",
    ledger.unflushedEntries === 0 ? 0 : 2,
    ledger.unflushedEntries === 0
      ? "No committed audit entries are waiting for durable ledger reconciliation."
      : `${ledger.unflushedEntries} committed audit entr${ledger.unflushedEntries === 1 ? "y has" : "ies have"} a recoverable flush receipt pending; ${ledger.physicallyPendingEntries} still require a file append.`,
    ledger.unflushedEntries === 0 ? "No action required." : "Run `context-atlas recover-ledger` before another handoff; do not edit the ledger manually.",
  ));

  const unledgeredEvents = db.countUnledgeredEvents();
  checks.push(check(
    "event-ledger-coverage",
    "Timeline ledger coverage",
    unledgeredEvents === 0 ? "pass" : "critical",
    unledgeredEvents === 0 ? 0 : 3,
    unledgeredEvents === 0 ? "Every timeline event is anchored to the hash-chained ledger." : `${unledgeredEvents} timeline event${unledgeredEvents === 1 ? " is" : "s are"} missing a ledger anchor.`,
    unledgeredEvents === 0 ? "No action required." : "Stop synchronization and recover from a verified backup or investigate an interrupted write.",
  ));

  const repository = knownRepository ?? getRepoStatus(repoRoot);
  const maxCommits = loadConfig(repoRoot).config.maxCommits;
  const syncedHead = db.getMeta("last_synced_head");
  const currentHead = repository.head ?? "UNBORN";
  const synchronized = syncedHead === currentHead;
  checks.push(check(
    "repository-sync",
    "Repository synchronization",
    synchronized ? "pass" : "warning",
    synchronized ? 0 : 2,
    synchronized ? `Knowledge is synchronized to ${currentHead.slice(0, 12)}.` : `Repository is at ${currentHead.slice(0, 12)}, but Context Atlas recorded ${syncedHead?.slice(0, 12) ?? "no sync"}.`,
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
  checks.push(check(
    "approved-overview",
    "Human-approved project overview",
    approvedNarrative ? "pass" : "warning",
    approvedNarrative ? 0 : 1,
    approvedNarrative ? "A human-approved overview is available and versioned." : "Only observed structure is available; no narrative has been approved.",
    approvedNarrative ? "Review it after major architectural changes." : "Review a pending proposal with `context-atlas proposals`, then approve it explicitly.",
  ));

  const project = entities.find((entity) => entity.type === "project");
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
  const components = componentHealth(entities);
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

function componentHealth(entities: ReturnType<AtlasDatabase["listEntities"]>): ComponentHealth[] {
  return entities
    .filter((entity) => entity.type === "component" && entity.status !== "removed")
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .map((entity) => {
      const evidenceIds = entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [];
      const stale = entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays;
      if (evidenceIds.length === 0) {
        return {
          id: entity.id,
          title: entity.title,
          status: "unsupported" as const,
          reason: "No primary evidence is attached to this component snapshot.",
          evidenceIds,
          lastSeen: entity.lastSeen,
        };
      }
      if (stale) {
        return {
          id: entity.id,
          title: entity.title,
          status: "stale" as const,
          reason: `The component was last observed at ${entity.lastSeen} and is outside its ${entity.staleAfterDays}-day freshness window.`,
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
