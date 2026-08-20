import { AtlasDatabase } from "./database.js";
import { getCurrentGuidanceWatermark } from "./config.js";
import { withEvidenceValidationCache } from "./evidence-validation.js";
import {
  getFreshRepositoryReadBoundary,
  getFreshRepoStatus,
  repositoryReadBoundary,
  withRepoStatusSnapshot,
  type RepositoryReadBoundary,
} from "./git.js";
import type { RepoStatus } from "./types.js";
import { newId, nowIso, stableStringify } from "./util.js";

export const CONTRACT_VERSION = "1.0.0";
export const CONTRACT_SCHEMA_VERSION = 1;

export class ContractSnapshotChangedError extends Error {
  readonly code = "snapshot_changed";
  constructor() {
    super("Context Atlas state changed while the read response was being assembled; retry against a stable repository and knowledge snapshot.");
    this.name = "ContractSnapshotChangedError";
  }
}

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

export interface StableContractReadContext {
  database: AtlasDatabase;
  repository: RepoStatus;
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

/**
 * Holds one observer connection open while a read adapter builds its payload
 * and envelope. SQLite's connection-local data_version detects commits from
 * other connections; live Git/worktree and guidance-policy fingerprints cover
 * non-database inputs. Results are refused instead of being labelled with a
 * snapshot boundary different from the data they contain.
 */
export function withStableContractRead<T>(repoRoot: string, operation: (context: StableContractReadContext) => T): T {
  const observer = new AtlasDatabase(repoRoot, { readOnly: true });
  try {
    const repository = getFreshRepoStatus(repoRoot);
    const before = contractReadBoundary(repoRoot, observer, repositoryReadBoundary(repository));
    const result = withRepoStatusSnapshot(repoRoot, repository, () =>
      withEvidenceValidationCache(repoRoot, () => operation({ database: observer, repository })));
    const after = contractReadBoundary(repoRoot, observer, getFreshRepositoryReadBoundary(repoRoot, repository));
    if (before !== after) {
      throw new ContractSnapshotChangedError();
    }
    return result;
  } finally {
    observer.close();
  }
}

function contractReadBoundary(repoRoot: string, database: AtlasDatabase, repository: RepositoryReadBoundary): string {
  const dataVersionRow = database.db.prepare("PRAGMA data_version").get() as Record<string, unknown>;
  const dataVersion = Number(Object.values(dataVersionRow)[0] ?? -1);
  return stableStringify({
    dataVersion,
    repository: {
      repositoryId: repository.repositoryId,
      objectFormat: repository.objectFormat,
      branch: repository.branch,
      head: repository.head,
      detached: repository.detached,
      dirty: repository.dirty,
      changedFiles: repository.changedFiles,
      workingTreeFingerprint: repository.workingTreeFingerprint,
      mergeInProgress: repository.mergeInProgress,
      rebaseInProgress: repository.rebaseInProgress,
    },
    guidanceWatermark: getCurrentGuidanceWatermark(repoRoot).watermark,
    ledgerHead: database.getMeta("ledger_head") ?? "GENESIS",
    synchronizedHead: database.getMeta("last_synced_head"),
    synchronizedFingerprint: database.getMeta("last_synced_worktree_fingerprint"),
    synchronizedGuidanceWatermark: database.getMeta("last_synced_guidance_watermark"),
  });
}
