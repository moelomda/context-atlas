import { AtlasDatabase } from "./database.js";
import {
  getCanonicalProjectEntity,
  isCanonicalProjectOverviewAssertion,
  projectOverviewClaimProjection,
  projectOverviewWarning,
  queryPresentedAssertions,
  type PresentedAssertion,
  type ProjectOverviewClaimProjection,
} from "./claim-status.js";
import { loadConfig } from "./config.js";
import { validateEvidenceLocators } from "./evidence-validation.js";
import { getRepoStatus } from "./git.js";
import { getHealthReport } from "./health.js";
import { flushLedgerOutbox, stageLedgerEntry } from "./ledger.js";
import { sanitizeText } from "./security.js";
import { detectAssertionConflicts } from "./temporal.js";
import type {
  ContextPack,
  ContextPackExclusion,
  ContextPackSection,
  ContextPackSectionId,
  EntityRecord,
  EvidenceRecord,
  HealthReport,
  RepoStatus,
  TimelineEvent,
} from "./types.js";
import { daysBetween, estimateTokens, nowIso, relevanceScore, sha256, stableStringify } from "./util.js";

const MAX_PACK_EVENT_CANDIDATES = 100_000;

export interface ContextPackBuildOptions {
  overrideId?: string;
  transportCharacterReserve?: number;
}

export type ContextPackWithClaims = ContextPack & {
  claims: { overview: ProjectOverviewClaimProjection };
};

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

export class ContextPackBudgetError extends Error {
  readonly code = "context_pack_budget_too_small";
  constructor(
    readonly requestedBudget: number,
    readonly minimumRequiredTokens: number,
    readonly minimumRequiredCharacters: number,
    readonly requiredSections: ContextPackSectionId[],
  ) {
    super(`Context-pack budget ${requestedBudget} cannot fit the mandatory safety envelope; at least ${minimumRequiredTokens} estimated tokens (${minimumRequiredCharacters} characters) are required.`);
    this.name = "ContextPackBudgetError";
  }
}

export class ContextPackInputError extends Error {
  readonly code = "context_pack_invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "ContextPackInputError";
  }
}

interface PackCandidate {
  kind: ContextPackExclusion["kind"];
  id: string;
  section: ContextPackSectionId;
  score: number;
  order: number;
  evidenceIds: string[];
  line: string;
  fixedExclusionReason?: ContextPackExclusion["reason"];
}

interface RenderedPack {
  markdown: string;
  sections: ContextPackSection[];
  evidence: EvidenceRecord[];
  includedEntityIds: string[];
  includedAssertionIds: string[];
  includedEventIds: string[];
  includedEvidenceIds: string[];
  exclusions: ContextPackExclusion[];
  selectionHash: string;
}

interface PackRenderInput {
  task: string;
  tokenBudget: number;
  project: EntityRecord;
  narrative: EntityRecord | null;
  repository: RepoStatus;
  overviewClaim: ProjectOverviewClaimProjection;
  candidates: PackCandidate[];
  selectedKeys: ReadonlySet<string>;
  health: HealthReport;
  warnings: string[];
  safety: ContextPack["safety"];
}

interface SectionBody {
  lines: string[];
  itemIds: string[];
  status: ContextPackSection["status"];
}

const SECTION_DEFINITIONS: ReadonlyArray<{ id: ContextPackSectionId; title: string }> = [
  { id: "identity_authority", title: "Identity and authority" },
  { id: "warnings", title: "Warnings" },
  { id: "goals", title: "Goals and current purpose" },
  { id: "components", title: "Components" },
  { id: "interfaces", title: "Interfaces and data flow" },
  { id: "conventions", title: "Conventions" },
  { id: "decisions", title: "Decision records" },
  { id: "constraints", title: "Constraints" },
  { id: "risks", title: "Risks" },
  { id: "recent_changes", title: "Relevant recent changes" },
  { id: "tests", title: "Tests" },
  { id: "conflicts", title: "Conflicts" },
  { id: "unknowns", title: "Unknowns and required verification" },
  { id: "evidence", title: "Evidence locators" },
  { id: "exclusions", title: "Selection and material exclusions" },
];

const OPTIONAL_SECTION_ORDER: ContextPackSectionId[] = [
  "conflicts",
  "risks",
  "constraints",
  "tests",
  "goals",
  "decisions",
  "interfaces",
  "conventions",
  "components",
  "recent_changes",
];

export function createContextPackOverride(
  repoRoot: string,
  input: { actor: string; reason: string; task?: string; durationMinutes?: number },
): ContextPackOverride {
  const actor = input.actor.trim();
  if (!/^human:[a-zA-Z0-9._@-]{1,200}$/.test(actor)) {
    throw new Error("Context-pack overrides require an attributed actor matching human:<id>.");
  }
  if (input.reason.length > 2_000) throw new Error("Override reason must not exceed 2000 characters.");
  if (input.task && input.task.length > 2_000) throw new Error("Override task scope must not exceed 2000 characters.");
  const cleanReason = sanitizeText(input.reason, 2_000);
  if (cleanReason.sensitive) throw new Error("Override reason appears to contain sensitive data.");
  if (cleanReason.value.trim().length < 20) throw new Error("Override reason must contain at least 20 characters of review rationale.");
  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    const health = getHealthReport(repoRoot, database);
    const criticalChecks = criticalHealthChecks(health);
    if (criticalChecks.length === 0) throw new Error("No critical context-integrity findings require an override.");
    const createdAt = nowIso();
    const requestedMinutes = input.durationMinutes ?? 60;
    const durationMinutes = Math.max(5, Math.min(1_440, Math.floor(requestedMinutes)));
    const expiresAt = new Date(Date.parse(createdAt) + durationMinutes * 60_000).toISOString();
    const taskDigest = input.task?.trim() ? sha256(inlineText(input.task)) : null;
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
  } finally {
    database.close();
  }
}

