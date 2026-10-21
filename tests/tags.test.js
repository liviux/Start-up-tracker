"use strict";

// Shared tags (lib/tags.js): usage across startups, and rename, merge and
// delete rewriting the records of every startup.
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { createStartup } = require("../lib/startups");
const tags = require("../lib/tags");

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  const one = createStartup(store, { name: "One" }, { origin: "tool" }).id;
  const two = createStartup(store, { name: "Two" }, { origin: "tool" }).id;
  store.replaceState(one, {
    items: [{ id: "t1", tags: ["launch", "paid"] }, { id: "t2", tags: ["Launch"] }, { id: "t3", tags: [] }],
    mediaItems: [{ id: "m1", tags: ["launch"] }],
    deletedFeedbackItems: [{ id: "f1", tags: ["launch"], deletedAt: "2026-10-01T00:00:00Z" }],
  }, { origin: "tool" });
  store.replaceState(two, { programs: [{ id: "p1", tags: ["launch", "free"] }], funding: [{ id: "u1", tags: ["paid"] }] }, { origin: "tool" });
  // Sections one by one: replacing the whole global state would drop the
  // startup list.
  store.replaceSection(GLOBAL_STARTUP_ID, "tags", [
    { id: "launch", label: "launch", description: "" },
    { id: "go-live", label: "go-live", description: "First public day.", color: "#3366cc" },
    { id: "paid", label: "paid", description: "Costs money." },
  ], { origin: "tool" });
  store.replaceSection(GLOBAL_STARTUP_ID, "campaigns", [{ id: "c1", name: "Spring", tags: ["launch"] }], { origin: "tool" });
  return { store, one, two };
}

const tagsOf = (store, scope, section, id) => store.readSection(scope, section).find((record) => record.id === id).tags;

test("usage counts every startup and the shared campaigns, with the bin apart", () => {
  const { store, one, two } = setup();
  const usage = tags.tagUsage(store).launch;
  assert.equal(usage.total, 5, "t1, t2, m1, p1 and the campaign");
  assert.equal(usage.inBin, 1);
  assert.equal(usage.startups[one].count, 3);
  assert.equal(usage.startups[one].name, "One");
  assert.equal(usage.startups[two].count, 1);
  assert.equal(usage.startups[GLOBAL_STARTUP_ID].count, 1);
  assert.deepEqual(usage.startups[one].sections, { items: 2, mediaItems: 1, deletedFeedbackItems: 1 });
});

test("renaming repoints records in every startup, the campaigns and the definition", () => {
  const { store, one, two } = setup();
  const result = tags.renameTag(store, "launch", "release", { origin: "ui" });
  assert.equal(result.tag, "release");
  assert.equal(result.recordsChanged, 6);
  assert.deepEqual(result.startupsChanged.sort(), [one, two].sort());
  assert.deepEqual(tagsOf(store, one, "items", "t1"), ["release", "paid"]);
  assert.deepEqual(tagsOf(store, one, "items", "t2"), ["release"]);
  assert.deepEqual(tagsOf(store, one, "items", "t3"), [], "untouched");
  assert.deepEqual(tagsOf(store, one, "deletedFeedbackItems", "f1"), ["release"], "records in the bin follow too");
  assert.deepEqual(tagsOf(store, two, "programs", "p1"), ["release", "free"]);
  assert.deepEqual(tagsOf(store, GLOBAL_STARTUP_ID, "campaigns", "c1"), ["release"]);
  const definitions = store.readSection(GLOBAL_STARTUP_ID, "tags").map((definition) => definition.id);
  assert.ok(definitions.includes("release") && !definitions.includes("launch"));
  const history = store.readRecordHistory(one, "items", "t1");
  assert.equal(history.entries[0].origin, "ui");
});

test("merging keeps one tag per record and the first description and colour found", () => {
  const { store, one } = setup();
  store.upsertRecord(one, "items", { id: "both", tags: ["launch", "go-live"] }, { origin: "tool" });
  tags.mergeTags(store, ["go-live"], "launch");
  assert.deepEqual(tagsOf(store, one, "items", "both"), ["launch"]);
  const kept = store.readSection(GLOBAL_STARTUP_ID, "tags").find((definition) => definition.id === "launch");
  assert.equal(kept.description, "First public day.");
  assert.equal(kept.color, "#3366cc");
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, "tags").some((definition) => definition.id === "go-live"), false);
  // Renaming onto an existing tag is the same merge.
  tags.renameTag(store, "paid", "launch");
  assert.deepEqual(tagsOf(store, one, "items", "t1"), ["launch"]);
  assert.throws(() => tags.mergeTags(store, ["launch"], "launch"), /at least one other tag/);
});

test("deleting takes the tag off every record and moves its definition to the bin", () => {
  const { store, one, two } = setup();
  const result = tags.deleteTag(store, "paid");
  assert.equal(result.recordsChanged, 2);
  assert.deepEqual(tagsOf(store, one, "items", "t1"), ["launch"]);
  assert.deepEqual(tagsOf(store, two, "funding", "u1"), []);
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, "tags").some((definition) => definition.id === "paid"), false);
  const binned = store.readSection(GLOBAL_STARTUP_ID, "deletedTags").find((definition) => definition.id === "paid");
  assert.equal(binned.description, "Costs money.");
  assert.ok(binned.deletedAt);
});

test("tags and colours are checked", () => {
  const { store } = setup();
  assert.throws(() => tags.renameTag(store, "", "x"), tags.TagError);
  assert.throws(() => tags.renameTag(store, "launch", "x".repeat(61)), /1 to 60/);
  assert.throws(() => tags.cleanDefinition({ id: "a", color: "red" }), /hex colour/);
  assert.deepEqual(tags.cleanDefinition({ id: " A ", color: "#AABBCC" }), { id: "a", label: "a", description: "", color: "#aabbcc" });
});
