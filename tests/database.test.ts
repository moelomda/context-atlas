import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { AtlasDatabase } from "../src/core/database.js";
import { createFixtureRepository, initializeFixture, removeFixture } from "./helpers.js";

const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("schema upgrades create a protected snapshot and migrate atomically", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);

  const old = new AtlasDatabase(root);
  old.db.exec("DROP TABLE ledger_flush_receipts; DROP TABLE ledger_outbox");
  old.setMeta("schema_version", "3");
  old.close();

  assert.throws(() => new AtlasDatabase(root, { readOnly: true }), /requires explicit migration to 4/);
  assert.equal(existsSync(path.join(root, ".context-atlas", "migrations")), false);

  const migrated = new AtlasDatabase(root);
  assert.equal(migrated.getMeta("schema_version"), "4");
  assert.match(migrated.getMeta("last_migration") ?? "", /^3->4@/);
  const table = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_outbox'").get() as { name?: string } | undefined;
  assert.equal(table?.name, "ledger_outbox");
  migrated.close();

  const snapshots = readdirSync(path.join(root, ".context-atlas", "migrations"));
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0] as string, /^atlas-v3-to-v4-.*\.db$/);
});

test("newer or malformed database schemas fail closed", () => {
  for (const unsupported of ["99", "not-a-version"]) {
    const root = createFixtureRepository();
    fixtures.push(root);
    initializeFixture(root);
    const database = new AtlasDatabase(root);
    database.setMeta("schema_version", unsupported);
    database.close();
    assert.throws(
      () => new AtlasDatabase(root),
      unsupported === "99" ? /newer than supported schema 4/ : /Invalid Context Atlas database schema version/,
    );
  }
});
