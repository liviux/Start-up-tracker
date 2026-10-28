"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

// Every scoped store call names its startup; these tests use one.
const SID = "test-0001";
const {
  GLOBAL_STARTUP_ID,
  RecordConflictError,
  RevisionConflictError,
  TrackerSqliteStore,
  verifyDatabaseFile,
} = require("../lib/tracker-sqlite-store");
const { writeLegacyDatabase } = require("./helpers/legacy-schema");

function fixtureState() {
  return {
    name: "Tracker",
    version: 3,
    categories: [{ id: "one", name: "One" }],
    items: [
      { id: "a", title: "A", details: { second: 2, first: 1 } },
      { id: "b", title: "B" },
    ],
    companyProfile: { incorporated: true },
    fundingRounds: [],
  };
}

test("round-trips state and applies record operations atomically", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    assert.deepEqual(store.replaceState(SID, fixtureState()), {
      revision: 1,
      stateHash: store.readState(SID).stateHash,
      unchanged: false,
    });
    assert.deepEqual(store.readState(SID).state, fixtureState());

    const result = store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "a", value: { id: "a", title: "Updated" } },
      { type: "delete", section: "items", id: "b" },
      { type: "upsert", section: "items", id: "c", value: { id: "c", title: "C" } },
    ], { expectedRevision: 1 });

    assert.equal(result.revision, 2);
    assert.equal(result.unchanged, false);
    assert.equal(typeof result.stateHash, "string");
    assert.deepEqual(store.readSection(SID, "items"), [
      { id: "a", title: "Updated" },
      { id: "c", title: "C" },
    ]);
    assert.deepEqual(store.getRecord(SID, "items", "c"), { id: "c", title: "C" });
    assert.deepEqual(store.getRecordWithRevision(SID, "items", "c"), {
      record: { id: "c", title: "C" },
      revision: 2,
    });
  } finally {
    store.close();
  }
});

test("preserves order, supports explicit reordering, and safely replays mutation IDs", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, fixtureState());
    const first = store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "c", value: { id: "c", title: "C" } },
      { type: "reorder", section: "items", ids: ["c", "a", "b"] },
    ], { expectedRevision: 1, mutationId: "outbox-1" });
    assert.deepEqual(store.readSection(SID, "items").map((item) => item.id), ["c", "a", "b"]);

    const replay = store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "c", value: { id: "c", title: "C" } },
      { type: "reorder", section: "items", ids: ["c", "a", "b"] },
    ], { expectedRevision: 1, mutationId: "outbox-1" });
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(store.readState(SID).revision, 2);

    assert.throws(() => store.deleteRecord(SID, "items", "a", { mutationId: "outbox-1" }),
      (error) => error.code === "SQLITE_TRACKER_MUTATION_ID_REUSED");
  } finally {
    store.close();
  }
});

test("canonical upsert payload validates IDs and honors position", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, fixtureState());
    store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "c", value: { id: "c", title: "C" }, position: 0 },
      { type: "upsert", section: "items", id: "b", value: { id: "b", title: "B2" }, position: 1 },
    ]);
    assert.deepEqual(store.readSection(SID, "items"), [
      { id: "c", title: "C" },
      { id: "a", title: "A", details: { second: 2, first: 1 } },
      { id: "b", title: "B2" },
    ]);
    assert.throws(() => store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "wrong", value: { id: "right" } },
    ]), /does not match/);

    const beforeUnchanged = store.readState(SID);
    const unchanged = store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "b", value: { id: "b", title: "B2" } },
    ], { expectedRevision: beforeUnchanged.revision });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.revision, beforeUnchanged.revision);
  } finally {
    store.close();
  }
});