export function buildContextPack(
  repoRoot: string,
  task: string,
  requestedBudget?: number,
  options: ContextPackBuildOptions = {},
): ContextPackWithClaims {
  if (task.length > 2_000) {
    throw new ContextPackInputError("Context-pack task must not exceed 2000 characters; the task was refused rather than silently truncated.");
  }
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const cleanTask = sanitizeText(task, 2_000);
    const normalizedTask = inlineText(cleanTask.value);
    if (cleanTask.sensitive) throw new Error("Context-pack task appears to contain sensitive data and was refused before rendering.");
    if (!normalizedTask) throw new Error("Context-pack task must contain a non-empty description.");
    const project = getCanonicalProjectEntity(database);
    if (!project) throw new Error("No synchronized project snapshot exists. Run `context-atlas sync` first.");
    const narrative = database.getEntity("narrative:project-overview");
    const config = loadConfig(repoRoot).config;
    const configuredBudget = config.defaultTokenBudget;
    const candidateBudget = requestedBudget ?? configuredBudget;
    if (!Number.isInteger(candidateBudget) || candidateBudget < 500 || candidateBudget > 20_000) {
      throw new Error("Context-pack token budget must be an integer between 500 and 20000; 500 tokens is the minimum accepted request, while the typed mandatory envelope may require more.");
    }
    const tokenBudget = candidateBudget;
    const transportCharacterReserve = options.transportCharacterReserve ?? 0;
    if (!Number.isInteger(transportCharacterReserve) || transportCharacterReserve < 0 || transportCharacterReserve >= tokenBudget * 4) {
      throw new Error("Context-pack transport character reserve must be a non-negative integer smaller than the requested hard character cap.");
    }
    const packCharacterLimit = tokenBudget * 4 - transportCharacterReserve;
    const repository = getRepoStatus(repoRoot);
    const health = getHealthReport(repoRoot, database, repository);
    const criticalChecks = criticalHealthChecks(health);
    const criticalDigest = digestCriticalChecks(criticalChecks);
    const override = criticalChecks.length > 0 && options.overrideId
      ? resolveContextPackOverride(database, options.overrideId, normalizedTask, criticalDigest)
      : null;
    if (criticalChecks.length > 0 && !override) throw new ContextPackBlockedError(criticalChecks);

    const allEntities = database.listEntities();
    const assertions = queryPresentedAssertions(repoRoot);
    const overviewAssertion = assertions.find((assertion) => isCanonicalProjectOverviewAssertion(assertion, project.id));
    const conflictingAssertionIds = new Set(detectAssertionConflicts(repoRoot)
      .flatMap((conflict) => conflict.assertionIds));
    const overviewClaim = projectOverviewClaimProjection(
      overviewAssertion,
      narrative,
      database.getMeta("last_synced_head"),
      repository,
      database.getMeta("last_synced_worktree_fingerprint"),
      conflictingAssertionIds,
      new Set(),
      database.getMeta("last_synced_guidance_watermark"),
      project.id,
    );
    const claimWarning = projectOverviewWarning(overviewClaim);
    const warnings = [
      ...(claimWarning ? [claimWarning] : []),
      ...(override ? [`OVERRIDDEN CRITICAL CONTEXT: ${override.actor} accepted the current integrity findings until ${override.expiresAt}. This pack remains navigation-only.`] : []),
      ...health.checks
        .filter((item) => item.status === "warning" || item.status === "critical")
        .map((item) => `${item.id}: ${item.label}: ${item.details}`),
    ];
    const safety: ContextPack["safety"] = {
      safeToUse: criticalChecks.length === 0 || override !== null,
      scope: "navigation-only",
      notProofOfCorrectness: true,
      criticalChecks,
      override: override ? {
        id: override.id,
        actor: override.actor,
        reasonDigest: override.reasonDigest,
        createdAt: override.createdAt,
        expiresAt: override.expiresAt,
      } : null,
    };
    const eventCount = database.countEvents();
    if (eventCount > MAX_PACK_EVENT_CANDIDATES) {
      throw new ContextPackBlockedError([{
        id: "pack-event-candidate-limit",
        label: "Context-pack event candidate limit",
        details: `The store contains ${eventCount} events, exceeding the bounded candidate scan of ${MAX_PACK_EVENT_CANDIDATES}. Refusing instead of silently omitting potentially relevant history.`,
      }]);
    }
    const packEvents = database.listEvents("", MAX_PACK_EVENT_CANDIDATES);
    const evidenceRecords = database.listAllEvidence();
    const availableEvidenceIds = new Set(evidenceRecords.map((item) => item.id));
    const packProjectionEvidenceIds = new Set([
      ...allEntities
        .filter((entity) => entity.status !== "removed" && entity.status !== "superseded" && entity.status !== "stale")
        .map((entity) => entity.primaryEvidenceId)
        .filter((id): id is string => Boolean(id)),
      ...assertions
        .filter((assertion) => assertion.presentation.settled || assertion.id === overviewAssertion?.id)
        .flatMap((assertion) => assertion.evidence.map((item) => item.evidenceId)),
      ...packEvents.flatMap((event) => event.evidence),
    ]);
    const packProjectionEvidence = evidenceRecords.filter((item) => packProjectionEvidenceIds.has(item.id));
    const evidenceValidation = validateEvidenceLocators(repoRoot, packProjectionEvidence);
    const invalidEvidenceIds = new Set([
      ...evidenceValidation.invalidEvidenceIds,
      ...evidenceValidation.unvalidatedEvidenceIds,
    ]);
    const policyDeniedEvidenceIds = new Set([
      ...packProjectionEvidence.filter((item) => item.sensitive).map((item) => item.id),
      ...evidenceValidation.policyDeniedEvidenceIds,
    ]);
    const invalidMandatoryEntities = [
      project,
      ...(narrative && overviewClaim.status === "current" ? [narrative] : []),
    ].filter((entity) => {
      const evidenceId = entity.primaryEvidenceId;
      return !evidenceId
        || !availableEvidenceIds.has(evidenceId)
        || invalidEvidenceIds.has(evidenceId)
        || policyDeniedEvidenceIds.has(evidenceId);
    });
    if (invalidMandatoryEntities.length > 0) {
      throw new ContextPackBlockedError([{
        id: "pack-mandatory-entity-evidence-closure",
        label: "Mandatory entity evidence closure",
        details: `Mandatory pack entities lack resolved, locally valid, policy-permitted primary evidence: ${invalidMandatoryEntities.map((entity) => entity.id).join(", ")}. Integrity overrides cannot bypass claim-level evidence closure.`,
      }]);
    }
    const overviewEvidenceIds = overviewClaim.evidence.map((item) => item.evidenceId);
    const overviewSupportEvidenceIds = overviewClaim.evidence
      .filter((item) => item.role === "support")
      .map((item) => item.evidenceId);
    const unresolvedOverviewEvidence = overviewEvidenceIds.filter((id) => !availableEvidenceIds.has(id));
    const invalidOverviewEvidence = overviewEvidenceIds.filter((id) => invalidEvidenceIds.has(id));
    const deniedOverviewEvidence = overviewEvidenceIds.filter((id) => policyDeniedEvidenceIds.has(id));
    const permittedOverviewEvidence = overviewSupportEvidenceIds.filter((id) => !policyDeniedEvidenceIds.has(id) && !invalidEvidenceIds.has(id));
    if (overviewClaim.assertionId && overviewClaim.status !== "stale" && (overviewSupportEvidenceIds.length === 0
      || unresolvedOverviewEvidence.length > 0
      || invalidOverviewEvidence.length > 0
      || deniedOverviewEvidence.length > 0
      || permittedOverviewEvidence.length === 0)) {
      throw new ContextPackBlockedError([{
        id: "pack-overview-evidence-closure",
        label: "Project overview evidence closure",
        details: overviewSupportEvidenceIds.length === 0
          ? "The mandatory project overview has no supporting evidence and cannot be included as current or historical guidance."
          : unresolvedOverviewEvidence.length > 0
            ? `The mandatory project overview references missing supporting evidence: ${unresolvedOverviewEvidence.join(", ")}.`
            : invalidOverviewEvidence.length > 0
              ? `The mandatory project overview references local evidence that is missing, changed, unsafe, or policy-denied: ${invalidOverviewEvidence.join(", ")}.`
              : deniedOverviewEvidence.length > 0
                ? `The mandatory project overview references evidence withheld under the sensitive-content policy: ${deniedOverviewEvidence.join(", ")}.`
                : "The mandatory project overview has no policy-permitted supporting evidence.",
      }]);
    }
    const candidates = buildPackCandidates(
      normalizedTask,
      allEntities,
      assertions,
      packEvents,
      project.id,
      narrative?.id ?? null,
      overviewAssertion?.id ?? null,
      availableEvidenceIds,
      invalidEvidenceIds,
      policyDeniedEvidenceIds,
      conflictingAssertionIds,
    );
    const privacyDeniedCandidates = candidates.filter((candidate) => candidate.fixedExclusionReason === "policy-denied");
    if (privacyDeniedCandidates.length > 0) {
      throw new ContextPackBlockedError([{
        id: "pack-policy-denied-evidence",
        label: "Policy-denied context evidence",
        details: `Material context candidates rely only on sensitive evidence and cannot be rendered: ${privacyDeniedCandidates.map(candidateKey).join(", ")}.`,
      }]);
    }
    const selectedKeys = new Set<string>();
    const renderInput = (): PackRenderInput => ({
      task: normalizedTask,
      tokenBudget,
      project,
      narrative,
      repository,
      overviewClaim,
      candidates,
      selectedKeys,
      health,
      warnings,
      safety,
    });
    const generatedAt = nowIso();
    const nonMaterialEntityCount = Math.max(0, allEntities.length
      - 1
      - (narrative ? 1 : 0)
      - candidates.filter((item) => item.kind === "entity").length);
    const nonMaterialEventCount = Math.max(0, eventCount - candidates.filter((item) => item.kind === "event").length);
    const assemblePack = (rendered: RenderedPack): ContextPackWithClaims => {
      const bodyContentHash = sha256(rendered.markdown);
      const packId = `pack_${sha256(stableStringify({
        task: normalizedTask,
        tokenBudget,
        transportCharacterReserve,
        liveHead: repository.head,
        indexedHead: project.payload.head ?? null,
        workingTreeFingerprint: repository.workingTreeFingerprint,
        overviewClaimStatus: overviewClaim.status,
        selectionHash: rendered.selectionHash,
        contentHash: bodyContentHash,
        selectorVersion: "section-reserved-v2",
        rendererVersion: "markdown-v2",
        criticalDigest,
        overrideId: override?.id ?? null,
      })).slice(0, 24)}`;
      const pack: ContextPackWithClaims = {
        schemaVersion: 2,
        packId,
        task: normalizedTask,
        generatedAt,
        repository: {
          project: project.title,
          branch: repository.branch,
          head: repository.head,
          indexedHead: typeof project.payload.head === "string" ? project.payload.head : null,
          synchronized: overviewClaim.repository.synchronized,
        },
        tokenBudget,
        estimatedTokens: 0,
        truncated: rendered.exclusions.length > 0,
        contentHash: bodyContentHash,
        policy: {
          selectorVersion: "section-reserved-v2",
          rendererVersion: "markdown-v2",
          tokenEstimator: "characters-divided-by-four-ceiling-v1",
          budgetScope: "compact-json",
          hardCharacterLimit: tokenBudget * 4,
          serializedCharacters: 0,
          reservedTransportCharacters: transportCharacterReserve,
          minimumTokenBudget: 500,
        },
        freshness: {
          verdict: health.verdict,
          safeToUse: safety.safeToUse,
          warningCheckIds: health.checks.filter((item) => item.status === "warning").map((item) => item.id),
          criticalCheckIds: health.checks.filter((item) => item.status === "critical").map((item) => item.id),
        },
        sections: rendered.sections,
        selection: {
          includedEntityIds: rendered.includedEntityIds,
          includedAssertionIds: rendered.includedAssertionIds,
          includedEventIds: rendered.includedEventIds,
          includedEvidenceIds: rendered.includedEvidenceIds,
          excludedEntityCount: rendered.exclusions.filter((item) => item.kind === "entity").length,
          nonMaterialEntityCount,
          nonMaterialEventCount,
          exclusions: rendered.exclusions,
          selectionHash: rendered.selectionHash,
        },
        claims: { overview: overviewClaim },
        safety,
        markdown: "",
        evidence: rendered.evidence.map(safeEvidence),
        warnings,
      };
      for (let pass = 0; pass < 12; pass += 1) {
        pack.markdown = renderPackMarkdown(pack, rendered.markdown);
        const serialized = JSON.stringify(pack);
        const serializedCharacters = serialized.length;
        const estimatedTokens = estimateTokens(serialized);
        if (pack.policy.serializedCharacters === serializedCharacters && pack.estimatedTokens === estimatedTokens) return pack;
        pack.policy.serializedCharacters = serializedCharacters;
        pack.estimatedTokens = estimatedTokens;
      }
      throw new Error("Context-pack serialized budget metadata did not converge.");
    };
    const serializedLength = (pack: ContextPackWithClaims): number => JSON.stringify(pack).length;

    let rendered = renderCanonicalPack(database, renderInput());
    let pack = assemblePack(rendered);
    const minimumRequiredCharacters = serializedLength(pack);
    if (minimumRequiredCharacters > packCharacterLimit) {
      throw new ContextPackBudgetError(
        tokenBudget,
        Math.ceil((minimumRequiredCharacters + transportCharacterReserve) / 4),
        minimumRequiredCharacters + transportCharacterReserve,
        SECTION_DEFINITIONS.map((section) => section.id),
      );
    }
    for (const candidate of candidates) {
      if (candidate.fixedExclusionReason) continue;
      selectedKeys.add(candidateKey(candidate));
      const attempt = renderCanonicalPack(database, renderInput());
      const attemptPack = assemblePack(attempt);
      if (serializedLength(attemptPack) <= packCharacterLimit) {
        rendered = attempt;
        pack = attemptPack;
      } else {
        selectedKeys.delete(candidateKey(candidate));
      }
    }
    const finalCharacters = serializedLength(pack);
    if (finalCharacters !== pack.policy.serializedCharacters || finalCharacters > packCharacterLimit) {
      throw new Error("Context-pack compact JSON exceeded its declared hard character limit.");
    }
    return pack;
  } finally {
    database.close();
  }
}

