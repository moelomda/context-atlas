import type { AtlasDatabase } from "./database.js";
import { validateEvidenceLocators } from "./evidence-validation.js";
import type { PresentedRelationship, RelationshipEvidenceValidation, RelationshipRecord } from "./types.js";

/**
 * Projects stored topology into a fail-closed current-use view. A relationship
 * is current only when its evidence still verifies against the synchronized
 * repository snapshot. Unknown providers, missing records, and policy-denied
 * locators remain visible for diagnosis but are never settled guidance.
 */
export function presentRelationships(
  repoRoot: string,
  database: AtlasDatabase,
  relationships: readonly RelationshipRecord[],
  repositorySynchronized: boolean,
): PresentedRelationship[] {
  const ordered = [...relationships].sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.targetId.localeCompare(right.targetId) ||
      left.id.localeCompare(right.id),
  );
  const evidenceIds = unique(ordered.flatMap((relationship) => (relationship.evidenceId ? [relationship.evidenceId] : [])));
  const evidenceRecords = database.listEvidence(evidenceIds);
  const evidenceById = new Map(evidenceRecords.map((record) => [record.id, record]));
  const validations = validateEvidenceLocators(repoRoot, evidenceRecords);
  const validationById = new Map(validations.results.map((validation) => [validation.evidenceId, validation]));

  return ordered.map((relationship) => {
    const evidenceValidation = relationshipEvidenceValidation(
      relationship.evidenceId,
      evidenceById.has(relationship.evidenceId ?? ""),
      relationship.evidenceId ? validationById.get(relationship.evidenceId) : undefined,
    );
    const presentation = relationshipPresentation(relationship, evidenceValidation, repositorySynchronized);
    return {
      id: relationship.id,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      type: relationship.type,
      evidenceId: relationship.evidenceId,
      active: relationship.active,
      status: presentation.status,
      settled: presentation.status === "current",
      reason: presentation.reason,
      authority: "repository-observation",
      confidence: relationship.confidence,
      evidenceIds: relationship.evidenceId ? [relationship.evidenceId] : [],
      evidenceValidation,
    };
  });
}

function relationshipEvidenceValidation(
  evidenceId: string | null,
  recordExists: boolean,
  validation: ReturnType<typeof validateEvidenceLocators>["results"][number] | undefined,
): RelationshipEvidenceValidation {
  if (!evidenceId) {
    return {
      evidenceId: null,
      locatorKind: null,
      outcome: "missing",
      status: "missing-reference",
      details: "The relationship has no evidence reference.",
    };
  }
  if (!recordExists) {
    return {
      evidenceId,
      locatorKind: null,
      outcome: "missing",
      status: "missing-record",
      details: "The relationship references an evidence record that is not present in the store.",
    };
  }
  if (!validation) {
    return {
      evidenceId,
      locatorKind: null,
      outcome: "not-validated",
      status: "invalid-record",
      details: "Evidence validation did not return an outcome for the relationship evidence.",
    };
  }
  return {
    evidenceId: validation.evidenceId,
    locatorKind: validation.locatorKind,
    outcome: validation.outcome,
    status: validation.status,
    details: validation.details,
  };
}

function relationshipPresentation(
  relationship: RelationshipRecord,
  evidenceValidation: RelationshipEvidenceValidation,
  repositorySynchronized: boolean,
): { status: PresentedRelationship["status"]; reason: string } {
  if (!relationship.active) {
    return {
      status: "stale",
      reason: "The relationship is inactive and retained only as historical topology.",
    };
  }
  if (evidenceValidation.outcome !== "verified") {
    return {
      status: "unknown",
      reason: `Relationship evidence is ${evidenceValidation.status}; topology is visible for diagnosis but is not settled current guidance.`,
    };
  }
  if (!repositorySynchronized) {
    return {
      status: "stale",
      reason:
        "Relationship evidence verifies for the indexed snapshot, but the repository or guidance boundary has changed since synchronization.",
    };
  }
  return {
    status: "current",
    reason: "Relationship evidence verifies against the synchronized repository snapshot; this does not prove runtime behavior.",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
