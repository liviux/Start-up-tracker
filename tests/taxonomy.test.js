"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const taxonomy = require("../lib/taxonomy");
const { loadLibrary, validateLibraryFile } = require("../lib/taxonomy-schema");

const node = (id, level, parentId, extra = {}) => ({
  id, section: id.split(".")[0], level, parentId, name: id, description: `About ${id}.`, order: 1,
  ...(level === "category" ? { shortName: id.split(".").pop() } : {}), ...extra,
});

// A small library standing in for content/taxonomy, so a "later release" can
// be simulated by adding nodes to it.
function library(extra = []) {
  const mk = [
    node("mk.a", "category", null, { recommended: true }),
    node("mk.a.one", "subcategory", "mk.a"),
    node("mk.a.one.x", "type", "mk.a.one"),
    node("mk.b", "category", null),
    node("mk.b.two", "subcategory", "mk.b"),
  ];
  return {
    mk: { libraryVersion: extra.length ? 2 : 1, nodes: [...mk, ...extra] },
    po: { libraryVersion: 1, nodes: [node("po.a", "category", null)] },
    fu: { libraryVersion: 1, nodes: [node("fu.a", "category", null)] },
  };
}

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  taxonomy.seedTaxonomy(store, library());
  store.replaceState("one-0001", { items: [{ id: "t1", taxonomy: ["mk.a.one.x", "mk.b.two"] }, { id: "t2", taxonomy: ["mk.a"] }] });
  store.replaceState("two-0002", { items: [{ id: "t1", taxonomy: ["mk.a.one"] }], deletedItems: [{ id: "old", taxonomy: ["mk.a.one.x"] }] });
  return store;
}

test("the shipped library is valid and every node has a description", () => {
  const shipped = loadLibrary();
  for (const section of ["mk", "po", "fu"]) {
    assert.ok(shipped[section].nodes.length > 50, section);
    assert.ok(shipped[section].nodes.every((entry) => entry.description.length > 20), `${section} descriptions`);
    assert.ok(shipped[section].nodes.some((entry) => entry.level === "type"), `${section} has types`);
  }
});

test("the library is seeded into the global scope once", () => {
  const store = setup();
  assert.equal(taxonomy.readNodes(store).length, 7);
  assert.deepEqual(taxonomy.readLibraryState(store).versions, { mk: 1, po: 1, fu: 1 });
  assert.equal(taxonomy.seedTaxonomy(store, library()), false);
});

test("deleting a node with a move repoints targets in every startup, bins included", () => {
  const store = setup();
  assert.throws(() => taxonomy.deleteNode(store, "mk.a.one"), { code: "inUse" });
  assert.throws(() => taxonomy.deleteNode(store, "mk.a.one", "mk.a.one.x"), { code: "badMoveTo" }, "not inside the deleted branch");
  assert.throws(() => taxonomy.deleteNode(store, "mk.a.one", "po.a"), { code: "badMoveTo" }, "not in another section");
  const result = taxonomy.deleteNode(store, "mk.a.one", "mk.b.two");
  assert.deepEqual(result.deleted.sort(), ["mk.a.one", "mk.a.one.x"]);
  assert.deepEqual(store.readSection("one-0001", "items")[0].taxonomy, ["mk.b.two"], "duplicates collapse, order kept");
  assert.deepEqual(store.readSection("two-0002", "items")[0].taxonomy, ["mk.b.two"]);
  assert.deepEqual(store.readSection("two-0002", "deletedItems")[0].taxonomy, ["mk.b.two"]);
  assert.deepEqual(store.readSection("one-0001", "items")[1].taxonomy, ["mk.a"], "unrelated targets untouched");
  assert.equal(taxonomy.readNodes(store).some((entry) => entry.id.startsWith("mk.a.one")), false);
});

test("merging moves children and repoints every target", () => {
  const store = setup();
  assert.throws(() => taxonomy.mergeNode(store, "mk.a.one", "mk.b"), { code: "badMerge" });
  taxonomy.mergeNode(store, "mk.a.one", "mk.b.two");
  assert.equal(taxonomy.readNodes(store).find((entry) => entry.id === "mk.a.one.x").parentId, "mk.b.two");
  assert.deepEqual(store.readSection("two-0002", "items")[0].taxonomy, ["mk.b.two"]);
  assert.deepEqual(store.readSection("one-0001", "items")[0].taxonomy, ["mk.a.one.x", "mk.b.two"]);
});

