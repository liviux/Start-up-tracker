"use strict";

// The option lists shared by every startup (public/js/options.js): shipped
// in content/options.json, edited ones kept whole in the global
// "optionLists" section. A list set back to null returns to the shipped one.

const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const Options = require("../public/js/options.js");
const fieldRegistry = require("./field-registry");

const OPTIONS_SECTION = "optionLists";
const DEFAULT_FILE = path.join(__dirname, "..", "content", "options.json");

let cached = null;

// The shipped lists. The documents checklist lives with the Programs fields,
// so the field registry and this list never disagree.
function readDefaults(file = DEFAULT_FILE) {
  if (cached && cached.file === file) return cached.defaults;
  const defaults = JSON.parse(fs.readFileSync(file, "utf8"));
  const registry = fieldRegistry.readRegistry();
  const documents = [...(registry.common?.activities || []), ...(registry.po?.activities || [])].find((activity) => activity.checklist);
  defaults.documentChecklist = documents ? documents.checklist.map(({ id, label, description }) => ({ id, label, description })) : [];
  cached = { file, defaults };
  return defaults;
}

function readStored(store) {
  const value = store.readSection(GLOBAL_STARTUP_ID, OPTIONS_SECTION);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean = {};
  for (const name of Options.LIST_NAMES) if (Array.isArray(value[name])) clean[name] = value[name];
  return clean;
}

function readOptions(store) {
  const defaults = readDefaults();
  const stored = readStored(store);
  const lists = {};
  for (const name of Options.LIST_NAMES) lists[name] = stored[name] || defaults[name] || [];
  return { lists, defaults, stored };
}

// Saves the lists named in `changes`: a list replaces the stored one, null
// removes it. Every list is checked before anything is written.
function writeOptions(store, changes, { origin = "ui", actor } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Options.OptionError("lists must be an object of option lists.");
  const next = { ...readStored(store) };
  for (const [name, list] of Object.entries(changes)) {
    if (!Options.specOf(name)) throw new Options.OptionError(`Unknown option list "${name}".`, "unknownList");
    if (list === null) delete next[name];
    else next[name] = Options.validateList(name, list);
  }
  store.replaceSection(GLOBAL_STARTUP_ID, OPTIONS_SECTION, next, { origin, actor, label: "Option lists" });
  return readOptions(store);
}

module.exports = { OPTIONS_SECTION, readDefaults, readOptions, writeOptions };
