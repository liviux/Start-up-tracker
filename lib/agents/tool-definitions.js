"use strict";

// The tracker tools an agent run gets, as MCP tool definitions. They are
// served by bin/tracker-mcp.js and carried out by the tracker
// (lib/agents/tools.js) with the run's own token. There is no delete tool.

const SECTION = { type: "string", enum: ["mk", "po", "fu"], description: "mk = Marketing, po = Programs and opportunities, fu = Funding." };
const CATEGORIES = { type: "array", items: { type: "string" }, description: "Category ids from get_taxonomy, primary first. Several are allowed." };

const TOOLS = Object.freeze([
  {
    name: "get_startup_context",
    description: "The startup this run works for: name, profile, the company and founders text, the daily limit for new targets, today's date and time zone.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "get_taxonomy",
    description: "The categories, subcategories and types this startup has turned on, with their ids and descriptions.",
    inputSchema: { type: "object", properties: { section: SECTION }, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_tags",
    description: "The tags in use, with their descriptions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "list_campaigns",
    description: "The campaigns, with their ids, status and dates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "search_targets",
    description: "Finds targets by text or web address, in the lists and the recycle bin, to check for duplicates before creating one.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words of the name or notes, or a web address." },
        section: SECTION,
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: "get_target",
    description: "One target with all its fields and its current revision (needed by update_target).",
    inputSchema: { type: "object", properties: { section: SECTION, id: { type: "string" } }, required: ["section", "id"], additionalProperties: false },
    readOnly: true,
  },
  {
    name: "create_target",
    description: "Adds a target. Fields use the field registry's names (name, organization, link, status, priority, nextAction, nextActionDate, deadline, owner, tags and the section's own fields). Unknown fields are left out and reported. Check for duplicates first.",
    inputSchema: {
      type: "object",
      properties: {
        section: SECTION,
        fields: { type: "object", description: "Field values by name. \"name\" is required.", additionalProperties: true },
        categories: CATEGORIES,
        notes: { type: "string", description: "Markdown: summary, official sources with the date checked." },
      },
      required: ["section", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: "update_target",
    description: "Changes fields of an existing target. Pass the revision from get_target; if the target changed meanwhile, read it again. Nothing is deleted.",
    inputSchema: {
      type: "object",
      properties: {
        section: SECTION,
        id: { type: "string" },
        baseRevision: { type: "integer", minimum: 0 },
        fields: { type: "object", additionalProperties: true },
        categories: CATEGORIES,
      },
      required: ["section", "id", "baseRevision"],
      additionalProperties: false,
    },
  },
  {
    name: "append_note",
    description: "Adds a dated paragraph at the end of a target's notes.",
    inputSchema: { type: "object", properties: { section: SECTION, id: { type: "string" }, text: { type: "string" } }, required: ["section", "id", "text"], additionalProperties: false },
  },
  {
    name: "link_records",
    description: "Links two records of this startup. Kinds: mk, po, fu, media, feedback, campaign, research. Relations: related, uses, feedback-about, blocks, follow-up-of, funds.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" } }, required: ["kind", "id"] },
        to: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" } }, required: ["kind", "id"] },
        relation: { type: "string" },
        context: { type: "string" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_calendar_load",
    description: "How many dated items fall on each day in a range, so new targets respect the per-day limit.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    readOnly: true,
  },
]);

const NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

module.exports = { TOOLS, NAMES };
