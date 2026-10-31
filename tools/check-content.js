#!/usr/bin/env node
"use strict";

// Validates the reviewable JSON under content/. Every file must parse; files of
// a known kind also get a shape check, so a contributor's change to taxonomy,
// fields or translations is caught before it reaches the app.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content");

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJson(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Translations: nested objects whose leaves are strings, or plural objects
// whose keys are Intl.PluralRules categories.
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
function validateTranslations(value, problems, trail = "") {
  if (!isPlainObject(value)) {
    problems.push(`${trail || "(root)"} must be an object`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const at = trail ? `${trail}.${key}` : key;
    if (typeof child === "string") continue;
    if (isPlainObject(child) && Object.keys(child).length && Object.keys(child).every((k) => PLURAL_KEYS.has(k))) {
      if (typeof child.other !== "string") problems.push(`${at} plural forms need an "other" form`);
      continue;
    }
    validateTranslations(child, problems, at);
  }
}

// The status list: the same checks the editor applies to a saved list.
function validateStatuses(value, problems) {
  try {
    require("../lib/status-config").validateStatusConfig(value, value);
  } catch (error) {
    problems.push(error.message);
  }
}

// The stored values; a target keeps one of these as its priority.
const PRIORITY_IDS = ["Very High", "High", "Medium", "Low", "Very Low"];
function validatePriorities(value, problems) {
  if (!isPlainObject(value) || !Array.isArray(value.priorities)) {
    problems.push("needs a priorities list");
    return;
  }
  const ids = value.priorities.map((priority) => priority?.id);
  if (ids.join() !== PRIORITY_IDS.join()) problems.push(`priorities are fixed: ${PRIORITY_IDS.join(", ")}, in that order`);
  for (const priority of value.priorities) {
    if (typeof priority?.label !== "string" || !priority.label.trim()) problems.push(`${priority?.id}: needs a label`);
  }
  if (!ids.includes(value.defaultPriority)) problems.push("defaultPriority must be one of the priorities");
}

// The shared option lists: every list the app knows, each passing the same
// checks as an edited list (public/js/options.js).
function validateOptions(value, problems) {
  const Options = require("../public/js/options.js");
  if (!isPlainObject(value)) {
    problems.push("must be an object of option lists");
    return;
  }
  for (const name of Options.LIST_NAMES.filter((list) => list !== "documentChecklist")) {
    if (!Array.isArray(value[name])) {
      problems.push(`${name}: missing`);
      continue;
    }
    try {
      const clean = Options.validateList(name, value[name]);
      clean.forEach((option, index) => {
        if (!value[name][index].id) problems.push(`${name}[${index}]: needs an id`);
        else if (option.id !== value[name][index].id) problems.push(`${name}[${index}]: id "${value[name][index].id}" is not valid`);
      });
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  for (const name of Object.keys(value)) {
    if (!Options.LIST_NAMES.includes(name) || name === "documentChecklist") problems.push(`${name}: unknown list`);
  }
}

// The prompt library: every preset names a shipped prompt and shipped
// examples, and every example fills one of the four example variables.
function validatePromptFile(name) {
  return (value, problems) => {
    const listKey = { "built-in": "prompts", presets: "presets", examples: "examples", variables: "variables" }[name];
    if (listKey && !Array.isArray(value?.[listKey])) {
      problems.push(`needs a "${listKey}" list`);
      return;
    }
    const ids = new Set();
    for (const entry of listKey ? value[listKey] : []) {
      const id = entry?.id || entry?.name;
      if (!id) problems.push("an entry has no id");
      else if (ids.has(id)) problems.push(`${id}: used twice`);
      ids.add(id);
    }
    if (name === "built-in") value.prompts.forEach((prompt) => {
      if (typeof prompt.body !== "string" || !prompt.body.trim()) problems.push(`${prompt.id}: needs a body`);
    });
    if (name === "examples") value.examples.forEach((example) => {
      if (!["SEARCH_FOCUS", "VERIFIED_ACTIVITY", "AVOID", "SPECIAL_SCHEDULE"].includes(example.variable)) problems.push(`${example.id}: unknown variable ${example.variable}`);
      if (typeof example.text !== "string" || !example.text.trim()) problems.push(`${example.id}: needs a text`);
    });
    if (name === "presets") {
      const prompts = new Set((readJsonQuiet("prompts/built-in.json")?.prompts || []).map((prompt) => prompt.id));
      const examples = new Set((readJsonQuiet("prompts/examples.json")?.examples || []).map((example) => example.id));
      value.presets.forEach((preset) => {
        if (!prompts.has(preset.promptId)) problems.push(`${preset.id}: unknown prompt ${preset.promptId}`);
        if (!["mk", "po", "fu", "general"].includes(preset.section)) problems.push(`${preset.id}: unknown section ${preset.section}`);
        for (const list of [preset.examples, ...Object.values(preset.examplesBySection || {})]) {
          for (const exampleIds of Object.values(list || {})) for (const id of exampleIds) if (!examples.has(id)) problems.push(`${preset.id}: unknown example ${id}`);
        }
      });
    }
  };
}

// Company templates (lib/company/template-schema.js): errors fail the check.
function validateCompanyTemplate(value, problems, { rel, text }) {
  const { checkTemplate } = require("../lib/company/template-schema");
  const id = rel.replace(/^company-templates\//, "").replace(/\.json$/, "");
  problems.push(...checkTemplate(value, { fileName: id, text }).errors);
}

// The template index: where the country list comes from, and every country
// in it has a template.
function validateTemplateIndex(value, problems) {
  const ranking = value?.ranking;
  if (!ranking || typeof ranking !== "object") {
    problems.push("needs a \"ranking\" object");
    return;
  }
  if (typeof ranking.title !== "string" || !ranking.title.trim()) problems.push("ranking.title is missing");
  if (!Number.isInteger(ranking.year)) problems.push("ranking.year must be a year");
  if (!/^https:\/\//.test(ranking.url || "")) problems.push("ranking.url must be an https URL");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ranking.verifiedOn || "")) problems.push("ranking.verifiedOn must be YYYY-MM-DD");
  const countries = new Set();
  for (const name of fs.readdirSync(path.join(CONTENT, "company-templates"))) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    const template = readJsonQuiet(`company-templates/${name}`);
    if (template?.country) countries.add(template.country);
  }
  for (const code of ranking.countries || []) if (!countries.has(code)) problems.push(`ranking lists ${code}, which has no template`);
}

function readJsonQuiet(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONTENT, rel), "utf8"));
  } catch {
    return null;
  }
}

const VALIDATORS = [
  { test: (rel) => /^i18n\/[a-z]{2}(?:-[A-Z]{2})?\.json$/.test(rel), name: "translations", validate: validateTranslations },
  { test: (rel) => rel === "statuses.json", name: "statuses", validate: validateStatuses },
  { test: (rel) => rel === "priorities.json", name: "priorities", validate: validatePriorities },
  { test: (rel) => rel === "options.json", name: "options", validate: validateOptions },
  ...["built-in", "presets", "examples", "variables"].map((name) => ({ test: (rel) => rel === `prompts/${name}.json`, name: `prompts/${name}`, validate: validatePromptFile(name) })),
  { test: (rel) => rel === "company-templates/index.json", name: "company template index", validate: validateTemplateIndex },
  { test: (rel) => /^company-templates\/[a-z0-9-]+\.json$/.test(rel), name: "company template", validate: validateCompanyTemplate },
];

function checkContent({ root = CONTENT } = {}) {
  const results = [];
  for (const file of listJson(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const problems = [];
    let parsed;
    const text = fs.readFileSync(file, "utf8");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      problems.push(`not valid JSON: ${error.message}`);
    }
    if (parsed !== undefined) {
      const validator = VALIDATORS.find((v) => v.test(rel));
      if (validator) validator.validate(parsed, problems, { rel, text });
    }
    results.push({ file: rel, problems });
  }
  // The field registry is checked as a whole: keys shared across its files must
  // agree (lib/fields-schema.js).
  const fieldsDir = path.join(root, "fields");
  if (fs.existsSync(path.join(fieldsDir, "common.json"))) {
    const { errors } = require("../lib/fields-schema").checkFieldRegistry(fieldsDir);
    results.push({ file: "fields/", problems: errors });
  }
  return results;
}

if (require.main === module) {
  const results = checkContent();
  let count = 0;
  for (const { file, problems } of results) {
    for (const problem of problems) {
      count += 1;
      console.log(`ERROR content/${file}: ${problem}`);
    }
  }
  console.log(`check-content: ${results.length} file(s), ${count} problem(s)`);
  process.exitCode = count ? 1 : 0;
}

module.exports = { checkContent, validateTranslations, VALIDATORS };