test("membership changes lock ordering and existing upserts cannot move records implicitly", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, fixtureState());
    const baseline = store.readRevisionMap(SID);
    store.applyOperations(SID, [{
      type: "upsert", section: "items", id: "c", value: { id: "c", title: "C" },
      position: 0, baseRevision: 0,
    }]);
    assert.deepEqual(store.readSection(SID, "items").map(({ id }) => id), ["c", "a", "b"]);

    assert.throws(() => store.applyOperations(SID, [{
      type: "reorder", section: "items", ids: ["b", "a", "c"],
      baseRevision: baseline.sections.items,
    }]), (error) => error instanceof RecordConflictError && error.conflicts[0].id === null);

    const afterInsert = store.readRevisionMap(SID);
    store.applyOperations(SID, [{
      type: "upsert", section: "items", id: "a", value: { id: "a", title: "A2" },
      position: 2, baseRevision: afterInsert.records.items.a,
    }]);
    assert.deepEqual(store.readSection(SID, "items").map(({ id }) => id), ["c", "a", "b"]);

    const beforeDelete = store.readRevisionMap(SID);
    store.applyOperations(SID, [{
      type: "delete", section: "items", id: "b",
      baseRevision: beforeDelete.records.items.b,
    }]);
    assert.ok(store.readRevisionMap(SID).sections.items > beforeDelete.sections.items);
  } finally {
    store.close();
  }
});

test("tombstone completeness watermark survives pruning and ID recreation", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    const items = Array.from({ length: 5_001 }, (_, index) => ({ id: `item-${index}` }));
    store.replaceState(SID, { items });
    const baseline = store.getRevision(SID);
    store.applyOperations(SID, items.map(({ id }) => ({ type: "delete", section: "items", id })));
    assert.equal(store.readChangesSince(SID, baseline), null);
    store.applyOperations(SID, items.map((value) => ({ type: "upsert", section: "items", id: value.id, value })));
    assert.equal(store.readChangesSince(SID, baseline), null);
  } finally {
    store.close();
  }
});

test("rolls back a batch and reports optimistic-lock conflicts", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, fixtureState());
    assert.throws(
      () => store.upsertRecord(SID, "items", { id: "c" }, { expectedRevision: 0 }),
      RevisionConflictError,
    );
    assert.throws(() => store.applyOperations(SID, [
      { type: "upsert", section: "items", id: "c", value: { id: "c" } },
      { type: "reorder", section: "missing", ids: ["x"] },
    ]));
    assert.equal(store.getRecord(SID, "items", "c"), undefined);
    assert.equal(store.readState(SID).revision, 1);
  } finally {
    store.close();
  }
});

