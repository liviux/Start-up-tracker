"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const timeline = require("../public/scripts/record-history-timeline.js");

function change(entryId, changedAt, fields, extra = {}) {
  return {
    entryId,
    section: "items",
    event: "updated",
    changedAt,
    origin: "ui",
    fields,
    ...extra,
  };
}

test("a dotted path resolves into nested objects and creates what is missing", () => {
  const record = { details: { budget: { total: 10 } } };
  const found = timeline.resolvePath(record, "details.budget.total", false);
  assert.equal(found.container.total, 10);

  const created = timeline.resolvePath(record, "details.contact.email", true);
  created.container[created.key] = "a@b.c";
  assert.equal(record.details.contact.email, "a@b.c");

  assert.equal(timeline.resolvePath(record, "details.missing.deep", false), null);
  assert.equal(timeline.resolvePath(null, "anything", true), null);
});

test("a literal key containing dots wins over a nested lookup", () => {
  // details keys can be labels someone typed. "Reach (est.)" splits into
  // segments that would otherwise be walked as if it were nested.
  const record = { details: { "Reach (est.) 2026": 500 } };
  const found = timeline.resolvePath(record, "details.Reach (est.) 2026", false);
  assert.equal(found.key, "Reach (est.) 2026");
  assert.equal(found.container[found.key], 500);

  // A genuinely nested path with the same prefix still resolves nested.
  const nested = { a: { "b.c": { d: 1 } } };
  const resolved = timeline.resolvePath(nested, "a.b.c.d", false);
  assert.equal(resolved.container[resolved.key], 1);
});

test("a path splits by the keys the data actually nests by", () => {
  // splitPath is what the timeline labels a field with, so getting it wrong
  // shows the user "Extra Params › Reach (est › ) 2026" instead of the key
  // they typed.
  const record = { extraParams: { "Reach (est.) 2026": 500 }, status: "done" };
  assert.deepEqual(
    timeline.splitPath(record, "extraParams.Reach (est.) 2026"),
    ["extraParams", "Reach (est.) 2026"],
  );
  assert.deepEqual(timeline.splitPath(record, "status"), ["status"]);
  assert.deepEqual(timeline.splitPath({ a: { b: { c: 1 } } }, "a.b.c"), ["a", "b", "c"]);

  // A key that is itself dotted at the top level stays whole.
  assert.deepEqual(timeline.splitPath({ "a.b": 1 }, "a.b"), ["a.b"]);

  // Nothing to split by: a path the record does not have, a non-object root.
  assert.equal(timeline.splitPath(record, "extraParams.Gone"), null);
  assert.equal(timeline.splitPath(record, "missing"), null);
  assert.equal(timeline.splitPath("not an object", "a.b"), null);
  assert.equal(timeline.splitPath(null, "a"), null);

  // A scalar partway along the path is not something to walk into.
  assert.equal(timeline.splitPath({ a: "text" }, "a.b"), null);
});

test("rolling a change back restores the value it held before", () => {
  const after = { id: "x", status: "done", notes: "new text", owner: "Ana" };
  const entry = change(4, "2026-08-11T09:00:00.000Z", [
    { path: "status", before: "todo", after: "done" },
    { path: "notes", before: "old text", after: "new text" },
    // No `before` at all: the field did not exist before this change.
    { path: "owner", after: "Ana" },
  ]);

  const before = timeline.applyBeforeValues(after, entry);
  assert.equal(before.status, "todo");
  assert.equal(before.notes, "old text");
  assert.equal("owner" in before, false, "a field with no before value did not exist yet");
  // The input is not mutated, or the caller's live record would be rewritten.
  assert.equal(after.status, "done");
});

test("a clamped value is never written back as if it were the whole value", () => {
  const after = { notes: "a very long note" };
  const entry = change(5, "2026-08-11T09:00:00.000Z", [
    { path: "notes", before: { truncated: true, length: 90_000, text: "a very long" }, after: "a very long note" },
  ]);
  const before = timeline.applyBeforeValues(after, entry);
  assert.equal(before.notes, "a very long note", "the clamped value is skipped rather than restored partially");
});

test("versions are rebuilt walking the timeline backwards from the live record", () => {
  const record = { id: "x", status: "done", title: "Third" };
  const entries = [
    change(3, "2026-08-11T12:00:00.000Z", [{ path: "status", before: "doing", after: "done" }]),
    change(2, "2026-08-10T12:00:00.000Z", [{ path: "title", before: "Second", after: "Third" }]),
    {
      entryId: 1,
      section: "items",
      event: "created",
      changedAt: "2026-08-09T12:00:00.000Z",
      origin: "ui",
      fields: [],
    },
  ];

  const items = timeline.buildTimeline(entries, { record });
  assert.equal(items.length, 3);

  assert.deepEqual(items[0].stateAfter, { id: "x", status: "done", title: "Third" });
  assert.deepEqual(items[0].stateBefore, { id: "x", status: "doing", title: "Third" });
  assert.deepEqual(items[1].stateAfter, { id: "x", status: "doing", title: "Third" });
  assert.deepEqual(items[1].stateBefore, { id: "x", status: "doing", title: "Second" });
  // Before the record was created there was no record.
  assert.deepEqual(items[2].stateAfter, { id: "x", status: "doing", title: "Second" });
  assert.equal(items[2].stateBefore, null);
});

