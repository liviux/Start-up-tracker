// The category library as the page sees it: categories, subcategories and
// types for MK, PO and FU, shared by every startup, plus this startup's
// choice of which nodes are turned on. The same file runs in Node for the
// tests.
//
// A target keeps its nodes in `taxonomy: [nodeId, ...]`, the first being the
// primary. Picking a type records its subcategory and category too. A target
// shows under a category when any of its nodes falls in that branch. Ids the
// library does not know are kept as they are, never replaced.
//
// The older fields (`category`, `subcategory`, `subcategories`, `type`) are
// kept on records as a mirror of the list, for the parts of the page that
// still read them.
//
// UMD: browsers get window.StartupTrackerTaxonomy, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerTaxonomy = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SECTIONS = ["mk", "po", "fu"];
  const LEVELS = ["category", "subcategory", "type"];

  let nodes = [];
  let byId = new Map();
  let childrenOf = new Map();
  // null: every node is on (a startup that never chose). A Set: the ids on.
  let enabledIds = null;

  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name));
  }

  function setNodes(list) {
    nodes = Array.isArray(list) ? list.filter((node) => node && node.id && SECTIONS.includes(node.section)) : [];
    byId = new Map(nodes.map((node) => [node.id, node]));
    childrenOf = new Map();
    for (const node of nodes) {
      const key = node.parentId || `root:${node.section}`;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(node);
    }
    for (const list of childrenOf.values()) list.sort(byOrder);
  }

  // The startup's selection: { enabled: [ids] }, or nothing for "all on".
  function setEnabled(selection) {
    enabledIds = selection && Array.isArray(selection.enabled) ? new Set(selection.enabled) : null;
  }

  function enabledSelection() {
    return enabledIds ? { enabled: [...enabledIds] } : null;
  }

  // The server's library, or the shipped files when the server cannot answer.
  async function load(fetchImpl = fetch) {
    try {
      const response = await fetchImpl("/api/taxonomy", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setNodes(body.nodes);
      return body;
    } catch {
      const files = await Promise.all(SECTIONS.map((section) => fetchImpl(`/content/taxonomy/${section}.json`).then((response) => response.json())));
      setNodes(files.flatMap((file) => (file.nodes || []).map((node) => ({ ...node, section: file.section }))));
      return { nodes };
    }
  }

  function all() {
    return nodes;
  }

  function get(id) {
    return byId.get(id) || null;
  }

  function isKnown(id) {
    return byId.has(id);
  }

  function children(id, section, { onlyEnabled = false } = {}) {
    const list = childrenOf.get(id || `root:${section}`) || [];
    return onlyEnabled ? list.filter((node) => isEnabled(node.id)) : list;
  }

  function categories(section, options = {}) {
    return children(null, section, options);
  }

  // The node and its ancestors, category first.
  function path(id) {
    const chain = [];
    let node = byId.get(id);
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      chain.unshift(node);
      node = node.parentId ? byId.get(node.parentId) : null;
    }
    return chain;
  }

  function descendants(id) {
    const out = new Set([id]);
    const queue = [id];
    while (queue.length) {
      for (const child of childrenOf.get(queue.shift()) || []) {
        if (!out.has(child.id)) {
          out.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return out;
  }

  // On when the startup never chose, or when the node and every ancestor
  // are on. Unknown ids count as on, so nothing hides because of them.
  function isEnabled(id) {
    if (!enabledIds || !byId.has(id)) return true;
    return path(id).every((node) => enabledIds.has(node.id));
  }

  // Turns a node on (with its ancestors, so it shows) or off (with
  // everything under it). Returns the new selection.
  function toggle(id, on) {
    const next = enabledIds ? new Set(enabledIds) : new Set(nodes.map((node) => node.id));
    if (on) {
      for (const node of path(id)) next.add(node.id);
      for (const childId of descendants(id)) next.add(childId);
    } else {
      for (const childId of descendants(id)) next.delete(childId);
    }
    enabledIds = next;
    return enabledSelection();
  }

  // ---- a target's list -----------------------------------------------------

  // Adds each pick's ancestors right after it, drops repeats, keeps unknown
  // ids and the order given (the first stays the primary).
  function normalizeSelection(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const id = String(raw || "").trim();
      if (!id) continue;
      const chain = byId.has(id) ? path(id).map((node) => node.id).reverse() : [id];
      for (const entry of chain) if (!out.includes(entry)) out.push(entry);
    }
    return out;
  }

  // The picks a person made: the list without the ancestors that are only
  // there because a deeper node implies them.
  function leaves(list) {
    const ids = Array.isArray(list) ? list : [];
    return ids.filter((id) => !ids.some((other) => other !== id && byId.has(other) && path(other).some((node) => node.id === id)));
  }

  // Does any node of the list fall in the branch of `branchId`?
  function inBranch(list, branchId) {
    if (!branchId || branchId === "all") return true;
    const ids = Array.isArray(list) ? list : [];
    return ids.some((id) => id === branchId || path(id).some((node) => node.id === branchId));
  }

  function nodeAt(list, level) {
    for (const id of Array.isArray(list) ? list : []) {
      const node = path(id).find((entry) => entry.level === level);
      if (node) return node;
    }
    return null;
  }

  // The older single-value fields, mirrored from the list: the primary
  // category, subcategory and type, and every subcategory. A list of
  // unknown ids keeps the record's older values.
  function legacyFields(list, previous = {}) {
    const ids = Array.isArray(list) ? list : [];
    const known = ids.filter((id) => byId.has(id));
    if (!known.length) {
      return {
        category: previous.category || ids[0] || "",
        subcategory: previous.subcategory || "",
        subcategories: Array.isArray(previous.subcategories) ? previous.subcategories : [],
        type: previous.type || "",
      };
    }
    const subcategories = [];
    for (const id of known) {
      const sub = path(id).find((node) => node.level === "subcategory");
      if (sub && !subcategories.includes(sub.id)) subcategories.push(sub.id);
    }
    return {
      category: nodeAt(known, "category")?.id || "",
      subcategory: subcategories[0] || "",
      subcategories,
      type: nodeAt(known, "type")?.id || "",
    };
  }

  // The list for a record: its own, or one built from the older fields.
  function listFor(record) {
    if (Array.isArray(record?.taxonomy) && record.taxonomy.length) return normalizeSelection(record.taxonomy);
    const picks = [];
    if (record?.type) picks.push(record.type);
    if (Array.isArray(record?.subcategories)) picks.push(...record.subcategories);
    if (record?.subcategory) picks.push(record.subcategory);
    if (record?.category) picks.push(record.category);
    return normalizeSelection(picks.filter((id) => typeof id === "string"));
  }

  // Ids in the list this startup turned off, or that the library lacks.
  function disabledIn(list) {
    return (Array.isArray(list) ? list : []).filter((id) => byId.has(id) && !isEnabled(id));
  }

  function unknownIn(list) {
    return (Array.isArray(list) ? list : []).filter((id) => !byId.has(id));
  }

  // ---- names ----------------------------------------------------------------

  function name(id) {
    return byId.get(id)?.name || String(id || "");
  }

  function shortName(id) {
    const node = byId.get(id);
    return node?.shortName || node?.name || String(id || "");
  }

  function description(id) {
    return byId.get(id)?.description || "";
  }

  // "Category > Subcategory > Type".
  function pathLabel(id) {
    return byId.has(id) ? path(id).map((node) => node.name).join(" > ") : String(id || "");
  }

  function search(section, query, { onlyEnabled = true } = {}) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    return nodes.filter((node) => node.section === section)
      .filter((node) => !onlyEnabled || isEnabled(node.id))
      .filter((node) => {
        const text = `${pathLabel(node.id)} ${node.description || ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      });
  }

  // ---- the older nested shape -------------------------------------------------

  // { id, name, shortName, description, subcategories: [{ id, name,
  // description, types: [...] }] } per category, for the parts of the page
  // built on it. onlyEnabled leaves out what the startup turned off.
  function nestedCategories(section, options = {}) {
    const pick = (node) => ({ id: node.id, name: node.name, description: node.description || "" });
    return categories(section, options).map((category) => ({
      ...pick(category),
      shortName: category.shortName || category.name,
      recommended: Boolean(category.recommended),
      subcategories: children(category.id, section, options).map((sub) => ({
        ...pick(sub),
        types: children(sub.id, section, options).map(pick),
      })),
    }));
  }

  // A category in the nested shape, also for an id the library lacks (shown
  // under its own id) so a record never moves to another category.
  function nestedCategory(id, section) {
    const node = byId.get(id);
    if (node && node.level === "category") return nestedCategories(node.section).find((category) => category.id === id);
    return { id: String(id || ""), name: String(id || ""), shortName: String(id || ""), description: "", unknown: true, section, subcategories: [] };
  }

  return {
    SECTIONS,
    LEVELS,
    setNodes,
    setEnabled,
    enabledSelection,
    load,
    all,
    get,
    isKnown,
    children,
    categories,
    path,
    descendants,
    isEnabled,
    toggle,
    normalizeSelection,
    leaves,
    inBranch,
    legacyFields,
    listFor,
    disabledIn,
    unknownIn,
    name,
    shortName,
    description,
    pathLabel,
    search,
    nestedCategories,
    nestedCategory,
  };
});