test("locks per record, so concurrent edits to different records do not collide", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-record-lock-"));
  const store = new TrackerSqliteStore(path.join(temporaryDir, "tracker.sqlite"));
  try {
    store.replaceState(SID, fixtureState());
    const before = store.readRevisionMap(SID);
    const firstId = String(store.readState(SID).state.items[0].id);
    const secondId = String(store.readState(SID).state.items[1].id);

    // Another writer changes the second item.
    store.applyOperations(SID, [{
      type: "upsert",
      section: "items",
      id: secondId,
      value: { id: secondId, platform: "Moved by someone else" },
      baseRevision: before.records.items[secondId],
    }]);

    // The first item is untouched, so an edit based on its own revision applies
    // even though the global revision has moved on.
    const applied = store.applyOperations(SID, [{
      type: "upsert",
      section: "items",
      id: firstId,
      value: { id: firstId, platform: "Edited concurrently" },
      baseRevision: before.records.items[firstId],
    }]);
    assert.equal(applied.unchanged, false);
    assert.equal(store.readState(SID).state.items[0].platform, "Edited concurrently");

    // Re-using the stale base for the record that did move is still a conflict,
    // and the error names exactly which record collided.
    assert.throws(
      () => store.applyOperations(SID, [{
        type: "upsert",
        section: "items",
        id: secondId,
        value: { id: secondId, platform: "Stale" },
        baseRevision: before.records.items[secondId],
      }]),
      (error) => error instanceof RecordConflictError
        && error.conflicts.length === 1
        && error.conflicts[0].id === secondId
        && error.conflicts[0].reason === "modified",
    );

    // Editing a record another writer deleted is a conflict too.
    const beforeDelete = store.readRevisionMap(SID);
    store.applyOperations(SID, [{ type: "delete", section: "items", id: firstId }]);
    assert.throws(
      () => store.applyOperations(SID, [{
        type: "upsert",
        section: "items",
        id: firstId,
        value: { id: firstId, platform: "Resurrected" },
        baseRevision: beforeDelete.records.items[firstId],
      }]),
      (error) => error instanceof RecordConflictError && error.conflicts[0].reason === "deleted",
    );
  } finally {
    store.close();
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("appendRecordHistory validates input array and read-only mode", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-append-history-"));
  try {
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    let store = new TrackerSqliteStore(databasePath);
    try {
      assert.throws(
        () => store.appendRecordHistory(SID, null),
        { name: "TypeError", message: "entries must be an array." },
      );
      assert.throws(
        () => store.appendRecordHistory(SID, "invalid"),
        { name: "TypeError", message: "entries must be an array." },
      );
    } finally {
      store.close();
    }

    store = new TrackerSqliteStore(databasePath, { readOnly: true });
    try {
      assert.throws(
        () => store.appendRecordHistory(SID, []),
        { name: "Error", message: "Cannot append history to a read-only store." },
      );
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("importRecordHistory keeps the source timeline, provenance and approximate flag", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    const result = store.importRecordHistory(SID, [
      {
        section: "items",
        id: "a",
        event: "updated",
        revision: 7,
        changedAt: "2026-01-02T03:04:05.000Z",
        sessionStartedAt: "2026-01-02T03:00:00.000Z",
        origin: "backfill",
        actor: "Old tracker",
        label: "Imported timeline",
        approximate: true,
        fieldsJson: JSON.stringify([{ path: "status", before: "todo", after: "done" }]),
      },
      {
        section: "items",
        id: "a",
        event: "deleted",
        revision: 8,
        changedAt: "2026-01-03T03:04:05.000Z",
        origin: "restore",
        snapshot: { id: "a", status: "done" },
      },
    ]);
    assert.deepEqual(result, { written: 2, total: 2 });
    const history = store.readRecordHistory(SID, "items", "a");
    assert.equal(history.total, 2);
    const updated = history.entries.find((entry) => entry.event === "updated");
    assert.deepEqual(updated.fields, [{ path: "status", before: "todo", after: "done" }]);
    assert.equal(updated.origin, "backfill");
    assert.equal(updated.actor, "Old tracker");
    assert.equal(updated.approximate, true);
    assert.equal(updated.changedAt, "2026-01-02T03:04:05.000Z");
    const deleted = history.entries.find((entry) => entry.event === "deleted");
    assert.equal(deleted.origin, "restore");
    assert.deepEqual(deleted.snapshot, { id: "a", status: "done" });
    assert.throws(() => store.importRecordHistory(SID, [{ section: "items", id: "b", event: "nope" }]), /Unknown history event/);
    assert.throws(() => store.importRecordHistory(SID, [{ section: "items", id: "b", event: "updated", fieldsJson: "{" }]), /not valid/);
  } finally {
    store.close();
  }
});

test("checkIntegrity reports ok on valid database and throws when closed", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, fixtureState());
    const report = store.checkIntegrity();
    assert.deepEqual(report, {
      ok: true,
      integrity: ["ok"],
      foreignKeyErrors: [],
    });
  } finally {
    store.close();
  }

  assert.throws(
    () => store.checkIntegrity(),
    (error) => error.message === "TrackerSqliteStore is closed.",
  );
});

test("readRecordHistory throws expected errors on invalid parameters and closed store", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    // Invalid sectionName
    assert.throws(() => store.readRecordHistory(SID, "", "a"), TypeError);
    assert.throws(() => store.readRecordHistory(SID, null, "a"), TypeError);
    assert.throws(() => store.readRecordHistory(SID, undefined, "a"), TypeError);
    assert.throws(() => store.readRecordHistory(SID, 123, "a"), TypeError);
    assert.throws(() => store.readRecordHistory(SID, {}, "a"), TypeError);

    // Invalid recordId
    assert.throws(() => store.readRecordHistory(SID, "items", ""), TypeError);
    assert.throws(() => store.readRecordHistory(SID, "items", null), TypeError);
    assert.throws(() => store.readRecordHistory(SID, "items", undefined), TypeError);
    assert.throws(() => store.readRecordHistory(SID, "items", {}), TypeError);

    // Closed store
    store.close();
    assert.throws(() => store.readRecordHistory(SID, "items", "a"), /TrackerSqliteStore is closed/);
  } finally {
    if (!store.closed) {
      store.close();
    }
  }
});

