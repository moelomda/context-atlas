#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { makeContractEnvelope } from "../core/contracts.js";
import { buildContextPack } from "../core/context-pack.js";
import { getHealthReport } from "../core/health.js";
import { explainEntity, getEvidenceRecord, getOverview, getTimeline, searchAtlas } from "../core/query.js";
import { getAssertionEvolution, getAssertionHistory, getAssertionReviewHistory, queryAssertions } from "../core/temporal.js";

const server = new McpServer({ name: "context-atlas", version: "0.1.0" }, {
  instructions: "Use Context Atlas as evidence-backed navigation, not as proof of correctness. This MCP surface is deliberately read-only. Synchronization, proposals, and review decisions are available only through explicit human-operated CLI commands. Pending proposals are never project truth.",
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
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ task, tokenBudget, repo }) => {
  const root = resolveRepo(repo);
  return result(makeContractEnvelope(root, "context-pack", buildContextPack(root, task, tokenBudget)));
});

server.registerTool("atlas_explain", {
  title: "Explain a project entity",
  description: "Explain a component, document, decision, dependency, or project entity with versions, relationships, history, and evidence.",
  inputSchema: { target: z.string().min(1).max(1_000), repo: repoSchema },
  annotations: readAnnotations,
}, async ({ target, repo }) => {
  const root = resolveRepo(repo);
  return result(makeContractEnvelope(root, "explain", explainEntity(root, target)));
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
  return result(makeContractEnvelope(root, "history", getTimeline(root, query ?? "", limit ?? 100)));
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
  return result(makeContractEnvelope(root, "search", searchAtlas(root, query, limit ?? 20)));
});

server.registerTool("atlas_evidence", {
  title: "Resolve project evidence",
  description: "Resolve one evidence identifier to its safe locator, digest, observation time, sensitivity label, and metadata. Sensitive locators remain withheld.",
  inputSchema: {
    evidenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    repo: repoSchema,
  },
  annotations: readAnnotations,
}, async ({ evidenceId, repo }) => {
  const root = resolveRepo(repo);
  return result(makeContractEnvelope(root, "evidence", getEvidenceRecord(root, evidenceId)));
});

server.registerTool("atlas_assertions", {
  title: "Query temporal project assertions",
  description: "Return accepted, evidence-linked project assertions as they were valid and known at optional valid-time and recorded-time coordinates.",
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
  return result(makeContractEnvelope(root, "assertions", queryAssertions(root, {
    ...(validAt ? { validAt } : {}),
    ...(recordedAt ? { recordedAt } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...(predicate ? { predicate } : {}),
  })));
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
  return result(makeContractEnvelope(root, "assertion-history", {
    logicalId,
    revisions: getAssertionHistory(root, logicalId),
    reviews: getAssertionReviewHistory(root, logicalId),
  }));
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
  return result(makeContractEnvelope(root, "assertion-evolution", getAssertionEvolution(root, {
    ...(subjectId ? { subjectId } : {}),
    ...(predicate ? { predicate } : {}),
    ...(recordedFrom ? { recordedFrom } : {}),
    ...(recordedTo ? { recordedTo } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  })));
});

function resolveRepo(candidate?: string): string {
  return loadConfig(candidate ?? process.env.CONTEXT_ATLAS_REPO ?? process.cwd()).root;
}

function inRepo<T>(candidate: string | undefined, kind: string, query: (root: string) => T) {
  const root = resolveRepo(candidate);
  return result(makeContractEnvelope(root, kind, query(root)));
}

function result(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], structuredContent: asRecord(value) };
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
