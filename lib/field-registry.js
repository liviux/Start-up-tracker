"use strict";

// The field registry the record window draws (content/fields/*.json) and the
// custom fields people add in Extra > Fields. Custom field definitions are
// global, shared by every startup, in the "customFields" collection; their
// values live on each record under `custom`. The checks are the page's own
// (public/js/fields.js), so both sides agree on what a valid field is.

const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const Fields = require("../public/js/fields.js");

const CUSTOM_FIELDS_SECTION = "customFields";
const FILES = ["common", "mk", "po", "fu"];
const DEFAULT_DIR = path.join(__dirname, "..", "content", "fields");

let cached = null;

function readRegistry(dir = DEFAULT_DIR) {
  if (cached && cached.dir === dir) return cached.registry;
  const registry = {};
  for (const name of FILES) registry[name] = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  cached = { dir, registry };
  Fields.setRegistry(registry);
  return registry;
}

function readCustomFields(store) {
  const list = store.readSection(GLOBAL_STARTUP_ID, CUSTOM_FIELDS_SECTION);
  return Array.isArray(list) ? list : [];
}

// Replaces the custom field list after checking every definition. A field
// that is removed keeps its values on the records; they show under "Other
// fields" until a field with the same key comes back.
function writeCustomFields(store, list, { origin = "ui", actor } = {}) {
  readRegistry();
  if (!Array.isArray(list)) throw new Fields.FieldError("fields must be a list.");
  if (list.length > 300) throw new Fields.FieldError("Up to 300 custom fields are kept.", "tooMany");
  const clean = [];
  for (const definition of list) clean.push(Fields.validateCustomField(definition, clean));
  store.replaceSection(GLOBAL_STARTUP_ID, CUSTOM_FIELDS_SECTION, clean, { origin, actor, label: "Custom fields" });
  return clean;
}

module.exports = { CUSTOM_FIELDS_SECTION, readRegistry, readCustomFields, writeCustomFields };