function buildPackCandidates(
  task: string,
  entities: EntityRecord[],
  assertions: PresentedAssertion[],
  events: TimelineEvent[],
  projectId: string,
  narrativeId: string | null,
  overviewAssertionId: string | null,
  availableEvidenceIds: ReadonlySet<string>,
  invalidEvidenceIds: ReadonlySet<string>,
  policyDeniedEvidenceIds: ReadonlySet<string>,
  conflictingAssertionIds: ReadonlySet<string>,
): PackCandidate[] {
  const candidates: PackCandidate[] = [];
  for (const [order, entity] of entities
    .filter((item) => item.id !== projectId
      && item.id !== narrativeId
      && item.status !== "removed"
      && item.status !== "superseded")
    .sort((left, right) => left.id.localeCompare(right.id))
    .entries()) {
    const score = relevanceScore(task, entity.title, entity.summary, stableStringify(entity.payload));
    if (score <= 0 && !["component", "decision", "dependency", "manifest", "risk"].includes(entity.type)) continue;
    const evidencePolicy = candidateEvidencePolicy(
      entity.primaryEvidenceId ? [entity.primaryEvidenceId] : [],
      availableEvidenceIds,
      invalidEvidenceIds,
      policyDeniedEvidenceIds,
    );
    const stale = entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays;
    candidates.push({
      kind: "entity",
      id: entity.id,
      section: sectionForEntity(entity),
      score: score + confidenceRank(entity.confidence) / 100,
      order,
      evidenceIds: evidencePolicy.evidenceIds,
      line: claimLine(entity),
      ...fixedExclusion(evidencePolicy.fixedExclusionReason, stale ? "stale" : undefined),
    });
  }
  for (const [order, assertion] of assertions.entries()) {
    if (assertion.id === overviewAssertionId) continue;
    const score = relevanceScore(task, assertion.subjectId, assertion.predicate, stableStringify(assertion.value));
    if (score <= 0 && !/(decision|risk|constraint|test|conflict|interface|schema|policy)/i.test(assertion.predicate)) continue;
    const evidencePolicy = candidateEvidencePolicy(
      assertion.evidence.map((item) => item.evidenceId).sort(),
      availableEvidenceIds,
      invalidEvidenceIds,
      policyDeniedEvidenceIds,
    );
    const unsettledReason = assertion.presentation.settled
      ? undefined
      : assertion.presentation.status === "stale"
        ? "stale"
        : assertion.presentation.status === "conflicting" || conflictingAssertionIds.has(assertion.id)
          ? "conflict"
          : "unsettled";
    candidates.push({
      kind: "assertion",
      id: assertion.id,
      section: sectionForAssertion(assertion),
      score: score + (assertion.authority === "human" ? 0.05 : 0),
      order,
      evidenceIds: evidencePolicy.evidenceIds,
      line: assertionLine(assertion, evidencePolicy.evidenceIds),
      ...fixedExclusion(evidencePolicy.fixedExclusionReason, unsettledReason),
    });
  }
  for (const [order, event] of events.entries()) {
    const score = relevanceScore(task, event.title, event.summary, event.files.map((file) => file.path).join(" "));
    if (score <= 0 && order >= 3) continue;
    const evidencePolicy = candidateEvidencePolicy([...event.evidence].sort(), availableEvidenceIds, invalidEvidenceIds, policyDeniedEvidenceIds);
    candidates.push({
      kind: "event",
      id: event.id,
      section: "recent_changes",
      score,
      order,
      evidenceIds: evidencePolicy.evidenceIds,
      line: eventLine(event, evidencePolicy.evidenceIds),
      ...fixedExclusion(evidencePolicy.fixedExclusionReason),
    });
  }
  const bySection = new Map<ContextPackSectionId, PackCandidate[]>();
  for (const candidate of candidates) {
    const section = bySection.get(candidate.section) ?? [];
    section.push(candidate);
    bySection.set(candidate.section, section);
  }
  for (const section of bySection.values()) {
    section.sort((left, right) => right.score - left.score || left.order - right.order || left.id.localeCompare(right.id));
  }
  const ordered: PackCandidate[] = [];
  const maximum = Math.max(0, ...[...bySection.values()].map((section) => section.length));
  for (let index = 0; index < maximum; index += 1) {
    for (const sectionId of OPTIONAL_SECTION_ORDER) {
      const candidate = bySection.get(sectionId)?.[index];
      if (candidate) ordered.push(candidate);
    }
  }
  return ordered;
}

