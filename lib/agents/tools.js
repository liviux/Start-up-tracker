"use strict";

// What the tracker tools do (definitions: lib/agents/tool-definitions.js).
// They run in the tracker, called by bin/tracker-mcp.js with the run's token,
// and work on one startup only.
//
// Writes are recorded with origin "agent", the actor "<harness> · <model>"
// and the run id as label, so the history says which run changed what. Each
// carries a mutation id: a call retried after a lost answer is applied once.
// `onChange` hears every record a run creates or changes, with its value
// before, which is what "Undo this run" restores.

const { GLOBAL_STARTUP_ID } = require("../tracker-sqlite-store");
const Fields = require("../../public/js/fields.js");
const AiImport = require("../../public/js/ai-import.js");
const Taxonomy = require("../../public/js/taxonomy-model.js");
const CalendarModel = require("../../public/js/calendar-model.js");
const Links = require("../../public/js/links-model.js");
const fieldRegistry = require("../field-registry");
const taxonomyStore = require("../taxonomy");
const { readStatuses } = require("../statuses");
const { getStartup } = require("../startups");
const { NAMES } = require("./tool-definitions");
const PRIORITIES = require("../../content/priorities.json");

const SECTIONS = Object.freeze({
  mk: { collection: "items", bin: "deletedItems" },
  po: { collection: "programs", bin: "deletedPrograms" },
  fu: { collection: "funding", bin: "deletedFunding" },
});
const PROFILE_KEYS = ["oneLiner", "description", "industry", "website", "links", "country", "entityType", "currency", "homeRegion", "aiContext", "maxNewTargetsPerDay"];
const PRIORITY_LABELS = PRIORITIES.priorities.flatMap((priority) => priority.legacy || []);
const MAX_RESULTS = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ToolError extends Error {
  constructor(message, code = "toolError", statusCode = 400) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sectionOf(value) {
  const section = SECTIONS[value];
  if (!section) throw new ToolError("section must be mk, po or fu.");
  return section;
}

function list(store, startupId, name) {
  const value = store.readSection(startupId, name);
  return Array.isArray(value) ? value : [];
}

function prepareRegistry(store, startupId) {
  fieldRegistry.readRegistry();
  Fields.setCustomFields(fieldRegistry.readCustomFields(store));
  Taxonomy.setNodes(taxonomyStore.readNodes(store));
  Taxonomy.setEnabled(store.readSection(startupId, "enabledTaxonomy") || null);
}

function describe(section, record) {
  const core = new Map(Fields.coreFields(section).map((field) => [field.key, field]));
  const value = (key) => (core.get(key) ? Fields.getValue(section, record, core.get(key)) : "");
  return { name: value("name") || record.name || "", link: value("link") || "", status: record.status || "" };
}

function revisionOf(store, startupId, collection, id) {
  const map = store.readRevisionMap(startupId);
  return Number(map.records?.[collection]?.[id] || 0);
}

function today(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function applyCategories(record, section, ids) {
  const picks = (Array.isArray(ids) ? ids : []).map(String).filter((id) => {
    const node = Taxonomy.get(id);
    return node && node.section === section;
  });
  if (!picks.length) return [];
  record.taxonomy = Taxonomy.normalizeSelection(picks);
  const legacy = Taxonomy.legacyFields(record.taxonomy, record);
  record.category = legacy.category;
  record.subcategory = legacy.subcategory;
  record.type = legacy.type;
  if (section === "mk") record.subcategories = legacy.subcategories;
  return picks;
}

// Runs one tool. ctx: { store, startupId, run: { id, harness, model },
// mutationId, timeZone, onChange(change), results }. `results` (a Map kept
// for the run) holds the answer of each write by mutation id, so a retried
// call gets the first answer instead of running again.
function callTool(name, input, ctx) {
  if (!NAMES.includes(name)) throw new ToolError(`Unknown tool ${name}.`, "unknownTool", 404);
  const key = ctx.mutationId ? `${name}\0${ctx.mutationId}` : "";
  if (key && ctx.results?.has(key)) return { ...ctx.results.get(key), replayed: true };
  const result = runTool(name, input, ctx);
  if (key && ctx.results) ctx.results.set(key, result);
  return result;
}

function runTool(name, input, ctx) {
  const args = input && typeof input === "object" ? input : {};
  const { store, startupId } = ctx;
  if (!startupId || startupId === GLOBAL_STARTUP_ID) throw new ToolError("A run works on one startup.", "badStartup", 403);
  prepareRegistry(store, startupId);
  const write = (operations, label) => store.applyOperations(startupId, operations, {
    origin: "agent",
    actor: `${ctx.run?.harness || "Agent"}${ctx.run?.model ? ` · ${ctx.run.model}` : ""}`.slice(0, 120),
    label: label || `Run ${ctx.run?.id || ""}`.trim(),
    mutationId: ctx.mutationId || undefined,
  });

  switch (name) {
    case "get_startup_context": {
      const startup = getStartup(store, startupId);
      const profile = store.readSection(startupId, "profile") || {};
      const out = { id: startupId, name: startup?.name || "", today: today(ctx.timeZone), timeZone: ctx.timeZone || "" };
      for (const key of PROFILE_KEYS) if (profile[key] !== undefined && profile[key] !== "") out[key] = profile[key];
      // Company: the legal form only. Sensitive values (ID numbers, bank
      // accounts) are never part of a tool's answer.
      const company = store.readSection(startupId, "companyProfile");
      if (company && typeof company === "object") out.company = { template: company.templateId || "", legalForm: company.legalForm || "", incorporated: company.incorporated !== false };
      return out;
    }
    case "get_taxonomy": {
      const wanted = args.section ? [args.section] : ["mk", "po", "fu"];
      for (const section of wanted) sectionOf(section);
      const nodes = Taxonomy.all().filter((node) => wanted.includes(node.section) && Taxonomy.isEnabled(node.id));
      return { categories: nodes.map((node) => ({ id: node.id, section: node.section, level: node.level, parentId: node.parentId || "", name: node.name, description: node.description || "" })) };
    }
    case "list_tags":
      return { tags: list(store, GLOBAL_STARTUP_ID, "tags").map((tag) => ({ id: tag.id, label: tag.label || tag.id, description: tag.description || "" })) };
    case "list_campaigns":
      return { campaigns: list(store, GLOBAL_STARTUP_ID, "campaigns").map((campaign) => ({ id: campaign.id, name: campaign.name, status: campaign.status || "", startDate: campaign.startDate || "", endDate: campaign.endDate || "" })) };
    case "search_targets": {
      const query = String(args.query || "").trim();
      if (!query) throw new ToolError("query is required.");
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), MAX_RESULTS);
      const urlKey = AiImport.urlKey(query);
      const words = AiImport.nameKey(query).split(" ").filter(Boolean);
      const results = [];
      for (const [section, { collection, bin }] of Object.entries(SECTIONS)) {
        if (args.section && args.section !== section) continue;
        for (const [inBin, records] of [[false, list(store, startupId, collection)], [true, list(store, startupId, bin)]]) {
          for (const record of records) {
            const described = describe(section, record);
            const byLink = urlKey && described.link && AiImport.urlKey(described.link) === urlKey;
            const haystack = AiImport.nameKey(`${described.name} ${described.link} ${record.notes || ""}`);
            if (byLink || (words.length && words.every((word) => haystack.includes(word)))) {
              results.push({ section, id: String(record.id), ...described, inRecycleBin: inBin, match: byLink ? "link" : "text" });
            }
          }
        }
      }
      results.sort((a, b) => (a.match === "link" ? -1 : 0) - (b.match === "link" ? -1 : 0));
      return { results: results.slice(0, limit), total: results.length };
    }
    case "get_target": {
      const { collection } = sectionOf(args.section);
      const record = list(store, startupId, collection).find((entry) => String(entry.id) === String(args.id));
      if (!record) throw new ToolError("No such target.", "notFound", 404);
      return { section: args.section, revision: revisionOf(store, startupId, collection, record.id), record };
    }
    case "create_target": {
      const { collection } = sectionOf(args.section);
      const existing = list(store, startupId, collection).map((record) => ({ id: record.id, ...describe(args.section, record) }));
      const statuses = readStatuses(store);
      const [row] = AiImport.check([{ ...(args.fields || {}), section: args.section, notes: args.notes || "", categories: args.categories || [] }], {
        Fields,
        isStatus: (id) => statuses.statuses.some((status) => status.id === id),
        defaultStatus: () => statuses.defaultStatus,
        priorities: PRIORITY_LABELS,
        category: (id) => Taxonomy.get(id),
        existing: { [args.section]: existing },
      });
      if (!row.ok) throw new ToolError(row.problems.join(" "), "invalid");
      if (row.duplicateOf) throw new ToolError(`A target with the same ${row.duplicateOf.reason} exists: ${row.duplicateOf.name} (id ${row.duplicateOf.id}). Update it instead.`, "duplicate", 409);
      const now = new Date().toISOString();
      const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const record = AiImport.toRecord(row, Fields, { id, now });
      applyCategories(record, args.section, row.categories);
      const result = write([{ type: "upsert", section: collection, id, value: record, baseRevision: 0 }]);
      const revision = revisionOf(store, startupId, collection, id);
      ctx.onChange?.({ section: collection, kind: args.section, id, event: "created", before: null, after: record, revision });
      return { section: args.section, id, revision, warnings: row.warnings, replayed: Boolean(result.replayed) };
    }
    case "update_target": {
      const { collection } = sectionOf(args.section);
      const current = list(store, startupId, collection).find((entry) => String(entry.id) === String(args.id));
      if (!current) throw new ToolError("No such target. Agents cannot restore or delete targets.", "notFound", 404);
      const revision = revisionOf(store, startupId, collection, current.id);
      if (Number(args.baseRevision) !== revision) throw new ToolError(`The target changed since revision ${args.baseRevision} (now ${revision}). Read it again with get_target.`, "conflict", 409);
      const next = JSON.parse(JSON.stringify(current));
      const warnings = [];
      const known = new Map();
      Fields.coreFields(args.section).forEach((field) => known.set(field.key, field));
      Fields.detailGroups(args.section).forEach((group) => group.fields.forEach((field) => known.set(field.key, field)));
      Fields.customFields(args.section).forEach((field) => known.set(field.key, field));
      for (const [key, raw] of Object.entries(args.fields || {})) {
        const field = known.get(key);
        if (!field || ["id", "taxonomy", "readonly-id"].includes(field.key) || field.type === "readonly-id") {
          warnings.push(`"${key}" is not a field this tool can set and is left out.`);
          continue;
        }
        if (raw === null || raw === "") continue;
        const value = Fields.normalize(field, raw);
        if (Fields.isEmpty(field, value)) {
          warnings.push(`"${key}" could not be read as ${field.type} and is left out.`);
          continue;
        }
        Fields.setValue(args.section, next, field, value);
      }
      if (Array.isArray(args.categories) && args.categories.length) applyCategories(next, args.section, args.categories);
      next.updatedAt = new Date().toISOString();
      const result = write([{ type: "upsert", section: collection, id: String(current.id), value: next, baseRevision: revision }]);
      const after = revisionOf(store, startupId, collection, current.id);
      ctx.onChange?.({ section: collection, kind: args.section, id: String(current.id), event: "updated", before: current, after: next, revision: after });
      return { section: args.section, id: String(current.id), revision: after, warnings, replayed: Boolean(result.replayed) };
    }
    case "append_note": {
      const { collection } = sectionOf(args.section);
      const current = list(store, startupId, collection).find((entry) => String(entry.id) === String(args.id));
      if (!current) throw new ToolError("No such target.", "notFound", 404);
      const text = String(args.text || "").trim();
      if (!text) throw new ToolError("text is required.");
      const next = { ...current, notes: `${String(current.notes || "").trimEnd()}${current.notes ? "\n\n" : ""}${today(ctx.timeZone)}: ${text}`, updatedAt: new Date().toISOString() };
      const revision = revisionOf(store, startupId, collection, current.id);
      const result = write([{ type: "upsert", section: collection, id: String(current.id), value: next, baseRevision: revision }]);
      const after = revisionOf(store, startupId, collection, current.id);
      ctx.onChange?.({ section: collection, kind: args.section, id: String(current.id), event: "updated", before: current, after: next, revision: after });
      return { section: args.section, id: String(current.id), revision: after, replayed: Boolean(result.replayed) };
    }
    case "link_records": {
      const from = { kind: String(args.from?.kind || ""), id: String(args.from?.id || "") };
      const to = { kind: String(args.to?.kind || ""), id: String(args.to?.id || "") };
      let link;
      try {
        link = Links.makeLink(from, to, args.relation || "related", args.context ? { context: String(args.context).slice(0, 200) } : {});
      } catch (error) {
        throw new ToolError(error.message, "invalidLink");
      }
      for (const end of [from, to]) {
        const section = Links.KINDS[end.kind]?.section;
        if (!section || !list(store, startupId, section).some((record) => String(record.id) === end.id)) throw new ToolError(`No ${end.kind} record ${end.id} in this startup.`, "notFound", 404);
      }
      const existing = list(store, startupId, Links.LINKS_SECTION).find((entry) => entry.id === link.id);
      if (existing) return { id: link.id, created: false };
      const result = write([{ type: "upsert", section: Links.LINKS_SECTION, id: link.id, value: link, baseRevision: 0 }]);
      ctx.onChange?.({ section: Links.LINKS_SECTION, kind: "link", id: link.id, event: "created", before: null, after: link, revision: revisionOf(store, startupId, Links.LINKS_SECTION, link.id) });
      return { id: link.id, created: true, replayed: Boolean(result.replayed) };
    }
    case "get_calendar_load": {
      if (!DATE.test(args.from || "") || !DATE.test(args.to || "") || args.from > args.to) throw new ToolError("from and to must be dates (YYYY-MM-DD), from first.");
      const days = {};
      for (const collection of ["items", "programs", "funding"]) {
        for (const record of list(store, startupId, collection)) {
          for (const event of CalendarModel.recordEvents(collection, record)) {
            if (event.date >= args.from && event.date <= args.to) days[event.date] = (days[event.date] || 0) + 1;
          }
        }
      }
      const profile = store.readSection(startupId, "profile") || {};
      return { from: args.from, to: args.to, maxNewTargetsPerDay: Number(profile.maxNewTargetsPerDay) || 10, days };
    }
    default:
      throw new ToolError(`Unknown tool ${name}.`, "unknownTool", 404);
  }
}

module.exports = { SECTIONS, ToolError, callTool };
