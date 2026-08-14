import { AtlasDatabase } from "./database.js";
import { loadConfig } from "./config.js";
import { getHealthReport } from "./health.js";
import { flushLedgerOutbox, stageLedgerEntry } from "./ledger.js";
import { sanitizeText } from "./security.js";
import { queryAssertions, type AssertionRecord } from "./temporal.js";
import type { ContextPack, EntityRecord, EvidenceRecord, HealthReport, TimelineEvent } from "./types.js";
import { daysBetween, estimateTokens, nowIso, relevanceScore, sha256, stableStringify, truncateToTokenBudget } from "./util.js";

export interface ContextPackBuildOptions {
  overrideId?: string;
}

export interface ContextPackOverride {
  id: string;
  actor: string;
  reasonDigest: string;
  taskDigest: string | null;
  criticalDigest: string;
  createdAt: string;
  expiresAt: string;
}

export class ContextPackBlockedError extends Error {
  readonly code = "context_pack_blocked";
  constructor(readonly criticalChecks: Array<{ id: string; label: string; details: string }>) {
    super(`Context pack blocked by critical integrity checks: ${criticalChecks.map((item) => item.id).join(", ")}. Resolve them or create an explicit, expiring human override.`);
    this.name = "ContextPackBlockedError";
  }
}

