import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
  removeSchema5TimelineIntegrity(old);
  old.db.exec("DROP TABLE ledger_flush_receipts; DROP TABLE ledger_outbox");
  old.setMeta("schema_version", "3");
  old.close();

  assert.throws(() => new AtlasDatabase(root, { readOnly: true }), /requires explicit migration to 5/);
  assert.equal(existsSync(path.join(root, ".context-atlas", "migrations")), false);

  const migrated = new AtlasDatabase(root);
  assert.equal(migrated.getMeta("schema_version"), "5");
  assert.match(migrated.getMeta("last_migration") ?? "", /^3->5@/);
  const table = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_outbox'").get() as { name?: string } | undefined;
  assert.equal(table?.name, "ledger_outbox");
  assertTimelineIntegrityBackfilled(migrated);
  migrated.close();

  const snapshots = readdirSync(path.join(root, ".context-atlas", "migrations"));
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0] as string, /^atlas-v3-to-v5-.*\.db$/);
});

test("schema 4 upgrades backfill immutable timeline content and ledger bindings", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);

  const old = new AtlasDatabase(root);
  removeSchema5TimelineIntegrity(old);
  old.setMeta("schema_version", "4");
  old.close();
  writeFileSync(
    path.join(root, ".context-atlas", ".gitignore"),
    "atlas.db\natlas.db-*\nexports/\nbackups/\n",
    "utf8",
  );

  assert.throws(() => new AtlasDatabase(root, { readOnly: true }), /requires explicit migration to 5/);
  const migrated = new AtlasDatabase(root);
  assert.equal(migrated.getMeta("schema_version"), "5");
  assert.match(migrated.getMeta("last_migration") ?? "", /^4->5@/);
  assertTimelineIntegrityBackfilled(migrated);
  migrated.close();

  const snapshots = readdirSync(path.join(root, ".context-atlas", "migrations"));
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0] as string, /^atlas-v4-to-v5-.*\.db$/);
  const migrationRelativePath = `.context-atlas/migrations/${snapshots[0] as string}`;
  assert.equal(
    execFileSync("git", ["-C", root, "check-ignore", migrationRelativePath], { encoding: "utf8", windowsHide: true }).trim(),
    migrationRelativePath,
    "legacy stores must add the migration snapshot ignore rule before writing a full database copy",
  );
});

test("schema 5 startup never blesses a missing immutable event digest", () => {
  const root = createFixtureRepository();
  fixtures.push(root);
  initializeFixture(root);

  const damaged = new AtlasDatabase(root);
  const event = damaged.db.prepare("SELECT id FROM events ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
  const eventId = event?.id;
  assert.ok(eventId);
  damaged.db.exec("DROP TRIGGER event_integrity_no_delete");
  damaged.db.prepare("DELETE FROM event_integrity WHERE event_id = ?").run(eventId);
  damaged.close();

  const reopened = new AtlasDatabase(root);
  const integrity = reopened.listEventIntegrityRecords().find((item) => item.id === eventId);
  assert.equal(integrity?.contentDigest, null);
  assert.equal(reopened.getMeta("schema_version"), "5");
  reopened.close();
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
      unsupported === "99" ? /newer than supported schema 5/ : /Invalid Context Atlas database schema version/,
    );
  }
});

function removeSchema5TimelineIntegrity(database: AtlasDatabase): void {
  database.db.exec(`
    DROP TRIGGER events_immutable_content;
    DROP TRIGGER events_ledger_hash_once;
    DROP TRIGGER events_no_delete;
    DROP TRIGGER event_integrity_immutable_content;
    DROP TRIGGER event_integrity_binding_once;
    DROP TRIGGER event_integrity_no_delete;
    DROP TABLE event_integrity;
  `);
}

function assertTimelineIntegrityBackfilled(database: AtlasDatabase): void {
  const counts = database.db.prepare(`
    SELECT COUNT(*) AS event_count,
           COUNT(event_integrity.event_id) AS integrity_count,
           SUM(CASE WHEN length(event_integrity.content_digest) = 64 THEN 1 ELSE 0 END) AS valid_content_count,
           SUM(CASE WHEN events.ledger_hash IS NULL OR length(event_integrity.binding_digest) = 64 THEN 1 ELSE 0 END) AS valid_binding_count
    FROM events
    LEFT JOIN event_integrity ON event_integrity.event_id = events.id
  `).get() as { event_count: number; integrity_count: number; valid_content_count: number; valid_binding_count: number };
  assert.ok(counts.event_count > 0);
  assert.equal(counts.integrity_count, counts.event_count);
  assert.equal(counts.valid_content_count, counts.event_count);
  assert.equal(counts.valid_binding_count, counts.event_count);

  const triggers = database.db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'events_immutable_content', 'events_ledger_hash_once', 'events_no_delete',
      'event_integrity_immutable_content', 'event_integrity_binding_once', 'event_integrity_no_delete'
    )
  `).get() as { count: number };
  assert.equal(triggers.count, 6);
}
