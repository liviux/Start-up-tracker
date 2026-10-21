"use strict";

// The category library as the page sees it (public/js/taxonomy-model.js).
const assert = require("node:assert/strict");
const test = require("node:test");
const Taxonomy = require("../public/js/taxonomy-model.js");

const node = (id, level, parentId, extra = {}) => ({
  id, section: id.split(".")[0], level, parentId, name: `Name ${id}`, description: `About ${id}.`, order: 1,
  ...(level === "category" ? { shortName: `Short ${id}` } : {}), ...extra,
});

function load(enabled = null) {
  Taxonomy.setNodes([
    node("mk.a", "category", null),
    node("mk.a.one", "subcategory", "mk.a"),
    node("mk.a.one.x", "type", "mk.a.one"),
    node("mk.a.two", "subcategory", "mk.a", { order: 2 }),
    node("mk.b", "category", null, { order: 2 }),
    node("mk.b.three", "subcategory", "mk.b"),
    node("po.a", "category", null),
  ]);
  Taxonomy.setEnabled(enabled);
}

test("picking a type also records its subcategory and category, primary first", () => {
  load();
  assert.deepEqual(Taxonomy.normalizeSelection(["mk.a.one.x", "mk.b.three"]), ["mk.a.one.x", "mk.a.one", "mk.a", "mk.b.three", "mk.b"]);
  assert.deepEqual(Taxonomy.leaves(Taxonomy.normalizeSelection(["mk.a.one.x", "mk.b.three"])), ["mk.a.one.x", "mk.b.three"]);
  assert.deepEqual(Taxonomy.legacyFields(Taxonomy.normalizeSelection(["mk.a.one.x", "mk.b.three"])), {
    category: "mk.a",
    subcategory: "mk.a.one",
    subcategories: ["mk.a.one", "mk.b.three"],
    type: "mk.a.one.x",
  });
});

test("a target in two branches shows under both and counts once in the total", () => {
  load();
  const records = [
    { id: "t1", taxonomy: Taxonomy.normalizeSelection(["mk.a.one", "mk.b.three"]) },
    { id: "t2", taxonomy: Taxonomy.normalizeSelection(["mk.a.two"]) },
  ];
  const count = (branch) => records.filter((record) => Taxonomy.inBranch(record.taxonomy, branch)).length;
  assert.equal(count("mk.a"), 2);
  assert.equal(count("mk.b"), 1);
  assert.equal(count("mk.a.one"), 1);
  assert.equal(count("all"), records.length, "the total counts each target once");
  assert.ok(count("mk.a") + count("mk.b") > records.length, "per-category counts can add up to more");
});

test("turning a node off hides it from this startup's pickers, and on brings it back", () => {
  load();
  assert.deepEqual(Taxonomy.categories("mk", { onlyEnabled: true }).map((entry) => entry.id), ["mk.a", "mk.b"]);
  const off = Taxonomy.toggle("mk.a", false);
  assert.ok(!off.enabled.includes("mk.a.one.x"), "everything under it goes off too");
  assert.deepEqual(Taxonomy.categories("mk", { onlyEnabled: true }).map((entry) => entry.id), ["mk.b"]);
  assert.equal(Taxonomy.isEnabled("mk.a.one"), false);
  assert.deepEqual(Taxonomy.search("mk", "Name"), Taxonomy.search("mk", "Name").filter((entry) => !entry.id.startsWith("mk.a")));

  // Another startup with no choice of its own still sees everything.
  Taxonomy.setEnabled(null);
  assert.equal(Taxonomy.isEnabled("mk.a.one"), true);

  Taxonomy.setEnabled(off);
  const on = Taxonomy.toggle("mk.a.one.x", true);
  assert.ok(["mk.a", "mk.a.one", "mk.a.one.x"].every((id) => on.enabled.includes(id)), "turning a type on turns its parents on");
  assert.equal(Taxonomy.isEnabled("mk.a.one.x"), true);
});

test("a target keeps a node that is off or unknown", () => {
  load({ enabled: ["mk.b", "mk.b.three"] });
  const list = Taxonomy.normalizeSelection(["mk.a.one", "old-category"]);
  assert.deepEqual(list, ["mk.a.one", "mk.a", "old-category"]);
  assert.deepEqual(Taxonomy.disabledIn(list), ["mk.a.one", "mk.a"]);
  assert.deepEqual(Taxonomy.unknownIn(list), ["old-category"]);
  assert.equal(Taxonomy.nestedCategory("old-category", "mk").name, "old-category", "shown under its own id, never as another category");
  assert.deepEqual(Taxonomy.listFor({ category: "launches", subcategories: ["product-launch"] }), ["product-launch", "launches"]);
  assert.deepEqual(Taxonomy.legacyFields(["launches"], { category: "launches", subcategories: ["product-launch"] }).subcategories, ["product-launch"]);
});

test("names, paths and the nested shape", () => {
  load();
  assert.equal(Taxonomy.pathLabel("mk.a.one.x"), "Name mk.a > Name mk.a.one > Name mk.a.one.x");
  assert.equal(Taxonomy.shortName("mk.a"), "Short mk.a");
  const nested = Taxonomy.nestedCategories("mk");
  assert.deepEqual(nested.map((category) => category.id), ["mk.a", "mk.b"]);
  assert.deepEqual(nested[0].subcategories.map((sub) => sub.id), ["mk.a.one", "mk.a.two"]);
  assert.deepEqual(nested[0].subcategories[0].types.map((type) => type.id), ["mk.a.one.x"]);
  assert.deepEqual(Taxonomy.search("mk", "one x").map((entry) => entry.id), ["mk.a.one.x"]);
});
