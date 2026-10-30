"use strict";

// Settings shared by every startup, kept as one object in the global scope's
// "settings" section. Reads always come back complete: stored values over the
// defaults. Writes are checked key by key, so a bad value is refused with the
// field it belongs to instead of being saved and breaking the page later.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { normalizeRetentionDays } = require("./recycle-bin");

const SETTINGS_SECTION = "settings";
const THEMES = ["studio", "ledger", "nightshift", "fieldnotes", "meridian", "lacquer", "shinjuku", "quiet", "tactile", "broadsheet", "signal", "coda"];
// Older palette-only ids still name a theme. Keep this table in step with
// LEGACY_TASTES in public/scripts/taste-switcher.js and js/boot.js: the server
// resolves saved settings before the browser sees them, so without the map an
// old choice would silently become Studio.
const THEME_ALIASES = Object.freeze({
  a: "meridian",
  b: "studio",
  c: "signal",
  kinpaku: "lacquer",
  paper: "broadsheet",
  mirai: "shinjuku",
  aurora: "fieldnotes",
  cyber: "nightshift",
  "soft-ui": "tactile",
  linear: "meridian",
  minimal: "signal",
  classic: "studio",
});

function themeAlias(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(THEME_ALIASES, value) ? THEME_ALIASES[value] : value;
}
// The same lists as public/js/dates.js (tests/dates.test.js checks).
const DATE_FORMATS = ["system", "d MMM yyyy", "MMM d, yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy"];
const WEEK_STARTS = ["monday", "sunday", "saturday"];
// Section colours (public/js/sections.js): a palette, and a picked colour per
// section that overrides it ("" keeps the palette's).
const SECTION_IDS = ["mk", "po", "fu", "comp"];
const SECTION_PALETTES = ["standard", "colorblind"];

const DEFAULT_SETTINGS = Object.freeze({
  appName: "Startup Tracker",
  language: "en",
  timeZone: "",
  dateFormat: "system",
  weekStart: "monday",
  pageSize: 25,
  yourName: "",
  network: true,
  defaultScope: "startup",
  appearance: Object.freeze({ mode: "system", theme: "studio" }),
  sectionColors: Object.freeze({ palette: "standard", mk: "", po: "", fu: "", comp: "" }),
  backups: Object.freeze({ automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 20 }),
  recycleBin: Object.freeze({ retentionDays: 30 }),
});

class SettingsError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = "SettingsError";
    this.field = field;
    this.code = "badSetting";
    this.statusCode = 400;
  }
}

let knownTimeZones = null;
function isTimeZone(value) {
  if (!knownTimeZones) knownTimeZones = new Set(Intl.supportedValuesOf("timeZone"));
  if (knownTimeZones.has(value)) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function text(field, value, { min = 0, max }) {
  if (typeof value !== "string") throw new SettingsError(field, "must be text.");
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < min) throw new SettingsError(field, "cannot be empty.");
  if (cleaned.length > max) throw new SettingsError(field, `keep it under ${max} characters.`);
  return cleaned;
}

function oneOf(field, value, allowed) {
  if (!allowed.includes(value)) throw new SettingsError(field, `must be one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}.`);
  return value;
}

function integer(field, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new SettingsError(field, `must be a whole number from ${min} to ${max}.`);
  return number;
}

function object(field, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsError(field, "must be an object.");
  return value;
}

function onlyKeys(field, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new SettingsError(`${field}.${key}`, "is not a setting.");
  }
}

