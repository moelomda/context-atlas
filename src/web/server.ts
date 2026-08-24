import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertionPresentationWarnings, getPresentedAssertion, queryPresentedAssertions } from "../core/claim-status.js";
import { ContractSnapshotChangedError, CONTRACT_VERSION, makeContractEnvelope, withStableContractRead } from "../core/contracts.js";
import {
  applyExternalImportText,
  ExternalImportInputError,
  ExternalImportPlanChangedError,
  previewExternalImportText,
  type ExternalImportRequest,
  type ExternalImportTextSource,
} from "../core/external-import.js";
import { getHealthReport } from "../core/health.js";
import { approveProposal, listProposals, rejectProposal } from "../core/proposals.js";
import { explainEntity, getEvidenceRecord, getGraph, getOverview, getTimeline, searchAtlas } from "../core/query.js";
import { findSecrets } from "../core/security.js";
import { getAssertionEvolution, getAssertionHistory, getAssertionReviewHistory } from "../core/temporal.js";
import type { ProposalRecord } from "../core/types.js";

export interface WebServerOptions {
  host?: string;
  port?: number;
}

interface BrowserSecurityContext {
  readonly sessionToken: string;
  readonly hostname: string;
  port: number | null;
}

interface ReviewRequest {
  actor: string;
  rationale: string;
}

const REVIEW_SESSION_PATH = "/api/v1/review-session";
const REVIEW_WORKSPACE_PATH = "/api/v1/review-workspace";
const REVIEW_MUTATION_PATTERN = /^\/api\/v1\/proposals\/([a-zA-Z0-9_-]{1,200})\/(approve|reject)$/;
const EXTERNAL_IMPORT_PREVIEW_PATH = "/api/v1/external-import/preview";
const EXTERNAL_IMPORT_APPLY_PATH = "/api/v1/external-import/apply";
const SESSION_HEADER = "x-context-atlas-session";
const MAX_JSON_BODY_BYTES = 4_096;
const MAX_EXTERNAL_IMPORT_JSON_BODY_BYTES = 300 * 1_024;
const MAX_BROWSER_SOURCE_BYTES = 192 * 1_024;
const MAX_REVIEW_RATIONALE_CHARACTERS = 1_000;
const MIN_REVIEW_RATIONALE_CHARACTERS = 8;

function isExternalImportPath(pathname: string): boolean {
  return pathname === EXTERNAL_IMPORT_PREVIEW_PATH || pathname === EXTERNAL_IMPORT_APPLY_PATH;
}

function isProtectedPostPath(pathname: string): boolean {
  return pathname === REVIEW_SESSION_PATH || REVIEW_MUTATION_PATTERN.test(pathname) || isExternalImportPath(pathname);
}

