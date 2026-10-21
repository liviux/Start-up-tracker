"use strict";

// The category library shared by every startup: categories, subcategories
// and types for MK, PO and FU, kept as the global collection "taxonomy".
// content/taxonomy/*.json is the built-in library it starts from; nodes the
// person adds are global too and carry custom: true.
//
// Targets keep the nodes they belong to in `taxonomy: [nodeId, ...]`, the
// first being the primary. Deleting or merging a node repoints those lists in
// every startup, so no target is left pointing at a node that is gone.
//
// Which nodes are turned on is a per-startup choice, kept in that startup's
// "enabledTaxonomy" section; this module does not touch it.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { SECTIONS, PARENT_LEVEL, TaxonomyError, cleanNode, validateNodes, loadLibrary } = require("./taxonomy-schema");

const TAXONOMY_SECTION = "taxonomy";
// The library versions this tracker has taken, and the library nodes the
// person chose not to add, per section.
const LIBRARY_STATE_SECTION = "taxonomyLibrary";
const TARGET_SECTIONS = {
  mk: ["items", "deletedItems"],
  po: ["programs", "deletedPrograms"],
  fu: ["funding", "deletedFunding"],
};

function readNodes(store) {
  const nodes = store.readSection(GLOBAL_STARTUP_ID, TAXONOMY_SECTION);
  return Array.isArray(nodes) ? nodes : [];
}

function readLibraryState(store) {
  const value = store.readSection(GLOBAL_STARTUP_ID, LIBRARY_STATE_SECTION);
  const state = value && typeof value === "object" ? value : {};
  return {
    versions: { ...(state.versions || {}) },
    dismissed: { ...(state.dismissed || {}) },
  };
}

function writeAll(store, nodes, libraryState, options) {
  const operations = [{ type: "replaceSection", section: TAXONOMY_SECTION, value: validateNodes(nodes) }];
  if (libraryState) operations.push({ type: "replaceSection", section: LIBRARY_STATE_SECTION, value: libraryState });
  return store.applyOperations(GLOBAL_STARTUP_ID, operations, { origin: "api", ...options });
}

// The shipped library goes into the global scope the first time the tracker
// starts. Later starts leave the stored library alone: what the person edited
// stays as they left it.
function seedTaxonomy(store, library = loadLibrary()) {
  if (store.readSection(GLOBAL_STARTUP_ID, TAXONOMY_SECTION) !== undefined) return false;
  const nodes = SECTIONS.flatMap((section) => library[section].nodes);
  const versions = Object.fromEntries(SECTIONS.map((section) => [section, library[section].libraryVersion]));
  writeAll(store, nodes, { versions, dismissed: {} }, { origin: "tool", label: "Built-in category library" });
  return true;
}

// Library nodes this tracker does not have and was not told to skip: what a
// newer release added. Nothing is added until acceptLibraryNodes.
function libraryUpdates(store, library = loadLibrary()) {
  const have = new Set(readNodes(store).map((node) => node.id));
  const { dismissed } = readLibraryState(store);
  const updates = [];
  for (const section of SECTIONS) {
    const skipped = new Set(dismissed[section] || []);
    for (const node of library[section].nodes) {
      if (!have.has(node.id) && !skipped.has(node.id)) updates.push(node);
    }
  }
  return updates;
}

// Adds the accepted library nodes, with any of their parents that are
// missing, and records the rest of this release's new nodes as skipped.
function acceptLibraryNodes(store, acceptedIds, library = loadLibrary(), options = {}) {
  const pending = libraryUpdates(store, library);
  const pendingById = new Map(pending.map((node) => [node.id, node]));
  const accepted = new Set();
  const libraryById = new Map(SECTIONS.flatMap((section) => library[section].nodes).map((node) => [node.id, node]));
  const have = new Set(readNodes(store).map((node) => node.id));
  for (const id of acceptedIds || []) {
    if (!pendingById.has(id)) throw new TaxonomyError(`${id} is not a new library node.`, "notAnUpdate");
    let current = pendingById.get(id);
    while (current && !have.has(current.id) && !accepted.has(current.id)) {
      accepted.add(current.id);
      current = current.parentId ? libraryById.get(current.parentId) : null;
    }
  }
  const nodes = [...readNodes(store), ...[...accepted].map((id) => libraryById.get(id))];
  const libraryState = readLibraryState(store);
  for (const section of SECTIONS) {
    const skippedNow = pending.filter((node) => node.section === section && !accepted.has(node.id)).map((node) => node.id);
    libraryState.dismissed[section] = [...new Set([...(libraryState.dismissed[section] || []), ...skippedNow])];
    libraryState.versions[section] = library[section].libraryVersion;
  }
  writeAll(store, nodes, libraryState, { label: `Added ${accepted.size} categories from the library`, ...options });
  return { added: [...accepted] };
}

