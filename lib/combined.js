"use strict";

// Read-only views across every startup that is not archived: search and the
// calendar's "All startups" mode. Results carry their startup so the browser
// can switch to it before opening anything; nothing here ever writes.

const { listStartups } = require("./startups");
const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const CalendarModel = require("../public/js/calendar-model.js");
const CompanyModel = require("../public/js/company-model.js");
const companyTemplates = require("./company/templates");
const { readStatuses } = require("./statuses");

const MAX_SEARCH_RESULTS = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Collections that hold the records a person looks for, with the fields that
// name a record and the fields searched besides those.
const SEARCHED_SECTIONS = [
  { section: "items", kind: "marketing", title: ["name"], text: ["organization", "link", "nextAction", "notes"] },
  { section: "programs", kind: "program", title: ["name"], text: ["organization", "link", "nextAction", "notes"] },
  { section: "funding", kind: "funding", title: ["name"], text: ["organization", "link", "nextAction", "notes"] },
  { section: "mediaItems", kind: "media", title: ["title", "name", "originalName"], text: ["notes", "description"] },
];
// Campaigns are shared by every startup: they are read once, from the global
// scope, and carry no startup (the page opens them where it is).
const SHARED_SEARCHED_SECTIONS = [
  { section: "campaigns", kind: "campaign", title: ["name"], text: ["notes", "description", "goal"] },
];

function openStartups(store) {
  return listStartups(store, { includeArchived: false });
}

function startupLabel(startup) {
  return { id: startup.id, name: startup.name, icon: startup.icon || "" };
}

function firstText(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function searchAll(store, query, { limit = MAX_SEARCH_RESULTS } = {}) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { results: [], truncated: false };
  const results = [];
  let truncated = false;
  const scopes = [...openStartups(store).map((startup) => ({ id: startup.id, label: startupLabel(startup), specs: SEARCHED_SECTIONS })), { id: GLOBAL_STARTUP_ID, label: null, specs: SHARED_SEARCHED_SECTIONS }];
  for (const scope of scopes) {
    for (const spec of scope.specs) {
      const records = store.readSection(scope.id, spec.section);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const title = firstText(record, spec.title);
        const haystack = [title, ...spec.text.map((field) => (typeof record?.[field] === "string" ? record[field] : ""))]
          .join("\n")
          .toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        if (results.length >= limit) {
          truncated = true;
          break;
        }
        results.push({ startup: scope.label, ...(scope.label ? {} : { shared: true }), section: spec.section, kind: spec.kind, id: String(record.id), title: title || String(record.id), status: record.status || "" });
      }
    }
  }
  return { results, truncated };
}

// The dated moments of every open startup's records: the same ones each
// startup's own calendar shows (public/js/calendar-model.js), plus each
// record's status so the "all time" summary can count records without dates.
const CALENDAR_COLLECTIONS = [
  ["items", "mk"],
  ["programs", "po"],
  ["funding", "fu"],
];

// A startup's Company steps and deadlines, as js/company-model.js works
// them out on the page: with its template, today's date and the status list.
function companyView(store, startupId, statusRules) {
  const profile = store.readSection(startupId, CompanyModel.SECTIONS.profile);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const sections = {};
  for (const name of [CompanyModel.SECTIONS.profile, CompanyModel.SECTIONS.steps, CompanyModel.SECTIONS.obligations, CompanyModel.SECTIONS.deadlines]) sections[name] = store.readSection(startupId, name);
  return CompanyModel.view(companyTemplates.getTemplate(profile.templateId), sections, { today: new Date().toISOString().slice(0, 10), isDone: statusRules.isDone });
}

function statusRulesOf(store) {
  const config = readStatuses(store);
  const groups = new Map(config.statuses.map((status) => [status.id, status.group]));
  return { defaultStatus: config.defaultStatus, isDone: (id) => ["done", "closed"].includes(groups.get(id)) };
}

function calendarAll(store, { from = "", to = "" } = {}) {
  if (from && !DATE_PATTERN.test(from)) throw new RangeError("from must be a date (YYYY-MM-DD).");
  if (to && !DATE_PATTERN.test(to)) throw new RangeError("to must be a date (YYYY-MM-DD).");
  const events = [];
  const records = [];
  const statusRules = statusRulesOf(store);
  const keep = (startup, event) => {
    if (!CalendarModel.inRange(event, from, to)) return;
    events.push({ startup: startupLabel(startup), ...event });
  };
  // Shared campaigns once, without a startup.
  for (const record of store.readSection(GLOBAL_STARTUP_ID, "campaigns") || []) {
    if (!record || typeof record !== "object") continue;
    for (const event of CalendarModel.recordEvents("campaigns", record)) {
      if (CalendarModel.inRange(event, from, to)) events.push({ startup: null, shared: true, ...event });
    }
  }
  for (const startup of openStartups(store)) {
    for (const [collection, section] of CALENDAR_COLLECTIONS) {
      const list = store.readSection(startup.id, collection);
      if (!Array.isArray(list)) continue;
      for (const record of list) {
        if (!record || typeof record !== "object") continue;
        records.push({ startupId: startup.id, section, id: String(record.id), status: typeof record.status === "string" ? record.status : "" });
        for (const event of CalendarModel.recordEvents(collection, record)) keep(startup, event);
      }
    }
    const company = companyView(store, startup.id, statusRules);
    if (company) {
      for (const record of CompanyModel.calendarRecords(company, { defaultStatus: statusRules.defaultStatus })) records.push({ startupId: startup.id, section: "comp", ...record });
      for (const event of CompanyModel.calendarEvents(company, { defaultStatus: statusRules.defaultStatus })) keep(startup, event);
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || String(a.startup?.name || "").localeCompare(String(b.startup?.name || "")));
  return { events, records };
}

// The targets of one campaign in every open startup, each with its startup,
// so Extra > Campaigns can list what a shared campaign covers.
const CAMPAIGN_SECTIONS = [
  { collection: "items", section: "mk" },
  { collection: "programs", section: "po" },
  { collection: "funding", section: "fu" },
];

function campaignTargets(store, campaignId) {
  const id = String(campaignId || "").trim();
  if (!id) throw new RangeError("campaign must name a campaign id.");
  const targets = [];
  for (const startup of openStartups(store)) {
    for (const spec of CAMPAIGN_SECTIONS) {
      const records = store.readSection(startup.id, spec.collection);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (String(record?.campaignId || "") !== id) continue;
        targets.push({
          startup: startupLabel(startup),
          section: spec.section,
          id: String(record.id),
          title: firstText(record, ["name"]) || String(record.id),
          status: typeof record.status === "string" ? record.status : "",
          date: typeof record.nextActionDate === "string" ? record.nextActionDate : "",
        });
      }
    }
  }
  return { targets };
}

module.exports = { searchAll, calendarAll, campaignTargets, MAX_SEARCH_RESULTS };
