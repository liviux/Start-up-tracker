// The shared status list (one for MK, PO, FU and Company, in every startup)
// and the fixed priorities. Everything the page asks about a status goes
// through here: its group, label and description, whether it is still open,
// how a filter treats it, and how a dropdown lists it. The same file runs in
// Node for the tests.
//
// A status that is not in the list is kept as it is, never replaced by the
// first status: it belongs to the "unmapped" group, shows as "Unmapped" and
// the filter can select it.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerStatuses = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const UNMAPPED = "unmapped";
  const OPEN_GROUPS = new Set(["planned", "in_progress"]);

  let config = { defaultStatus: "new", groups: [], statuses: [], waitingStatuses: [], campaignStatuses: [] };
  let priorities = { defaultPriority: "medium", priorities: [] };
  let byId = new Map();
  let legacyPriority = new Map();

  function setConfig(statusConfig, priorityConfig) {
    if (statusConfig && Array.isArray(statusConfig.statuses)) {
      config = statusConfig;
      byId = new Map(config.statuses.map((status) => [status.id, status]));
    }
    if (priorityConfig && Array.isArray(priorityConfig.priorities)) {
      priorities = priorityConfig;
      legacyPriority = new Map();
      for (const priority of priorities.priorities) {
        legacyPriority.set(priority.id, priority.id);
        legacyPriority.set(String(priority.label).toLowerCase(), priority.id);
        for (const legacy of priority.legacy || []) legacyPriority.set(String(legacy).toLowerCase(), priority.id);
      }
    }
  }

  // The server's list, or the shipped one when the server cannot answer
  // (the page then still shows labels and groups).
  async function load(fetchImpl = fetch) {
    try {
      const response = await fetchImpl("/api/statuses", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setConfig(body.statuses, body.priorities);
    } catch {
      const [statusResponse, priorityResponse] = await Promise.all([
        fetchImpl("/content/statuses.json"),
        fetchImpl("/content/priorities.json"),
      ]);
      setConfig(await statusResponse.json(), await priorityResponse.json());
    }
    return config;
  }

  function current() {
    return config;
  }

  function groups() {
    return config.groups;
  }

  function statuses() {
    return config.statuses;
  }

  function get(id) {
    return byId.get(id) || null;
  }

  function isKnown(id) {
    return byId.has(id);
  }

  function groupOf(id) {
    return byId.get(id)?.group || UNMAPPED;
  }

  function label(id) {
    return byId.get(id)?.label || String(id || "");
  }

  function description(id) {
    return byId.get(id)?.description || "";
  }

  function groupLabel(groupId) {
    return config.groups.find((group) => group.id === groupId)?.label || groupId;
  }

  function inGroup(groupId) {
    return config.statuses.filter((status) => status.group === groupId).map((status) => status.id);
  }

  // Planned and In progress still need work; Done and Closed do not. An
  // unmapped status counts as open, so nothing disappears because its value
  // is unknown.
  function isOpen(id) {
    const group = groupOf(id);
    return group === UNMAPPED || OPEN_GROUPS.has(group);
  }

  function isWaiting(id) {
    return (config.waitingStatuses || []).includes(id);
  }

  // Sort order: the list's own order, with unmapped values last.
  function rank(id) {
    const index = config.statuses.findIndex((status) => status.id === id);
    return index === -1 ? config.statuses.length : index;
  }

  function defaultStatus() {
    return config.defaultStatus || config.statuses[0]?.id || "";
  }

  // One CSS-safe name per status, plus one per group for colouring badges.
  function slug(id) {
    return String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "none";
  }

  function badgeClass(id) {
    return `status-badge status-${slug(id)} status-group-${groupOf(id).replace(/_/g, "-")}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  // <option>s grouped by status group. A current value that is not in the
  // list stays selectable under "Unmapped", so opening a record never
  // changes its status.
  function optionsHtml(selected, { unmappedLabel = "Unmapped" } = {}) {
    const parts = [];
    if (selected && !isKnown(selected)) {
      parts.push(`<optgroup label="${escapeHtml(unmappedLabel)}"><option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option></optgroup>`);
    }
    for (const group of config.groups) {
      const options = config.statuses
        .filter((status) => status.group === group.id)
        .map((status) => `<option value="${escapeHtml(status.id)}"${status.id === selected ? " selected" : ""} title="${escapeHtml(status.description)}">${escapeHtml(status.label)}</option>`)
        .join("");
      if (options) parts.push(`<optgroup label="${escapeHtml(group.label)}">${options}</optgroup>`);
    }
    return parts.join("");
  }

  // A filter selection is a set of status ids, plus UNMAPPED when unmapped
  // values are wanted.
  function defaultSelection() {
    const selection = new Set(config.statuses.filter((status) => OPEN_GROUPS.has(status.group)).map((status) => status.id));
    selection.add(UNMAPPED);
    return selection;
  }

  function allSelection() {
    const selection = new Set(config.statuses.map((status) => status.id));
    selection.add(UNMAPPED);
    return selection;
  }

  function matches(selection, statusId) {
    return isKnown(statusId) ? selection.has(statusId) : selection.has(UNMAPPED);
  }

  // "all", "off" or "k/n" for one group's chip.
  function groupState(selection, groupId) {
    if (groupId === UNMAPPED) return selection.has(UNMAPPED) ? "all" : "off";
    const ids = inGroup(groupId);
    const chosen = ids.filter((id) => selection.has(id)).length;
    if (chosen === 0) return "off";
    if (chosen === ids.length) return "all";
    return `${chosen}/${ids.length}`;
  }

  function setGroup(selection, groupId, on) {
    const next = new Set(selection);
    const ids = groupId === UNMAPPED ? [UNMAPPED] : inGroup(groupId);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  }

  function toggle(selection, statusId) {
    const next = new Set(selection);
    if (next.has(statusId)) next.delete(statusId);
    else next.add(statusId);
    return next;
  }

  // Stored filters survive edits to the list: ids that no longer exist are
  // dropped, and a stored filter that ends up empty falls back to the default.
  function restoreSelection(stored) {
    if (!Array.isArray(stored)) return defaultSelection();
    const selection = new Set(stored.filter((id) => id === UNMAPPED || isKnown(id)));
    return selection.size ? selection : defaultSelection();
  }

  function countByStatus(records, read = (record) => record.status) {
    const counts = new Map();
    for (const record of records) {
      const id = read(record);
      const key = isKnown(id) ? id : UNMAPPED;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function countByGroup(records, read = (record) => record.status) {
    const counts = Object.fromEntries([...config.groups.map((group) => [group.id, 0]), [UNMAPPED, 0]]);
    for (const record of records) counts[groupOf(read(record))] += 1;
    return counts;
  }

  // Priorities: a fixed list with stable ids. Values saved before ids existed
  // ("Very High") are read as their id.
  function priorityList() {
    return priorities.priorities;
  }

  function normalizePriority(value) {
    if (value === undefined || value === null || value === "") return priorities.defaultPriority;
    return legacyPriority.get(String(value).toLowerCase()) || String(value);
  }

  function priorityLabel(id) {
    const normalized = normalizePriority(id);
    return priorities.priorities.find((priority) => priority.id === normalized)?.label || String(id || "");
  }

  function priorityRank(id) {
    const index = priorities.priorities.findIndex((priority) => priority.id === normalizePriority(id));
    return index === -1 ? priorities.priorities.length : index;
  }

  function priorityOptionsHtml(selected) {
    const normalized = normalizePriority(selected);
    return priorities.priorities
      .map((priority) => `<option value="${escapeHtml(priority.id)}"${priority.id === normalized ? " selected" : ""}>${escapeHtml(priority.label)}</option>`)
      .join("");
  }

  function campaignStatuses() {
    return config.campaignStatuses || [];
  }

  function campaignStatusLabel(id) {
    return campaignStatuses().find((status) => status.id === id)?.label || String(id || "");
  }

  return {
    UNMAPPED,
    setConfig,
    load,
    current,
    groups,
    statuses,
    get,
    isKnown,
    groupOf,
    label,
    description,
    groupLabel,
    inGroup,
    isOpen,
    isWaiting,
    defaultStatus,
    rank,
    slug,
    badgeClass,
    optionsHtml,
    defaultSelection,
    allSelection,
    matches,
    groupState,
    setGroup,
    toggle,
    restoreSelection,
    countByStatus,
    countByGroup,
    priorityList,
    normalizePriority,
    priorityLabel,
    priorityRank,
    priorityOptionsHtml,
    campaignStatuses,
    campaignStatusLabel,
  };
});