test("readToolMetadata handles missing keys, store state assertions, and key validation", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-read-toolmeta-"));
  try {
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    let store = new TrackerSqliteStore(databasePath);

    // Reading unwritten/missing key returns null
    assert.equal(store.readToolMetadata("nonexistent_key"), null);
    assert.equal(store.readToolMetadata("some.valid-key_123"), null);

    // Write value and verify readToolMetadata returns exact string value
    store.writeToolMetadata("sync.watermark", "100500");
    assert.equal(store.readToolMetadata("sync.watermark"), "100500");

    // Key validation error cases
    assert.throws(() => store.readToolMetadata(null), /non-empty strings/);
    assert.throws(() => store.readToolMetadata(undefined), /non-empty strings/);
    assert.throws(() => store.readToolMetadata(123), /non-empty strings/);
    assert.throws(() => store.readToolMetadata(""), /non-empty strings/);
    assert.throws(() => store.readToolMetadata("   "), /non-empty strings/);
    assert.throws(() => store.readToolMetadata("key with spaces"), /characters outside/);
    assert.throws(() => store.readToolMetadata("key@special#chars"), /characters outside/);

    store.close();

    // Verify reading from read-only store
    store = new TrackerSqliteStore(databasePath, { readOnly: true });
    assert.equal(store.readToolMetadata("sync.watermark"), "100500");
    assert.equal(store.readToolMetadata("missing.key"), null);
    store.close();

    // Verify assertOpen when calling readToolMetadata on a closed store
    assert.throws(
      () => store.readToolMetadata("sync.watermark"),
      (error) => error instanceof Error && error.message === "TrackerSqliteStore is closed.",
    );
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("reports only what changed after a revision, deletions included", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-changes-since-"));
  const store = new TrackerSqliteStore(path.join(temporaryDir, "tracker.sqlite"));
  try {
    store.replaceState(SID, fixtureState());
    const baseline = store.getRevision(SID);
    const items = store.readState(SID).state.items;
    const keptId = String(items[0].id);
    const removedId = String(items[1].id);

    store.applyOperations(SID, [{
      type: "upsert",
      section: "items",
      id: keptId,
      value: { id: keptId, platform: "Changed" },
    }]);
    store.applyOperations(SID, [{ type: "delete", section: "items", id: removedId }]);

    const changes = store.readChangesSince(SID, baseline);
    assert.equal(changes.complete, true);
    assert.deepEqual(changes.upserts.map((entry) => entry.id), [keptId]);
    assert.deepEqual(changes.deletes, [{ section: "items", id: removedId }]);

    // Nothing has happened since the current revision.
    assert.deepEqual(store.readChangesSince(SID, changes.revision).upserts, []);
  } finally {
    store.close();
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

for (const version of [1, 3]) {
  test(`upgrades a schema v${version} database into one startup named Imported without touching any record`, () => {
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-schema-upgrade-"));
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    try {
      const original = fixtureState();
      const legacy = writeLegacyDatabase(databasePath, original, {
        version,
        revision: 7,
        history: version === 3 ? [{ section: "items", id: String(original.items[0].id), event: "created", at: "2026-01-01T00:00:00.000Z" }] : [],
      });
      let upgradeSeen = null;
      const store = new TrackerSqliteStore(databasePath, { onBeforeUpgrade: (info) => { upgradeSeen = info; } });
      try {
        assert.equal(upgradeSeen.fromVersion, version);
        assert.equal(store.getInfo().schemaVersion, 4);
        const ids = store.listStartupIds();
        assert.equal(ids.length, 1, "all old rows go into one startup");
        const [importedId] = ids;
        assert.match(importedId, /^imported-[a-z0-9]{4}$/);
        const startups = store.readSection(GLOBAL_STARTUP_ID, "startups");
        assert.deepEqual(startups.map((startup) => [startup.id, startup.name, startup.archived]), [[importedId, "Imported", false]]);

        // Byte-identical record JSON, in the same order, under the new id.
        const raw = new (require("node:sqlite").DatabaseSync)(databasePath, { readOnly: true });
        try {
          const rows = raw.prepare("SELECT section_name, record_id, value_json FROM state_records WHERE startup_id = ? ORDER BY section_name, ordinal").all(importedId);
          assert.deepEqual(rows.map((row) => ({ ...row })), legacy.records.map((row) => ({ ...row })));
          const sections = raw.prepare("SELECT section_name, kind, value_json FROM state_sections WHERE startup_id = ? ORDER BY ordinal").all(importedId);
          assert.deepEqual(sections.map((row) => ({ ...row })), legacy.sections.map((row) => ({ ...row })));
        } finally {
          raw.close();
        }
        const state = store.readState(importedId);
        assert.deepEqual(state.state, original);
        assert.equal(state.revision, 7, "the startup keeps the old revision");
        if (version === 3) {
          assert.equal(store.readRecordHistory(importedId, "items", String(original.items[0].id)).total, 1, "history moves with its records");
        }
        // Rows are stamped with the revision they were last known at, so an
        // edit based on the state just read applies cleanly.
        const map = store.readRevisionMap(importedId);
        const id = String(state.state.items[0].id);
        assert.equal(map.records.items[id], 7);
        const applied = store.applyOperations(importedId, [{ type: "upsert", section: "items", id, value: { id, platform: "After upgrade" }, baseRevision: 7 }]);
        assert.equal(applied.unchanged, false);
        assert.deepEqual(store.checkIntegrity().foreignKeyErrors, []);
      } finally {
        store.close();
      }
      // A second open does not upgrade again.
      const again = new TrackerSqliteStore(databasePath, { onBeforeUpgrade: () => { throw new Error("upgraded twice"); } });
      again.close();
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  });
}

test("a database from before startups cannot be opened read-only", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-legacy-ro-"));
  try {
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    writeLegacyDatabase(databasePath, fixtureState(), { version: 3 });
    assert.throws(() => new TrackerSqliteStore(databasePath, { readOnly: true }), (error) => error.code === "SQLITE_TRACKER_LEGACY_SCHEMA");
    const verification = verifyDatabaseFile(databasePath);
    assert.equal(verification.ok, false);
    assert.equal(verification.legacy, true);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("records a created entry and coalesces the edits that follow it", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [] });
    store.upsertRecord(SID, "items", { id: "a", status: "todo", notes: "one" }, { origin: "ui" });
    store.upsertRecord(SID, "items", { id: "a", status: "todo", notes: "one\ntwo" }, { origin: "ui" });
    store.upsertRecord(SID, "items", { id: "a", status: "done", notes: "one\ntwo" }, { origin: "ui" });

    const { entries, total, available } = store.readRecordHistory(SID, "items", "a");
    assert.equal(available, true);
    assert.equal(total, 1, "one session of edits is one entry");
    assert.equal(entries[0].event, "created");
    assert.equal(entries[0].origin, "ui");
    assert.equal(entries[0].approximate, false);
    // A creation reports what the record ended up holding, not a before-value it
    // never publicly had.
    assert.deepEqual(
      entries[0].fields.map((field) => [field.path, field.before, field.after]).sort(),
      [["notes", undefined, "one\ntwo"], ["status", undefined, "done"]],
    );
  } finally {
    store.close();
  }
});

test("ignores a save that only moves updatedAt", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", title: "A", updatedAt: "first" }] });
    const before = store.getInfo().historyEntryCount;
    const result = store.upsertRecord(SID, "items", { id: "a", title: "A", updatedAt: "second" });
    assert.equal(result.unchanged, false, "the record itself did change");
    assert.equal(store.getInfo().historyEntryCount, before, "but nothing worth reading changed");
  } finally {
    store.close();
  }
});

test("keeps the first before-value and the latest after-value across a session", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", status: "todo" }] });
    store.appendRecordHistory(SID, [
      {
        section: "items",
        id: "a",
        event: "updated",
        before: { id: "a", status: "todo" },
        after: { id: "a", status: "doing" },
        changedAt: "2026-06-01T10:00:00.000Z",
        origin: "backfill",
        approximate: true,
      },
      {
        section: "items",
        id: "a",
        event: "updated",
        before: { id: "a", status: "doing" },
        after: { id: "a", status: "done" },
        changedAt: "2026-06-01T10:05:00.000Z",
        origin: "backfill",
        approximate: true,
      },
    ]);

    const updates = store.readRecordHistory(SID, "items", "a").entries
      .filter((entry) => entry.event === "updated");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].fields, [{ path: "status", before: "todo", after: "done" }]);
    assert.equal(updates[0].approximate, true);
  } finally {
    store.close();
  }
});

