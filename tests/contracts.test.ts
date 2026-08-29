import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { ContractSnapshotChangedError, withStableContractRead } from "../src/core/contracts.js";
import { AtlasDatabase } from "../src/core/database.js";
import { validateEvidenceLocators } from "../src/core/evidence-validation.js";
import { getRepoStatus } from "../src/core/git.js";
import { getOverview } from "../src/core/query.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) removeFixture(fixtures.pop() as string);
});

test("contract read guard returns stable values and refuses a concurrent knowledge commit", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);

  const overview = withStableContractRead(root, (context) => {
    assert.strictEqual(getRepoStatus(root), context.repository, "nested reads must reuse the request's repository observation");
    const evidenceIds = (context.database.db.prepare("SELECT id FROM evidence ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    const evidence = context.database.listEvidence(evidenceIds);
    assert.ok(evidence.length > 0);
    const firstValidation = validateEvidenceLocators(root, evidence);
    const repeatedValidation = validateEvidenceLocators(root, evidence);
    assert.strictEqual(
      repeatedValidation.results[0],
      firstValidation.results[0],
      "repeated locator checks in one stable read must reuse the request-local validation result",
    );
    return getOverview(root);
  });
  assert.equal((overview.project as { name: string }).name, "Fixture Shop");
  assert.throws(
    () =>
      withStableContractRead(root, () => {
        const writer = new AtlasDatabase(root);
        try {
          writer.setMeta("contract_guard_probe", new Date().toISOString());
        } finally {
          writer.close();
        }
        return "must-not-escape";
      }),
    ContractSnapshotChangedError,
  );

  assert.throws(
    () =>
      withStableContractRead(root, () => {
        appendFileSync(`${root}/README.md`, "\nConcurrent contract drift.\n", "utf8");
        return "must-not-escape";
      }),
    ContractSnapshotChangedError,
  );
});
