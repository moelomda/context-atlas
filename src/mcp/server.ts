#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertionPresentationWarnings, queryPresentedAssertions } from "../core/claim-status.js";
import { loadConfig } from "../core/config.js";
import { makeContractEnvelope, withStableContractRead } from "../core/contracts.js";
import { buildContextPack } from "../core/context-pack.js";
import { getHealthReport } from "../core/health.js";
import {
  diffContextPackSnapshots,
  listContextPackHistory,
  readContextPackSnapshot,
  summarizeContextPackSnapshot,
  type ContextPackDiff,
  type ContextPackHistory,
  type ContextPackSnapshotSummary,
} from "../core/pack-lifecycle.js";
import { explainEntity, getEvidenceRecord, getOverview, getTimeline, searchAtlas } from "../core/query.js";
import { getAssertionEvolution, getAssertionHistory, getAssertionReviewHistory } from "../core/temporal.js";

const server = new McpServer({ name: "context-atlas", version: "0.1.0" }, {
  instructions: "Use Context Atlas as evidence-backed navigation, not as proof of correctness. This MCP surface is deliberately read-only. Synchronization, proposals, pack persistence/refresh, retention, and review decisions require an explicit human-operated CLI or protected loopback-dashboard workflow. Pending proposals are never project truth.",
});

const repoSchema = z.string().min(1).max(4_096).optional().describe("Path inside an initialized Context Atlas Git repository. Defaults to the current directory.");
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

server.registerTool("atlas_overview", {
  title: "Get project overview",
  description: "Return the current evidence-backed project summary, statistics, risks, and recent history. Pending proposals are excluded.",
  inputSchema: { repo: repoSchema },
  annotations: readAnnotations,
}, async ({ repo }) => inRepo(repo, "overview", getOverview));

server.registerTool("atlas_context_pack", {
  title: "Build task context pack",
  description: "Build a bounded, task-specific context pack with confidence labels, health warnings, and evidence citations before a coding change.",
  inputSchema: {
    task: z.string().min(1).max(2_000),
    tokenBudget: z.number().int().min(500).max(20_000).optional(),
    overrideId: z.string().regex(/^pack_override_[a-f0-9]{24}$/).optional()
      .describe("Optional ID of an existing, task-scoped, unexpired human CLI override. Using it never hides the critical warning."),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ task, tokenBudget, overrideId, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => contextPackResult(root, task, tokenBudget, overrideId));
});

server.registerTool("atlas_pack_history", {
  title: "List saved context packs",
  description: "List a bounded, newest-first history of immutable context-pack snapshots without rebuilding or changing project memory.",
  inputSchema: {
    limit: z.number().int().min(1).max(256).optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ limit, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => compactStructuredResult(
    makeContractEnvelope(root, "pack-history", compactPackHistory(listContextPackHistory(root, limit === undefined ? {} : { limit }))),
    "Verified saved context-pack history is available in structuredContent.",
  ));
});

const packSnapshotIdSchema = z.string().regex(/^pack_snapshot_[a-f0-9]{64}$/)
  .describe("Immutable context-pack snapshot ID returned by atlas_pack_history.");

server.registerTool("atlas_pack_snapshot", {
  title: "Read a saved context pack",
  description: "Verify and read one immutable context-pack snapshot. By default this returns safe metadata; request includePack only when the full historical pack is necessary.",
  inputSchema: {
    snapshotId: packSnapshotIdSchema,
    includePack: z.boolean().optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ snapshotId, includePack, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => {
    const snapshot = readContextPackSnapshot(root, snapshotId);
    const data = includePack
      ? snapshot
      : { summary: compactPackSummary(summarizeContextPackSnapshot(snapshot)), packIncluded: false };
    const envelope = makeContractEnvelope(root, "pack-snapshot", data, includePack ? snapshot.pack.warnings : []);
    return compactStructuredResult(envelope, `Verified context-pack snapshot ${snapshot.snapshotId} is available once in structuredContent.`);
  });
});

server.registerTool("atlas_pack_diff", {
  title: "Compare saved context packs",
  description: "Compare two verified immutable context-pack snapshots across task, repository, freshness, policy, sections, selected claims, relationships, events, evidence, and warnings.",
  inputSchema: {
    leftSnapshotId: packSnapshotIdSchema,
    rightSnapshotId: packSnapshotIdSchema,
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ leftSnapshotId, rightSnapshotId, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => compactStructuredResult(
    makeContractEnvelope(root, "pack-diff", compactPackDiff(diffContextPackSnapshots(root, leftSnapshotId, rightSnapshotId))),
    "Verified context-pack diff is available in structuredContent.",
  ));
});

