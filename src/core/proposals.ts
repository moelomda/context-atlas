import { AtlasDatabase } from "./database.js";
import { flushLedgerOutbox, stageLedgerEntry } from "./ledger.js";
import { sanitizeText } from "./security.js";
import { recordAssertionRevisionInDatabase } from "./temporal.js";
import type { EntityRecord, ProposalRecord } from "./types.js";
import { newId, nowIso, sha256, slugify } from "./util.js";

export interface ProposalInput {
  kind: string;
  title: string;
  summary: string;
  targetId?: string;
  evidenceIds: string[];
  payload?: Record<string, unknown>;
}

export function createProposal(repoRoot: string, input: ProposalInput): ProposalRecord {
  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    const title = sanitizeText(input.title, 300);
    const summary = sanitizeText(input.summary, 2_000);
    if (!title.value || !summary.value) throw new Error("Proposal title and summary are required.");
    if (input.targetId && !database.getEntity(input.targetId)) throw new Error(`Unknown target entity: ${input.targetId}`);
    const validEvidence = database.listEvidence(input.evidenceIds);
    if (validEvidence.length !== input.evidenceIds.length) throw new Error("Every proposal evidence ID must exist in the local evidence store.");
    const proposal: ProposalRecord = {
      id: newId("proposal"),
      kind: sanitizeText(input.kind, 80).value || "context_update",
      targetId: input.targetId ?? null,
      title: title.value,
      summary: summary.value,
      payload: input.payload ?? { proposedNarrative: summary.value },
      evidenceIds: input.evidenceIds,
      riskFlags: [
        "requires-human-review",
        ...(input.evidenceIds.length === 0 ? ["missing-evidence"] : []),
        ...(title.sensitive || summary.sensitive ? ["sensitive-content-redacted"] : []),
      ],
      status: "pending",
      createdAt: nowIso(),
      reviewedAt: null,
      reviewNote: null,
      conflictGroup: null,
    };
    const subjectId = proposalSubject(database, proposal);
    let stored!: ProposalRecord;
    database.transaction(() => {
      let assertionId: string | null = null;
      let assertionLogicalId: string | null = null;
      if (proposal.evidenceIds.length > 0) {
        const assertion = recordAssertionRevisionInDatabase(database, {
          logicalId: `claim:proposal:${proposal.id}`,
          subjectId,
          predicate: proposalPredicate(proposal),
          value: proposalValue(proposal),
          scope: proposalScope(proposal),
          authority: "inferred",
          confidence: "inferred",
          producer: `proposal:${proposal.id}`,
          lifecycle: "proposed",
          reviewState: "unreviewed",
          validFrom: proposal.createdAt,
          recordedAt: proposal.createdAt,
          evidence: proposal.evidenceIds.map((evidenceId) => ({ evidenceId, role: "support" })),
          action: "propose",
          metadata: { proposalId: proposal.id, proposalKind: proposal.kind },
        }, { transaction: false });
        assertionId = assertion.id;
        assertionLogicalId = assertion.logicalId;
      }
      stored = database.createProposal({
        ...proposal,
        payload: {
          ...proposal.payload,
          assertionId,
          assertionLogicalId,
          assertionSubjectId: subjectId,
          assertionPredicate: proposalPredicate(proposal),
        },
      });
      stageLedgerEntry(repoRoot, database, {
        kind: "proposal_created",
        actionId: stored.id,
        payload: { kind: stored.kind, targetId: stored.targetId, evidenceIds: stored.evidenceIds },
      });
    });
    flushLedgerOutbox(repoRoot, database);
    return stored;
  } finally {
    database.close();
  }
}

