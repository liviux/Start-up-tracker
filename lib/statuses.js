"use strict";

// The status list shared by every startup and by MK, PO, FU and Company, kept
// in the global scope's "statuses" section. content/statuses.json is the
// built-in list it starts from. Built-in ids and their groups never change;
// labels, descriptions and order can. Custom subtypes can be added to any of
// the four groups and removed once their records have moved elsewhere.
//
// Campaign statuses are a second, simpler list in the same section: no
// groups, and every entry can be renamed, reordered or removed (after its
// campaigns move).

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { StatusError, builtIn, validateStatusConfig, ID_PATTERN } = require("./status-config");

const STATUSES_SECTION = "statuses";
// Sections whose records carry one of these statuses, with their bins.
const TARGET_SECTIONS = ["items", "programs", "funding", "companySteps", "companyDeadlines", "deletedItems", "deletedPrograms", "deletedFunding", "deletedCompanySteps"];
const CAMPAIGN_SECTIONS = ["campaigns", "deletedCampaigns"];

function readStatuses(store) {
  const stored = store.readSection(GLOBAL_STARTUP_ID, STATUSES_SECTION);
  if (!stored) return validateStatusConfig(builtIn());
  try {
    return validateStatusConfig(stored);
  } catch {
    // A stored list that no longer validates (a built-in added by an update)
    // is completed from the built-in list rather than thrown away.
    return mergeWithBuiltIn(stored);
  }
}

function mergeWithBuiltIn(stored) {
  const reference = builtIn();
  const statuses = Array.isArray(stored?.statuses) ? stored.statuses.filter((status) => status && ID_PATTERN.test(status.id || "")) : [];
  const ids = new Set(statuses.map((status) => status.id));
  for (const status of reference.statuses) if (!ids.has(status.id)) statuses.push(status);
  const fixed = statuses.map((status) => {
    const original = reference.statuses.find((entry) => entry.id === status.id);
    return original ? { ...status, group: original.group } : status;
  });
  return validateStatusConfig({ ...reference, ...stored, groups: reference.groups, statuses: fixed, campaignStatuses: Array.isArray(stored?.campaignStatuses) && stored.campaignStatuses.length ? stored.campaignStatuses : reference.campaignStatuses }, reference);
}

// Puts the built-in list in place the first time the tracker starts.
function seedStatuses(store) {
  if (store.readSection(GLOBAL_STARTUP_ID, STATUSES_SECTION) !== undefined) return false;
  store.replaceSection(GLOBAL_STARTUP_ID, STATUSES_SECTION, validateStatusConfig(builtIn()), { origin: "tool", label: "Built-in statuses" });
  return true;
}

// Saves an edited list. Removing a status only happens through deleteStatus,
// which first moves the records that use it.
function writeStatuses(store, next, options = {}) {
  const current = readStatuses(store);
  const cleaned = validateStatusConfig(next);
  const keptIds = new Set(cleaned.statuses.map((status) => status.id));
  for (const status of current.statuses) {
    if (!keptIds.has(status.id)) throw new StatusError(`Delete ${status.label} with "Delete", which moves its records first.`, "useDelete");
  }
  const keptCampaignIds = new Set(cleaned.campaignStatuses.map((status) => status.id));
  for (const status of current.campaignStatuses) {
    if (!keptCampaignIds.has(status.id)) throw new StatusError(`Delete ${status.label} with "Delete", which moves its campaigns first.`, "useDelete");
  }
  store.replaceSection(GLOBAL_STARTUP_ID, STATUSES_SECTION, cleaned, { origin: "api", ...options });
  return cleaned;
}

// Moves every record with status `from` to `to` in the given sections of
// every startup and of the global scope.
function moveRecords(store, sections, from, to, options) {
  let moved = 0;
  for (const scopeId of [GLOBAL_STARTUP_ID, ...store.listStartupIds()]) {
    const operations = [];
    for (const section of sections) {
      const records = store.readSection(scopeId, section);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record?.status === from) operations.push({ type: "upsert", section, id: record.id, value: { ...record, status: to } });
      }
    }
    if (operations.length) {
      store.applyOperations(scopeId, operations, options);
      moved += operations.length;
    }
  }
  return moved;
}

function deleteStatus(store, statusId, moveTo, options = {}) {
  const current = readStatuses(store);
  const status = current.statuses.find((entry) => entry.id === statusId);
  if (!status) throw new StatusError("Unknown status.", "unknownStatus", 404);
  if (!status.custom) throw new StatusError(`${status.label} is built in and cannot be deleted.`, "builtIn");
  if (!moveTo || moveTo === statusId || !current.statuses.some((entry) => entry.id === moveTo)) {
    throw new StatusError("Choose the status its records move to.", "badMoveTo");
  }
  const target = current.statuses.find((entry) => entry.id === moveTo);
  const label = `Status ${status.label} deleted; its records moved to ${target.label}`;
  const moved = moveRecords(store, TARGET_SECTIONS, statusId, moveTo, { origin: "api", label, ...options });
  const next = {
    ...current,
    statuses: current.statuses.filter((entry) => entry.id !== statusId),
    defaultStatus: current.defaultStatus === statusId ? moveTo : current.defaultStatus,
    waitingStatuses: current.waitingStatuses.filter((id) => id !== statusId),
  };
  store.replaceSection(GLOBAL_STARTUP_ID, STATUSES_SECTION, validateStatusConfig(next), { origin: "api", label, ...options });
  return { moved, statuses: readStatuses(store) };
}

// Status values in one startup's records that the shared list does not know.
// An import keeps them as they are, and the page shows them as "Unmapped".
function unknownStatuses(state, config) {
  const known = new Set(config.statuses.map((status) => status.id));
  const counts = new Map();
  for (const section of TARGET_SECTIONS) {
    for (const record of Array.isArray(state?.[section]) ? state[section] : []) {
      const value = record?.status;
      if (typeof value !== "string" || !value || known.has(value)) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, count }));
}

function deleteCampaignStatus(store, statusId, moveTo, options = {}) {
  const current = readStatuses(store);
  const status = current.campaignStatuses.find((entry) => entry.id === statusId);
  if (!status) throw new StatusError("Unknown campaign status.", "unknownStatus", 404);
  if (current.campaignStatuses.length === 1) throw new StatusError("Campaigns need at least one status.", "noCampaignStatuses");
  if (!moveTo || moveTo === statusId || !current.campaignStatuses.some((entry) => entry.id === moveTo)) {
    throw new StatusError("Choose the status its campaigns move to.", "badMoveTo");
  }
  const target = current.campaignStatuses.find((entry) => entry.id === moveTo);
  const label = `Campaign status ${status.label} deleted; its campaigns moved to ${target.label}`;
  const moved = moveRecords(store, CAMPAIGN_SECTIONS, statusId, moveTo, { origin: "api", label, ...options });
  const next = { ...current, campaignStatuses: current.campaignStatuses.filter((entry) => entry.id !== statusId) };
  store.replaceSection(GLOBAL_STARTUP_ID, STATUSES_SECTION, validateStatusConfig(next), { origin: "api", label, ...options });
  return { moved, statuses: readStatuses(store) };
}

module.exports = {
  STATUSES_SECTION,
  TARGET_SECTIONS,
  StatusError,
  builtIn,
  validateStatusConfig,
  readStatuses,
  seedStatuses,
  writeStatuses,
  deleteStatus,
  deleteCampaignStatus,
  unknownStatuses,
};
