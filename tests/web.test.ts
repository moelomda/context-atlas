import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Script } from "node:vm";
import { AtlasDatabase } from "../src/core/database.js";
import { approveProposal, createProposal, listProposals } from "../src/core/proposals.js";
import { startWebServer } from "../src/web/server.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

function requestWithHost(target: string, hostHeader: string): Promise<number> {
  const targetUrl = new URL(target);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: "GET",
      headers: { Host: hostHeader },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("dashboard source keeps the launch interaction and accessibility contract", () => {
  const html = readFileSync(new URL("../src/web/public/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web/public/styles.css", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  const source = `${html}\n${script}\n${styles}`;

  assert.doesNotThrow(() => new Script(script, { filename: "app.js" }), "dashboard JavaScript must parse before it is shipped");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "static dashboard IDs must be unique");
  assert.doesNotMatch(source, /\uFFFD|\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2[\u0080-\u00BF]{2}/u, "dashboard sources must not contain replacement characters or common UTF-8 mojibake");

  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /id="search-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="briefing-dialog"/);
  assert.match(html, /data-view="review"/);
  assert.match(html, /id="proposal-review-dialog"/);
  assert.match(html, /id="proposal-review-form"[^>]*method="dialog"[^>]*novalidate/);
  assert.match(html, /pattern="human:\[a-zA-Z0-9\._@-\]\{1,200\}"/);
  assert.match(html, /id="proposal-review-rationale"[^>]*required[^>]*minlength="8"[^>]*maxlength="1000"/);
  assert.match(html, /id="proposal-review-error"[^>]*role="alert"/);
  assert.match(html, /aria-describedby="briefing-description"/);
  assert.match(html, /id="app-status"[^>]*role="status"/);
  assert.match(html, /id="toast-region"[^>]*aria-hidden="true"/);
  assert.match(html, /data-state="loading" role="status"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "CSP-safe HTML must not add inline scripts");
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, "CSP-safe HTML must not add inline styles");

  assert.match(script, /function escapeHTML/);
  assert.match(script, /function currentUseState/);
  assert.match(script, /status === "current" && object\.settled === true/);
  assert.match(script, /inconsistent current-use state/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /function briefingSteps/);
  assert.match(script, /function focusSpatialNode/);
  assert.match(script, /Browse the same map as an accessible table/);
  assert.match(script, /<caption>Filtered project knowledge nodes/);
  assert.match(script, /function navigateTimeline/);
  assert.match(script, /function applyHealthFilter/);
  assert.match(script, /Freshness and evidence by component/);
  assert.match(script, /Context use blocked/);
  assert.match(script, /Reviewed overview is .*do not treat it as current/);
  assert.match(script, /historical context only/);
  assert.match(script, /overviewClaim\.evidence/);
  assert.match(script, /presentationStatus: presentation\.status/);
  assert.match(script, /Unsettled only/);
  assert.match(script, /Not settled for current use/);
  assert.match(script, /Evidence identifiers/);
  assert.match(script, /const rovingNodeId/);
  assert.match(script, /querySelectorAll\("#map-world \.node"\)/);
  assert.match(script, /currentUseMarkup\(purpose\)/);
  assert.match(script, /currentUseMarkup\(item\)/);
  assert.match(script, /role="region" aria-label="Scrollable filtered project knowledge table" tabindex="0"/);
  assert.match(script, /role="region" aria-label="Scrollable component freshness and evidence table" tabindex="0"/);
  assert.match(script, /setActiveSearchOption/);
  assert.match(script, /aria-activedescendant/);
  assert.match(script, /state\.searchActiveIndex/);
  assert.match(script, /dom\.shortcutDialog\?\.open \|\| dom\.briefingDialog\?\.open/);
  assert.match(script, /dom\.briefingDialog\?\.addEventListener\("cancel"/);
  assert.match(script, /if \(dom\.briefingDialog\?\.open\) closeBriefing\(\)/);
  assert.doesNotMatch(script, /object\.stale \? "stale" : object\.status/, "the map must not promote lifecycle status into current-use status");
  assert.doesNotMatch(script, />Current context</, "generic current labels must not hide the presentation contract");
  assert.match(script, /preferredScrollBehavior/);
  assert.match(script, /event\.key === "ArrowDown"/);
  assert.match(script, /\/api\/v1\/overview/);
  assert.match(script, /contractVersion !== "1\.0\.0"/);
  assert.match(script, /review: "\/api\/v1\/review-workspace"/);
  assert.match(script, /reviewSession: "\/api\/v1\/review-session"/);
  assert.match(script, /"X-Context-Atlas-Session"/);
  assert.match(script, /async function ensureReviewSession/);
  assert.match(script, /async function submitProposalReview/);
  assert.match(script, /function renderReview/);
  assert.match(script, /Evidence changed since proposal creation/);
  assert.match(script, /data-proposal-action="approve"/);
  assert.match(script, /data-proposal-action="reject"/);
  assert.match(script, /human:&lt;id&gt;/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/, "the browser session token must remain in memory only");
  assert.match(script, /edge\.settled \? "" : " is-unsettled"/);
  assert.match(script, /Unsettled topology/);

  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(prefers-contrast: more\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /@media \(max-width: 430px\)/);
  assert.match(styles, /\.briefing-dialog/);
  assert.match(styles, /\.map-svg \.node\.is-dimmed/);
  assert.match(styles, /\.map-table-view table/);
  assert.match(styles, /\.component-health-scroll table/);
  assert.match(styles, /\.claim-state-banner/);
  assert.match(styles, /\.briefing-claim-warning/);
  assert.match(styles, /\.current-use-state/);
  assert.match(styles, /\.review-proposal-card/);
  assert.match(styles, /\.proposal-review-dialog/);
  assert.match(styles, /\.review-history-scroll/);
  assert.match(
    styles,
    /\.review-page\s*>\s*\*,[\s\S]*?\.review-hero\s*\{\s*min-width:\s*0;/,
    "review grid items must shrink on mobile so the wide history table stays inside its own scroller",
  );
  assert.match(styles, /\.review-history-scroll\s*\{[\s\S]*?overflow:\s*auto;/);
  assert.match(styles, /\.map-svg \.edge\.is-unsettled/);
  assert.match(serverSource, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(serverSource, /timingSafeEqual/);
  assert.match(serverSource, /validateSameOriginRequest/);
  assert.match(serverSource, /MAX_JSON_BODY_BYTES = 4_096/);
  assert.match(serverSource, /findSecrets\(rationale\)/);
  assert.match(serverSource, /const urlHost = host\.includes\(":"\) \? `\[\$\{host\}\]` : host/);
  assert.doesNotMatch(serverSource, /console\.(?:log|info|warn|error)/, "the review session token must never enter server logs");
  assert.match(styles, /\.map-context-banner/);
  assert.match(styles, /\.map-table-scroll:focus-visible/);
  const definedCustomProperties = new Set([...styles.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const referencedCustomProperties = [...styles.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]);
  assert.ok(referencedCustomProperties.every((name) => definedCustomProperties.has(name)), "every referenced CSS custom property must be defined");
  assert.doesNotMatch(`${html}\n${styles}`, /https?:\/\//i, "the local dashboard must not depend on remote UI assets");

  const mcpSource = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(mcpSource, /approveProposal|rejectProposal|review-session|review-workspace/, "human browser review mutations must remain absent from MCP");
});

test("IPv6 loopback servers publish a bracketed browser URL", async (context) => {
  await assert.rejects(startWebServer(".", { host: "127.attacker.example", port: 0 }), /refuses unauthenticated non-loopback/);
  await assert.rejects(startWebServer(".", { host: "127.000.000.001", port: 0 }), /refuses unauthenticated non-loopback/);
  let started: Awaited<ReturnType<typeof startWebServer>>;
  try {
    started = await startWebServer(".", { host: "::1", port: 0 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(code)) {
      context.skip(`IPv6 loopback is unavailable in this environment (${code}).`);
      return;
    }
    throw error;
  }
  try {
    assert.match(started.url, /^http:\/\/\[::1\]:\d+$/);
    assert.doesNotThrow(() => new URL(started.url));
    const apiProbe = await fetch(`${started.url}/api/not-a-resource`);
    assert.equal(apiProbe.status, 404, "a bracketed IPv6 Host header must pass the strict loopback check");
  } finally {
    await new Promise<void>((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  }
});

test("review boundary rejects cross-origin, missing-token, malformed, and secret-shaped requests without mutation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "context-atlas-test-"));
  fixtures.push(root);
  mkdirSync(path.join(root, ".context-atlas"));
  const database = new AtlasDatabase(root);
  database.close();
  const { server, url } = await startWebServer(root, { port: 0 });
  const target = `${url}/api/v1/proposals/proposal_missing/reject`;
  try {
    assert.equal(await requestWithHost(`${url}/api/v1/review-workspace`, `127.0.0.2:${new URL(url).port}`), 403);

    const crossOriginBootstrap = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(crossOriginBootstrap.status, 403);

    const trailingSlashOrigin = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { Origin: `${url}/`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(trailingSlashOrigin.status, 403, "Origin must match exactly, not merely normalize to the same URL");

    const bootstrap = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(bootstrap.status, 200);
    const token = (await bootstrap.json() as { data: { token: string } }).data.token;
    assert.match(token, /^[a-zA-Z0-9_-]{40,100}$/);

    const readMutation = await fetch(target);
    assert.equal(readMutation.status, 405);

    const missingToken = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: "This request intentionally has no token." }),
    });
    assert.equal(missingToken.status, 403);

    const wrongToken = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": "x".repeat(token.length) },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: "This request intentionally has the wrong token." }),
    });
    assert.equal(wrongToken.status, 403);

    const malformedActor = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "assistant:boundary-test", rationale: "This request intentionally has the wrong actor namespace." }),
    });
    assert.equal(malformedActor.status, 422);

    const wrongContentType = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "text/plain", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: "Only JSON requests may cross this boundary." }),
    });
    assert.equal(wrongContentType.status, 415);

    const malformedJson = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": token },
      body: "{",
    });
    assert.equal(malformedJson.status, 400);

    const oversized = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: "x".repeat(4_100) }),
    });
    assert.equal(oversized.status, 413);

    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const secretRationale = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: `Never persist ${secret} in the review trail.` }),
    });
    assert.equal(secretRationale.status, 422);
    const secretResponse = await secretRationale.text();
    assert.match(secretResponse, /resembles a secret or credential/);
    assert.doesNotMatch(secretResponse, new RegExp(secret));

    const unknownProposal = await fetch(target, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "human:boundary-test", rationale: "A valid boundary request still cannot review an unknown proposal." }),
    });
    assert.equal(unknownProposal.status, 404);
    assert.deepEqual(listProposals(root), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("local dashboard serves protected static assets and API data", async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  approveProposal(root, listProposals(root, "pending")[0]?.id as string, "Reviewed for versioned dashboard contract verification.", "human:web-test");
  await assert.rejects(startWebServer(root, { host: "0.0.0.0", port: 0 }), /refuses unauthenticated non-loopback/);
  const { server, url } = await startWebServer(root, { port: 0 });
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const html = await page.text();
    assert.match(html, /Context Atlas/);
    assert.match(html, /Understand the project from zero/);

    const script = await fetch(`${url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await script.text(), /Take the 90-second briefing/);

    const styles = await fetch(`${url}/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await styles.text(), /prefers-reduced-motion/);

    const assetHead = await fetch(`${url}/app.js`, { method: "HEAD" });
    assert.equal(assetHead.status, 200);
    assert.equal(await assetHead.text(), "");

    const overview = await fetch(`${url}/api/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json() as { project: { name: string } }).project.name, "Fixture Shop");

    const search = await fetch(`${url}/api/search?q=billing`);
    assert.equal(search.status, 200);
    assert.ok((await search.json() as { results: unknown[] }).results.length > 0);

    const secretSearch = await fetch(`${url}/api/search?q=sk-this-must-never-enter-context-storage`);
    assert.doesNotMatch(JSON.stringify(await secretSearch.json()), /sk-this-must-never-enter-context-storage/);

    const versionedOverview = await fetch(`${url}/api/v1/overview`);
    assert.equal(versionedOverview.headers.get("x-context-atlas-contract"), "1.0.0");
    const versionedOverviewBody = await versionedOverview.json() as {
      contractVersion: string;
      snapshot: { repositoryId: string };
      warnings: string[];
      data: {
        project: { name: string; presentationStatus: string; settled: boolean; reason: string; authority: string; evidenceIds: string[] };
        summaryAuthority: string;
        orientation: {
          purpose: { status: string; settled: boolean; reason: string; authority: string };
          architecture: Array<{ status: string; settled: boolean; reason: string; authority: string }>;
        };
      };
    };
    assert.equal(versionedOverviewBody.contractVersion, "1.0.0");
    assert.equal(versionedOverviewBody.data.project.name, "Fixture Shop");
    assert.equal(versionedOverviewBody.data.summaryAuthority, "human-reviewed");
    assert.equal(versionedOverviewBody.data.project.presentationStatus, "current");
    assert.equal(versionedOverviewBody.data.project.settled, true);
    assert.ok(versionedOverviewBody.data.project.reason);
    assert.ok(versionedOverviewBody.data.project.authority);
    assert.ok(versionedOverviewBody.data.project.evidenceIds.length > 0);
    assert.equal(versionedOverviewBody.data.orientation.purpose.status, "current");
    assert.equal(versionedOverviewBody.data.orientation.purpose.settled, true);
    assert.ok(versionedOverviewBody.data.orientation.purpose.reason);
    assert.ok(versionedOverviewBody.data.orientation.purpose.authority);
    assert.ok(versionedOverviewBody.data.orientation.architecture.length > 0);
    assert.ok(versionedOverviewBody.data.orientation.architecture.every((item) => item.status === "current" && item.settled && item.reason && item.authority));
    assert.match(versionedOverviewBody.snapshot.repositoryId, /^repo_/);

    const capabilitiesResponse = await fetch(`${url}/api/v1`);
    const capabilitiesBody = await capabilitiesResponse.json() as {
      data: { readOnly: boolean; agentSurfaceReadOnly: boolean; humanReviewMutations: boolean; humanReview: { surface: string; agentSurfaceReadOnly: boolean } };
    };
    assert.equal(capabilitiesBody.data.readOnly, false);
    assert.equal(capabilitiesBody.data.agentSurfaceReadOnly, true);
    assert.equal(capabilitiesBody.data.humanReviewMutations, true);
    assert.equal(capabilitiesBody.data.humanReview.surface, "loopback-browser-only");
    assert.equal(capabilitiesBody.data.humanReview.agentSurfaceReadOnly, true);

    const graphResponse = await fetch(`${url}/api/v1/graph`);
    assert.equal(graphResponse.status, 200);
    const graphBody = await graphResponse.json() as {
      warnings: string[];
      data: {
        warnings: string[];
        nodes: Array<{
          id: string;
          presentationStatus: string;
          settled: boolean;
          reason: string;
          authority: string;
          evidenceIds: string[];
          stale: boolean;
        }>;
      };
    };
    assert.ok(graphBody.data.nodes.length > 0);
    assert.ok(graphBody.data.nodes.every((node) => ["current", "stale", "conflicting", "removed", "unknown"].includes(node.presentationStatus)));
    assert.ok(graphBody.data.nodes.every((node) => node.settled === (node.presentationStatus === "current")));
    assert.ok(graphBody.data.nodes.every((node) => node.stale === !node.settled));
    assert.ok(graphBody.data.nodes.every((node) => node.reason && node.authority && Array.isArray(node.evidenceIds)));
    assert.deepEqual(graphBody.warnings, [...new Set(graphBody.data.warnings)].sort());

    const searchResponse = await fetch(`${url}/api/v1/search?q=billing`);
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json() as {
      warnings: string[];
      data: { warnings: string[]; results: Array<{ status: string; settled: boolean; reason: string; authority: string; evidenceIds: string[] }> };
    };
    assert.ok(searchBody.data.results.length > 0);
    assert.ok(searchBody.data.results.every((result) => result.status && typeof result.settled === "boolean" && result.reason && result.authority && Array.isArray(result.evidenceIds)));
    assert.deepEqual(searchBody.warnings, [...new Set(searchBody.data.warnings)].sort());

    const explainTarget = graphBody.data.nodes[0]?.id as string;
    const explainResponse = await fetch(`${url}/api/v1/explain?target=${encodeURIComponent(explainTarget)}`);
    assert.equal(explainResponse.status, 200);
    const explainBody = await explainResponse.json() as {
      warnings: string[];
      data: {
        warnings: string[];
        presentation: { status: string; settled: boolean; reason: string; authority: string; evidenceIds: string[] };
        related: Array<{ presentationStatus: string; settled: boolean; reason: string; authority: string; evidenceIds: string[] }>;
      };
    };
    assert.equal(explainBody.data.presentation.settled, explainBody.data.presentation.status === "current");
    assert.ok(explainBody.data.presentation.reason);
    assert.ok(explainBody.data.presentation.authority);
    assert.ok(Array.isArray(explainBody.data.presentation.evidenceIds));
    assert.ok(explainBody.data.related.every((item) => item.presentationStatus && typeof item.settled === "boolean" && item.reason && item.authority && Array.isArray(item.evidenceIds)));
    assert.deepEqual(explainBody.warnings, [...new Set(explainBody.data.warnings)].sort());
    const assertionsResponse = await fetch(`${url}/api/v1/assertions?predicate=project.overview`);
    const assertionsBody = await assertionsResponse.json() as { data: Array<{ id: string; logicalId: string }> };
    assert.equal(assertionsBody.data.length, 1);
    const assertionResponse = await fetch(`${url}/api/v1/assertions/${encodeURIComponent(assertionsBody.data[0]?.id as string)}`);
    assert.equal(assertionResponse.status, 200);
    const historyResponse = await fetch(`${url}/api/v1/assertion-history/${encodeURIComponent(assertionsBody.data[0]?.logicalId as string)}`);
    assert.match(JSON.stringify(await historyResponse.json()), /human:web-test/);

    const reviewWorkspaceResponse = await fetch(`${url}/api/v1/review-workspace`);
    assert.equal(reviewWorkspaceResponse.status, 200);
    const reviewWorkspaceBody = await reviewWorkspaceResponse.json() as {
      contractVersion: string;
      data: { counts: { pending: number; reviewed: number }; conflictGroups: unknown[]; history: Array<{ status: string; reviewTrail: Array<{ actor: string }> }> };
    };
    assert.equal(reviewWorkspaceBody.contractVersion, "1.0.0");
    assert.equal(reviewWorkspaceBody.data.counts.pending, 0);
    assert.equal(reviewWorkspaceBody.data.counts.reviewed, 1);
    assert.equal(reviewWorkspaceBody.data.conflictGroups.length, 0);
    assert.equal(reviewWorkspaceBody.data.history[0]?.status, "approved");
    assert.ok(reviewWorkspaceBody.data.history[0]?.reviewTrail.some((item) => item.actor === "human:web-test"));
    assert.doesNotMatch(JSON.stringify(reviewWorkspaceBody), /X-Context-Atlas-Session|review-session.*token/i);

    const sessionGet = await fetch(`${url}/api/v1/review-session`);
    assert.equal(sessionGet.status, 405);
    assert.equal(sessionGet.headers.get("allow"), "POST");

    const healthResponse = await fetch(`${url}/api/v1/health`);
    const healthBody = await healthResponse.json() as { data: { verdict: string; safeToUse: boolean; components: Array<{ reason: string; evidenceIds: string[] }> } };
    assert.ok(["healthy", "degraded"].includes(healthBody.data.verdict));
    assert.equal(healthBody.data.safeToUse, true);
    assert.ok(healthBody.data.components.length > 0);
    assert.ok(healthBody.data.components.every((component) => component.reason && component.evidenceIds.length > 0));

    appendFileSync(path.join(root, "README.md"), "\nUnindexed dashboard contract drift.\n", "utf8");
    const driftedOverviewResponse = await fetch(`${url}/api/v1/overview`);
    const driftedOverviewBody = await driftedOverviewResponse.json() as {
      warnings: string[];
      data: { summaryAuthority: string; project: { presentationStatus: string; settled: boolean }; assertions: { overview: { status: string; settled: boolean; reason: string } } };
    };
    assert.equal(driftedOverviewBody.data.project.settled, false);
    assert.notEqual(driftedOverviewBody.data.project.presentationStatus, "current");
    assert.equal(driftedOverviewBody.data.assertions.overview.settled, false);
    assert.notEqual(driftedOverviewBody.data.assertions.overview.status, "current");
    assert.ok(driftedOverviewBody.data.assertions.overview.reason);
    assert.notEqual(driftedOverviewBody.data.summaryAuthority, "human-reviewed");
    assert.ok(driftedOverviewBody.warnings.length > 0);

    const driftedGraphResponse = await fetch(`${url}/api/v1/graph`);
    const driftedGraphBody = await driftedGraphResponse.json() as {
      warnings: string[];
      data: { nodes: Array<{ presentationStatus: string; settled: boolean; stale: boolean; reason: string; authority: string }> };
    };
    assert.ok(driftedGraphBody.data.nodes.length > 0);
    assert.ok(driftedGraphBody.data.nodes.every((node) => !node.settled && node.presentationStatus !== "current" && node.stale && node.reason && node.authority));
    assert.ok(driftedGraphBody.warnings.length > 0);

    const driftedSearchResponse = await fetch(`${url}/api/v1/search?q=billing`);
    const driftedSearchBody = await driftedSearchResponse.json() as {
      warnings: string[];
      data: { results: Array<{ status: string; settled: boolean; reason: string; authority: string }> };
    };
    assert.ok(driftedSearchBody.data.results.length > 0);
    assert.ok(driftedSearchBody.data.results.every((result) => !result.settled && result.status !== "current" && result.reason && result.authority));
    assert.ok(driftedSearchBody.warnings.length > 0);

    const traversal = await fetch(`${url}/..%2f..%2fsecret`);
    assert.ok([400, 403].includes(traversal.status));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("browser proposal review is same-origin, token-gated, explicit, bounded, and conflict-aware", async () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);
  const first = listProposals(root, "pending")[0];
  assert.ok(first, "the synchronized fixture should create an initial proposal");
  const second = createProposal(root, {
    kind: first.kind,
    title: "Alternative project overview",
    summary: "Use the same current evidence to test explicit human conflict resolution in the browser workspace.",
    ...(first.targetId ? { targetId: first.targetId } : {}),
    evidenceIds: first.evidenceIds,
  });
  assert.ok(second.conflictGroup);

  const { server, url } = await startWebServer(root, { port: 0 });
  const mutationUrl = (proposalId: string, action: "approve" | "reject"): string =>
    `${url}/api/v1/proposals/${encodeURIComponent(proposalId)}/${action}`;
  const post = (target: string, body: string, headers: Record<string, string> = {}): Promise<Response> => fetch(target, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json", ...headers },
    body,
  });
  try {
    const workspaceResponse = await fetch(`${url}/api/v1/review-workspace`);
    assert.equal(workspaceResponse.status, 200);
    assert.equal(workspaceResponse.headers.get("cache-control"), "no-store");
    const workspace = await workspaceResponse.json() as {
      data: {
        counts: { pending: number; conflictGroups: number; evidenceWarnings: number };
        conflictGroups: Array<{ conflicting: boolean; proposals: Array<{ id: string; evidenceReady: boolean; evidence: Array<{ permittedForCurrentUse: boolean }> }> }>;
      };
    };
    assert.equal(workspace.data.counts.pending, 2);
    assert.equal(workspace.data.counts.conflictGroups, 1);
    assert.equal(workspace.data.conflictGroups.length, 1);
    assert.equal(workspace.data.conflictGroups[0]?.conflicting, true);
    assert.equal(workspace.data.conflictGroups[0]?.proposals.length, 2);
    assert.ok(workspace.data.conflictGroups[0]?.proposals.every((proposal) => proposal.evidenceReady));
    assert.ok(workspace.data.conflictGroups[0]?.proposals.every((proposal) => proposal.evidence.every((evidence) => evidence.permittedForCurrentUse)));

    assert.equal(await requestWithHost(`${url}/api/v1/review-workspace`, "attacker.example"), 403);

    const getMutation = await fetch(mutationUrl(first.id, "approve"));
    assert.equal(getMutation.status, 405);
    assert.equal(getMutation.headers.get("allow"), "POST");

    const evilBootstrap = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(evilBootstrap.status, 403);
    assert.equal(evilBootstrap.headers.get("access-control-allow-origin"), null);
    const evilBootstrapBody = await evilBootstrap.json() as { data: Record<string, unknown> };
    assert.equal(evilBootstrapBody.data.code, "invalid_origin");
    assert.equal("token" in evilBootstrapBody.data, false, "a rejected bootstrap must not expose a session token");

    const missingOrigin = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingOrigin.status, 403);

    const crossSiteMetadata = await fetch(`${url}/api/v1/review-session`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    });
    assert.equal(crossSiteMetadata.status, 403);

    const bootstrap = await post(`${url}/api/v1/review-session`, "{}");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get("cache-control"), "no-store");
    assert.equal(bootstrap.headers.get("access-control-allow-origin"), null);
    const bootstrapBody = await bootstrap.json() as { contractVersion: string; data: { token: string; header: string; scope: string } };
    assert.equal(bootstrapBody.contractVersion, "1.0.0");
    assert.match(bootstrapBody.data.token, /^[a-zA-Z0-9_-]{40,100}$/);
    assert.equal(bootstrapBody.data.header, "X-Context-Atlas-Session");
    assert.match(bootstrapBody.data.scope, /server process/);
    const token = bootstrapBody.data.token;

    const stolenTokenCrossOrigin = await fetch(mutationUrl(first.id, "reject"), {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
        "X-Context-Atlas-Session": token,
      },
      body: JSON.stringify({
        actor: "human:web-reviewer",
        rationale: "A token alone must not bypass the exact same-origin boundary.",
      }),
    });
    assert.equal(stolenTokenCrossOrigin.status, 403);

    const wrongToken = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "This request has the wrong session proof.",
    }), { "X-Context-Atlas-Session": "x".repeat(token.length) });
    assert.equal(wrongToken.status, 403);

    const noToken = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "This request does not include session proof.",
    }));
    assert.equal(noToken.status, 403);

    const malformedActor = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "model:web-reviewer",
      rationale: "The actor is deliberately malformed for this boundary test.",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(malformedActor.status, 422);
    assert.match(await malformedActor.text(), /invalid_actor/);

    const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
    const secretRationale = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: `Reject because ${secret} should never enter immutable review history.`,
    }), { "X-Context-Atlas-Session": token });
    assert.equal(secretRationale.status, 422);
    const secretRationaleBody = await secretRationale.text();
    assert.match(secretRationaleBody, /resembles a secret or credential/);
    assert.doesNotMatch(secretRationaleBody, new RegExp(secret));

    const missingRationale = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "short",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(missingRationale.status, 422);

    const unknownField = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "This body includes an unrecognized field and must be rejected.",
      decision: "reject",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(unknownField.status, 422);

    const malformedJson = await post(mutationUrl(first.id, "reject"), "{", { "X-Context-Atlas-Session": token });
    assert.equal(malformedJson.status, 400);

    const wrongContentType = await fetch(mutationUrl(first.id, "reject"), {
      method: "POST",
      headers: { Origin: url, "Content-Type": "text/plain", "X-Context-Atlas-Session": token },
      body: JSON.stringify({ actor: "human:web-reviewer", rationale: "Text bodies must not cross the review boundary." }),
    });
    assert.equal(wrongContentType.status, 415);

    const oversized = await post(mutationUrl(first.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "x".repeat(4_100),
    }), { "X-Context-Atlas-Session": token });
    assert.equal(oversized.status, 413);

    assert.equal(listProposals(root, "pending").length, 2, "rejected CSRF and malformed requests must not mutate proposals");

    const conflictApproval = await post(mutationUrl(first.id, "approve"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "This candidate cannot be approved while an alternative remains pending.",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(conflictApproval.status, 409);
    assert.match(await conflictApproval.text(), /proposal_conflict/);
    assert.equal(listProposals(root, "pending").length, 2);

    const rejection = await post(mutationUrl(second.id, "reject"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "Reject the duplicate alternative after comparing the same current evidence.",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(rejection.status, 200);
    assert.equal(listProposals(root).find((proposal) => proposal.id === second.id)?.status, "rejected");

    const approval = await post(mutationUrl(first.id, "approve"), JSON.stringify({
      actor: "human:web-reviewer",
      rationale: "Approve the remaining candidate because its linked evidence is current and verified.",
    }), { "X-Context-Atlas-Session": token });
    assert.equal(approval.status, 200);
    assert.equal(listProposals(root).find((proposal) => proposal.id === first.id)?.status, "approved");

    const racingProposal = createProposal(root, {
      kind: "decision",
      title: "Serialize browser review decisions",
      summary: "Only one concurrent review request may transition this proposal and emit durable knowledge.",
      evidenceIds: first.evidenceIds,
    });
    const racingBody = JSON.stringify({
      actor: "human:web-race-reviewer",
      rationale: "Approve exactly once while two browser requests race for the same pending proposal.",
    });
    const racingResponses = await Promise.all([
      post(mutationUrl(racingProposal.id, "approve"), racingBody, { "X-Context-Atlas-Session": token }),
      post(mutationUrl(racingProposal.id, "approve"), racingBody, { "X-Context-Atlas-Session": token }),
    ]);
    assert.deepEqual(racingResponses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(listProposals(root).find((proposal) => proposal.id === racingProposal.id)?.status, "approved");
    const raceDatabase = new AtlasDatabase(root, { readOnly: true });
    try {
      const row = raceDatabase.db.prepare("SELECT COUNT(*) AS count FROM events WHERE id = ?")
        .get(`event_approval_${racingProposal.id}`) as { count: number };
      assert.equal(Number(row.count), 1);
    } finally {
      raceDatabase.close();
    }

    const after = await fetch(`${url}/api/v1/review-workspace`);
    const afterBody = await after.json() as {
      data: { counts: { pending: number; reviewed: number }; history: Array<{ id: string; reviewNote: string; reviewTrail: Array<{ actor: string; action: string }> }> };
    };
    assert.equal(afterBody.data.counts.pending, 0);
    assert.equal(afterBody.data.counts.reviewed, 3);
    assert.ok(afterBody.data.history.every((proposal) => proposal.reviewNote.length >= 8));
    assert.ok(afterBody.data.history.every((proposal) => proposal.reviewTrail.some((entry) => entry.actor.startsWith("human:"))));
    assert.ok(afterBody.data.history.some((proposal) => proposal.reviewTrail.some((entry) => entry.actor === "human:web-reviewer")));
    assert.ok(afterBody.data.history.some((proposal) => proposal.reviewTrail.some((entry) => entry.actor === "human:web-race-reviewer")));
    assert.ok(afterBody.data.history.some((proposal) => proposal.reviewTrail.some((entry) => entry.action === "reject")));
    assert.ok(afterBody.data.history.some((proposal) => proposal.reviewTrail.some((entry) => entry.action === "accept")));
    assert.equal(afterBody.data.history.filter((proposal) => proposal.id === racingProposal.id).length, 1);
    assert.doesNotMatch(JSON.stringify(afterBody), new RegExp(secret));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