test("starts a new entry once the session gap is exceeded", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", status: "todo" }] });
    store.appendRecordHistory(SID, [
      {
        section: "items",
        id: "a",
        event: "updated",
        before: { id: "a", status: "todo" },
        after: { id: "a", status: "doing" },
        changedAt: "2026-06-01T10:00:00.000Z",
        origin: "backfill",
      },
      {
        section: "items",
        id: "a",
        event: "updated",
        before: { id: "a", status: "doing" },
        after: { id: "a", status: "done" },
        changedAt: "2026-06-01T11:30:00.000Z",
        origin: "backfill",
      },
    ]);

    const updates = store.readRecordHistory(SID, "items", "a").entries
      .filter((entry) => entry.event === "updated");
    assert.equal(updates.length, 2, "90 minutes apart is two sessions");
    assert.equal(updates[0].changedAt, "2026-06-01T11:30:00.000Z", "newest first");
  } finally {
    store.close();
  }
});

test("drops an entry for an edit that was undone inside the session", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", status: "todo" }] });
    // The creation above is logged with origin "import"; a "ui" edit is a
    // different writer and so starts its own entry rather than extending it.
    store.upsertRecord(SID, "items", { id: "a", status: "doing" }, { origin: "ui" });
    assert.equal(store.readRecordHistory(SID, "items", "a").total, 2);
    store.upsertRecord(SID, "items", { id: "a", status: "todo" }, { origin: "ui" });
    assert.equal(store.readRecordHistory(SID, "items", "a").total, 1, "back where it started");
    assert.equal(store.readRecordHistory(SID, "items", "a").entries[0].event, "created");
  } finally {
    store.close();
  }
});

