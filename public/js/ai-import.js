// "Import AI results": targets an AI chat sent back as JSON, checked before
// anything is added (window.StartupTrackerAiImport).
//
// The format is the one {{TRACKER_ACCESS}} asks chat agents for:
//   { "targets": [ { "section": "mk", "name": "...", "link": "https://...", ... } ] }
// Keys are the field registry's common names (js/fields.js): the basics
// (name, organization, link, status, priority, nextAction, nextActionDate,
// nextActionTime, deadline, owner, tags), "notes", "categories" (category
// ids) and any field of that section, flat or under "details". Unknown keys
// are reported and left out; nothing is invented to fill a gap.
//
// UMD: browsers get window.StartupTrackerAiImport, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerAiImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);

  const SECTIONS = Object.freeze(["mk", "po", "fu"]);
  const MAX_TARGETS = 200;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  // Keys outside the registry that every entry may carry.
  const EXTRA_KEYS = Object.freeze(["section", "notes", "categories", "details", "custom"]);
  // Basics that are set elsewhere, never from an import.
  const IGNORED_CORE = Object.freeze(["id", "taxonomy", "repeat", "campaignId"]);

  // The JSON in a pasted reply: a fenced ```json block, or the first object
  // or list in the text.
  function extractJson(text) {
    const source = String(text || "");
    const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : source;
    const start = candidate.search(/[[{]/);
    if (start < 0) throw new SyntaxError("No JSON found. Paste the reply that holds the targets.");
    const opener = candidate[start];
    const closer = opener === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(closer);
    if (end <= start) throw new SyntaxError("The JSON is cut off.");
    return JSON.parse(candidate.slice(start, end + 1));
  }

  function parse(text) {
    let data;
    try {
      data = extractJson(text);
    } catch (error) {
      return { entries: [], error: error instanceof SyntaxError ? error.message : String(error.message || error) };
    }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.targets) ? data.targets : null;
    if (!entries) return { entries: [], error: "The JSON needs a \"targets\" list." };
    if (entries.length > MAX_TARGETS) return { entries: [], error: t("aiImport.parse.upToTargetsCanBe", { MAX_TARGETS }) };
    return { entries, error: "" };
  }

  // "https://www.Example.com/a/" and "example.com/a" are the same address.
  function urlKey(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    return text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  }

  function nameKey(value) {
    return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function isWebLink(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  // The fields an entry of a section may set, by key.
  function fieldsBySection(Fields, section) {
    const map = new Map();
    const add = (field) => {
      if (field && !IGNORED_CORE.includes(field.key) && field.type !== "readonly-id") map.set(field.key, field);
    };
    Fields.coreFields(section).forEach(add);
    Fields.detailGroups(section).forEach((group) => group.fields.forEach(add));
    Fields.customFields(section).forEach(add);
    return map;
  }

  // Checks every entry. `context`: Fields (js/fields.js), isStatus(id),
  // defaultStatus(), priorities (labels), category(id) -> { section } or null,
  // existing: { mk: [{ id, name, link }], po: [...], fu: [...] }.
  // Returns one row per entry: { index, section, values, notes, categories,
  // problems, warnings, duplicateOf, ok }. A row with problems cannot be
  // imported; a duplicate can, but starts unticked.
  function check(entries, context) {
    const { Fields, isStatus = () => true, defaultStatus = () => "", priorities = [], category = () => null, existing = {} } = context;
    const seen = { mk: [], po: [], fu: [] };
    return (Array.isArray(entries) ? entries : []).map((entry, index) => {
      const problems = [];
      const warnings = [];
      const values = {};
      const row = { index, section: "", values, notes: "", categories: [], problems, warnings, duplicateOf: null, ok: false };
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push("Not an object.");
        return row;
      }
      const section = String(entry.section || "").trim().toLowerCase();
      if (!SECTIONS.includes(section)) {
        problems.push(t("aiImport.check.sectionMustBeMkPo"));
        return row;
      }
      row.section = section;
      const known = fieldsBySection(Fields, section);
      const flat = { ...(entry.details && typeof entry.details === "object" ? entry.details : {}), ...(entry.custom && typeof entry.custom === "object" ? entry.custom : {}), ...entry };
      for (const [key, raw] of Object.entries(flat)) {
        if (EXTRA_KEYS.includes(key) || raw === null || raw === undefined || raw === "") continue;
        const field = known.get(key);
        if (!field) {
          warnings.push(t("aiImport.check.isNotAFieldOf", { key }));
          continue;
        }
        const value = Fields.normalize(field, raw);
        if (Fields.isEmpty(field, value) || (field.type === "date" && !DATE.test(String(raw).trim()))) {
          warnings.push(t("aiImport.check.couldNotBeReadAs", { key, type: field.type }));
          continue;
        }
        values[key] = value;
      }
      if (!values.name) problems.push("A target needs a name.");
      if (values.link && !isWebLink(values.link)) {
        warnings.push("The link is not a web address and is left out.");
        delete values.link;
      }
      if (values.status && !isStatus(values.status)) {
        warnings.push(`Unknown status "${values.status}"; the default status is used.`);
        delete values.status;
      }
      if (!values.status) values.status = defaultStatus();
      if (values.priority && priorities.length && !priorities.includes(values.priority)) {
        warnings.push(t("aiImport.check.unknownPriorityIsLeftOut", { priority: values.priority }));
        delete values.priority;
      }
      row.notes = typeof entry.notes === "string" ? entry.notes.trim() : "";
      for (const id of Array.isArray(entry.categories) ? entry.categories : []) {
        const node = category(String(id));
        if (!node) warnings.push(t("aiImport.check.unknownCategoryIsLeftOut", { id }));
        else if (node.section !== section) warnings.push(t("aiImport.check.categoryBelongsToAnotherSection", { id }));
        else if (!row.categories.includes(String(id))) row.categories.push(String(id));
      }

      if (!problems.length) {
        const link = urlKey(values.link);
        const name = nameKey(values.name);
        const match = (list) => list.find((other) => (link && urlKey(other.link) === link) || (name && nameKey(other.name) === name));
        const tracked = match(existing[section] || []);
        const earlier = match(seen[section]);
        if (tracked) row.duplicateOf = { id: tracked.id, name: tracked.name, reason: link && urlKey(tracked.link) === link ? "link" : "name", where: "tracker" };
        else if (earlier) row.duplicateOf = { id: "", name: earlier.name, reason: link && urlKey(earlier.link) === link ? "link" : "name", where: "import" };
        seen[section].push({ name: values.name, link: values.link || "" });
      }
      row.ok = problems.length === 0;
      return row;
    });
  }

  // The record a checked row becomes, written through the registry so every
  // value lands where the section keeps it.
  function toRecord(row, Fields, { id, now = new Date().toISOString() } = {}) {
    const record = { id, createdAt: now, updatedAt: now };
    const known = fieldsBySection(Fields, row.section);
    for (const [key, value] of Object.entries(row.values)) Fields.setValue(row.section, record, known.get(key), value);
    if (row.notes) record.notes = row.notes;
    return record;
  }

  // The reply format, as {{TRACKER_ACCESS}} shows it to chat agents.
  function formatExample(section = "mk") {
    return JSON.stringify({ targets: [{ section, name: "Name of the target", link: "https://example.com/official-page", organization: "Who runs it", nextAction: "The first concrete step", nextActionDate: "YYYY-MM-DD", deadline: "YYYY-MM-DD", priority: "Medium", categories: [`${section}.<category id>`], notes: "Markdown: summary, official sources with the date checked, rules and eligibility." }] }, null, 2);
  }

  return Object.freeze({ SECTIONS, MAX_TARGETS, parse, check, toRecord, urlKey, nameKey, formatExample });
});
