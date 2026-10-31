"use strict";

// The field registry the record window draws (content/fields/*.json), read
// once and handed to public/js/fields.js, so the server and the page agree on
// every field.

const fs = require("fs");
const path = require("path");
const Fields = require("../public/js/fields.js");

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

module.exports = { readRegistry };