test("keeps a deleted record's timeline and its final state", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", title: "A", status: "todo" }] });
    store.upsertRecord(SID, "items", { id: "a", title: "A", status: "done" });
    store.deleteRecord(SID, "items", "a");

    const { entries } = store.readRecordHistory(SID, "items", "a");
    assert.equal(entries[0].event, "deleted");
    assert.deepEqual(entries[0].snapshot, { id: "a", title: "A", status: "done" });
    assert.ok(entries.length > 1, "the edits leading up to the delete survive it");
    // A new record reusing the ID must not extend the deleted record's session.
    store.upsertRecord(SID, "items", { id: "a", title: "Reused" });
    assert.equal(store.readRecordHistory(SID, "items", "a").entries[0].event, "created");
  } finally {
    store.close();
  }
});

test("reordering and moving records writes no history", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const before = store.getInfo().historyEntryCount;
    store.reorderRecords(SID, "items", ["c", "b", "a"]);
    assert.equal(store.getInfo().historyEntryCount, before, "order is not record content");
  } finally {
    store.close();
  }
});

test("records nested object keys individually and arrays whole", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, {
      items: [{ id: "a", details: { deadline: "2026-09-01", amount: 5 }, tags: ["one"] }],
    });
    store.upsertRecord(SID, "items", {
      id: "a",
      details: { deadline: "2026-10-01", amount: 5 },
      tags: ["one", "two"],
    });

    const fields = store.readRecordHistory(SID, "items", "a").entries[0].fields;
    const byPath = Object.fromEntries(fields.map((field) => [field.path, field]));
    assert.deepEqual(Object.keys(byPath).sort(), ["details.deadline", "tags"]);
    assert.equal(byPath["details.deadline"].before, "2026-09-01");
    assert.deepEqual(byPath.tags.before, ["one"]);
    assert.deepEqual(byPath.tags.after, ["one", "two"]);
  } finally {
    store.close();
  }
});