function candidateEvidencePolicy(
  evidenceIds: string[],
  availableEvidenceIds: ReadonlySet<string>,
  invalidEvidenceIds: ReadonlySet<string>,
  policyDeniedEvidenceIds: ReadonlySet<string>,
): { evidenceIds: string[]; fixedExclusionReason?: "unsupported" | "policy-denied" } {
  const uniqueEvidenceIds = unique(evidenceIds);
  if (uniqueEvidenceIds.length === 0
    || uniqueEvidenceIds.some((id) => !availableEvidenceIds.has(id) || invalidEvidenceIds.has(id))) {
    return {
      evidenceIds: uniqueEvidenceIds.filter((id) => availableEvidenceIds.has(id)
        && !invalidEvidenceIds.has(id)
        && !policyDeniedEvidenceIds.has(id)),
      fixedExclusionReason: uniqueEvidenceIds.some((id) => policyDeniedEvidenceIds.has(id)) ? "policy-denied" : "unsupported",
    };
  }
  const permitted = uniqueEvidenceIds.filter((id) => !policyDeniedEvidenceIds.has(id));
  return permitted.length > 0
    ? { evidenceIds: permitted }
    : { evidenceIds: [], fixedExclusionReason: "policy-denied" };
}

function fixedExclusion(
  evidenceReason?: "unsupported" | "policy-denied",
  unsettledReason?: "unsettled" | "stale" | "conflict",
): Pick<PackCandidate, "fixedExclusionReason"> | Record<string, never> {
  if (evidenceReason === "policy-denied") return { fixedExclusionReason: evidenceReason };
  if (unsettledReason) return { fixedExclusionReason: unsettledReason };
  return evidenceReason ? { fixedExclusionReason: evidenceReason } : {};
}

