"use strict";

// The company templates in content/company-templates/. Each is checked with
// lib/company/template-schema.js when read; a template with errors is left
// out of the list (npm run check reports it), so a broken file never reaches
// the page. "generic" is the one for any other country or legal form.

const fs = require("fs");
const path = require("path");
const { checkTemplate } = require("./template-schema");

const DEFAULT_DIR = path.join(__dirname, "..", "..", "content", "company-templates");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let cache = null;

function readAll(dir = DEFAULT_DIR) {
  if (cache && cache.dir === dir) return cache;
  const templates = new Map();
  const problems = [];
  let ranking = null;
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      if (file === "index.json") {
        ranking = JSON.parse(text).ranking || null;
        continue;
      }
      const id = file.slice(0, -5);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        problems.push({ id, errors: [`not valid JSON: ${error.message}`] });
        continue;
      }
      const { errors } = checkTemplate(parsed, { fileName: id });
      if (errors.length) {
        problems.push({ id, errors });
        continue;
      }
      templates.set(id, parsed);
    }
  }
  cache = { dir, templates, problems, ranking };
  return cache;
}

// What the template picker shows, sorted by country name with Generic last.
function listTemplates(dir) {
  const { templates, ranking } = readAll(dir);
  const summaries = [...templates.values()].map((template) => ({
    id: template.id,
    country: template.country,
    countryName: template.countryName,
    entityType: template.entityType,
    nameLocal: template.nameLocal,
    nameEnglish: template.nameEnglish,
    currency: template.currency,
    bilingual: template.bilingual,
    verifiedOn: template.verifiedOn,
    draft: Boolean(template.draft),
  }));
  summaries.sort((a, b) => (a.id === "generic") - (b.id === "generic") || String(a.countryName || "").localeCompare(String(b.countryName || "")) || a.entityType.localeCompare(b.entityType));
  return { templates: summaries, ranking };
}

function getTemplate(id, dir) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  return readAll(dir).templates.get(id) || null;
}

// Tests point the loader at another folder; this forgets what was read.
function resetCache() {
  cache = null;
}

module.exports = { DEFAULT_DIR, readAll, listTemplates, getTemplate, resetCache };