function findNode(nodes, id) {
  const node = nodes.find((entry) => entry.id === id);
  if (!node) throw new TaxonomyError("Unknown category.", "unknownNode", 404);
  return node;
}

function descendantsOf(nodes, id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

function slug(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
}

function createNode(store, input, options = {}) {
  const nodes = readNodes(store);
  const parent = input.parentId ? findNode(nodes, input.parentId) : null;
  const section = parent ? parent.section : input.section;
  if (!SECTIONS.includes(section)) throw new TaxonomyError(`The section must be one of ${SECTIONS.join(", ")}.`, "badSection");
  const level = parent ? (parent.level === "category" ? "subcategory" : parent.level === "subcategory" ? "type" : null) : "category";
  if (!level) throw new TaxonomyError("A type cannot have children.", "badParent");
  const base = `${parent ? parent.id : section}.${slug(input.name)}`;
  let id = base;
  for (let suffix = 2; nodes.some((node) => node.id === id); suffix += 1) id = `${base}-${suffix}`;
  const siblings = nodes.filter((node) => node.section === section && node.parentId === (parent ? parent.id : null));
  const node = cleanNode({
    id,
    section,
    level,
    parentId: parent ? parent.id : null,
    name: input.name,
    shortName: input.shortName,
    description: input.description,
    order: siblings.reduce((max, sibling) => Math.max(max, sibling.order || 0), 0) + 1,
    custom: true,
  }, section);
  writeAll(store, [...nodes, node], null, { label: `Added category ${node.name}`, ...options });
  return node;
}

// Name, short name, description and order can change. Moving a node under
// another parent of the right level, in the same section, is allowed too.
function updateNode(store, id, patch = {}, options = {}) {
  const nodes = readNodes(store);
  const current = findNode(nodes, id);
  const next = { ...current };
  for (const field of ["name", "shortName", "description", "order"]) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
    const parent = patch.parentId ? findNode(nodes, patch.parentId) : null;
    if ((parent ? parent.level : null) !== PARENT_LEVEL[current.level] || (parent && parent.section !== current.section)) {
      throw new TaxonomyError(`A ${current.level} needs a ${PARENT_LEVEL[current.level] || "top level"} parent in the same section.`, "badParent");
    }
    next.parentId = parent ? parent.id : null;
  }
  const cleaned = cleanNode(next, current.section);
  writeAll(store, nodes.map((node) => (node.id === id ? cleaned : node)), null, { label: `Changed category ${cleaned.name}`, ...options });
  return cleaned;
}

// New order for the children of one parent: `ids` lists them all, in the
// order wanted.
function reorderNodes(store, ids, options = {}) {
  const nodes = readNodes(store);
  if (!Array.isArray(ids) || !ids.length) throw new TaxonomyError("List the categories in their new order.", "badOrder");
  const listed = ids.map((id) => findNode(nodes, id));
  const parentId = listed[0].parentId;
  const section = listed[0].section;
  const siblings = nodes.filter((node) => node.section === section && node.parentId === parentId);
  if (listed.some((node) => node.parentId !== parentId || node.section !== section) || new Set(ids).size !== siblings.length || listed.length !== siblings.length) {
    throw new TaxonomyError("List every category under the same parent, once each.", "badOrder");
  }
  const order = new Map(ids.map((id, index) => [id, index + 1]));
  writeAll(store, nodes.map((node) => (order.has(node.id) ? { ...node, order: order.get(node.id) } : node)), null, { label: "Reordered categories", ...options });
  return ids;
}

// Puts a built-in node's name, short name and description back to the
// library text.
function resetNode(store, id, library = loadLibrary(), options = {}) {
  const nodes = readNodes(store);
  const current = findNode(nodes, id);
  const original = library[current.section]?.nodes.find((node) => node.id === id);
  if (!original) throw new TaxonomyError("Only built-in categories can be reset.", "notBuiltIn");
  const reset = { ...current, name: original.name, description: original.description };
  if (original.shortName) reset.shortName = original.shortName;
  writeAll(store, nodes.map((node) => (node.id === id ? cleanNode(reset, current.section) : node)), null, { label: `Reset category ${original.name}`, ...options });
  return reset;
}