export async function startWebServer(repoRoot: string, options: WebServerOptions = {}): Promise<{ server: Server; url: string }> {
  const requestedHost = options.host ?? "127.0.0.1";
  const host = requestedHost.trim().replace(/^\[(.*)\]$/, "$1");
  const port = options.port ?? 4242;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Port must be between 0 and 65535.");
  if (!isLoopbackHost(host)) throw new Error("Context Atlas refuses unauthenticated non-loopback binding. Use 127.0.0.1, ::1, or localhost.");
  const publicDirectory = resolvePublicDirectory();
  const security: BrowserSecurityContext = {
    sessionToken: randomBytes(32).toString("base64url"),
    hostname: normalizeHostname(host),
    port: null,
  };
  const server = createServer((request, response) => {
    handleRequest(repoRoot, publicDirectory, security, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
        const status = error instanceof ContractSnapshotChangedError ? 409 : 500;
        const code = error instanceof ContractSnapshotChangedError ? error.code : "request_failed";
        sendVersionedError(repoRoot, response, status, code, message, request.method === "HEAD");
        return;
      }
      sendJson(response, 500, { error: "request_failed", message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  security.port = actualPort;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return { server, url: `http://${urlHost}:${actualPort}` };
}

async function handleRequest(
  repoRoot: string,
  publicDirectory: string,
  security: BrowserSecurityContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    if (!hasStrictLoopbackHost(request, security)) {
      sendJson(response, 403, { error: "invalid_host", message: "API requests require a single loopback Host header for this server port." });
      return;
    }
    if (method === "POST" && isProtectedPostPath(url.pathname)) {
      await handleVersionedPost(repoRoot, url, request, response, security);
      return;
    }
    if (isProtectedPostPath(url.pathname) && method !== "POST") {
      response.setHeader("Allow", "POST");
      const message = url.pathname === REVIEW_SESSION_PATH
        ? "Review sessions are bootstrapped with a same-origin JSON POST."
        : isExternalImportPath(url.pathname)
          ? "External source preview and apply require an explicit same-origin JSON POST."
          : "Proposal decisions require an explicit same-origin JSON POST.";
      sendVersionedError(repoRoot, response, 405, "method_not_allowed", message, method === "HEAD");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "method_not_allowed", message: "This API resource does not accept that method." });
      return;
    }
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      handleVersionedApi(repoRoot, url, request, response);
      return;
    }
    switch (url.pathname) {
      case "/api/overview": sendJson(response, 200, getOverview(repoRoot), request.method === "HEAD"); return;
      case "/api/graph": sendJson(response, 200, getGraph(repoRoot), request.method === "HEAD"); return;
      case "/api/timeline": {
        const query = boundedQuery(url.searchParams.get("q"));
        const limit = boundedLimit(url.searchParams.get("limit"), 200);
        sendJson(response, 200, getTimeline(repoRoot, query, limit), request.method === "HEAD"); return;
      }
      case "/api/health": sendJson(response, 200, getHealthReport(repoRoot), request.method === "HEAD"); return;
      case "/api/search": {
        const query = boundedQuery(url.searchParams.get("q"));
        if (!query) { sendJson(response, 400, { error: "query_required" }); return; }
        sendJson(response, 200, searchAtlas(repoRoot, query, boundedLimit(url.searchParams.get("limit"), 20)), request.method === "HEAD"); return;
      }
      default: sendJson(response, 404, { error: "not_found" }); return;
    }
  }

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (!/^[a-zA-Z0-9._/-]+$/.test(requested) || requested.includes("..")) {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  let filePath = path.resolve(publicDirectory, requested);
  if (!filePath.startsWith(`${path.resolve(publicDirectory)}${path.sep}`) && filePath !== path.resolve(publicDirectory, "index.html")) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = path.join(publicDirectory, "index.html");
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=3600");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(filePath).pipe(response);
}

function handleVersionedApi(repoRoot: string, url: URL, request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("X-Context-Atlas-Contract", CONTRACT_VERSION);
  const headOnly = request.method === "HEAD";
  const send = <T,>(kind: string, query: () => T, warningBuilder: (data: T) => string[] = () => []): void => {
    const envelope = withStableContractRead(repoRoot, () => {
      const data = query();
      return makeContractEnvelope(repoRoot, kind, data, warningBuilder(data));
    });
    sendJson(response, 200, envelope, headOnly);
  };
  switch (url.pathname) {
    case "/api/v1":
      send("capabilities", () => ({
        apiVersion: "v1",
        readOnly: false,
        agentSurfaceReadOnly: true,
        humanReviewMutations: true,
        endpoints: ["overview", "graph", "timeline", "health", "search", "explain", "evidence", "proposals", "assertions", "assertion-evolution", "review-workspace", "external-import-preview", "external-import-apply"],
        humanReview: {
          available: true,
          surface: "loopback-browser-only",
          sessionBootstrap: REVIEW_SESSION_PATH,
          mutationsRequireExplicitConfirmation: true,
          agentSurfaceReadOnly: true,
        },
        externalImport: {
          available: true,
          surface: "loopback-browser-only",
          preview: EXTERNAL_IMPORT_PREVIEW_PATH,
          apply: EXTERNAL_IMPORT_APPLY_PATH,
          maximumSourceBytes: MAX_BROWSER_SOURCE_BYTES,
          statelessPreview: true,
          requiresExactConfirmation: "IMPORT",
          agentSurfaceReadOnly: true,
        },
      }));
      return;
    case "/api/v1/overview": {
      send("overview", () => getOverview(repoRoot), dataWarnings);
      return;
    }
    case "/api/v1/graph": {
      send("graph", () => getGraph(repoRoot, boundedLimit(url.searchParams.get("nodes"), 750)), dataWarnings);
      return;
    }
    case "/api/v1/timeline": {
      const query = boundedQuery(url.searchParams.get("q"));
      send("timeline", () => getTimeline(repoRoot, query, boundedLimit(url.searchParams.get("limit"), 200)));
      return;
    }
    case "/api/v1/health": {
      send(
        "health",
        () => getHealthReport(repoRoot),
        (health) => health.checks.filter((item) => item.status === "warning" || item.status === "critical").map((item) => item.id),
      );
      return;
    }
    case "/api/v1/search": {
      const query = boundedQuery(url.searchParams.get("q"));
      if (!query) { sendVersionedError(repoRoot, response, 400, "query_required", "A non-empty q parameter is required.", headOnly); return; }
      send("search", () => searchAtlas(repoRoot, query, boundedLimit(url.searchParams.get("limit"), 20)), dataWarnings);
      return;
    }
    case "/api/v1/explain": {
      const target = boundedQuery(url.searchParams.get("target"));
      if (!target) { sendVersionedError(repoRoot, response, 400, "target_required", "A non-empty target parameter is required.", headOnly); return; }
      send("explain", () => explainEntity(repoRoot, target), dataWarnings);
      return;
    }
    case "/api/v1/proposals": {
      const status = url.searchParams.get("status") ?? undefined;
      if (status && !["pending", "approved", "rejected", "superseded"].includes(status)) {
        sendVersionedError(repoRoot, response, 400, "invalid_status", "Unknown proposal status filter.", headOnly);
        return;
      }
      send("proposals", () => listProposals(repoRoot, status as "pending" | "approved" | "rejected" | "superseded" | undefined));
      return;
    }
    case REVIEW_WORKSPACE_PATH: {
      send("review-workspace", () => buildReviewWorkspace(repoRoot));
      return;
    }
    case REVIEW_SESSION_PATH: {
      response.setHeader("Allow", "POST");
      sendVersionedError(repoRoot, response, 405, "method_not_allowed", "Review sessions are bootstrapped with a same-origin JSON POST.", headOnly);
      return;
    }
    case "/api/v1/assertions": {
      send("assertions", () => queryPresentedAssertions(repoRoot, {
        ...(url.searchParams.get("validAt") ? { validAt: boundedQuery(url.searchParams.get("validAt")) } : {}),
        ...(url.searchParams.get("recordedAt") ? { recordedAt: boundedQuery(url.searchParams.get("recordedAt")) } : {}),
        ...(url.searchParams.get("subject") ? { subjectId: boundedQuery(url.searchParams.get("subject")) } : {}),
        ...(url.searchParams.get("predicate") ? { predicate: boundedQuery(url.searchParams.get("predicate")) } : {}),
      }), assertionPresentationWarnings);
      return;
    }
    case "/api/v1/assertion-evolution": {
      send("assertion-evolution", () => getAssertionEvolution(repoRoot, {
        ...(url.searchParams.get("subject") ? { subjectId: boundedQuery(url.searchParams.get("subject")) } : {}),
        ...(url.searchParams.get("predicate") ? { predicate: boundedQuery(url.searchParams.get("predicate")) } : {}),
        ...(url.searchParams.get("recordedFrom") ? { recordedFrom: boundedQuery(url.searchParams.get("recordedFrom")) } : {}),
        ...(url.searchParams.get("recordedTo") ? { recordedTo: boundedQuery(url.searchParams.get("recordedTo")) } : {}),
        ...(url.searchParams.get("validFrom") ? { validFrom: boundedQuery(url.searchParams.get("validFrom")) } : {}),
        ...(url.searchParams.get("validTo") ? { validTo: boundedQuery(url.searchParams.get("validTo")) } : {}),
      }));
      return;
    }
    default: {
      if (REVIEW_MUTATION_PATTERN.test(url.pathname)) {
        response.setHeader("Allow", "POST");
        sendVersionedError(repoRoot, response, 405, "method_not_allowed", "Proposal decisions require an explicit same-origin JSON POST.", headOnly);
        return;
      }
      const evidenceMatch = url.pathname.match(/^\/api\/v1\/evidence\/([a-zA-Z0-9_-]{1,200})$/);
      if (evidenceMatch?.[1]) {
        const evidenceId = evidenceMatch[1];
        try { send("evidence", () => getEvidenceRecord(repoRoot, evidenceId)); }
        catch (error) { sendVersionedError(repoRoot, response, 404, "evidence_not_found", error instanceof Error ? error.message : String(error), headOnly); }
        return;
      }
      const assertionMatch = url.pathname.match(/^\/api\/v1\/assertions\/(.+)$/);
      if (assertionMatch?.[1]) {
        const assertionId = safePathIdentifier(assertionMatch[1]);
        if (!assertionId) { sendVersionedError(repoRoot, response, 400, "invalid_assertion_id", "Invalid assertion identifier.", headOnly); return; }
        try {
          send("assertion", () => {
            const assertion = getPresentedAssertion(repoRoot, assertionId);
            if (!assertion) throw new Error(`Unknown assertion: ${assertionId}`);
            return assertion;
          }, (assertion) => assertionPresentationWarnings([assertion]));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Unknown assertion:")) {
            sendVersionedError(repoRoot, response, 404, "assertion_not_found", error.message, headOnly);
            return;
          }
          throw error;
        }
        return;
      }
      const assertionHistoryMatch = url.pathname.match(/^\/api\/v1\/assertion-history\/(.+)$/);
      if (assertionHistoryMatch?.[1]) {
        const logicalId = safePathIdentifier(assertionHistoryMatch[1]);
        if (!logicalId) { sendVersionedError(repoRoot, response, 400, "invalid_logical_id", "Invalid logical assertion identifier.", headOnly); return; }
        send("assertion-history", () => ({ logicalId, revisions: getAssertionHistory(repoRoot, logicalId), reviews: getAssertionReviewHistory(repoRoot, logicalId) }));
        return;
      }
      sendVersionedError(repoRoot, response, 404, "not_found", "Unknown versioned API endpoint.", headOnly);
    }
  }
}