function renderCanonicalPack(database: AtlasDatabase, input: PackRenderInput): RenderedPack {
  const selected = input.candidates.filter((candidate) => input.selectedKeys.has(candidateKey(candidate)));
  const excluded = input.candidates.filter((candidate) => !input.selectedKeys.has(candidateKey(candidate)));
  const includedEntityIds = unique([
    input.project.id,
    ...(input.narrative ? [input.narrative.id] : []),
    ...selected.filter((item) => item.kind === "entity").map((item) => item.id),
  ]);
  const includedAssertionIds = unique([
    ...(input.overviewClaim.status === "current" && input.overviewClaim.assertionId ? [input.overviewClaim.assertionId] : []),
    ...selected.filter((item) => item.kind === "assertion").map((item) => item.id),
  ]);
  const includedEventIds = selected.filter((item) => item.kind === "event").map((item) => item.id);
  const includedEvidenceIds = unique([
    ...(input.project.primaryEvidenceId ? [input.project.primaryEvidenceId] : []),
    ...(input.overviewClaim.status === "current" && input.narrative?.primaryEvidenceId ? [input.narrative.primaryEvidenceId] : []),
    ...(input.overviewClaim.status === "current" ? input.overviewClaim.evidence.map((item) => item.evidenceId) : []),
    ...selected.flatMap((item) => item.evidenceIds),
  ]);
  const evidenceById = new Map(database.listEvidence(includedEvidenceIds).map((item) => [item.id, item]));
  const missingEvidenceIds = includedEvidenceIds.filter((id) => !evidenceById.has(id));
  if (includedEvidenceIds.length === 0 || missingEvidenceIds.length > 0) {
    throw new ContextPackBlockedError([{
      id: "pack-evidence-closure",
      label: "Context-pack evidence closure",
      details: missingEvidenceIds.length > 0
        ? `Required evidence records are missing: ${missingEvidenceIds.join(", ")}.`
        : "The mandatory project/overview envelope has no permitted evidence.",
    }]);
  }
  const evidence = includedEvidenceIds.map((id) => evidenceById.get(id) as EvidenceRecord);
  const exclusions: ContextPackExclusion[] = [
    ...(input.overviewClaim.assertionId && input.overviewClaim.status !== "current" ? [{
      kind: "assertion" as const,
      id: input.overviewClaim.assertionId,
      section: "goals" as const,
      reason: input.overviewClaim.status === "stale"
        ? "stale" as const
        : input.overviewClaim.status === "conflicting" ? "conflict" as const : "unsettled" as const,
      material: true as const,
      evidenceIds: input.overviewClaim.evidence.map((item) => item.evidenceId),
    }] : []),
    ...excluded.map((candidate) => ({
      kind: candidate.kind,
      id: candidate.id,
      section: candidate.section,
      reason: candidate.fixedExclusionReason ?? "token-budget",
      material: true as const,
      evidenceIds: candidate.evidenceIds,
    })),
  ];
  const selectionHash = sha256(stableStringify({
    includedEntityIds,
    includedAssertionIds,
    includedEventIds,
    includedEvidence: evidence.map((item) => [item.id, item.digest]),
    exclusions,
  }));
  const selectedBySection = new Map<ContextPackSectionId, PackCandidate[]>();
  for (const candidate of selected) {
    const values = selectedBySection.get(candidate.section) ?? [];
    values.push(candidate);
    selectedBySection.set(candidate.section, values);
  }
  const warningChecks = input.health.checks.filter((item) => item.status === "warning");
  const criticalChecks = input.health.checks.filter((item) => item.status === "critical");
  const bodies = new Map<ContextPackSectionId, SectionBody>();
  bodies.set("identity_authority", {
    lines: [
      `- Task: ${input.task}`,
      `- [entity ${input.project.id}] Repository: ${inlineText(input.project.title)}; live branch ${inlineText(input.repository.branch)}; live HEAD ${inlineText(input.repository.head ?? "unborn")}; indexed HEAD ${inlineText(String(input.project.payload.head ?? "unborn"))}; synchronization ${input.overviewClaim.repository.synchronized ? "current" : "stale"}; live working tree ${input.repository.dirty ? "dirty" : "clean"}. The evidence locator records the indexed snapshot; live Git state was observed while generating this pack. [evidence ${input.project.primaryEvidenceId ?? "missing-evidence"}]`,
      `- Authority: navigation-only; pending proposals are excluded; current source and tests remain authoritative. Health verdict: ${input.health.verdict}.`,
    ],
    itemIds: [input.project.id],
    status: "present",
  });
  const warningLines = input.warnings.length > 0
    ? input.warnings.map((warning) => `- ${inlineText(warning)}`)
    : ["- No Context Atlas integrity or freshness warning is currently reported; this is not a code-correctness verdict."];
  if (input.safety.override) {
    warningLines.unshift(`- OVERRIDDEN CRITICAL CONTEXT WARNING: ${input.safety.override.actor} accepted the listed integrity risks until ${input.safety.override.expiresAt}; override ${input.safety.override.id}; rationale digest ${input.safety.override.reasonDigest.slice(0, 12)}. This remains navigation-only.`);
  }
  bodies.set("warnings", {
    lines: warningLines,
    itemIds: [
      ...(input.overviewClaim.status === "current" ? [] : ["claim:project.overview"]),
      ...criticalChecks.map((item) => `health:${item.id}`),
      ...warningChecks.map((item) => `health:${item.id}`),
    ],
    status: input.warnings.length > 0 || Boolean(input.safety.override) ? "present" : "none",
  });
  const goalCandidates = selectedBySection.get("goals") ?? [];
  const narrativeLine = input.narrative
    ? input.overviewClaim.status === "current"
      ? `- [entity ${input.narrative.id}] Overview projection source: narrative status ${input.narrative.status}; this derived entity supplies freshness context while the reviewed assertion remains authoritative. [evidence ${input.narrative.primaryEvidenceId ?? "missing-evidence"}]`
      : `- [entity ${input.narrative.id}] Overview projection is ${input.overviewClaim.status}; its derived prose is withheld from current guidance until a supported human review settles it. [evidence ${input.project.primaryEvidenceId ?? "missing-evidence"}]`
    : "- No derived overview narrative entity exists; the project overview projection is incomplete.";
  bodies.set("goals", {
    lines: [overviewClaimLine(input.overviewClaim, input.project), narrativeLine, ...goalCandidates.map((item) => item.line)],
    itemIds: [
      input.overviewClaim.status === "current" && input.overviewClaim.assertionId
        ? input.overviewClaim.assertionId
        : input.project.id,
      ...(input.narrative ? [input.narrative.id] : []),
      ...goalCandidates.map((item) => item.id),
    ],
    status: input.overviewClaim.status === "unknown" ? "unknown" : "present",
  });
  setCandidateSection(bodies, selectedBySection, "components", "No task-relevant component fit the budget; inspect the repository map before acting.");
  setCandidateSection(bodies, selectedBySection, "interfaces", "No task-relevant interface or data-flow claim is established; treat it as unknown.");
  setCandidateSection(bodies, selectedBySection, "conventions", "No task-relevant convention is established; inspect current code and configuration.");
  setCandidateSection(bodies, selectedBySection, "decisions", "No task-relevant decision record fit the pack; architectural intent and acceptance state remain unknown.");
  setCandidateSection(bodies, selectedBySection, "constraints", "No task-specific constraint is established by selected evidence; discover constraints before editing.");
  setCandidateSection(bodies, selectedBySection, "risks", "No task-specific risk claim is selected; this is not evidence that the change is safe.");
  setCandidateSection(bodies, selectedBySection, "recent_changes", "No task-relevant recent change fit the pack; inspect Git history before relying on chronology.");
  setCandidateSection(bodies, selectedBySection, "tests", "No task-specific test is established by selected evidence; discover and run relevant checks before editing.");
  const conflictCandidates = selectedBySection.get("conflicts") ?? [];
  const conflictChecks = criticalChecks.filter((item) => /conflict/i.test(item.id));
  bodies.set("conflicts", {
    lines: conflictCandidates.length > 0
      ? conflictCandidates.map((item) => item.line)
      : [`- Active critical conflict checks: ${conflictChecks.map((item) => item.id).join(", ") || "none"}. Absence here is not proof of semantic consistency.`],
    itemIds: [...conflictCandidates.map((item) => item.id), ...conflictChecks.map((item) => `health:${item.id}`)],
    status: conflictCandidates.length > 0 || conflictChecks.length > 0 ? "present" : "none",
  });
  bodies.set("unknowns", {
    lines: [
      "- Runtime correctness, production behavior, and unstated architectural intent are not proven by this pack.",
      "- Re-open current source and run the repository's relevant tests before making or accepting a change.",
      "- Treat absent rationale, interfaces, constraints, and risks as unknown; do not infer them from naming alone.",
    ],
    itemIds: ["unknown:runtime-correctness", "unknown:verification", "unknown:unstated-intent"],
    status: "present",
  });
  bodies.set("evidence", {
    lines: evidence.map(evidenceLine),
    itemIds: evidence.map((item) => item.id),
    status: "present",
  });
  bodies.set("exclusions", {
    lines: exclusions.length > 0
      ? [
          `- ${exclusions.length} material candidate${exclusions.length === 1 ? " was" : "s were"} excluded; every exact ID and reason follows.`,
          ...exclusions.map((item) => `- ${item.kind}:${item.id} -> ${item.reason} (${item.section}).`),
          `- Exact selection manifest hash: ${selectionHash}.`,
        ]
      : ["- No material candidate was excluded.", `- Exact selection manifest hash: ${selectionHash}.`],
    itemIds: exclusions.map((item) => `${item.kind}:${item.id}`),
    status: exclusions.length > 0 ? "present" : "none",
  });
  const renderedSections = SECTION_DEFINITIONS.map((definition) => {
    const body = bodies.get(definition.id) ?? { lines: ["- Unknown."], itemIds: [], status: "unknown" as const };
    const markdown = [`## ${definition.title}`, "", ...body.lines].join("\n");
    return {
      metadata: {
        id: definition.id,
        title: definition.title,
        required: true as const,
        status: body.status,
        includedItemIds: body.itemIds,
        estimatedTokens: estimateTokens(markdown),
      },
      markdown,
    };
  });
  const markdown = renderedSections.flatMap((section) => [section.markdown, ""]).join("\n").trimEnd();
  return {
    markdown,
    sections: renderedSections.map((section) => section.metadata),
    evidence,
    includedEntityIds,
    includedAssertionIds,
    includedEventIds,
    includedEvidenceIds: evidence.map((item) => item.id),
    exclusions,
    selectionHash,
  };
}