// Rewrites every target's taxonomy list in one section through `map` (old id
// to new id, or null to drop it), in every startup. Order is kept, duplicates
// that the rewrite creates are dropped, and a target whose list would end up
// empty keeps nothing rather than a dangling id.
function repointTargets(store, section, map, options) {
  let changed = 0;
  for (const startupId of store.listStartupIds()) {
    const operations = [];
    for (const name of TARGET_SECTIONS[section]) {
      const records = store.readSection(startupId, name);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!Array.isArray(record?.taxonomy) || !record.taxonomy.some((id) => map.has(id))) continue;
        const next = [];
        for (const id of record.taxonomy) {
          const mapped = map.has(id) ? map.get(id) : id;
          if (mapped && !next.includes(mapped)) next.push(mapped);
        }
        operations.push({ type: "upsert", section: name, id: record.id, value: { ...record, taxonomy: next } });
      }
    }
    if (operations.length) {
      store.applyOperations(startupId, operations, options);
      changed += operations.length;
    }
  }
  return changed;
}

// How many targets, across every startup, use each node.
function usageCounts(store) {
  const counts = {};
  for (const startupId of store.listStartupIds()) {
    for (const names of Object.values(TARGET_SECTIONS)) {
      const records = store.readSection(startupId, names[0]);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        for (const id of new Set(Array.isArray(record?.taxonomy) ? record.taxonomy : [])) counts[id] = (counts[id] || 0) + 1;
      }
    }
  }
  return counts;
}

// Deletes a node and everything under it. Targets that used any of them move
// to `moveTo` (a node of the same section outside the deleted branch); with
// no moveTo the deleted ids are simply dropped from their lists, which is
// only allowed when no target uses them.
function deleteNode(store, id, moveTo = "", options = {}) {
  const nodes = readNodes(store);
  const node = findNode(nodes, id);
  const removed = descendantsOf(nodes, id);
  const counts = usageCounts(store);
  const used = [...removed].reduce((sum, removedId) => sum + (counts[removedId] || 0), 0);
  if (moveTo) {
    const target = findNode(nodes, moveTo);
    if (target.section !== node.section || removed.has(target.id)) throw new TaxonomyError("Move the targets to a category of the same section, outside the one you delete.", "badMoveTo");
  } else if (used > 0) {
    throw new TaxonomyError(`${used} targets use this category. Choose where they move first.`, "inUse", 409);
  }
  const label = `Deleted category ${node.name}`;
  const moved = repointTargets(store, node.section, new Map([...removed].map((removedId) => [removedId, moveTo || null])), { origin: "api", label, ...options });
  writeAll(store, nodes.filter((entry) => !removed.has(entry.id)), null, { label, ...options });
  return { deleted: [...removed], moved };
}

// Merges `id` into `into` (same section and level): its children move under
// `into`, and every target that used it uses `into` instead.
function mergeNode(store, id, into, options = {}) {
  const nodes = readNodes(store);
  const source = findNode(nodes, id);
  const target = findNode(nodes, into);
  if (source.id === target.id) throw new TaxonomyError("Choose another category to merge into.", "sameNode");
  if (source.section !== target.section || source.level !== target.level) throw new TaxonomyError("Only categories of the same section and level can be merged.", "badMerge");
  const label = `Merged category ${source.name} into ${target.name}`;
  const moved = repointTargets(store, source.section, new Map([[source.id, target.id]]), { origin: "api", label, ...options });
  const next = nodes
    .filter((node) => node.id !== source.id)
    .map((node) => (node.parentId === source.id ? { ...node, parentId: target.id } : node));
  writeAll(store, next, null, { label, ...options });
  return { merged: source.id, into: target.id, moved };
}

// The library as a file to share with other installs, and the other way: an
// imported library adds the nodes this tracker does not have, as custom nodes.
function exportLibrary(store) {
  return { format: "startup-tracker-taxonomy", formatVersion: 1, nodes: readNodes(store) };
}

function importLibrary(store, file, options = {}) {
  if (!file || file.format !== "startup-tracker-taxonomy" || file.formatVersion !== 1) throw new TaxonomyError("This is not a Startup Tracker category library.", "notLibrary");
  const incoming = validateNodes(file.nodes);
  const nodes = readNodes(store);
  const have = new Set(nodes.map((node) => node.id));
  const added = incoming.filter((node) => !have.has(node.id)).map((node) => ({ ...node, custom: true }));
  writeAll(store, [...nodes, ...added], null, { label: `Imported ${added.length} categories`, ...options });
  return { added: added.map((node) => node.id), skipped: incoming.length - added.length };
}

module.exports = {
  TAXONOMY_SECTION,
  LIBRARY_STATE_SECTION,
  TARGET_SECTIONS,
  TaxonomyError,
  readNodes,
  readLibraryState,
  seedTaxonomy,
  libraryUpdates,
  acceptLibraryNodes,
  createNode,
  updateNode,
  reorderNodes,
  resetNode,
  usageCounts,
  deleteNode,
  mergeNode,
  exportLibrary,
  importLibrary,
};
