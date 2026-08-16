import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Script } from "node:vm";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { startWebServer } from "../src/web/server.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("dashboard source keeps the launch interaction and accessibility contract", () => {
  const html = readFileSync(new URL("../src/web/public/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web/public/styles.css", import.meta.url), "utf8");
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
  assert.doesNotMatch(script, /object\.stale \? "stale" : object\.status/, "the map must not promote lifecycle status into current-use status");
  assert.doesNotMatch(script, />Current context</, "generic current labels must not hide the presentation contract");
  assert.match(script, /preferredScrollBehavior/);
  assert.match(script, /event\.key === "ArrowDown"/);
  assert.match(script, /\/api\/v1\/overview/);
  assert.match(script, /contractVersion !== "1\.0\.0"/);

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
  assert.match(styles, /\.map-context-banner/);
  assert.match(styles, /\.map-table-scroll:focus-visible/);
  const definedCustomProperties = new Set([...styles.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const referencedCustomProperties = [...styles.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]);
  assert.ok(referencedCustomProperties.every((name) => definedCustomProperties.has(name)), "every referenced CSS custom property must be defined");
  assert.doesNotMatch(`${html}\n${styles}`, /https?:\/\//i, "the local dashboard must not depend on remote UI assets");
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