async function handleVersionedPost(
  repoRoot: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  security: BrowserSecurityContext,
): Promise<void> {
  response.setHeader("X-Context-Atlas-Contract", CONTRACT_VERSION);
  if (url.search) {
    sendVersionedError(repoRoot, response, 400, "unexpected_query", "Protected browser POST endpoints do not accept query parameters.");
    return;
  }
  const originError = validateSameOriginRequest(request, security);
  if (originError) {
    sendVersionedError(repoRoot, response, 403, originError.code, originError.message);
    return;
  }
  if (!isJsonContentType(singleRawHeader(request, "content-type"))) {
    sendVersionedError(repoRoot, response, 415, "json_required", "Protected browser POST endpoints accept only application/json with an optional UTF-8 charset.");
    return;
  }

  if (url.pathname !== REVIEW_SESSION_PATH
    && !sessionTokenMatches(singleRawHeader(request, SESSION_HEADER), security.sessionToken)) {
    sendVersionedError(repoRoot, response, 403, "invalid_review_session", "A valid in-memory browser review session is required.");
    return;
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(
      request,
      isExternalImportPath(url.pathname) ? MAX_EXTERNAL_IMPORT_JSON_BODY_BYTES : MAX_JSON_BODY_BYTES,
    );
  } catch (error) {
    const bodyError = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "invalid_json", "The request body must be valid JSON.");
    sendVersionedError(repoRoot, response, bodyError.status, bodyError.code, bodyError.message);
    return;
  }

  if (url.pathname === REVIEW_SESSION_PATH) {
    if (!isEmptyObject(payload)) {
      sendVersionedError(repoRoot, response, 400, "invalid_bootstrap", "The review-session bootstrap body must be an empty JSON object.");
      return;
    }
    sendJson(response, 200, makeContractEnvelope(repoRoot, "review-session", {
      token: security.sessionToken,
      header: "X-Context-Atlas-Session",
      scope: "this server process and browser origin",
    }));
    return;
  }

  if (isExternalImportPath(url.pathname)) {
    const validated = validateExternalImportPost(payload, url.pathname === EXTERNAL_IMPORT_APPLY_PATH);
    if ("error" in validated) {
      sendVersionedError(repoRoot, response, 422, validated.error, validated.message);
      return;
    }
    try {
      if (url.pathname === EXTERNAL_IMPORT_PREVIEW_PATH) {
        const plan = previewExternalImportText(repoRoot, validated.source, validated.request);
        sendJson(response, 200, makeContractEnvelope(repoRoot, "external-import-preview", plan, plan.warnings));
        return;
      }
      const result = applyExternalImportText(repoRoot, validated.source, {
        ...validated.request,
        planId: validated.planId,
        confirmation: validated.confirmation,
      });
      sendJson(response, 200, makeContractEnvelope(repoRoot, "external-import-apply", result));
      return;
    } catch (error) {
      const mapped = mapExternalImportError(error);
      sendVersionedError(repoRoot, response, mapped.status, mapped.code, mapped.message);
      return;
    }
  }

  const mutationMatch = url.pathname.match(REVIEW_MUTATION_PATTERN);
  if (!mutationMatch?.[1] || !mutationMatch[2]) {
    sendVersionedError(repoRoot, response, 404, "not_found", "Unknown versioned API endpoint.");
    return;
  }
  const review = validateReviewRequest(payload);
  if ("error" in review) {
    sendVersionedError(repoRoot, response, 422, review.error, review.message);
    return;
  }
  const action = mutationMatch[2] as "approve" | "reject";
  try {
    const proposal = action === "approve"
      ? approveProposal(repoRoot, mutationMatch[1], review.rationale, review.actor)
      : rejectProposal(repoRoot, mutationMatch[1], review.rationale, review.actor);
    sendJson(response, 200, makeContractEnvelope(repoRoot, "proposal-review", {
      action,
      proposal: reviewProposalSummary(repoRoot, proposal, false, proposalReviewTrails(repoRoot, [proposal]).get(proposal.id)),
    }));
  } catch (error) {
    const mapped = mapProposalReviewError(error);
    sendVersionedError(repoRoot, response, mapped.status, mapped.code, mapped.message);
  }
}

