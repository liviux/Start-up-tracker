"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TrackerSqliteStore, GLOBAL_STARTUP_ID, makeStartupId, normalizeStartupId } = require("../lib/tracker-sqlite-store");

const A = "alpha-0001";
const B = "beta-0002";

function twoStartups(options) {
  const store = new TrackerSqliteStore(":memory:", options);
  store.replaceState(A, { items: [{ id: "same", title: "Alpha" }], settings: { color: "blue" } });
  store.replaceState(B, { items: [{ id: "same", title: "Beta" }], settings: { color: "green" } });
  return store;
}

test("two startups can use the same record ids and never see each other's records", () => {
  const store = twoStartups();
  try {
    assert.equal(store.getRecord(A, "items", "same").title, "Alpha");
    assert.equal(store.getRecord(B, "items", "same").title, "Beta");
    store.upsertRecord(A, "items", { id: "only-a", title: "Only in A" });
    assert.equal(store.getRecord(B, "items", "only-a"), undefined);
    assert.deepEqual(store.readState(B).state.items.map((item) => item.id), ["same"]);
  } finally {
    store.close();
  }
});

test("revisions, changes and history are counted per startup", () => {
  const store = twoStartups();
  try {
    const beforeB = store.getRevision(B);
    const hashB = store.readStateHash(B);
    store.upsertRecord(A, "items", { id: "same", title: "Alpha 2" });
    store.deleteRecord(A, "items", "same");
    assert.equal(store.getRevision(B), beforeB, "B's ETag never moves because of A");
    assert.equal(store.readStateHash(B), hashB);
    assert.deepEqual(store.readChangesSince(B, beforeB).upserts, []);
    assert.deepEqual(store.readChangesSince(B, beforeB).deletes, []);
    assert.equal(store.readChangesSince(A, 1).deletes.length, 1);
    assert.equal(store.readRecordHistory(B, "items", "same").entries.every((entry) => entry.event !== "deleted"), true);
    assert.ok(store.readRecordHistory(A, "items", "same").entries.some((entry) => entry.event === "deleted"));
    assert.equal(store.readRevisionMap(B).records.items.same, beforeB);
  } finally {
    store.close();
  }
});

test("replaceState on one startup leaves the other byte-identical", () => {
  const store = twoStartups();
  try {
    const before = JSON.stringify(store.readState(B));
    store.replaceState(A, { items: [], notes: "replaced" });
    assert.equal(JSON.stringify(store.readState(B)), before);
    assert.deepEqual(store.readState(A).state, { items: [], notes: "replaced" });
  } finally {
    store.close();
  }
});

test("a mutation id is remembered per startup", () => {
  const store = twoStartups();
  try {
    const op = [{ type: "upsert", section: "items", value: { id: "m", title: "x" } }];
    store.applyOperations(A, op, { mutationId: "same-mutation" });
    const inB = store.applyOperations(B, op, { mutationId: "same-mutation" });
    assert.equal(inB.replayed, undefined, "B applies it for real");
    assert.equal(store.getRecord(B, "items", "m").title, "x");
    assert.equal(store.applyOperations(A, op, { mutationId: "same-mutation" }).replayed, true);
  } finally {
    store.close();
  }
});

test("history and tombstone caps count per startup", () => {
  const store = twoStartups({ limits: { historyEntries: 5, tombstones: 3 } });
  try {
    for (let i = 0; i < 10; i += 1) {
      store.upsertRecord(A, "items", { id: `a-${i}`, title: String(i) });
      store.deleteRecord(A, "items", `a-${i}`);
    }
    const bHistory = store.readRecordHistory(B, "items", "same");
    assert.ok(bHistory.total >= 1, "a busy startup never evicts another one's history");
    const raw = store.db;
    const countA = raw.prepare("SELECT COUNT(*) AS c FROM record_history WHERE startup_id = ?").get(A).c;
    const tombsA = raw.prepare("SELECT COUNT(*) AS c FROM deleted_records WHERE startup_id = ?").get(A).c;
    assert.ok(countA <= 5);
    assert.ok(tombsA <= 3);
    assert.equal(store.readChangesSince(A, 1), null, "a gap older than the tombstone window needs a full load");
    assert.notEqual(store.readChangesSince(B, 1), null);
  } finally {
    store.close();
  }
});