export function approveProposal(repoRoot: string, proposalId: string, note?: string, actor = "human:cli"): ProposalRecord {
  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    validateHumanActor(actor);
    const proposal = database.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    if (proposal.status !== "pending") throw new Error(`Proposal is already ${proposal.status}.`);
    if (proposal.evidenceIds.length === 0 || database.listEvidence(proposal.evidenceIds).length !== proposal.evidenceIds.length) {
      throw new Error("A proposal cannot become project truth without valid evidence.");
    }
    if (proposal.conflictGroup) {
      const conflicts = database.listProposals("pending").filter((candidate) => candidate.conflictGroup === proposal.conflictGroup);
      if (conflicts.length > 1) throw new Error("Resolve the conflicting pending proposals by rejecting obsolete versions before approval.");
    }

    const timestamp = nowIso();
    const entityId = entityIdForProposal(proposal);
    const existing = database.getEntity(entityId);
    const subjectId = proposalSubject(database, proposal);
    const predicate = proposalPredicate(proposal);
    const scope = proposalScope(proposal);
    const logicalId = canonicalLogicalId(proposal, subjectId, predicate, scope);
    const previousCanonical = database.db.prepare("SELECT id FROM assertions WHERE logical_id = ? ORDER BY revision DESC LIMIT 1")
      .get(logicalId) as { id?: unknown } | undefined;
    const previousCanonicalId = typeof previousCanonical?.id === "string" ? previousCanonical.id : null;
    if (previousCanonicalId && !note?.trim()) throw new Error("Revising accepted project knowledge requires an explicit review note.");
    let assertionId = "";
    const entityBase: EntityRecord = {
      id: entityId,
      type: proposal.kind === "decision" ? "decision" : "narrative",
      title: proposal.kind === "context_update" ? "Approved project overview" : proposal.title,
      summary: proposal.summary,
      status: "active",
      confidence: "approved",
      source: "human_approved",
      firstSeen: existing?.firstSeen ?? timestamp,
      lastSeen: timestamp,
      staleAfterDays: 30,
      payload: { ...proposal.payload, proposalId: proposal.id, targetId: proposal.targetId },
      primaryEvidenceId: proposal.evidenceIds[0] ?? null,
    };
    database.transaction(() => {
      if (typeof proposal.payload.assertionId === "string") {
        recordAssertionRevisionInDatabase(database, {
          supersedesId: proposal.payload.assertionId,
          subjectId,
          predicate,
          value: proposalValue(proposal),
          scope,
          authority: "inferred",
          confidence: "inferred",
          producer: `proposal:${proposal.id}`,
          lifecycle: "superseded",
          reviewState: "accepted",
          validFrom: proposal.createdAt,
          recordedAt: timestamp,
          evidence: proposal.evidenceIds.map((evidenceId) => ({ evidenceId, role: "support" })),
          actor,
          action: "supersede",
          rationale: note?.trim() || `Accepted into canonical assertion ${logicalId}.`,
          metadata: { proposalId: proposal.id, proposalKind: proposal.kind, mergedIntoLogicalId: logicalId },
        }, { transaction: false });
      }
      const assertion = recordAssertionRevisionInDatabase(database, {
        ...(previousCanonicalId ? { supersedesId: previousCanonicalId } : { logicalId }),
        subjectId,
        predicate,
        value: proposalValue(proposal),
        scope,
        authority: "human",
        confidence: "approved",
        producer: `proposal:${proposal.id}`,
        lifecycle: "accepted",
        reviewState: "accepted",
        validFrom: timestamp,
        recordedAt: timestamp,
        evidence: proposal.evidenceIds.map((evidenceId) => ({ evidenceId, role: "support" })),
        actor,
        action: previousCanonicalId ? "edit_accept" : "accept",
        ...(note ? { rationale: note } : {}),
        metadata: { proposalId: proposal.id, proposalKind: proposal.kind, projectionEntityId: entityId, candidateAssertionId: proposal.payload.assertionId ?? null },
      }, { transaction: false });
      assertionId = assertion.id;
      const entity: EntityRecord = {
        ...entityBase,
        payload: { ...entityBase.payload, assertionId: assertion.id, assertionLogicalId: assertion.logicalId },
      };
      database.upsertEntity(entity, proposal.evidenceIds, `approved proposal ${proposal.id}`);
      database.reviewProposal(proposal.id, "approved", note ? sanitizeText(note, 1_000).value : null);
      const ledger = stageLedgerEntry(repoRoot, database, {
        kind: "proposal_approved",
        actionId: proposal.id,
        payload: { entityId, assertionId, actor, evidenceIds: proposal.evidenceIds, note: note ? sha256(note) : null },
      });
      database.insertEvent({
        id: `event_approval_${proposal.id}`,
        timestamp,
        type: "context_approval",
        title: `Approved: ${proposal.title}`,
        summary: proposal.summary,
        commit: null,
        files: [],
        evidence: proposal.evidenceIds,
        ledgerHash: ledger.hash,
      });
    });
    flushLedgerOutbox(repoRoot, database);
    return database.getProposal(proposal.id) as ProposalRecord;
  } finally {
    database.close();
  }
}