test("a section replacement logs per record, not per section", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
    store.replaceSection(SID, "items", [{ id: "a", title: "A" }, { id: "c", title: "C" }]);

    assert.equal(store.readRecordHistory(SID, "items", "a").total, 1, "untouched record keeps its creation only");
    assert.equal(store.readRecordHistory(SID, "items", "c").entries[0].event, "created");
    const dropped = store.readRecordHistory(SID, "items", "b").entries[0];
    assert.equal(dropped.event, "deleted");
    assert.deepEqual(dropped.snapshot, { id: "b", title: "B" });
  } finally {
    store.close();
  }
});

test("a restore explains itself instead of erasing the trail", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a", status: "todo" }] });
    store.upsertRecord(SID, "items", { id: "a", status: "done" });
    const beforeRestore = store.readRecordHistory(SID, "items", "a").total;

    store.replaceState(SID, { items: [{ id: "a", status: "todo" }] }, {
      origin: "restore",
      label: "Restored from snapshot",
    });

    const { entries } = store.readRecordHistory(SID, "items", "a");
    assert.ok(entries.length > beforeRestore, "the restore is logged on top of the history it undid");
    assert.equal(entries[0].origin, "restore");
    assert.equal(entries[0].label, "Restored from snapshot");
    assert.deepEqual(entries[0].fields, [{ path: "status", before: "done", after: "todo" }]);
  } finally {
    store.close();
  }
});

test("a section missing from a replacement is a schema change, not mass deletion", () => {
  const store = new TrackerSqliteStore(":memory:");
  try {
    store.replaceState(SID, { items: [{ id: "a" }], retired: [{ id: "r" }] });
    store.replaceState(SID, { items: [{ id: "a" }] });
    assert.equal(
      store.readRecordHistory(SID, "retired", "r").entries.some((entry) => entry.event === "deleted"),
      false,
    );
  } finally {
    store.close();
  }
});

test("history reads report unavailable on a database without the table", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-history-"));
  try {
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    let store = new TrackerSqliteStore(databasePath);
    store.replaceState(SID, { items: [{ id: "a" }] });
    store.close();

    const raw = new (require("node:sqlite").DatabaseSync)(databasePath);
    raw.exec("DROP TABLE record_history");
    raw.close();

    store = new TrackerSqliteStore(databasePath, { readOnly: true });
    try {
      assert.deepEqual(store.readRecordHistory(SID, "items", "a"), { entries: [], total: 0, available: false });
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("tool metadata survives a reopen and cannot collide with the store's own keys", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-toolmeta-"));
  try {
    const databasePath = path.join(temporaryDir, "tracker.sqlite");
    let store = new TrackerSqliteStore(databasePath);
    try {
      assert.equal(store.readToolMetadata("backfill.last_commit"), null);
      store.writeToolMetadata("backfill.last_commit", "abc123");
      assert.equal(store.readToolMetadata("backfill.last_commit"), "abc123");
      // Values come back as the strings they were stored as, so a resumable job
      // that keeps a count has to parse it rather than assume a number.
      store.writeToolMetadata("backfill.count", 42);
      assert.equal(store.readToolMetadata("backfill.count"), "42");

      // The namespace prefix is what keeps a tool from overwriting the sync token
      // by picking the same key name.
      const revisionBefore = store.readState(SID).revision;
      store.writeToolMetadata("revision", "0");
      assert.equal(store.readState(SID).revision, revisionBefore);
      assert.equal(store.readToolMetadata("revision"), "0");

      assert.throws(() => store.writeToolMetadata("", "x"), /non-empty strings/);
      assert.throws(() => store.writeToolMetadata("bad key", "x"), /characters outside/);
      assert.throws(() => store.readToolMetadata(null), /non-empty strings/);
    } finally {
      store.close();
    }

    store = new TrackerSqliteStore(databasePath, { readOnly: true });
    try {
      assert.equal(store.readToolMetadata("backfill.last_commit"), "abc123");
      assert.throws(() => store.writeToolMetadata("backfill.last_commit", "z"), /read-only/);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});