function setCandidateSection(
  target: Map<ContextPackSectionId, SectionBody>,
  selected: Map<ContextPackSectionId, PackCandidate[]>,
  section: ContextPackSectionId,
  unknownText: string,
): void {
  const items = selected.get(section) ?? [];
  target.set(section, {
    lines: items.length > 0 ? items.map((item) => item.line) : [`- ${unknownText}`],
    itemIds: items.map((item) => item.id),
    status: items.length > 0 ? "present" : "unknown",
  });
}

function renderPackMarkdown(pack: ContextPackWithClaims, canonicalBody: string): string {
  const warningChecks = pack.freshness.warningCheckIds.join(", ") || "none";
  const criticalChecks = pack.freshness.criticalCheckIds.join(", ") || "none";
  const safety = pack.safety.override
    ? `OVERRIDDEN CRITICAL / navigation-only; override ${pack.safety.override.id}`
    : pack.safety.safeToUse ? "navigation-safe; not proof of correctness" : "blocked";
  return [
    "# Context Atlas task pack",
    "",
    `Pack ID: ${pack.packId}`,
    `Generated at: ${pack.generatedAt}`,
    `Content hash (canonical section body): ${pack.contentHash}`,
    `Format: schema ${pack.schemaVersion}; selector ${pack.policy.selectorVersion}; renderer ${pack.policy.rendererVersion}; estimator ${pack.policy.tokenEstimator}.`,
    `Budget: compact JSON ${pack.estimatedTokens}/${pack.tokenBudget} estimated tokens; ${pack.policy.serializedCharacters}/${pack.policy.hardCharacterLimit} characters; reserved transport characters ${pack.policy.reservedTransportCharacters}.`,
    `Repository: live HEAD ${pack.repository.head ?? "UNBORN"}; indexed HEAD ${pack.repository.indexedHead ?? "UNBORN"}; synchronized ${pack.repository.synchronized}.`,
    `Selection manifest: ${pack.selection.selectionHash}.`,
    `Freshness: ${pack.freshness.verdict}; warnings ${warningChecks}; critical ${criticalChecks}; safety ${safety}.`,
    "",
    canonicalBody,
  ].join("\n");
}