function buildReviewWorkspace(repoRoot: string): Record<string, unknown> {
  const proposals = listProposals(repoRoot);
  const reviewTrails = proposalReviewTrails(repoRoot, proposals);
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const history = proposals.filter((proposal) => proposal.status !== "pending").slice(0, 200);
  const pendingSummaries = pending.map((proposal) => reviewProposalSummary(repoRoot, proposal, true, reviewTrails.get(proposal.id)));
  const grouped = new Map<string, typeof pendingSummaries>();
  for (const proposal of pendingSummaries) {
    const groupId = proposal.conflictGroup ?? `proposal:${proposal.id}`;
    const members = grouped.get(groupId) ?? [];
    members.push(proposal);
    grouped.set(groupId, members);
  }
  const conflictGroups = [...grouped.entries()]
    .map(([id, proposalsInGroup]) => ({
      id,
      conflicting: proposalsInGroup.length > 1 || proposalsInGroup.some((proposal) => proposal.conflictGroup !== null),
      unresolved: proposalsInGroup.length > 1,
      targetId: proposalsInGroup[0]?.targetId ?? null,
      proposals: proposalsInGroup,
    }))
    .sort((left, right) => Number(right.conflicting) - Number(left.conflicting)
      || String(right.proposals[0]?.createdAt ?? "").localeCompare(String(left.proposals[0]?.createdAt ?? "")));
  return {
    generatedAt: new Date().toISOString(),
    authorityNotice: "Only an explicitly confirmed human browser review can change proposal status. Pending proposals are not project truth.",
    evidenceNotice: "Approval is available only when every linked evidence record is currently verified; source code remains authoritative.",
    counts: {
      pending: pending.length,
      conflictGroups: conflictGroups.filter((group) => group.unresolved).length,
      evidenceWarnings: pendingSummaries.filter((proposal) => !proposal.evidenceReady).length,
      reviewed: history.length,
    },
    conflictGroups,
    history: history.map((proposal) => reviewProposalSummary(repoRoot, proposal, false, reviewTrails.get(proposal.id))),
  };
}

