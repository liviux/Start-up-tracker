"use strict";

// Tags are shared by every startup (Extra > Tags). A record keeps its tags as
// lowercase strings in `tags`; the global "tags" section holds a label,
// description and colour for those that have one. Renaming, merging or
// deleting a tag rewrites every record that carries it, in every startup and
// in the global campaigns, each write with its own history entry.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { listStartups } = require("./startups");

const TAGS_SECTION = "tags";
const DELETED_TAGS_SECTION = "deletedTags";
const STARTUP_TAGGED_SECTIONS = Object.freeze([
  "items", "deletedItems",
  "programs", "deletedPrograms",
  "funding", "deletedFunding",
  "mediaItems", "deletedMediaItems",
  "feedbackItems", "deletedFeedbackItems",
]);
const GLOBAL_TAGGED_SECTIONS = Object.freeze(["campaigns", "deletedCampaigns"]);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

class TagError extends Error {
  constructor(message, code = "badTag", statusCode = 400) {
    super(message);
    this.name = "TagError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// The same rule as the page: trimmed, lowercase, up to 60 characters.
function normalizeTag(value) {
  const tag = String(value ?? "").trim().toLowerCase();
  return tag.length > 0 && tag.length <= 60 ? tag : "";
}

function requireTag(value, name) {
  const tag = normalizeTag(value);
  if (!tag) throw new TagError(`${name} must be a tag of 1 to 60 characters.`, "badTag");
  return tag;
}

function scopes(store) {
  const list = listStartups(store, { includeArchived: true }).map((startup) => ({ id: startup.id, name: startup.name, sections: STARTUP_TAGGED_SECTIONS }));
  list.push({ id: GLOBAL_STARTUP_ID, name: "", sections: GLOBAL_TAGGED_SECTIONS });
  return list;
}

function recordsOf(store, scopeId, section) {
  const records = store.readSection(scopeId, section);
  return Array.isArray(records) ? records : [];
}

// How often each tag is used, per startup and per section, counted over
// every startup (archived ones too) and the global campaigns. Deleted
// records count separately, so "in use" never hides what the bin holds.
function tagUsage(store) {
  const usage = {};
  const bump = (tag, scope, section) => {
    if (!usage[tag]) usage[tag] = { total: 0, inBin: 0, startups: {} };
    const entry = usage[tag];
    const inBin = section.startsWith("deleted");
    if (inBin) entry.inBin += 1;
    else entry.total += 1;
    if (!entry.startups[scope.id]) entry.startups[scope.id] = { name: scope.name, count: 0, sections: {} };
    const bucket = entry.startups[scope.id];
    if (!inBin) bucket.count += 1;
    bucket.sections[section] = (bucket.sections[section] || 0) + 1;
  };
  for (const scope of scopes(store)) {
    for (const section of scope.sections) {
      for (const record of recordsOf(store, scope.id, section)) {
        const seen = new Set();
        for (const raw of Array.isArray(record?.tags) ? record.tags : []) {
          const tag = normalizeTag(raw);
          if (tag && !seen.has(tag)) {
            seen.add(tag);
            bump(tag, scope, section);
          }
        }
      }
    }
  }
  return usage;
}

// Rewrites the tags of every record carrying one of `from`: they become `to`,
// or are dropped when `to` is empty. Returns how many records changed.
function rewriteRecords(store, from, to, { origin, actor, label }) {
  const fromSet = new Set(from);
  let changed = 0;
  const startupsChanged = [];
  const now = new Date().toISOString();
  for (const scope of scopes(store)) {
    const operations = [];
    const revisions = store.readRevisionMap(scope.id);
    for (const section of scope.sections) {
      for (const record of recordsOf(store, scope.id, section)) {
        const tags = Array.isArray(record?.tags) ? record.tags.map(normalizeTag).filter(Boolean) : [];
        if (!tags.some((tag) => fromSet.has(tag))) continue;
        const next = [];
        for (const tag of tags) {
          const value = fromSet.has(tag) ? to : tag;
          if (value && !next.includes(value)) next.push(value);
        }
        const id = String(record.id);
        operations.push({
          type: "upsert",
          section,
          id,
          value: { ...record, tags: next, updatedAt: now },
          baseRevision: revisions?.records?.[section]?.[id] ?? undefined,
        });
      }
    }
    if (!operations.length) continue;
    store.applyOperations(scope.id, operations, { origin, actor, label });
    changed += operations.length;
    if (scope.id !== GLOBAL_STARTUP_ID) startupsChanged.push(scope.id);
  }
  return { recordsChanged: changed, startupsChanged };
}

function readDefinitions(store) {
  return recordsOf(store, GLOBAL_STARTUP_ID, TAGS_SECTION);
}

function cleanDefinition(definition) {
  const id = requireTag(definition?.id, "id");
  const clean = { id, label: String(definition?.label || id).trim().slice(0, 60) || id, description: String(definition?.description || "").trim().slice(0, 1000) };
  const color = String(definition?.color || "").trim();
  if (color) {
    if (!COLOR_PATTERN.test(color)) throw new TagError("A tag colour is a hex colour such as #3366cc.", "badColor");
    clean.color = color.toLowerCase();
  }
  return clean;
}

// Renames `from` to `to` everywhere. When `to` already exists this is a merge
// of the two, so it goes through mergeTags.
function renameTag(store, fromValue, toValue, options = {}) {
  const from = requireTag(fromValue, "from");
  const to = requireTag(toValue, "to");
  if (from === to) return { recordsChanged: 0, startupsChanged: [], tag: to };
  return mergeTags(store, [from], to, { ...options, label: options.label || `Tag renamed: ${from} to ${to}` });
}

// Every tag in `fromValues` becomes `to`, on the records and in the
// definitions: the kept definition takes the first description and colour it
// finds when its own are empty.
function mergeTags(store, fromValues, toValue, { origin = "ui", actor, label } = {}) {
  const to = requireTag(toValue, "to");
  const from = [...new Set((Array.isArray(fromValues) ? fromValues : [fromValues]).map((value) => requireTag(value, "from")))].filter((tag) => tag !== to);
  if (!from.length) throw new TagError("Pick at least one other tag to merge.", "nothingToMerge");
  const writeLabel = label || `Tags merged into ${to}`;
  const result = rewriteRecords(store, from, to, { origin, actor, label: writeLabel });

  const definitions = readDefinitions(store);
  const merged = definitions.find((definition) => normalizeTag(definition?.id) === to);
  const sources = definitions.filter((definition) => from.includes(normalizeTag(definition?.id)));
  const keep = cleanDefinition(merged || { id: to, label: to, description: "" });
  for (const source of sources) {
    if (!keep.description && source.description) keep.description = String(source.description).trim();
    if (!keep.color && COLOR_PATTERN.test(String(source.color || ""))) keep.color = String(source.color).toLowerCase();
  }
  const revisions = store.readRevisionMap(GLOBAL_STARTUP_ID);
  const baseOf = (id) => revisions?.records?.[TAGS_SECTION]?.[id] ?? undefined;
  const operations = sources.map((source) => ({ type: "delete", section: TAGS_SECTION, id: String(source.id), baseRevision: baseOf(String(source.id)) }));
  operations.push({ type: "upsert", section: TAGS_SECTION, id: to, value: keep, baseRevision: merged ? baseOf(String(merged.id)) : 0 });
  store.applyOperations(GLOBAL_STARTUP_ID, operations, { origin, actor, label: writeLabel });
  return { ...result, tag: to };
}

// Removes a tag from every record and moves its definition to the recycle
// bin, from where it can come back (the records keep no trace of it).
function deleteTag(store, value, { origin = "ui", actor } = {}) {
  const tag = requireTag(value, "tag");
  const label = `Tag deleted: ${tag}`;
  const result = rewriteRecords(store, [tag], "", { origin, actor, label });
  const definition = readDefinitions(store).find((entry) => normalizeTag(entry?.id) === tag);
  if (definition) {
    const revisions = store.readRevisionMap(GLOBAL_STARTUP_ID);
    store.applyOperations(GLOBAL_STARTUP_ID, [
      { type: "delete", section: TAGS_SECTION, id: String(definition.id), baseRevision: revisions?.records?.[TAGS_SECTION]?.[String(definition.id)] ?? undefined },
      { type: "upsert", section: DELETED_TAGS_SECTION, id: String(definition.id), value: { ...definition, deletedAt: new Date().toISOString() } },
    ], { origin, actor, label });
  }
  return { ...result, tag };
}

module.exports = {
  TAGS_SECTION,
  DELETED_TAGS_SECTION,
  STARTUP_TAGGED_SECTIONS,
  GLOBAL_TAGGED_SECTIONS,
  TagError,
  normalizeTag,
  cleanDefinition,
  tagUsage,
  renameTag,
  mergeTags,
  deleteTag,
};
