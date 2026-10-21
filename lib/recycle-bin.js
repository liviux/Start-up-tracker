"use strict";

// The recycle bin. Deleting a record moves it from its section to a paired
// "deleted" section with a deletedAt time; restoring moves it back. Records
// left in the bin longer than the retention period are deleted for good.
//
// Prompts, tags and campaigns are shared by every startup, so their bin is
// the global one and shows in every startup.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { removeLinksTo } = require("./links");
const { storedNameOf } = require("./media-files");

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const STARTUP_PAIRS = [
  ["items", "deletedItems"],
  ["programs", "deletedPrograms"],
  ["funding", "deletedFunding"],
  ["mediaItems", "deletedMediaItems"],
  ["feedbackItems", "deletedFeedbackItems"],
  ["dailyLinks", "deletedDailyLinks"],
  ["companySteps", "deletedCompanySteps"],
  ["companyObligations", "deletedCompanyObligations"],
  ["companyExpenses", "deletedCompanyExpenses"],
];

const GLOBAL_PAIRS = [
  ["prompts", "deletedPrompts"],
  ["tags", "deletedTags"],
  ["campaigns", "deletedCampaigns"],
];

// Both directions, so a section's partner can be looked up from either side.
const PAIRS = new Map();
for (const [live, deleted] of [...STARTUP_PAIRS, ...GLOBAL_PAIRS]) {
  PAIRS.set(live, deleted);
  PAIRS.set(deleted, live);
}

function pairedSection(section) {
  return PAIRS.get(section) || null;
}

// null means "keep until I empty the bin".
function normalizeRetentionDays(value) {
  if (value === null || value === "never") return null;
  if (value === undefined || value === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new RangeError(`Keep deleted records between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days, or until you empty the bin.`);
  }
  return days;
}

// Every bin section is looked for in every scope, so a record type that
// moves between a startup and the global scope keeps being cleaned up.
function deletedSectionsOf() {
  return [...STARTUP_PAIRS, ...GLOBAL_PAIRS].map(([, deleted]) => deleted);
}

// Deletes for good every record that has sat in a bin longer than the
// retention period, in every startup and in the global bin. A record without
// a readable deletedAt is kept: it cannot be shown to be old enough.
function purgeExpired(store, { retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const days = normalizeRetentionDays(retentionDays);
  const purged = [];
  // Uploaded files of purged media records, for the caller to remove once
  // nothing else names them (lib/media-files.js removeUnusedFiles).
  const mediaFiles = [];
  if (days === null) return { purged, mediaFiles, retentionDays: null };
  const cutoff = now.getTime() - days * DAY_MS;
  const scopes = [GLOBAL_STARTUP_ID, ...store.listStartupIds()];
  for (const scopeId of scopes) {
    const operations = [];
    for (const section of deletedSectionsOf()) {
      const records = store.readSection(scopeId, section);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const deletedAt = Date.parse(record?.deletedAt || "");
        if (Number.isFinite(deletedAt) && deletedAt < cutoff) {
          operations.push({ type: "delete", section, id: record.id });
          purged.push({ startupId: scopeId, section, id: record.id });
          const storedName = section === "deletedMediaItems" ? storedNameOf(record) : "";
          if (storedName) mediaFiles.push({ startupId: scopeId, storedName });
        }
      }
    }
    if (operations.length) {
      store.applyOperations(scopeId, operations, {
        origin: "tool",
        label: `Recycle bin: deleted for good after ${days} days`,
      });
      // Their links go too; links of records still in the bin stay. Links
      // live with each startup, so a shared record (a campaign) is looked
      // for in every startup's links.
      const removed = operations.map((operation) => ({ section: operation.section, id: operation.id }));
      const linkScopes = scopeId === GLOBAL_STARTUP_ID ? store.listStartupIds() : [scopeId];
      for (const linkScope of linkScopes) removeLinksTo(store, linkScope, removed);
    }
  }
  return { purged, mediaFiles, retentionDays: days };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  STARTUP_PAIRS,
  GLOBAL_PAIRS,
  pairedSection,
  normalizeRetentionDays,
  deletedSectionsOf,
  purgeExpired,
};