const VALIDATORS = {
  appName: (value) => text("appName", value, { min: 1, max: 60 }),
  language: (value) => oneOf("language", value, ["en"]),
  timeZone: (value) => {
    if (value === "") return "";
    if (typeof value !== "string" || !isTimeZone(value)) throw new SettingsError("timeZone", "is not a time zone this system knows.");
    return value;
  },
  dateFormat: (value) => oneOf("dateFormat", value, DATE_FORMATS),
  weekStart: (value) => oneOf("weekStart", value, WEEK_STARTS),
  pageSize: (value) => integer("pageSize", value, 10, 200),
  yourName: (value) => text("yourName", value, { max: 80 }),
  network: (value) => {
    if (typeof value !== "boolean") throw new SettingsError("network", "must be true or false.");
    return value;
  },
  defaultScope: (value) => oneOf("defaultScope", value, ["startup", "all"]),
  appearance: (value, current) => {
    object("appearance", value);
    onlyKeys("appearance", value, ["mode", "theme"]);
    const next = { ...current };
    if (value.mode !== undefined) next.mode = oneOf("appearance.mode", value.mode, ["system", "light", "dark"]);
    if (value.theme !== undefined) next.theme = oneOf("appearance.theme", themeAlias(value.theme), THEMES);
    return next;
  },
  sectionColors: (value, current) => {
    object("sectionColors", value);
    onlyKeys("sectionColors", value, ["palette", ...SECTION_IDS]);
    const next = { ...current };
    if (value.palette !== undefined) next.palette = oneOf("sectionColors.palette", value.palette, SECTION_PALETTES);
    for (const id of SECTION_IDS) {
      if (value[id] === undefined) continue;
      if (value[id] !== "" && !(typeof value[id] === "string" && /^#[0-9a-f]{6}$/i.test(value[id]))) {
        throw new SettingsError(`sectionColors.${id}`, "must be a colour such as #2563eb, or empty for the palette's colour.");
      }
      next[id] = value[id].toLowerCase();
    }
    return next;
  },
  backups: (value, current) => {
    object("backups", value);
    onlyKeys("backups", value, ["automatic", "intervalHours", "keepAutomatic", "keepSafety"]);
    const next = { ...current };
    if (value.automatic !== undefined) {
      if (typeof value.automatic !== "boolean") throw new SettingsError("backups.automatic", "must be true or false.");
      next.automatic = value.automatic;
    }
    if (value.intervalHours !== undefined) next.intervalHours = integer("backups.intervalHours", value.intervalHours, 1, 8760);
    if (value.keepAutomatic !== undefined) next.keepAutomatic = integer("backups.keepAutomatic", value.keepAutomatic, 1, 1000);
    if (value.keepSafety !== undefined) next.keepSafety = integer("backups.keepSafety", value.keepSafety, 1, 1000);
    return next;
  },
  recycleBin: (value, current) => {
    object("recycleBin", value);
    onlyKeys("recycleBin", value, ["retentionDays"]);
    const next = { ...current };
    if (value.retentionDays !== undefined) {
      try {
        next.retentionDays = normalizeRetentionDays(value.retentionDays);
      } catch (error) {
        throw new SettingsError("recycleBin.retentionDays", error.message);
      }
    }
    return next;
  },
};

function defaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

// Stored values over the defaults. A stored value that no longer validates
// (a theme that was removed, a zone the system dropped) falls back to its
// default instead of failing the whole read.
function resolveSettings(stored) {
  const result = defaults();
  if (!stored || typeof stored !== "object") return result;
  for (const [key, validate] of Object.entries(VALIDATORS)) {
    if (stored[key] === undefined) continue;
    let value = stored[key];
    if (key === "appearance" && value && typeof value === "object" && value.theme !== undefined) {
      value = { ...value, theme: themeAlias(value.theme) };
    }
    try {
      result[key] = validate(value, result[key]);
    } catch {
      // Keep the default.
    }
  }
  return result;
}

function readSettings(store) {
  return resolveSettings(store.readSection(GLOBAL_STARTUP_ID, SETTINGS_SECTION));
}

// Applies a partial change and returns the complete result. Objects merge one
// level deep, so { backups: { keepSafety: 5 } } leaves keepAutomatic alone.
function mergeSettings(current, patch) {
  object("settings", patch);
  const next = JSON.parse(JSON.stringify(current));
  for (const [key, value] of Object.entries(patch)) {
    const validate = VALIDATORS[key];
    if (!validate) throw new SettingsError(key, "is not a setting.");
    next[key] = validate(value, current[key]);
  }
  return next;
}

function writeSettings(store, patch, options = {}) {
  const next = mergeSettings(readSettings(store), patch);
  const result = store.replaceSection(GLOBAL_STARTUP_ID, SETTINGS_SECTION, next, { origin: "api", ...options });
  return { settings: next, revision: result.revision };
}

module.exports = {
  SETTINGS_SECTION,
  DEFAULT_SETTINGS,
  THEMES,
  THEME_ALIASES,
  DATE_FORMATS,
  WEEK_STARTS,
  SettingsError,
  defaults,
  resolveSettings,
  readSettings,
  mergeSettings,
  writeSettings,
};
