import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { approveProposal, listProposals } from "../src/core/proposals.js";
import { startWebServer } from "../src/web/server.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("dashboard source keeps the launch interaction and accessibility contract", () => {
  const html = readFileSync(new URL("../src/web/public/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web/public/styles.css", import.meta.url), "utf8");

  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /id="briefing-dialog"/);
  assert.match(html, /id="app-status"[^>]*role="status"/);
  assert.match(html, /data-state="loading" role="status"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "CSP-safe HTML must not add inline scripts");
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, "CSP-safe HTML must not add inline styles");

  assert.match(script, /function escapeHTML/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /function briefingSteps/);
  assert.match(script, /function focusSpatialNode/);
  assert.match(script, /Browse the same map as an accessible table/);
  assert.match(script, /<caption>Filtered project knowledge nodes/);
  assert.match(script, /function navigateTimeline/);
  assert.match(script, /function applyHealthFilter/);
  assert.match(script, /Freshness and evidence by component/);
  assert.match(script, /Context use blocked/);
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
    const versionedOverviewBody = await versionedOverview.json() as { contractVersion: string; snapshot: { repositoryId: string }; data: { project: { name: string } } };
    assert.equal(versionedOverviewBody.contractVersion, "1.0.0");
    assert.equal(versionedOverviewBody.data.project.name, "Fixture Shop");
    assert.match(versionedOverviewBody.snapshot.repositoryId, /^repo_/);
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

    const traversal = await fetch(`${url}/..%2f..%2fsecret`);
    assert.ok([400, 403].includes(traversal.status));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
