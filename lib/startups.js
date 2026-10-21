"use strict";

// The startup list: one record per startup in the global scope's "startups"
// collection. Ids come from makeStartupId and never change on rename.

const { GLOBAL_STARTUP_ID, STARTUPS_SECTION, makeStartupId, normalizeStartupId } = require("./tracker-sqlite-store");

const MAX_NAME_LENGTH = 120;
// Per-startup sections that "copy settings from another startup" copies.
// Records (targets, media, feedback...) are copied only on request.
const STARTUP_SETTINGS_SECTIONS = ["profile", "enabledTaxonomy", "uiPreferences"];

class StartupError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function cleanName(name) {
  const value = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!value) throw new StartupError(400, "A startup needs a name.", "nameRequired");
  if (value.length > MAX_NAME_LENGTH) throw new StartupError(400, `Keep the name under ${MAX_NAME_LENGTH} characters.`, "nameTooLong");
  return value;
}

function cleanIcon(icon) {
  const value = String(icon ?? "").trim();
  // An icon is a small image stored inline (resized in the browser to 256 px).
  if (value && !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i.test(value)) {
    throw new StartupError(400, "The icon must be a PNG, JPG, GIF, WebP, SVG or ICO image.", "badIcon");
  }
  if (value.length > 400_000) throw new StartupError(413, "The icon is too large.", "iconTooLarge");
  return value;
}

function readList(store) {
  const list = store.readSection(GLOBAL_STARTUP_ID, STARTUPS_SECTION);
  return Array.isArray(list) ? list : [];
}

function listStartups(store, { includeArchived = true } = {}) {
  return readList(store)
    .filter((startup) => includeArchived || !startup.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

function getStartup(store, startupId) {
  let id;
  try {
    id = normalizeStartupId(startupId);
  } catch {
    return null;
  }
  if (id === GLOBAL_STARTUP_ID) return null;
  return readList(store).find((startup) => startup.id === id) || null;
}

function writeStartupRecord(store, record, options) {
  if (store.readSection(GLOBAL_STARTUP_ID, STARTUPS_SECTION) === undefined) {
    return store.replaceSection(GLOBAL_STARTUP_ID, STARTUPS_SECTION, [record], options);
  }
  return store.upsertRecord(GLOBAL_STARTUP_ID, STARTUPS_SECTION, record, options);
}

// copyProfileFields lists the profile fields to copy; left out, the whole
// profile is copied.
function createStartup(store, { name, icon = "", copySettingsFrom = "", copyProfileFields = null, copyRecords = false } = {}, options = {}) {
  const cleanedName = cleanName(name);
  const existing = readList(store);
  let id = makeStartupId(cleanedName);
  while (existing.some((startup) => startup.id === id)) id = makeStartupId(cleanedName);
  const now = new Date().toISOString();
  const record = {
    id,
    name: cleanedName,
    icon: cleanIcon(icon),
    order: existing.reduce((max, startup) => Math.max(max, Number(startup.order) || 0), -1) + 1,
    createdAt: now,
    lastOpenedAt: "",
    archived: false,
  };

  if (copySettingsFrom) {
    const source = getStartup(store, copySettingsFrom);
    if (!source) throw new StartupError(404, "The startup to copy settings from does not exist.", "unknownSource");
    const sourceState = store.readState(source.id).state;
    const copied = {};
    for (const [section, value] of Object.entries(sourceState)) {
      if (STARTUP_SETTINGS_SECTIONS.includes(section) || (copyRecords && Array.isArray(value))) copied[section] = value;
    }
    if (Array.isArray(copyProfileFields) && copied.profile && typeof copied.profile === "object" && !Array.isArray(copied.profile)) {
      const fields = new Set(copyProfileFields.map(String));
      copied.profile = Object.fromEntries(Object.entries(copied.profile).filter(([field]) => fields.has(field)));
    }
    if (Object.keys(copied).length) store.replaceState(id, copied, { origin: options.origin || "api", label: `Copied from ${source.name}` });
  }
  writeStartupRecord(store, record, options);
  return record;
}

function updateStartup(store, startupId, patch = {}, options = {}) {
  const current = getStartup(store, startupId);
  if (!current) throw new StartupError(404, "Unknown startup.", "unknownStartup");
  const next = { ...current };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.icon !== undefined) next.icon = cleanIcon(patch.icon);
  if (patch.order !== undefined) {
    const order = Number(patch.order);
    if (!Number.isInteger(order) || order < 0) throw new StartupError(400, "order must be a non-negative integer.", "badOrder");
    next.order = order;
  }
  if (patch.archived !== undefined) next.archived = Boolean(patch.archived);
  if (patch.lastOpenedAt !== undefined) next.lastOpenedAt = String(patch.lastOpenedAt);
  writeStartupRecord(store, next, options);
  return next;
}

// Removes the startup's rows and its list entry. The caller takes the safety
// backup and removes the media folder.
function deleteStartup(store, startupId, options = {}) {
  const current = getStartup(store, startupId);
  if (!current) throw new StartupError(404, "Unknown startup.", "unknownStartup");
  store.deleteStartupData(current.id);
  store.deleteRecord(GLOBAL_STARTUP_ID, STARTUPS_SECTION, current.id, options);
  return current;
}

module.exports = {
  STARTUP_SETTINGS_SECTIONS,
  StartupError,
  listStartups,
  getStartup,
  createStartup,
  updateStartup,
  deleteStartup,
};