function sectionForEntity(entity: EntityRecord): ContextPackSectionId {
  const searchable = `${entity.type} ${entity.title} ${entity.summary}`;
  if (entity.type === "decision") return "decisions";
  if (/\b(test|spec)\b/i.test(searchable)) return "tests";
  if (/\b(constraint|config|policy|limit|requirement)\b/i.test(searchable)) return "constraints";
  if (/\b(risk|hazard|security|privacy)\b/i.test(searchable)) return "risks";
  if (/\b(conflict|incompatible)\b/i.test(searchable)) return "conflicts";
  if (entity.type === "dependency" || entity.type === "manifest" || /\b(api|interface|schema|database|queue|event|data flow)\b/i.test(searchable)) return "interfaces";
  if (/\b(convention|style|pattern|standard)\b/i.test(searchable)) return "conventions";
  return "components";
}

function sectionForAssertion(assertion: PresentedAssertion): ContextPackSectionId {
  const searchable = `${assertion.predicate} ${assertion.subjectId} ${stableStringify(assertion.value)}`;
  if (/overview|goal|purpose|user/i.test(searchable)) return "goals";
  if (/decision|adr|choice/i.test(searchable)) return "decisions";
  if (/test|spec/i.test(searchable)) return "tests";
  if (/constraint|policy|limit|requirement/i.test(searchable)) return "constraints";
  if (/risk|hazard|security|privacy/i.test(searchable)) return "risks";
  if (/conflict|incompatible/i.test(searchable)) return "conflicts";
  if (/api|interface|schema|database|event|data/i.test(searchable)) return "interfaces";
  if (/convention|style|pattern|standard/i.test(searchable)) return "conventions";
  return "components";
}

