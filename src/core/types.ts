export const ATLAS_SCHEMA_VERSION = 1;

export type Confidence = "observed" | "documented" | "approved" | "inferred";
export type EntityStatus = "active" | "stale" | "superseded" | "removed";
export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

export interface AtlasConfig {
  schemaVersion: number;
  projectName: string;
  createdAt: string;
  repoRoot: string;
  staleAfterDays: number;
  defaultTokenBudget: number;
  maxCommits: number;
  maxComponentDepth: number;
  maxFiles: number;
  excludedPaths: string[];
}

export interface GitCommit {
  hash: string;
  timestamp: string;
  author: string;
  subject: string;
  files: CommitFile[];
}

export interface CommitFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface RepoStatus {
  root: string;
  canonicalRoot: string;
  gitCommonDir: string;
  repositoryId: string;
  objectFormat: "sha1" | "sha256" | "unknown";
  defaultBranch: string | null;
  head: string | null;
  branch: string;
  detached: boolean;
  dirty: boolean;
  changedFiles: number;
  shallow: boolean;
  reachableCommits: number;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  sparseCheckout: boolean;
  submoduleCount: number;
  lfsTracked: boolean;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  locator: string;
  digest: string;
  observedAt: string;
  sensitive: boolean;
  metadata: Record<string, unknown>;
}

export interface EntityRecord {
  id: string;
  type: string;
  title: string;
  summary: string;
  status: EntityStatus;
  confidence: Confidence;
  source: string;
  firstSeen: string;
  lastSeen: string;
  staleAfterDays: number;
  payload: Record<string, unknown>;
  primaryEvidenceId: string | null;
}

export interface RelationshipRecord {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: Confidence;
  evidenceId: string | null;
  active: boolean;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  summary: string;
  commit: string | null;
  files: CommitFile[];
  evidence: string[];
  ledgerHash: string | null;
}

export interface ProposalRecord {
  id: string;
  kind: string;
  targetId: string | null;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidenceIds: string[];
  riskFlags: string[];
  status: ProposalStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  conflictGroup: string | null;
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  summary: string;
  status: EntityStatus;
  confidence: Confidence;
  stale: boolean;
  evidenceCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: string;
  nodeLimit: number;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
}

export type HealthStatus = "pass" | "info" | "warning" | "critical";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  severity: number;
  details: string;
  recommendation: string;
}

export type HealthVerdict = "healthy" | "degraded" | "blocked";

export interface ComponentHealth {
  id: string;
  title: string;
  status: "current" | "stale" | "unsupported";
  reason: string;
  evidenceIds: string[];
  lastSeen: string;
}

export interface HealthReport {
  verdict: HealthVerdict;
  safeToUse: boolean;
  criticalCount: number;
  warningCount: number;
  score: number;
  checks: HealthCheck[];
  components: ComponentHealth[];
  pendingProposals: number;
  generatedAt: string;
}

export interface ContextPack {
  schemaVersion: number;
  packId: string;
  task: string;
  generatedAt: string;
  repository: { project: string; branch: string; head: string | null };
  tokenBudget: number;
  estimatedTokens: number;
  truncated: boolean;
  contentHash: string;
  selection: { includedEntityIds: string[]; includedAssertionIds: string[]; excludedEntityCount: number };
  safety: {
    safeToUse: boolean;
    scope: "navigation-only";
    notProofOfCorrectness: true;
    criticalChecks: Array<{ id: string; label: string; details: string }>;
    override: {
      id: string;
      actor: string;
      reasonDigest: string;
      createdAt: string;
      expiresAt: string;
    } | null;
  };
  markdown: string;
  evidence: EvidenceRecord[];
  warnings: string[];
}

export interface SyncResult {
  runId: string;
  repository: RepoStatus;
  commitsAdded: number;
  componentsObserved: number;
  documentsObserved: number;
  relationshipsObserved: number;
  proposalsCreated: string[];
  sensitiveItemsWithheld: number;
  truncatedFileScan: boolean;
  truncatedHistory: boolean;
  startedAt: string;
  completedAt: string;
}

export interface LedgerEntry {
  sequence: number;
  previousHash: string;
  timestamp: string;
  kind: string;
  actionId: string;
  payloadDigest: string;
  hash: string;
}