server.registerTool("atlas_explain", {
  title: "Explain a project entity",
  description: "Explain a component, document, decision, dependency, or project entity with versions, relationships, history, and evidence.",
  inputSchema: { target: z.string().min(1).max(1_000), repo: repoSchema },
  annotations: readAnnotations,
}, async ({ target, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => {
    const explanation = explainEntity(root, target);
    return result(makeContractEnvelope(root, "explain", explanation, dataWarnings(explanation)));
  });
});

server.registerTool("atlas_history", {
  title: "Search project history",
  description: "Return immutable Git and human-review timeline events, optionally filtered by a query.",
  inputSchema: {
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ query, limit, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => result(makeContractEnvelope(root, "history", getTimeline(root, query ?? "", limit ?? 100))));
});

server.registerTool("atlas_health", {
  title: "Check project-memory health",
  description: "Check freshness, evidence coverage, ledger integrity, proposal conflicts, secret containment, and repository synchronization.",
  inputSchema: { repo: repoSchema },
  annotations: readAnnotations,
}, async ({ repo }) => inRepo(repo, "health", getHealthReport));

server.registerTool("atlas_search", {
  title: "Search the project atlas",
  description: "Search evidence-backed entities and timeline events without exposing raw repository contents.",
  inputSchema: {
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(100).optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ query, limit, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => {
    const search = searchAtlas(root, query, limit ?? 20);
    return result(makeContractEnvelope(root, "search", search, dataWarnings(search)));
  });
});

server.registerTool("atlas_evidence", {
  title: "Resolve project evidence",
  description: "Resolve one evidence identifier to its safe locator, digest, observation time, and sensitivity label. Sensitive locators and host-specific metadata remain withheld.",
  inputSchema: {
    evidenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ evidenceId, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => result(makeContractEnvelope(root, "evidence", getEvidenceRecord(root, evidenceId))));
});

server.registerTool("atlas_assertions", {
  title: "Query temporal project assertions",
  description: "Return evidence-linked temporal assertions. Every row includes a mandatory presentation status, settled flag, reason, evidence, and current/as-of scope; immutable lifecycle alone must never be interpreted as current authority.",
  inputSchema: {
    validAt: z.string().max(64).optional(),
    recordedAt: z.string().max(64).optional(),
    subjectId: z.string().max(500).optional(),
    predicate: z.string().max(160).optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ validAt, recordedAt, subjectId, predicate, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => {
    const assertions = queryPresentedAssertions(root, {
      ...(validAt ? { validAt } : {}),
      ...(recordedAt ? { recordedAt } : {}),
      ...(subjectId ? { subjectId } : {}),
      ...(predicate ? { predicate } : {}),
    });
    return result(makeContractEnvelope(root, "assertions", assertions, assertionPresentationWarnings(assertions)));
  });
});

server.registerTool("atlas_assertion_history", {
  title: "Inspect assertion history",
  description: "Return every immutable revision and actor-attributed review action for one logical assertion.",
  inputSchema: {
    logicalId: z.string().min(1).max(500),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ logicalId, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => result(makeContractEnvelope(root, "assertion-history", {
    logicalId,
    revisions: getAssertionHistory(root, logicalId),
    reviews: getAssertionReviewHistory(root, logicalId),
  })));
});

server.registerTool("atlas_assertion_evolution", {
  title: "Inspect assertion evolution",
  description: "Return immutable assertion revisions across optional valid-time and recorded-time ranges for forensic change tracking.",
  inputSchema: {
    subjectId: z.string().max(500).optional(),
    predicate: z.string().max(160).optional(),
    recordedFrom: z.string().max(64).optional(),
    recordedTo: z.string().max(64).optional(),
    validFrom: z.string().max(64).optional(),
    validTo: z.string().max(64).optional(),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ subjectId, predicate, recordedFrom, recordedTo, validFrom, validTo, repo }) => {
  const root = resolveRepo(repo);
  return withStableContractRead(root, () => result(makeContractEnvelope(root, "assertion-evolution", getAssertionEvolution(root, {
    ...(subjectId ? { subjectId } : {}),
    ...(predicate ? { predicate } : {}),
    ...(recordedFrom ? { recordedFrom } : {}),
    ...(recordedTo ? { recordedTo } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  }))));
});

function resolveRepo(candidate?: string): string {
  return loadConfig(candidate ?? process.env.CONTEXT_ATLAS_REPO ?? process.cwd()).root;
}

function inRepo<T>(candidate: string | undefined, kind: string, query: (root: string) => T) {
  const root = resolveRepo(candidate);
  return withStableContractRead(root, () => {
    const data = query(root);
    return result(makeContractEnvelope(root, kind, data, dataWarnings(data)));
  });
}

function dataWarnings(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const warnings = (value as Record<string, unknown>).warnings;
  return Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === "string") : [];
}

function result(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return boundedMcpResult({ content: [{ type: "text" as const, text }], structuredContent: asRecord(value) });
}