test("a delete and a create at the same instant are one move, not two events", () => {
  // Deleting moves the record between sections, so the store writes both halves
  // in one transaction sharing one timestamp.
  const entries = [
    {
      entryId: 9,
      section: "deletedItems",
      event: "created",
      changedAt: "2026-08-12T10:00:00.000Z",
      origin: "ui",
      fields: [],
    },
    {
      entryId: 8,
      section: "items",
      event: "deleted",
      changedAt: "2026-08-12T10:00:00.000Z",
      origin: "ui",
      fields: [],
      snapshot: { id: "x", status: "done" },
    },
    change(7, "2026-08-11T10:00:00.000Z", [{ path: "status", before: "doing", after: "done" }]),
  ];

  const items = timeline.buildTimeline(entries, { record: { id: "x", status: "done" } });
  assert.equal(items.length, 2, "the pair collapses into a single entry");
  assert.equal(items[0].kind, "move");
  assert.equal(items[0].toBin, true);
  // A move changes no values, so the version on both sides of it is the same.
  assert.deepEqual(items[0].stateBefore, items[0].stateAfter);
  assert.equal(items[1].kind, "change");
});

test("coming back out of the recycle bin reads as a restore", () => {
  const entries = [
    {
      entryId: 11,
      section: "items",
      event: "created",
      changedAt: "2026-08-13T10:00:00.000Z",
      origin: "ui",
      fields: [],
    },
    {
      entryId: 10,
      section: "deletedItems",
      event: "deleted",
      changedAt: "2026-08-13T10:00:00.000Z",
      origin: "ui",
      fields: [],
    },
  ];
  const items = timeline.buildTimeline(entries, { record: { id: "x" } });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "move");
  assert.equal(items[0].toBin, false, "the record landed in the live section");
});

test("a delete with no matching create ends the record and keeps its last values", () => {
  const entries = [
    {
      entryId: 20,
      section: "items",
      event: "deleted",
      changedAt: "2026-08-14T10:00:00.000Z",
      origin: "tool",
      fields: [],
      snapshot: { id: "gone", title: "Last known title" },
    },
  ];
  const items = timeline.buildTimeline(entries, { record: null });
  assert.equal(items[0].stateAfter, null, "nothing exists after a real delete");
  assert.deepEqual(items[0].stateBefore, { id: "gone", title: "Last known title" });
});

test("hand-written activity entries interleave by date", () => {
  const entries = [change(2, "2026-08-12T10:00:00.000Z", [{ path: "status", before: "a", after: "b" }])];
  const activities = [
    { at: "2026-08-13T10:00:00.000Z", activity: { id: "act-late", type: "call" } },
    { at: "2026-08-11T10:00:00.000Z", activity: { id: "act-early", type: "email" } },
  ];
  const items = timeline.buildTimeline(entries, { record: { id: "x", status: "b" }, activities });
  assert.deepEqual(items.map((item) => item.kind), ["activity", "change", "activity"]);
  assert.deepEqual(items.map((item) => item.key), ["aact-late", "e2", "aact-early"]);
});

test("comparing two versions reports the fields that differ and ignores updatedAt", () => {
  const older = { id: "x", status: "todo", updatedAt: "2026-08-01T00:00:00.000Z", tags: ["a"] };
  const newer = { id: "x", status: "done", updatedAt: "2026-08-20T00:00:00.000Z", tags: ["a", "b"] };
  const fields = timeline.describeChanges(older, newer);
  assert.deepEqual(fields.map((field) => field.path), ["status", "tags"]);
  assert.deepEqual(fields[1].after, ["a", "b"], "arrays compare whole rather than per index");

  // Key order is not a change.
  assert.deepEqual(timeline.describeChanges({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
  // Nested objects recurse, so the path names the leaf that moved.
  const nested = timeline.describeChanges({ d: { x: 1, y: 2 } }, { d: { x: 9, y: 2 } });
  assert.deepEqual(nested.map((field) => field.path), ["d.x"]);
});

test("an empty timeline and a missing record do not throw", () => {
  assert.deepEqual(timeline.buildTimeline([], { record: null }), []);
  assert.deepEqual(timeline.buildTimeline(undefined, {}), []);
  assert.deepEqual(timeline.buildTimeline(null), []);
});
