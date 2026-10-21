const assert = require("node:assert/strict");
const test = require("node:test");

const { listChangedPaths, mergeRecords } = require("../public/scripts/record-conflict-merge");

test("automatically merges fields changed on only one side", () => {
  const base = { id: "a", notes: "Old", subcategory: "media", updatedAt: "one" };
  const local = { ...base, notes: "Mine", updatedAt: "two" };
  const server = { ...base, subcategory: "press", updatedAt: "three" };

  const result = mergeRecords(base, local, server);
  assert.equal(result.canAutoMerge, true);
  assert.deepEqual(result.merged, {
    id: "a",
    notes: "Mine",
    subcategory: "press",
    updatedAt: "two",
  });
  assert.deepEqual(result.localPaths, ["notes"]);
  assert.deepEqual(result.serverPaths, ["subcategory"]);
  assert.deepEqual(result.overlapPaths, []);
});

test("reports a divergent change to the same field", () => {
  const base = { id: "a", notes: "Old" };
  const result = mergeRecords(base, { ...base, notes: "Mine" }, { ...base, notes: "Theirs" });

  assert.equal(result.canAutoMerge, false);
  assert.deepEqual(result.overlapPaths, ["notes"]);
  assert.equal(result.conflicts[0].local, "Mine");
  assert.equal(result.conflicts[0].server, "Theirs");
});

test("accepts the same final value from both writers", () => {
  const base = { id: "a", status: "todo" };
  const result = mergeRecords(base, { ...base, status: "done" }, { ...base, status: "done" });

  assert.equal(result.canAutoMerge, true);
  assert.equal(result.merged.status, "done");
  assert.deepEqual(result.overlapPaths, []);
});

test("merges separate keys inside a nested object", () => {
  const base = { id: "a", extraParams: { cost: "$0", contact: "Sam" } };
  const local = { id: "a", extraParams: { cost: "$20", contact: "Sam" } };
  const server = { id: "a", extraParams: { cost: "$0", contact: "Alex" } };
  const result = mergeRecords(base, local, server);

  assert.equal(result.canAutoMerge, true);
  assert.deepEqual(result.merged.extraParams, { cost: "$20", contact: "Alex" });
  assert.deepEqual(result.localPaths, ["extraParams.cost"]);
  assert.deepEqual(result.serverPaths, ["extraParams.contact"]);
});

test("treats arrays as one field", () => {
  const base = { id: "a", tags: ["one"] };
  const result = mergeRecords(
    base,
    { ...base, tags: ["one", "mine"] },
    { ...base, tags: ["one", "theirs"] },
  );

  assert.equal(result.canAutoMerge, false);
  assert.deepEqual(result.overlapPaths, ["tags"]);
});

test("ignores id and updatedAt when listing user-visible changes", () => {
  assert.deepEqual(
    listChangedPaths(
      { id: "a", notes: "Old", updatedAt: "one" },
      { id: "a", notes: "New", updatedAt: "two" },
    ),
    ["notes"],
  );
});

test("record deletion and modification cannot be merged", () => {
  const base = { id: "a", notes: "Old" };
  const result = mergeRecords(base, undefined, { ...base, notes: "Changed" });

  assert.equal(result.canAutoMerge, false);
  assert.deepEqual(result.overlapPaths, ["(record)"]);
  assert.equal(result.conflicts[0].localMissing, true);
});

test("merges a nested key deletion with a sibling edit", () => {
  const base = { id: "a", extraParams: { cost: "$0", contact: "Sam" } };
  const local = { id: "a", extraParams: { contact: "Sam" } };
  const server = { id: "a", extraParams: { cost: "$0", contact: "Alex" } };
  const result = mergeRecords(base, local, server);

  assert.equal(result.canAutoMerge, true);
  assert.deepEqual(result.merged, { id: "a", extraParams: { contact: "Alex" } });
});

test("blocks deletion and editing of the same nested key", () => {
  const base = { id: "a", extraParams: { contact: "Sam" } };
  const local = { id: "a", extraParams: {} };
  const server = { id: "a", extraParams: { contact: "Alex" } };
  const result = mergeRecords(base, local, server);

  assert.equal(result.canAutoMerge, false);
  assert.deepEqual(result.overlapPaths, ["extraParams.contact"]);
});