test("custom nodes are added under the right level and built-ins can be reset", () => {
  const store = setup();
  const added = taxonomy.createNode(store, { parentId: "mk.b.two", name: "Local radio", description: "Interviews on local stations." });
  assert.equal(added.level, "type");
  assert.equal(added.custom, true);
  assert.throws(() => taxonomy.createNode(store, { parentId: added.id, name: "Too deep", description: "x" }), { code: "badParent" });
  assert.throws(() => taxonomy.createNode(store, { section: "mk", name: "No description" }), { code: "required" });
  taxonomy.updateNode(store, "mk.a", { name: "Renamed", description: "Changed." });
  taxonomy.resetNode(store, "mk.a", library());
  assert.equal(taxonomy.readNodes(store).find((entry) => entry.id === "mk.a").name, "mk.a");
  assert.throws(() => taxonomy.resetNode(store, added.id, library()), { code: "notBuiltIn" });
});

test("a library update adds only the nodes accepted, and skipped ones stay skipped", () => {
  const store = setup();
  const newer = library([node("mk.c", "category", null), node("mk.c.three", "subcategory", "mk.c"), node("mk.b.four", "subcategory", "mk.b")]);
  assert.deepEqual(taxonomy.libraryUpdates(store, newer).map((entry) => entry.id), ["mk.c", "mk.c.three", "mk.b.four"]);
  const result = taxonomy.acceptLibraryNodes(store, ["mk.c.three"], newer);
  assert.deepEqual(result.added.sort(), ["mk.c", "mk.c.three"], "a missing parent comes along");
  assert.equal(taxonomy.readNodes(store).some((entry) => entry.id === "mk.b.four"), false);
  assert.deepEqual(taxonomy.libraryUpdates(store, newer), [], "the rest is not offered again");
  assert.equal(taxonomy.readLibraryState(store).versions.mk, 2);
});

test("usage counts each target once per node, across startups", () => {
  const store = setup();
  const counts = taxonomy.usageCounts(store);
  assert.equal(counts["mk.a.one.x"], 1, "bins are not counted");
  assert.equal(counts["mk.a.one"], 1);
  assert.equal(counts["mk.b.two"], 1);
});

test("a shared library imports only the nodes this tracker lacks", () => {
  const store = setup();
  const shared = taxonomy.exportLibrary(store);
  shared.nodes.push(node("fu.a.new", "subcategory", "fu.a"));
  const result = taxonomy.importLibrary(store, shared);
  assert.deepEqual(result.added, ["fu.a.new"]);
  assert.equal(taxonomy.readNodes(store).find((entry) => entry.id === "fu.a.new").custom, true);
  assert.throws(() => taxonomy.importLibrary(store, { nodes: [] }), { code: "notLibrary" });
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, "taxonomy").length, 8);
});

test("library files with broken trees are refused", () => {
  assert.throws(() => validateLibraryFile({ section: "mk", libraryVersion: 1, nodes: [node("mk.a.one", "subcategory", "mk.missing")] }), { code: "badParent" });
  assert.throws(() => validateLibraryFile({ section: "mk", libraryVersion: 1, nodes: [node("mk.a", "category", null), node("mk.a", "category", null)] }), { code: "duplicateId" });
  assert.throws(() => validateLibraryFile({ section: "mk", libraryVersion: 1, nodes: [node("mk.a", "category", null, { description: "" })] }), { code: "required" });
});

test("each concept has one section: the approved duplicates are gone", () => {
  const shipped = loadLibrary();
  const ids = new Set(Object.values(shipped).flatMap((entry) => entry.nodes.map((node) => node.id)));
  for (const removed of ["mk.events", "mk.partners", "mk.pr.awards", "mk.communities.associations", "po.visibility.media"]) {
    assert.equal(ids.has(removed), false, `${removed} is removed`);
  }
  assert.ok(ids.has("po.visibility.awards"), "Programs owns awards");
  assert.ok(ids.has("po.partners.associations"), "Programs owns associations");
  assert.ok(ids.has("po.market.marketplaces"), "Programs owns marketplace programs");
  assert.ok(ids.has("mk.launches.marketplaces"), "Marketing owns store and registry listings");
  assert.ok(ids.has("mk.content.webinars"), "own webinars live in Marketing content");
  assert.ok(ids.has("mk.communities.own-community.host-meetup"), "own meetups live in Marketing communities");
  assert.equal(shipped.mk.nodes.find((node) => node.id === "mk.launches.marketplaces").name, "Store and registry listings");
  assert.equal(shipped.po.nodes.find((node) => node.id === "po.market.marketplaces").name, "Marketplace and app ecosystem programs");
});

test("shipped presets only name nodes that exist in the library", () => {
  const shipped = loadLibrary();
  const ids = new Set(Object.values(shipped).flatMap((entry) => entry.nodes.map((node) => node.id)));
  const presets = require("../content/prompts/presets.json").presets;
  for (const preset of presets) {
    for (const id of preset.scope?.taxonomy || []) assert.ok(ids.has(id), `${preset.id} names ${id}`);
  }
});