function reviewProposalSummary(
  repoRoot: string,
  proposal: ProposalRecord,
  includeEvidence: boolean,
  suppliedReviewTrail?: ReturnType<typeof getAssertionReviewHistory>,
): Record<string, unknown> & {
  id: string;
  targetId: string | null;
  conflictGroup: string | null;
  createdAt: string;
  evidenceReady: boolean;
} {
  const evidence = includeEvidence ? proposal.evidenceIds.map((evidenceId) => {
    try {
      const record = getEvidenceRecord(repoRoot, evidenceId);
      return {
        id: record.id,
        kind: record.kind,
        locator: record.locator,
        observedAt: record.observedAt,
        permittedForCurrentUse: record.permittedForCurrentUse,
        validation: record.validation,
      };
    } catch {
      return {
        id: evidenceId,
        kind: "unknown",
        locator: "[unavailable]",
        observedAt: null,
        permittedForCurrentUse: false,
        validation: {
          evidenceId,
          locatorKind: "provider",
          outcome: "invalid",
          status: "missing",
          details: "The linked evidence record is unavailable.",
        },
      };
    }
  }) : [];
  const evidenceReady = includeEvidence
    ? evidence.length > 0 && evidence.every((item) => item.permittedForCurrentUse)
    : proposal.evidenceIds.length > 0;
  const assertionLogicalId = typeof proposal.payload.assertionLogicalId === "string" ? proposal.payload.assertionLogicalId : null;
  const reviewTrail = suppliedReviewTrail ?? (assertionLogicalId ? getAssertionReviewHistory(repoRoot, assertionLogicalId) : []);
  return {
    id: proposal.id,
    kind: proposal.kind,
    targetId: proposal.targetId,
    title: proposal.title,
    summary: proposal.summary,
    evidenceIds: proposal.evidenceIds,
    evidence,
    evidenceReady,
    riskFlags: proposal.riskFlags,
    status: proposal.status,
    createdAt: proposal.createdAt,
    reviewedAt: proposal.reviewedAt,
    reviewNote: proposal.reviewNote,
    conflictGroup: proposal.conflictGroup,
    reviewTrail,
  };
}

