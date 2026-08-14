import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, makeContractEnvelope } from "../core/contracts.js";
import { getHealthReport } from "../core/health.js";
import { listProposals } from "../core/proposals.js";
import { explainEntity, getEvidenceRecord, getGraph, getOverview, getTimeline, searchAtlas } from "../core/query.js";
import { getAssertion, getAssertionEvolution, getAssertionHistory, getAssertionReviewHistory, queryAssertions } from "../core/temporal.js";

export interface WebServerOptions {
  host?: string;
  port?: number;
}

export async function startWebServer(repoRoot: string, options: WebServerOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4242;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Port must be between 0 and 65535.");
  if (!isLoopbackHost(host)) throw new Error("Context Atlas refuses unauthenticated non-loopback binding. Use 127.0.0.1, ::1, or localhost.");
  const publicDirectory = resolvePublicDirectory();
  const server = createServer((request, response) => {
    handleRequest(repoRoot, publicDirectory, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
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
  return { server, url: `http://${host}:${actualPort}` };
}

async function handleRequest(repoRoot: string, publicDirectory: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    if (!isLoopbackHostHeader(request.headers.host)) {
      sendJson(response, 403, { error: "invalid_host", message: "API requests require a loopback Host header." });
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
  const send = (kind: string, data: unknown, warnings: string[] = []): void => {
    sendJson(response, 200, makeContractEnvelope(repoRoot, kind, data, warnings), headOnly);
  };
  switch (url.pathname) {
    case "/api/v1":
      send("capabilities", {
        apiVersion: "v1",
        readOnly: true,
        endpoints: ["overview", "graph", "timeline", "health", "search", "explain", "evidence", "proposals", "assertions", "assertion-evolution"],
      });
      return;
    case "/api/v1/overview": send("overview", getOverview(repoRoot)); return;
    case "/api/v1/graph": send("graph", getGraph(repoRoot, boundedLimit(url.searchParams.get("nodes"), 750))); return;
    case "/api/v1/timeline": {
      const query = boundedQuery(url.searchParams.get("q"));
      send("timeline", getTimeline(repoRoot, query, boundedLimit(url.searchParams.get("limit"), 200)));
      return;
    }
    case "/api/v1/health": {
      const health = getHealthReport(repoRoot);
      send("health", health, health.checks.filter((item) => item.status === "warning" || item.status === "critical").map((item) => item.id));
      return;
    }
    case "/api/v1/search": {
      const query = boundedQuery(url.searchParams.get("q"));
      if (!query) { sendVersionedError(repoRoot, response, 400, "query_required", "A non-empty q parameter is required.", headOnly); return; }
      send("search", searchAtlas(repoRoot, query, boundedLimit(url.searchParams.get("limit"), 20)));
      return;
    }
    case "/api/v1/explain": {
      const target = boundedQuery(url.searchParams.get("target"));
      if (!target) { sendVersionedError(repoRoot, response, 400, "target_required", "A non-empty target parameter is required.", headOnly); return; }
      send("explain", explainEntity(repoRoot, target));
      return;
    }
    case "/api/v1/proposals": {
      const status = url.searchParams.get("status") ?? undefined;
      if (status && !["pending", "approved", "rejected", "superseded"].includes(status)) {
        sendVersionedError(repoRoot, response, 400, "invalid_status", "Unknown proposal status filter.", headOnly);
        return;
      }
      send("proposals", listProposals(repoRoot, status as "pending" | "approved" | "rejected" | "superseded" | undefined));
      return;
    }
    case "/api/v1/assertions": {
      send("assertions", queryAssertions(repoRoot, {
        ...(url.searchParams.get("validAt") ? { validAt: boundedQuery(url.searchParams.get("validAt")) } : {}),
        ...(url.searchParams.get("recordedAt") ? { recordedAt: boundedQuery(url.searchParams.get("recordedAt")) } : {}),
        ...(url.searchParams.get("subject") ? { subjectId: boundedQuery(url.searchParams.get("subject")) } : {}),
        ...(url.searchParams.get("predicate") ? { predicate: boundedQuery(url.searchParams.get("predicate")) } : {}),
      }));
      return;
    }
    case "/api/v1/assertion-evolution": {
      send("assertion-evolution", getAssertionEvolution(repoRoot, {
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
      const evidenceMatch = url.pathname.match(/^\/api\/v1\/evidence\/([a-zA-Z0-9_-]{1,200})$/);
      if (evidenceMatch?.[1]) {
        try { send("evidence", getEvidenceRecord(repoRoot, evidenceMatch[1])); }
        catch (error) { sendVersionedError(repoRoot, response, 404, "evidence_not_found", error instanceof Error ? error.message : String(error), headOnly); }
        return;
      }
      const assertionMatch = url.pathname.match(/^\/api\/v1\/assertions\/(.+)$/);
      if (assertionMatch?.[1]) {
        const assertionId = safePathIdentifier(assertionMatch[1]);
        if (!assertionId) { sendVersionedError(repoRoot, response, 400, "invalid_assertion_id", "Invalid assertion identifier.", headOnly); return; }
        const assertion = getAssertion(repoRoot, assertionId);
        if (!assertion) { sendVersionedError(repoRoot, response, 404, "assertion_not_found", `Unknown assertion: ${assertionId}`, headOnly); return; }
        send("assertion", assertion);
        return;
      }
      const assertionHistoryMatch = url.pathname.match(/^\/api\/v1\/assertion-history\/(.+)$/);
      if (assertionHistoryMatch?.[1]) {
        const logicalId = safePathIdentifier(assertionHistoryMatch[1]);
        if (!logicalId) { sendVersionedError(repoRoot, response, 400, "invalid_logical_id", "Invalid logical assertion identifier.", headOnly); return; }
        send("assertion-history", { logicalId, revisions: getAssertionHistory(repoRoot, logicalId), reviews: getAssertionReviewHistory(repoRoot, logicalId) });
        return;
      }
      sendVersionedError(repoRoot, response, 404, "not_found", "Unknown versioned API endpoint.", headOnly);
    }
  }
}

function sendVersionedError(repoRoot: string, response: ServerResponse, status: number, code: string, message: string, headOnly = false): void {
  response.setHeader("X-Context-Atlas-Contract", CONTRACT_VERSION);
  sendJson(response, status, makeContractEnvelope(repoRoot, "error", { code, message }), headOnly);
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
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value || value.length > 300 || /[\r\n]/.test(value)) return false;
  try {
    return isLoopbackHost(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}