test("every scoped call needs a valid startup id", () => {
  const store = twoStartups();
  try {
    for (const call of [
      () => store.readState(),
      () => store.readState(""),
      () => store.readState("Has Spaces"),
      () => store.applyOperations(undefined, [{ type: "delete", section: "items", id: "same" }]),
      () => store.getRecord(null, "items", "same"),
      () => store.readChangesSince(undefined, 0),
    ]) {
      assert.throws(call, /startup id/);
    }
    assert.equal(normalizeStartupId(GLOBAL_STARTUP_ID), "_global");
    assert.throws(() => store.deleteStartupData(GLOBAL_STARTUP_ID));
  } finally {
    store.close();
  }
});

test("deleting a startup removes all its rows and nothing else", () => {
  const store = twoStartups();
  try {
    store.replaceState(GLOBAL_STARTUP_ID, { startups: [{ id: A }, { id: B }] });
    const before = store.getRevision(A);
    store.deleteStartupData(A);
    assert.deepEqual(store.listStartupIds(), [B]);
    assert.deepEqual(store.readState(A).state, {});
    // The counter keeps rising, so a restored id never repeats a revision a
    // browser may still hold, and its changes feed cannot replay the old data.
    assert.ok(store.getRevision(A) > before);
    assert.equal(store.readChangesSince(A, before), null);
    store.replaceState(A, { items: [{ id: "back" }] });
    assert.ok(store.getRevision(A) > before + 1);
    assert.equal(store.readState(B).state.items[0].title, "Beta");
    assert.equal(store.readSection(GLOBAL_STARTUP_ID, "startups").length, 2);
  } finally {
    store.close();
  }
});

test("a whole-database snapshot holds every startup and verifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startups-snapshot-"));
  try {
    const store = new TrackerSqliteStore(path.join(dir, "tracker.sqlite"));
    store.replaceState(A, { items: [{ id: "x" }] });
    store.replaceState(B, { items: [{ id: "y" }] });
    const snapshot = store.createSnapshot(path.join(dir, "snap.sqlite"));
    store.close();
    assert.equal(snapshot.verification.ok, true);
    assert.equal(snapshot.verification.startupCount, 2);
    const copy = new TrackerSqliteStore(snapshot.outputPath, { readOnly: true });
    try {
      assert.deepEqual(copy.listStartupIds(), [A, B]);
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new startup ids are a slug of the name plus a short suffix", () => {
  assert.match(makeStartupId("Acme Robotics GmbH"), /^acme-robotics-gmbh-[a-z0-9]{4}$/);
  assert.match(makeStartupId("Éclair & Co."), /^eclair-co-[a-z0-9]{4}$/);
  assert.match(makeStartupId(""), /^startup-[a-z0-9]{4}$/);
  assert.notEqual(makeStartupId("Same"), makeStartupId("Same"));
});

test("replacing or deleting a startup's data starts a new lineage for it only", () => {
  const store = twoStartups();
  try {
    assert.equal(store.getLineageStart(B), store.getRevision(B), "replaceState in the fixture set it");
    store.upsertRecord(A, "items", { id: "n", title: "New" });
    const lineageB = store.getLineageStart(B);
    const result = store.replaceState(A, { items: [{ id: "r" }] });
    assert.equal(store.getLineageStart(A), result.revision);
    assert.equal(store.getLineageStart(B), lineageB);
    store.deleteStartupData(A);
    assert.equal(store.getLineageStart(A), store.getRevision(A));
    assert.equal(store.getLineageStart("never-used-0000"), 0);
  } finally {
    store.close();
  }
});

test("the first record of a collection creates it; deleting from a missing one does nothing", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.upsertRecord(A, "deletedMediaItems", { id: "m", deletedAt: "2026-10-19T00:00:00.000Z" });
    assert.deepEqual(store.readSection(A, "deletedMediaItems").map((record) => record.id), ["m"]);
    const revision = store.getRevision(A);
    assert.equal(store.deleteRecord(A, "neverCreated", "x").unchanged, true);
    assert.equal(store.getRevision(A), revision);
    assert.equal(store.readSection(B, "deletedMediaItems"), undefined, "only in that startup");
    store.replaceSection(A, "profile", { name: "x" });
    assert.throws(() => store.upsertRecord(A, "profile", { id: "y" }), /not a collection/);
  } finally {
    store.close();
  }
});