function proposalReviewTrails(
  repoRoot: string,
  proposals: readonly ProposalRecord[],
): Map<string, ReturnType<typeof getAssertionReviewHistory>> {
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const logicalIdsByProposal = new Map<string, Set<string>>();
  const assertionIdsByProposal = new Map<string, Set<string>>();
  for (const proposal of proposals) {
    const logicalIds = new Set<string>();
    if (typeof proposal.payload.assertionLogicalId === "string") logicalIds.add(proposal.payload.assertionLogicalId);
    logicalIdsByProposal.set(proposal.id, logicalIds);
    assertionIdsByProposal.set(proposal.id, new Set());
  }
  for (const assertion of getAssertionEvolution(repoRoot)) {
    const metadataProposalId = typeof assertion.metadata.proposalId === "string" ? assertion.metadata.proposalId : null;
    const producerProposalId = assertion.producer.startsWith("proposal:") ? assertion.producer.slice("proposal:".length) : null;
    const proposalId = metadataProposalId && proposalIds.has(metadataProposalId)
      ? metadataProposalId
      : producerProposalId && proposalIds.has(producerProposalId) ? producerProposalId : null;
    if (proposalId) {
      logicalIdsByProposal.get(proposalId)?.add(assertion.logicalId);
      assertionIdsByProposal.get(proposalId)?.add(assertion.id);
    }
  }
  const trails = new Map<string, ReturnType<typeof getAssertionReviewHistory>>();
  const reviewsByLogicalId = new Map<string, ReturnType<typeof getAssertionReviewHistory>>();
  for (const proposal of proposals) {
    const records = [...(logicalIdsByProposal.get(proposal.id) ?? [])]
      .flatMap((logicalId) => {
        const cached = reviewsByLogicalId.get(logicalId);
        if (cached) return cached;
        const loaded = getAssertionReviewHistory(repoRoot, logicalId);
        reviewsByLogicalId.set(logicalId, loaded);
        return loaded;
      })
      .filter((record) => assertionIdsByProposal.get(proposal.id)?.has(record.assertionId));
    const unique = new Map(records.map((record) => [record.id, record]));
    trails.set(proposal.id, [...unique.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id)));
  }
  return trails;
}

interface ValidatedExternalImportPost {
  source: ExternalImportTextSource;
  request: ExternalImportRequest;
  planId: string;
  confirmation: "IMPORT";
}

