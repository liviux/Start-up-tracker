"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { purgeExpired, normalizeRetentionDays, pairedSection } = require("../lib/recycle-bin");

const NOW = new Date("2026-10-17T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  store.replaceState("one-0001", {
    items: [{ id: "live" }],
    deletedItems: [
      { id: "old", deletedAt: daysAgo(31) },
      { id: "recent", deletedAt: daysAgo(5) },
      { id: "undated" },
    ],
    deletedMediaItems: [{ id: "old-media", deletedAt: daysAgo(40) }],
  }, { origin: "tool" });
  store.replaceState("two-0002", { deletedPrograms: [{ id: "old", deletedAt: daysAgo(100) }] }, { origin: "tool" });
  store.replaceState(GLOBAL_STARTUP_ID, { deletedTags: [{ id: "tag", deletedAt: daysAgo(60) }] }, { origin: "tool" });
  return store;
}

const ids = (store, scope, section) => (store.readSection(scope, section) || []).map((record) => record.id);

test("records older than 30 days leave every bin; recent and undated ones stay", () => {
  const store = setup();
  const result = purgeExpired(store, { now: NOW });
  assert.equal(result.purged.length, 4);
  assert.deepEqual(ids(store, "one-0001", "deletedItems"), ["recent", "undated"]);
  assert.deepEqual(ids(store, "one-0001", "deletedMediaItems"), []);
  assert.deepEqual(ids(store, "one-0001", "items"), ["live"]);
  assert.deepEqual(ids(store, "two-0002", "deletedPrograms"), []);
  assert.deepEqual(ids(store, GLOBAL_STARTUP_ID, "deletedTags"), []);
  const history = store.readRecordHistory("one-0001", "deletedItems", "old");
  assert.equal(history.entries[0].origin, "tool");
  assert.equal(history.entries[0].event, "deleted");
});

test("a changed number of days applies, and 'until I empty it' purges nothing", () => {
  const store = setup();
  assert.equal(purgeExpired(store, { now: NOW, retentionDays: 90 }).purged.length, 1);
  assert.deepEqual(purgeExpired(store, { now: NOW, retentionDays: null }).purged, []);
  assert.deepEqual(ids(store, "one-0001", "deletedItems"), ["old", "recent", "undated"]);
});

test("retention days are checked", () => {
  assert.equal(normalizeRetentionDays(undefined), 30);
  assert.equal(normalizeRetentionDays("never"), null);
  assert.equal(normalizeRetentionDays(7), 7);
  assert.throws(() => normalizeRetentionDays(6), RangeError);
  assert.throws(() => normalizeRetentionDays(366), RangeError);
  assert.throws(() => normalizeRetentionDays(1.5), RangeError);
});

test("sections pair both ways", () => {
  assert.equal(pairedSection("items"), "deletedItems");
  assert.equal(pairedSection("deletedTags"), "tags");
  assert.equal(pairedSection("profile"), null);
});
