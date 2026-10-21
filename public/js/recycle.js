// The recycle bin as the page keeps it. Deleting a record moves it from its
// section to the paired "deleted" section with a deletedAt time; restoring
// moves it back; "delete forever" removes it from the bin. The section names
// are the ones lib/recycle-bin.js purges after the retention period.
//
// These functions only build new arrays. app.js puts them into its state and
// saves them through the normal outbox, like any other edit.
//
// UMD: browsers get window.StartupTrackerRecycle, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerRecycle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // In the order the bin lists its groups. `title` names the field that
  // labels a record, `fallback` the next one to try.
  const KINDS = Object.freeze([
    { kind: "target", group: "mk", live: "items", deleted: "deletedItems", title: "platform" },
    { kind: "program", group: "po", live: "programs", deleted: "deletedPrograms", title: "name" },
    { kind: "funding", group: "fu", live: "funding", deleted: "deletedFunding", title: "funder", fallback: "opportunity" },
    { kind: "campaign", group: "campaigns", live: "campaigns", deleted: "deletedCampaigns", title: "name" },
    { kind: "media", group: "media", live: "mediaItems", deleted: "deletedMediaItems", title: "title" },
    { kind: "feedback", group: "feedback", live: "feedbackItems", deleted: "deletedFeedbackItems", title: "title" },
    { kind: "dailyLink", group: "researchLinks", live: "dailyLinks", deleted: "deletedDailyLinks", title: "title", fallback: "url" },
    { kind: "prompt", group: "prompts", live: "prompts", deleted: "deletedPrompts", title: "title" },
    { kind: "tag", group: "tags", live: "tagDefinitions", deleted: "deletedTags", title: "label", fallback: "id" },
    { kind: "companyStep", group: "company", live: "companySteps", deleted: "deletedCompanySteps", title: "title" },
    { kind: "companyObligation", group: "company", live: "companyObligations", deleted: "deletedCompanyObligations", title: "title" },
    { kind: "companyExpense", group: "company", live: "companyExpenses", deleted: "deletedCompanyExpenses", title: "title" },
  ].map((entry) => Object.freeze(entry)));

  const BY_DELETED = new Map(KINDS.map((entry) => [entry.deleted, entry]));
  const BY_LIVE = new Map(KINDS.map((entry) => [entry.live, entry]));
  const DELETED_SECTIONS = Object.freeze(KINDS.map((entry) => entry.deleted));

  function kindOfDeleted(section) {
    return BY_DELETED.get(section) || null;
  }

  function kindOfLive(section) {
    return BY_LIVE.get(section) || null;
  }

  function sameId(record, id) {
    return String(record?.id ?? "") === String(id);
  }

  function recordTitle(kind, record) {
    const entry = typeof kind === "string" ? (BY_DELETED.get(kind) || BY_LIVE.get(kind)) : kind;
    const value = record?.[entry?.title] || (entry?.fallback ? record?.[entry.fallback] : "") || record?.id || "";
    return String(value).trim();
  }

  // { live, deleted } with the record moved into the bin, first in the list.
  // A record that is not in `live` leaves both unchanged.
  function moveToBin(live, deleted, id, now = new Date()) {
    const liveList = Array.isArray(live) ? live : [];
    const deletedList = Array.isArray(deleted) ? deleted : [];
    const record = liveList.find((entry) => sameId(entry, id));
    if (!record) return { live: liveList, deleted: deletedList, moved: null };
    const stamp = now instanceof Date ? now.toISOString() : String(now);
    const moved = { ...record, deletedAt: stamp, updatedAt: stamp };
    return {
      live: liveList.filter((entry) => !sameId(entry, id)),
      deleted: [moved, ...deletedList.filter((entry) => !sameId(entry, id))],
      moved,
    };
  }

  // { live, deleted } with the record back in its section, first in the list
  // and without deletedAt. A record of the same id already back in `live` is
  // replaced, so a restore never makes a duplicate.
  function restoreFromBin(live, deleted, id, now = new Date()) {
    const liveList = Array.isArray(live) ? live : [];
    const deletedList = Array.isArray(deleted) ? deleted : [];
    const record = deletedList.find((entry) => sameId(entry, id));
    if (!record) return { live: liveList, deleted: deletedList, restored: null };
    const stamp = now instanceof Date ? now.toISOString() : String(now);
    const { deletedAt, ...rest } = record;
    void deletedAt;
    const restored = { ...rest, updatedAt: stamp };
    return {
      live: [restored, ...liveList.filter((entry) => !sameId(entry, id))],
      deleted: deletedList.filter((entry) => !sameId(entry, id)),
      restored,
    };
  }

  function removeFromBin(deleted, id) {
    return (Array.isArray(deleted) ? deleted : []).filter((entry) => !sameId(entry, id));
  }

  // Everything in the bin, grouped in KINDS order and newest first inside a
  // group. `read(section)` returns the records of a deleted section.
  function groupBin(read) {
    const groups = [];
    for (const entry of KINDS) {
      const records = (Array.isArray(read(entry.deleted)) ? read(entry.deleted) : [])
        .filter((record) => record && record.id !== undefined && record.id !== null && record.id !== "")
        .map((record) => ({
          kind: entry.kind,
          group: entry.group,
          section: entry.deleted,
          liveSection: entry.live,
          id: String(record.id),
          title: recordTitle(entry, record),
          deletedAt: String(record.deletedAt || ""),
        }))
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      if (!records.length) continue;
      const existing = groups.find((group) => group.group === entry.group);
      if (existing) {
        existing.records.push(...records);
        existing.records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      } else {
        groups.push({ group: entry.group, records });
      }
    }
    return groups;
  }

  function countBin(read) {
    return groupBin(read).reduce((total, group) => total + group.records.length, 0);
  }

  // The retention choices Settings offers: the server accepts 7 to 365 days,
  // or null for "keep until I empty the bin".
  const RETENTION_CHOICES = Object.freeze([7, 14, 30, 60, 90, 180, 365, null]);

  return Object.freeze({
    KINDS,
    DELETED_SECTIONS,
    RETENTION_CHOICES,
    kindOfDeleted,
    kindOfLive,
    recordTitle,
    moveToBin,
    restoreFromBin,
    removeFromBin,
    groupBin,
    countBin,
  });
});