function validateExternalImportPost(
  value: unknown,
  applying: boolean,
): ValidatedExternalImportPost | { error: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_external_import", message: "The external import body must be one JSON object." };
  }
  const object = value as Record<string, unknown>;
  const expectedRoot = applying ? ["confirmation", "metadata", "planId", "source"] : ["metadata", "source"];
  if (!hasExactFields(object, expectedRoot)) {
    return { error: "invalid_external_import_fields", message: `The ${applying ? "apply" : "preview"} body contains missing or unrecognized fields.` };
  }
  if (!object.source || typeof object.source !== "object" || Array.isArray(object.source)) {
    return { error: "invalid_external_source", message: "The source field must be one JSON object." };
  }
  if (!object.metadata || typeof object.metadata !== "object" || Array.isArray(object.metadata)) {
    return { error: "invalid_external_metadata", message: "The metadata field must be one JSON object." };
  }
  const source = object.source as Record<string, unknown>;
  const metadata = object.metadata as Record<string, unknown>;
  if (!hasExactFields(source, ["bodyBase64", "displayName", "observedAt", "selectionKind"])) {
    return { error: "invalid_external_source_fields", message: "Source must contain only bodyBase64, displayName, observedAt, and selectionKind." };
  }
  if (!hasExactFields(metadata, ["actor", "declaredAuthority", "originLabel", "purpose", "sensitivityLabel", "sourceKind", "title"])) {
    return { error: "invalid_external_metadata_fields", message: "Metadata contains missing or unrecognized fields." };
  }
  if (!Object.values(source).every((item) => typeof item === "string")
    || !Object.values(metadata).every((item) => typeof item === "string")) {
    return { error: "invalid_external_import_value", message: "External source and metadata values must be strings." };
  }
  const bodyBase64 = source.bodyBase64 as string;
  if (!isCanonicalBase64(bodyBase64)) {
    return { error: "invalid_external_source_encoding", message: "The selected source bytes must use canonical base64 encoding." };
  }
  const bytes = Buffer.from(bodyBase64, "base64");
  if (bytes.byteLength > MAX_BROWSER_SOURCE_BYTES) {
    return { error: "external_source_too_large", message: `The selected browser source must not exceed ${MAX_BROWSER_SOURCE_BYTES} bytes.` };
  }
  if (applying && (typeof object.planId !== "string" || typeof object.confirmation !== "string")) {
    return { error: "invalid_external_import_confirmation", message: "Apply requires a preview planId and exact IMPORT confirmation." };
  }
  if (applying && object.confirmation !== "IMPORT") {
    return { error: "invalid_external_import_confirmation", message: "External import requires exact confirmation IMPORT." };
  }
  return {
    source: {
      bytes,
      displayName: source.displayName as string,
      observedAt: source.observedAt as string,
      selectionKind: source.selectionKind as ExternalImportTextSource["selectionKind"],
    },
    request: {
      sourceKind: metadata.sourceKind as ExternalImportRequest["sourceKind"],
      originLabel: metadata.originLabel as string,
      declaredAuthority: metadata.declaredAuthority as ExternalImportRequest["declaredAuthority"],
      sensitivityLabel: metadata.sensitivityLabel as ExternalImportRequest["sensitivityLabel"],
      purpose: metadata.purpose as string,
      actor: metadata.actor as string,
      title: metadata.title as string,
      sourceObservedAt: source.observedAt as string,
    },
    planId: applying ? object.planId as string : "",
    confirmation: "IMPORT",
  };
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length > MAX_EXTERNAL_IMPORT_JSON_BODY_BYTES || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function mapExternalImportError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ExternalImportPlanChangedError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof ExternalImportInputError) {
    return { status: 422, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "external_import_failed",
    message: "The external source could not be imported; no source body was returned in this error.",
  };
}

class RequestBodyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function readBoundedJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const declaredLength = singleRawHeader(request, "content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    request.resume();
    throw new RequestBodyError(413, "payload_too_large", `The JSON request body must not exceed ${maximumBytes} bytes.`);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > maximumBytes) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new RequestBodyError(413, "payload_too_large", `The JSON request body must not exceed ${maximumBytes} bytes.`));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      try { resolve(JSON.parse(text)); }
      catch { reject(new RequestBodyError(400, "invalid_json", "The request body must be valid JSON.")); }
    });
    request.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new RequestBodyError(400, "request_body_error", "The request body could not be read."));
    });
  });
}

function validateReviewRequest(value: unknown): ReviewRequest | { error: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_review", message: "The review body must be a JSON object containing actor and rationale." };
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "actor" || keys[1] !== "rationale") {
    return { error: "invalid_review_fields", message: "The review body must contain only actor and rationale." };
  }
  if (typeof object.actor !== "string" || !/^human:[a-zA-Z0-9._@-]{1,200}$/.test(object.actor)) {
    return { error: "invalid_actor", message: "Actor must use the attributed human:<id> form." };
  }
  if (typeof object.rationale !== "string") {
    return { error: "invalid_rationale", message: "A textual review rationale is required." };
  }
  const rationale = object.rationale.trim();
  if (rationale.length < MIN_REVIEW_RATIONALE_CHARACTERS || rationale.length > MAX_REVIEW_RATIONALE_CHARACTERS) {
    return { error: "invalid_rationale", message: `Rationale must be between ${MIN_REVIEW_RATIONALE_CHARACTERS} and ${MAX_REVIEW_RATIONALE_CHARACTERS} characters.` };
  }
  if (findSecrets(rationale).length > 0) {
    return { error: "invalid_rationale", message: "Rationale must not contain text that resembles a secret or credential." };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(rationale)) {
    return { error: "invalid_rationale", message: "Rationale must not contain control characters." };
  }
  return { actor: object.actor, rationale };
}