export function createContextPackOverride(
  repoRoot: string,
  input: { actor: string; reason: string; task?: string; durationMinutes?: number },
): ContextPackOverride {
  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    const actor = sanitizeText(input.actor, 300).value.trim();
    if (!actor.startsWith("human:") || actor.length < 7) throw new Error("Context-pack overrides require an attributed human: actor.");
    const cleanReason = sanitizeText(input.reason, 2_000);
    if (cleanReason.sensitive) throw new Error("Override reason appears to contain sensitive data.");
    if (cleanReason.value.trim().length < 20) throw new Error("Override reason must contain at least 20 characters of review rationale.");
    const health = getHealthReport(repoRoot, database);
    const criticalChecks = criticalHealthChecks(health);
    if (criticalChecks.length === 0) throw new Error("No critical context-integrity findings require an override.");
    const createdAt = nowIso();
    const requestedMinutes = input.durationMinutes ?? 60;
    const durationMinutes = Math.max(5, Math.min(1_440, Math.floor(requestedMinutes)));
    const expiresAt = new Date(Date.parse(createdAt) + durationMinutes * 60_000).toISOString();
    const taskDigest = input.task?.trim() ? sha256(input.task.trim()) : null;
    const criticalDigest = digestCriticalChecks(criticalChecks);
    const reasonDigest = sha256(cleanReason.value);
    const id = `pack_override_${sha256(stableStringify({ actor, reasonDigest, taskDigest, criticalDigest, createdAt, expiresAt })).slice(0, 24)}`;
    database.transaction(() => {
      database.db.prepare(`
        INSERT INTO context_pack_overrides(id, actor, reason, reason_digest, task_digest, critical_digest, created_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, actor, cleanReason.value, reasonDigest, taskDigest, criticalDigest, createdAt, expiresAt);
      stageLedgerEntry(repoRoot, database, {
        kind: "context_pack_override_created",
        actionId: id,
        payload: { actor, reasonDigest, taskDigest, criticalDigest, createdAt, expiresAt },
      });
    });
    flushLedgerOutbox(repoRoot, database);
    return { id, actor, reasonDigest, taskDigest, criticalDigest, createdAt, expiresAt };
  } finally { database.close(); }
}

export function buildContextPack(repoRoot: string, task: string, requestedBudget?: number, options: ContextPackBuildOptions = {}): ContextPack {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const project = database.listEntities({ types: ["project"] })[0];
    if (!project) throw new Error("No synchronized project snapshot exists. Run `context-atlas sync` first.");
    const narrative = database.getEntity("narrative:project-overview");
    const configuredBudget = loadConfig(repoRoot).config.defaultTokenBudget;
    const candidateBudget = requestedBudget ?? configuredBudget;
    if (!Number.isInteger(candidateBudget) || candidateBudget < 500 || candidateBudget > 20_000) {
      throw new Error("Context-pack token budget must be an integer between 500 and 20000; 500 tokens is the minimum safe envelope.");
    }
    const tokenBudget = candidateBudget;
    const health = getHealthReport(repoRoot, database);
    const criticalChecks = criticalHealthChecks(health);
    const criticalDigest = digestCriticalChecks(criticalChecks);
    const override = criticalChecks.length > 0 && options.overrideId
      ? resolveContextPackOverride(database, options.overrideId, task, criticalDigest)
      : null;
    if (criticalChecks.length > 0 && !override) throw new ContextPackBlockedError(criticalChecks);
    const allEntities = database.listEntities();
    const assertions = queryAssertions(repoRoot);
    const decisions = allEntities.filter((entity) => entity.type === "decision")
      .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence));
    const relevant = allEntities
      .filter((entity) => !["project", "dependency", "narrative", "decision"].includes(entity.type))
      .map((entity) => ({ entity, score: relevanceScore(task, entity.title, entity.summary, JSON.stringify(entity.payload)) }))
      .filter((candidate) => candidate.score > 0 || candidate.entity.type === "component")
      .sort((left, right) => right.score - left.score || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence))
      .slice(0, 18)
      .map((candidate) => candidate.entity);
    const recentEvents = database.listEvents("", 100)
      .map((event) => ({ event, score: relevanceScore(task, event.title, event.summary, event.files.map((file) => file.path).join(" ")) }))
      .sort((left, right) => right.score - left.score || Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp))
      .slice(0, 12)
      .map((candidate) => candidate.event);

    const evidenceIds = new Set<string>();
    for (const entity of [project, narrative, ...decisions.slice(0, 8), ...relevant]) {
      if (entity?.primaryEvidenceId) evidenceIds.add(entity.primaryEvidenceId);
    }
    for (const event of recentEvents) for (const id of event.evidence) evidenceIds.add(id);
    for (const assertion of assertions) for (const item of assertion.evidence) evidenceIds.add(item.evidenceId);
    const evidence = database.listEvidence([...evidenceIds]);
    const warnings = health.checks
      .filter((item) => item.status === "warning" || item.status === "critical")
      .map((item) => `${item.label}: ${item.details}`);
    const safety = {
      safeToUse: criticalChecks.length === 0 || override !== null,
      scope: "navigation-only" as const,
      notProofOfCorrectness: true as const,
      criticalChecks,
      override: override ? {
        id: override.id,
        actor: override.actor,
        reasonDigest: override.reasonDigest,
        createdAt: override.createdAt,
        expiresAt: override.expiresAt,
      } : null,
    };
    const markdown = renderPack(task, project, narrative, relevant, decisions, assertions, recentEvents, evidence, warnings, safety);
    const mandatoryTail = renderMandatoryTail(safety, evidence);
    const bounded = truncateToTokenBudget(markdown, tokenBudget, mandatoryTail);
    const includedEntityIds = [project, ...(narrative ? [narrative] : []), ...decisions.slice(0, 8), ...relevant]
      .map((entity) => entity.id);
    const packId = `pack_${sha256(stableStringify({
      task,
      tokenBudget,
      head: project.payload.head ?? null,
      includedEntityIds,
      includedAssertionIds: assertions.map((assertion) => assertion.id),
      evidence: evidence.map((item) => [item.id, item.digest]),
      criticalDigest,
      overrideId: override?.id ?? null,
    })).slice(0, 24)}`;
    return {
      schemaVersion: 1,
      packId,
      task,
      generatedAt: nowIso(),
      repository: {
        project: project.title,
        branch: String(project.payload.branch ?? "unknown"),
        head: typeof project.payload.head === "string" ? project.payload.head : null,
      },
      tokenBudget,
      estimatedTokens: estimateTokens(bounded),
      truncated: bounded !== markdown,
      contentHash: sha256(bounded),
      selection: { includedEntityIds, includedAssertionIds: assertions.map((assertion) => assertion.id), excludedEntityCount: Math.max(0, allEntities.length - includedEntityIds.length) },
      safety,
      markdown: bounded,
      evidence: evidence.map(safeEvidence),
      warnings,
    };
  } finally {
    database.close();
  }
}

function renderPack(
  task: string,
  project: EntityRecord,
  narrative: EntityRecord | null,
  relevant: EntityRecord[],
  decisions: EntityRecord[],
  assertions: AssertionRecord[],
  events: TimelineEvent[],
  evidence: EvidenceRecord[],
  warnings: string[],
  safety: ContextPack["safety"],
): string {
  const lines: string[] = [
    "# Context Atlas task pack",
    "",
    `Task: ${task}`,
    "",
    "> Authority boundary: this pack is a navigation aid, not proof that code is correct. Claims include confidence and evidence IDs. Pending proposals are excluded. Verify code and tests before changing behavior.",
  ];
  if (safety.override) {
    lines.push("", `> OVERRIDDEN CRITICAL CONTEXT WARNING: ${safety.override.actor} accepted the listed integrity risks until ${safety.override.expiresAt}. Override ${safety.override.id}; rationale digest ${safety.override.reasonDigest.slice(0, 12)}. This remains navigation-only.`);
  }
  lines.push(
    "",
    "## Project now",
    "",
    claimLine(narrative ?? project),
    `- Repository state: branch ${String(project.payload.branch ?? "unknown")}, head ${String(project.payload.head ?? "unborn")}, working tree ${project.payload.dirty ? "dirty" : "clean"}. [${project.primaryEvidenceId ?? "missing-evidence"}]`,
  );
  if (!narrative) lines.push("- No human-approved project overview exists; the summary above is observed structure only.");

  lines.push("", "## Accepted temporal assertions", "");
  if (assertions.length === 0) lines.push("- No accepted temporal assertions exist. Human-reviewed project rationale remains unknown.");
  else for (const assertion of assertions.slice(0, 20)) {
    lines.push(`- ${assertion.predicate} on ${assertion.subjectId}: ${summarizeAssertionValue(assertion.value)} (authority: ${assertion.authority}; confidence: ${assertion.confidence}; lifecycle: ${assertion.lifecycle}; valid from ${assertion.validFrom}; recorded ${assertion.recordedAt}) [${assertion.evidence.map((item) => item.evidenceId).join(", ") || "missing-evidence"}]`);
  }

  lines.push("", "## Relevant components and documents", "");
  if (relevant.length === 0) lines.push("- No task-specific component matched. Inspect the repository before acting.");
  else for (const entity of relevant) lines.push(claimLine(entity));

  lines.push("", "## Active decisions", "");
  if (decisions.length === 0) lines.push("- No decision records were found. Treat architectural intent as unknown.");
  else for (const decision of decisions.slice(0, 10)) lines.push(claimLine(decision));

  lines.push("", "## Tests and constraints", "");
  const constraintEntities = relevant.filter((entity) => /test|spec|constraint|config|manifest/i.test(`${entity.type} ${entity.title} ${entity.summary}`)).slice(0, 10);
  if (constraintEntities.length === 0) lines.push("- No task-specific tests or constraints were established by the selected evidence. Discover and run the relevant checks before editing code.");
  else for (const entity of constraintEntities) lines.push(claimLine(entity));

  lines.push("", "## Unknowns and required verification", "");
  lines.push(
    "- Runtime correctness, production behavior, and unstated architectural intent are not proven by this pack.",
    "- Re-open current source and run the repository's relevant tests before making or accepting a change.",
    "- Treat absent rationale as unknown; do not infer it from naming or file layout alone.",
  );

  lines.push("", "## Relevant history", "");
  if (events.length === 0) lines.push("- No matching history was found.");
  else for (const event of events) {
    lines.push(`- ${event.timestamp}: ${event.title} — ${event.summary} [${event.evidence.join(", ") || "missing-evidence"}]`);
  }

  lines.push("", "## Health warnings", "");
  if (warnings.length === 0) lines.push("- No current Context Atlas health warnings.");
  else for (const warning of warnings) lines.push(`- ${warning}`);

  lines.push("", "## Evidence index", "");
  for (const item of evidence) {
    lines.push(item.sensitive
      ? `- [${item.id}] ${item.kind}: source withheld by sensitive-content policy; digest ${item.digest.slice(0, 12)}.`
      : `- [${item.id}] ${item.kind}: ${item.locator}; digest ${item.digest.slice(0, 12)}; observed ${item.observedAt}.`);
  }
  return lines.join("\n");
}

function claimLine(entity: EntityRecord): string {
  const freshness = daysBetween(entity.lastSeen) > entity.staleAfterDays ? ", stale" : "";
  return `- ${entity.title}: ${entity.summary} (confidence: ${entity.confidence}${freshness}) [${entity.primaryEvidenceId ?? "missing-evidence"}]`;
}

function safeEvidence(evidence: EvidenceRecord): EvidenceRecord {
  return evidence.sensitive ? { ...evidence, locator: "[withheld]", metadata: { withheld: true } } : evidence;
}

function renderMandatoryTail(
  safety: ContextPack["safety"],
  evidence: EvidenceRecord[],
): string {
  const evidenceIds = evidence.slice(0, 20).map((item) => item.id);
  const omittedEvidence = Math.max(0, evidence.length - evidenceIds.length);
  return [
    "## Truncation and safety",
    "",
    "- Context detail was truncated to the requested token budget.",
    `- Safety verdict: ${safety.safeToUse ? "usable for navigation only" : "BLOCKED by critical context-integrity findings"}.`,
    `- Critical checks: ${safety.criticalChecks.map((item) => item.id).join(", ") || "none"}.`,
    `- Human override: ${safety.override ? `${safety.override.id} by ${safety.override.actor}, expires ${safety.override.expiresAt}` : "none"}.`,
    `- Evidence IDs retained: ${evidenceIds.join(", ") || "none"}${omittedEvidence ? `; ${omittedEvidence} more remain in the structured evidence field` : ""}.`,
    "- Context Atlas is never proof of code correctness; inspect current code and tests before changing behavior.",
  ].join("\n");
}

function confidenceRank(confidence: EntityRecord["confidence"]): number {
  return { approved: 4, documented: 3, observed: 2, inferred: 1 }[confidence];
}

function criticalHealthChecks(report: HealthReport): Array<{ id: string; label: string; details: string }> {
  return report.checks
    .filter((item) => item.status === "critical")
    .map((item) => ({ id: item.id, label: item.label, details: item.details }));
}

function digestCriticalChecks(checks: Array<{ id: string; label: string; details: string }>): string {
  return sha256(stableStringify(checks.map((item) => ({ id: item.id, details: item.details }))));
}

function resolveContextPackOverride(database: AtlasDatabase, overrideId: string, task: string, criticalDigest: string): ContextPackOverride {
  if (!/^pack_override_[a-f0-9]{24}$/.test(overrideId)) throw new Error("Invalid context-pack override identifier.");
  const row = database.db.prepare("SELECT * FROM context_pack_overrides WHERE id = ?").get(overrideId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Unknown context-pack override: ${overrideId}`);
  const override: ContextPackOverride = {
    id: String(row.id),
    actor: String(row.actor),
    reasonDigest: String(row.reason_digest),
    taskDigest: row.task_digest === null ? null : String(row.task_digest),
    criticalDigest: String(row.critical_digest),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
  if (!override.actor.startsWith("human:")) throw new Error("Context-pack override actor is invalid.");
  if (override.criticalDigest !== criticalDigest) throw new Error("Context-pack override no longer matches the current critical findings.");
  if (override.taskDigest && override.taskDigest !== sha256(task.trim())) throw new Error("Context-pack override was granted for a different task.");
  if (Date.parse(override.expiresAt) <= Date.now()) throw new Error("Context-pack override has expired.");
  return override;
}

function summarizeAssertionValue(value: unknown): string {
  const serialized = stableStringify(value).replace(/\s+/g, " ");
  return serialized.length <= 280 ? serialized : `${serialized.slice(0, 277)}...`;
}
