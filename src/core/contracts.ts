import { AtlasDatabase } from "./database.js";
import { newId, nowIso } from "./util.js";

export const CONTRACT_VERSION = "1.0.0";
export const CONTRACT_SCHEMA_VERSION = 1;

export interface ContractSnapshot {
  repositoryId: string | null;
  head: string | null;
  knowledgeWatermark: string;
  synchronizedAt: string | null;
}

export interface ContractEnvelope<T> {
  schemaVersion: 1;
  contractVersion: string;
  kind: string;
  requestId: string;
  generatedAt: string;
  snapshot: ContractSnapshot;
  warnings: string[];
  data: T;
}

export function makeContractEnvelope<T>(repoRoot: string, kind: string, data: T, warnings: string[] = []): ContractEnvelope<T> {
  const database = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const project = database.listEntities({ types: ["project"] })[0];
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      kind,
      requestId: newId("request"),
      generatedAt: nowIso(),
      snapshot: {
        repositoryId: typeof project?.payload.repositoryId === "string" ? project.payload.repositoryId : null,
        head: database.getMeta("last_synced_head"),
        knowledgeWatermark: database.getMeta("ledger_head") ?? "GENESIS",
        synchronizedAt: database.getMeta("last_synced_at"),
      },
      warnings: [...new Set(warnings)].sort(),
      data,
    };
  } finally {
    database.close();
  }
}