function mapProposalReviewError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : "The proposal review could not be completed.";
  if (/Unknown proposal/i.test(message)) return { status: 404, code: "proposal_not_found", message };
  if (/already (approved|rejected|superseded)/i.test(message)) return { status: 409, code: "proposal_already_reviewed", message };
  if (/conflicting pending proposals/i.test(message)) return { status: 409, code: "proposal_conflict", message };
  if (/evidence|Synchronize|guidance dependency/i.test(message)) return { status: 409, code: "evidence_not_current", message };
  if (/human: actor/i.test(message)) return { status: 422, code: "invalid_actor", message };
  return { status: 422, code: "review_rejected", message };
}

function validateSameOriginRequest(
  request: IncomingMessage,
  security: BrowserSecurityContext,
): { code: string; message: string } | null {
  const host = singleRawHeader(request, "host");
  const origin = singleRawHeader(request, "origin");
  if (!host || !origin || !hasStrictLoopbackHost(request, security)) {
    return { code: "invalid_origin", message: "Review POST requests require one exact loopback Host and Origin." };
  }
  const fetchSite = singleRawHeader(request, "sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    return { code: "cross_site_request", message: "Cross-site review requests are not accepted." };
  }
  try {
    const expected = new URL(`http://${host}`);
    const supplied = new URL(origin);
    if (origin !== expected.origin || supplied.origin !== expected.origin || supplied.protocol !== "http:" || supplied.username || supplied.password
      || supplied.pathname !== "/" || supplied.search || supplied.hash) {
      return { code: "invalid_origin", message: "The Origin header must exactly match this loopback dashboard origin." };
    }
  } catch {
    return { code: "invalid_origin", message: "The Origin header must be a valid loopback dashboard origin." };
  }
  return null;
}

function singleRawHeader(request: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1) return null;
  const value = values[0]?.trim() ?? "";
  return value && value.length <= 1_024 && !/[\r\n]/.test(value) ? value : null;
}

function hasStrictLoopbackHost(request: IncomingMessage, security: BrowserSecurityContext): boolean {
  const host = singleRawHeader(request, "host");
  if (!host || host.length > 300) return false;
  try {
    const parsed = new URL(`http://${host}`);
    const port = Number(parsed.port || "80");
    return parsed.protocol === "http:" && !parsed.username && !parsed.password && parsed.pathname === "/"
      && isLoopbackHost(parsed.hostname) && normalizeHostname(parsed.hostname) === security.hostname
      && security.port !== null && port === security.port;
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function sessionTokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

function isEmptyObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;
}

function sendVersionedError(repoRoot: string, response: ServerResponse, status: number, code: string, message: string, headOnly = false): void {
  response.setHeader("X-Context-Atlas-Contract", CONTRACT_VERSION);
  sendJson(response, status, makeContractEnvelope(repoRoot, "error", { code, message }), headOnly);
}

function dataWarnings(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const warnings = (value as Record<string, unknown>).warnings;
  return Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === "string") : [];
}

function sendJson(response: ServerResponse, status: number, value: unknown, headOnly = false): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (headOnly) response.end(); else response.end(body);
}

function resolvePublicDirectory(): string {
  const adjacent = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  if (existsSync(adjacent)) return adjacent;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/web/public");
  if (existsSync(source)) return source;
  throw new Error("Context Atlas web assets were not found. Run the build command.");
}

function boundedQuery(value: string | null): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

function safePathIdentifier(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[a-zA-Z0-9:_-]{1,500}$/.test(decoded) ? decoded : null;
  } catch { return null; }
}

function boundedLimit(value: string | null, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(1, Math.min(1_000, Math.floor(number))) : fallback;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && String(Number(octet)) === octet && Number(octet) >= 0 && Number(octet) <= 255);
}