function compactStructuredResult(value: unknown, summary: string) {
  return boundedMcpResult({ content: [{ type: "text" as const, text: summary }], structuredContent: asRecord(value) });
}

const MAX_MCP_TOOL_RESULT_CHARACTERS = 2_500_000;

function boundedMcpResult<T extends { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }>(response: T): T {
  const characters = JSON.stringify(response).length;
  if (characters > MAX_MCP_TOOL_RESULT_CHARACTERS) {
    throw new Error(
      `Context Atlas refused an MCP tool result of ${characters} characters; narrow the query or request less history (limit ${MAX_MCP_TOOL_RESULT_CHARACTERS}).`,
    );
  }
  return response;
}

function compactPackHistory(history: ContextPackHistory) {
  return {
    schemaVersion: history.schemaVersion,
    limit: history.limit,
    retainedLimit: history.retainedLimit,
    totalCount: history.totalCount,
    count: history.count,
    snapshots: history.snapshots.map(compactPackSummary),
  };
}

function compactPackDiff(diff: ContextPackDiff) {
  return {
    ...diff,
    left: compactPackSummary(diff.left),
    right: compactPackSummary(diff.right),
  };
}

function compactPackSummary(summary: ContextPackSnapshotSummary) {
  const taskPreview = summary.task.length > 240 ? `${summary.task.slice(0, 237)}...` : summary.task;
  return {
    schemaVersion: summary.schemaVersion,
    snapshotId: summary.snapshotId,
    snapshotHash: summary.snapshotHash,
    semanticHash: summary.semanticHash,
    savedAt: summary.savedAt,
    packId: summary.packId,
    packContentHash: summary.packContentHash,
    taskPreview,
    taskDigest: summary.taskDigest,
    repository: summary.repository,
    policy: {
      contextPack: summary.policy.contextPack,
      guidance: {
        watermark: summary.policy.guidance.watermark,
        extractorVersion: summary.policy.guidance.extractorVersion,
        schemaVersion: summary.policy.guidance.schemaVersion,
        watermarkSchemaVersion: summary.policy.guidance.watermarkSchemaVersion,
        atlasIgnorePolicyHash: summary.policy.guidance.atlasIgnorePolicyHash,
      },
      overrideId: summary.policy.overrideId,
    },
    freshness: summary.freshness,
    selectionHash: summary.selectionHash,
  };
}

function contextPackResult(root: string, task: string, tokenBudget?: number, overrideId?: string) {
  const requestedBudget = tokenBudget ?? loadConfig(root).config.defaultTokenBudget;
  const hardCharacterLimit = requestedBudget * 4;
  let transportCharacterReserve = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const pack = buildContextPack(root, task, requestedBudget, { transportCharacterReserve, ...(overrideId ? { overrideId } : {}) });
    const envelope = {
      ...makeContractEnvelope(root, "context-pack", pack, pack.warnings),
      transport: {
        scope: "mcp-tool-result-compact-json" as const,
        hardCharacterLimit,
        serializedCharacters: 0,
        estimatedTokens: 0,
        jsonRpcFramingIncluded: false,
      },
    };
    const response = {
      content: [{
        type: "text" as const,
        text: "",
      }],
      structuredContent: asRecord(envelope),
    };
    for (let metadataPass = 0; metadataPass < 8; metadataPass += 1) {
      const disposition = pack.safety.override
        ? "OVERRIDDEN CRITICAL / navigation-only"
        : pack.safety.safeToUse ? "navigation-safe" : "blocked";
      response.content[0]!.text = `Context pack ${pack.packId} is available once in structuredContent (pack estimate ${pack.estimatedTokens} tokens; complete MCP tool-result estimate ${envelope.transport.estimatedTokens}/${pack.tokenBudget} tokens; ${disposition}).`;
      const serializedCharacters = JSON.stringify(response).length;
      const estimatedTokens = Math.ceil(serializedCharacters / 4);
      if (envelope.transport.serializedCharacters === serializedCharacters
        && envelope.transport.estimatedTokens === estimatedTokens) break;
      envelope.transport.serializedCharacters = serializedCharacters;
      envelope.transport.estimatedTokens = estimatedTokens;
    }
    const serializedCharacters = JSON.stringify(response).length;
    if (serializedCharacters !== envelope.transport.serializedCharacters) {
      throw new Error("Context-pack MCP transport budget metadata did not converge.");
    }
    if (serializedCharacters <= hardCharacterLimit) return response;
    const packCharacters = JSON.stringify(pack).length;
    const requiredReserve = serializedCharacters - packCharacters;
    if (requiredReserve <= transportCharacterReserve) break;
    transportCharacterReserve = requiredReserve;
  }
  throw new Error("Context-pack MCP response could not satisfy the requested compact transport character cap.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`Context Atlas MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