export function rejectProposal(repoRoot: string, proposalId: string, note?: string, actor = "human:cli"): ProposalRecord {
  const database = new AtlasDatabase(repoRoot);
  try {
    flushLedgerOutbox(repoRoot, database);
    validateHumanActor(actor);
    const proposal = database.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    if (proposal.status !== "pending") throw new Error(`Proposal is already ${proposal.status}.`);
    const cleanNote = note ? sanitizeText(note, 1_000).value : null;
    database.transaction(() => {
      if (typeof proposal.payload.assertionId === "string") {
        recordAssertionRevisionInDatabase(database, {
          supersedesId: proposal.payload.assertionId,
          subjectId: proposalSubject(database, proposal),
          predicate: proposalPredicate(proposal),
          value: proposalValue(proposal),
          scope: proposalScope(proposal),
          authority: "inferred",
          confidence: "inferred",
          producer: `proposal:${proposal.id}`,
          lifecycle: "rejected",
          reviewState: "rejected",
          validFrom: proposal.createdAt,
          recordedAt: nowIso(),
          evidence: proposal.evidenceIds.map((evidenceId) => ({ evidenceId, role: "support" })),
          actor,
          action: "reject",
          ...(cleanNote ? { rationale: cleanNote } : {}),
          metadata: { proposalId: proposal.id, proposalKind: proposal.kind },
        }, { transaction: false });
      }
      database.reviewProposal(proposal.id, "rejected", cleanNote);
      const ledger = stageLedgerEntry(repoRoot, database, {
        kind: "proposal_rejected",
        actionId: proposal.id,
        payload: { actor, evidenceIds: proposal.evidenceIds, note: cleanNote ? sha256(cleanNote) : null },
      });
      database.insertEvent({
        id: `event_rejection_${proposal.id}`,
        timestamp: nowIso(),
        type: "context_rejection",
        title: `Rejected: ${proposal.title}`,
        summary: cleanNote || "A human reviewer rejected this proposed context.",
        commit: null,
        files: [],
        evidence: proposal.evidenceIds,
        ledgerHash: ledger.hash,
      });
    });
    flushLedgerOutbox(repoRoot, database);
    return database.getProposal(proposal.id) as ProposalRecord;
  } finally {
    database.close();
  }
}

export function listProposals(repoRoot: string, status?: ProposalRecord["status"]): ProposalRecord[] {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try { return database.listProposals(status); } finally { database.close(); }
}

function entityIdForProposal(proposal: ProposalRecord): string {
  if (proposal.kind === "context_update") return "narrative:project-overview";
  if (proposal.kind === "decision") return `decision:approved:${slugify(proposal.title)}-${sha256(proposal.id).slice(0, 8)}`;
  return `narrative:approved:${slugify(proposal.title)}-${sha256(proposal.id).slice(0, 8)}`;
}

function proposalSubject(database: AtlasDatabase, proposal: ProposalRecord): string {
  if (proposal.targetId) return proposal.targetId;
  const project = database.listEntities({ types: ["project"] })[0];
  if (!project) throw new Error("A synchronized project entity is required before creating project context.");
  return project.id;
}

function proposalPredicate(proposal: Pick<ProposalRecord, "kind">): string {
  if (proposal.kind === "context_update") return "project.overview";
  if (proposal.kind === "decision") return "decision.record";
  if (proposal.kind === "risk") return "project.risk";
  return "project.narrative";
}

function proposalScope(proposal: Pick<ProposalRecord, "id" | "kind" | "targetId">): string {
  if (proposal.kind === "context_update") return "project";
  if (proposal.targetId) return `entity:${proposal.targetId}`;
  return `${proposal.kind}:${proposal.id}`;
}

function canonicalLogicalId(
  proposal: Pick<ProposalRecord, "id" | "kind" | "targetId">,
  subjectId: string,
  predicate: string,
  scope: string,
): string {
  const identity = proposal.kind === "context_update" || proposal.targetId
    ? [subjectId, predicate, scope]
    : [subjectId, predicate, scope, proposal.id];
  return `claim:canonical:${sha256(JSON.stringify(identity)).slice(0, 32)}`;
}

function proposalValue(proposal: Pick<ProposalRecord, "id" | "title" | "summary" | "payload">): Record<string, unknown> {
  const { assertionId: _assertionId, assertionLogicalId: _assertionLogicalId, assertionSubjectId: _subjectId, assertionPredicate: _predicate, ...payload } = proposal.payload;
  return { title: proposal.title, summary: proposal.summary, payload, proposalId: proposal.id };
}

function validateHumanActor(actor: string): void {
  const clean = sanitizeText(actor, 300);
  if (clean.sensitive || clean.value !== actor || !/^human:[a-zA-Z0-9._@-]{1,200}$/.test(actor)) {
    throw new Error("Proposal reviews require a valid attributed human: actor.");
  }
}