function candidateKey(candidate: Pick<PackCandidate, "kind" | "id">): string {
  return `${candidate.kind}:${candidate.id}`;
}

function overviewClaimLine(claim: ProjectOverviewClaimProjection, project: EntityRecord): string {
  if (!claim.assertionId || claim.value === null) {
    return `- [entity ${project.id}] No settled human-reviewed overview exists. Observed snapshot only: ${summarizePackText(project.summary)} [evidence ${project.primaryEvidenceId ?? "missing-evidence"}]`;
  }
  if (claim.status !== "current") {
    return `- ${claim.status.toUpperCase()} — HISTORICAL ONLY, NOT CURRENT GUIDANCE: reviewed overview prose is withheld. Reason: ${inlineText(claim.reason)} Observed snapshot only: ${summarizePackText(project.summary)} [evidence ${project.primaryEvidenceId ?? "missing-evidence"}]`;
  }
  return `- [assertion ${claim.assertionId}] CURRENT: ${summarizeAssertionValue(claim.value)}. Reason: ${inlineText(claim.reason)} [evidence ${evidenceReferences(claim.evidence)}]`;
}

function claimLine(entity: EntityRecord): string {
  const stale = entity.status === "stale" || daysBetween(entity.lastSeen) > entity.staleAfterDays;
  const state = stale ? "STALE — NOT SETTLED CURRENT FACT" : entity.status;
  return `- [entity ${entity.id}] ${inlineText(entity.title)}: ${summarizePackText(entity.summary)} (authority: ${inlineText(entity.source)}; confidence: ${entity.confidence}; state: ${state}) [evidence ${entity.primaryEvidenceId ?? "missing-evidence"}]`;
}

function assertionLine(assertion: PresentedAssertion, evidenceIds: string[]): string {
  const permitted = new Set(evidenceIds);
  return `- [assertion ${assertion.id}] ${inlineText(assertion.predicate)} on ${inlineText(assertion.subjectId)}: ${summarizeAssertionValue(assertion.value)} (presentation: ${assertion.presentation.status}; settled: ${assertion.presentation.settled}; authority: ${assertion.authority}; confidence: ${assertion.confidence}; lifecycle: ${assertion.lifecycle}; valid from ${assertion.validFrom}; recorded ${assertion.recordedAt}) [evidence ${evidenceReferences(assertion.evidence.filter((item) => permitted.has(item.evidenceId)))}]`;
}

function evidenceReferences(items: readonly { evidenceId: string; role: string }[]): string {
  return items.length > 0
    ? items.map((item) => `${inlineText(item.role)}:${item.evidenceId}`).join(", ")
    : "missing-evidence";
}

function eventLine(event: TimelineEvent, evidenceIds: string[]): string {
  return `- [event ${event.id}] ${event.timestamp}: ${inlineText(event.title)} — ${summarizePackText(event.summary)} [evidence ${evidenceIds.join(", ") || "missing-evidence"}]`;
}

function evidenceLine(item: EvidenceRecord): string {
  return item.sensitive
    ? `- [evidence ${item.id}] ${inlineText(item.kind)}: source withheld by sensitive-content policy; digest ${item.digest.slice(0, 12)}.`
    : `- [evidence ${item.id}] ${inlineText(item.kind)}: ${inlineText(item.locator)}; digest ${item.digest.slice(0, 12)}; observed ${item.observedAt}.`;
}

function safeEvidence(evidence: EvidenceRecord): EvidenceRecord {
  return evidence.sensitive
    ? { ...evidence, locator: "[withheld]", metadata: { withheld: true } }
    : { ...evidence, metadata: {} };
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizePackText(value: string): string {
  return inlineText(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  if (!/^human:[a-zA-Z0-9._@-]{1,200}$/.test(override.actor)) throw new Error("Context-pack override actor is invalid.");
  if (override.criticalDigest !== criticalDigest) throw new Error("Context-pack override no longer matches the current critical findings.");
  if (override.taskDigest && override.taskDigest !== sha256(inlineText(task))) throw new Error("Context-pack override was granted for a different task.");
  if (Date.parse(override.expiresAt) <= Date.now()) throw new Error("Context-pack override has expired.");
  return override;
}

function summarizeAssertionValue(value: unknown): string {
  return stableStringify(value).replace(/\s+/g, " ");
}
