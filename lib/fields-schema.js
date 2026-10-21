"use strict";

// Checks the field registry (content/fields/common.json, mk.json, po.json,
// fu.json): every field has a plain description and a fitting type, options
// are described, keys shared between sections mean the same thing, and no
// field clashes with a core field. Run directly for a summary:
//   node lib/fields-schema.js [fieldsDir]
const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = path.join(__dirname, "..", "content", "fields");
const FILES = ["common", "mk", "po", "fu"];
const SECTIONS = ["mk", "po", "fu"];
const BASE_TYPES = ["text", "textarea", "markdown", "number", "money", "money-range", "percent", "date", "datetime", "time", "url", "email", "select", "multiselect", "tristate", "person", "rating", "list"];
const CORE_TYPES = ["taxonomy", "status", "priority", "campaign", "tags", "repeat", "round", "readonly-id"];
const OPTION_TYPES = ["select", "multiselect", "rating"];
const NO_EXAMPLE_TYPES = ["select", "multiselect", "rating", "tristate", "date", "datetime", "time", "taxonomy", "status", "priority", "campaign", "round", "readonly-id", "markdown"];
const FIELD_PROPS = ["key", "label", "description", "example", "type", "group", "tab", "sections", "suggested", "validation", "showInList", "searchable"];
const VALIDATION_KEYS = ["min", "max", "pattern", "required"];
// Keys that deliberately appear in more than one section file and mean the same thing in each.
const SHARED_KEYS = {
  sourceUrl: ["po", "fu"],
  contactName: ["mk", "fu"],
  contactRole: ["mk", "fu"],
  lastContactDate: ["mk", "fu"],
  effortHours: ["mk", "po"],
  probabilityPercent: ["po", "fu"],
  lessonsLearned: ["po", "fu"],
};
const BANNED = ["seamless", "leverag", "robust", "unlock", "empower", "game-changing", "delve", "crucial", "pivotal", "vibrant", "showcas", "testament", "underscor", "foster", "landscape", "streamlin", "enhanc", "valuable", "additionally", "highlight", "at its core", "cutting-edge", "world-class"];
const BRANDS = ["product hunt", "hacker news", "reddit", "github", "linkedin", "y combinator", "techstars", "google", "amazon", "aws", "microsoft", "stripe", "twitter", "facebook", "instagram", "tiktok", "youtube", "discord", "slack", "notion", "nvidia", "openai"];
const LABEL_WORDS_OK = ["ID", "URL", "MVP", "SAFE", "Series", "A", "CVs"];
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Filled by one run of checkFieldRegistry.
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

function checkText(where, text, { sentence = false, maxSentences = 2 } = {}) {
  if (typeof text !== "string" || !text.trim()) return err(where, "missing text");
  if (text !== text.trim() || /\s{2,}/.test(text)) err(where, "extra whitespace");
  if (/[–—]/.test(text) || / -- /.test(text)) err(where, "em or en dash");
  if (/[‘’“”]/.test(text)) err(where, "curly quotes");
  const lower = text.toLowerCase();
  for (const word of BANNED) if (lower.includes(word)) err(where, `banned wording "${word}"`);
  for (const brand of BRANDS) if (new RegExp(`\\b${brand}\\b`).test(lower)) err(where, `brand name "${brand}"`);
  if (sentence) {
    if (!/[.?!]$/.test(text)) err(where, "description must end with a full stop");
    const count = (text.match(/[.?!](\s|$)/g) || []).length;
    if (count > maxSentences) err(where, `${count} sentences (max ${maxSentences})`);
    if (text.length < 15 || text.length > 300) warn(where, `description is ${text.length} characters`);
    if (/\d/.test(text.replace(/\b(0|1|5|100)\b/g, ""))) warn(where, `digits in description: "${text}"`);
  }
}

function checkLabel(where, label) {
  checkText(where, label);
  if (typeof label !== "string") return;
  if (!/^[A-Z0-9]/.test(label)) err(where, `label should start with a capital: "${label}"`);
  for (const word of label.split(/\s+/).slice(1)) {
    const bare = word.replace(/[^A-Za-z]/g, "");
    if (/^[A-Z]/.test(bare) && !LABEL_WORDS_OK.includes(bare)) err(where, `label not in sentence case: "${label}"`);
  }
}

function checkOptions(where, field) {
  const hasOptions = Object.prototype.hasOwnProperty.call(field, "options");
  if (!OPTION_TYPES.includes(field.type)) {
    if (hasOptions) err(where, `options are only for ${OPTION_TYPES.join(", ")}`);
    return;
  }
  if (!Array.isArray(field.options) || field.options.length < 2) return err(where, "needs at least two options");
  const seen = new Set();
  field.options.forEach((option, index) => {
    const at = `${where}.options[${index}]`;
    const keys = Object.keys(option).sort().join(",");
    if (keys !== "description,label,value") err(at, `option keys must be value, label, description (got ${keys})`);
    if (field.type === "rating") {
      if (option.value !== index + 1) err(at, "rating values must be 1 to 5 in order");
    } else if (typeof option.value !== "string" || !SLUG.test(option.value)) {
      err(at, `option value must be a lowercase slug: ${JSON.stringify(option.value)}`);
    }
    if (seen.has(option.value)) err(at, `duplicate option value ${option.value}`);
    seen.add(option.value);
    checkLabel(`${at}.label`, option.label);
    checkText(`${at}.description`, option.description, { sentence: true });
  });
  if (field.type === "rating" && field.options.length !== 5) err(where, "rating needs exactly five options");
}

function checkValidation(where, field) {
  const v = field.validation;
  if (v === null) {
    if (field.type === "percent") err(where, "percent fields need { min: 0, max: 100 }");
    return;
  }
  if (typeof v !== "object" || Array.isArray(v)) return err(where, "validation must be null or an object");
  for (const key of Object.keys(v)) if (!VALIDATION_KEYS.includes(key)) err(where, `unknown validation key ${key}`);
  if ("min" in v && typeof v.min !== "number") err(where, "min must be a number");
  if ("max" in v && typeof v.max !== "number") err(where, "max must be a number");
  if ("required" in v && v.required !== true) err(where, "required must be true when present");
  if ("pattern" in v) { try { new RegExp(v.pattern); } catch (e) { err(where, `bad pattern: ${e.message}`); } }
  if (("min" in v || "max" in v) && !["number", "percent", "money", "money-range"].includes(field.type)) err(where, "min and max are for numeric fields");
  if (field.type === "percent" && (v.min !== 0 || v.max !== 100)) err(where, "percent fields need { min: 0, max: 100 }");
}

function checkField(where, field, ctx) {
  for (const prop of FIELD_PROPS) if (!(prop in field)) err(where, `missing ${prop}`);
  for (const prop of Object.keys(field)) if (![...FIELD_PROPS, "options"].includes(prop)) err(where, `unknown property ${prop}`);
  if (typeof field.key !== "string" || !CAMEL.test(field.key)) err(where, `key must be camelCase: ${field.key}`);
  checkLabel(`${where}.label`, field.label);
  checkText(`${where}.description`, field.description, { sentence: true });
  const allowedTypes = ctx.allowCoreTypes ? [...BASE_TYPES, ...CORE_TYPES] : BASE_TYPES;
  if (!allowedTypes.includes(field.type)) err(where, `type ${field.type} not allowed here`);
  if (typeof field.example !== "string") err(where, "example must be a string");
  else if (field.example) {
    if (!field.example.startsWith("e.g. ")) err(where, `example must start with "e.g. ": ${field.example}`);
    checkText(`${where}.example`, field.example);
    if (/https?:\/\//.test(field.example) && !/https:\/\/example\.com(\/|$)/.test(field.example)) err(where, "URL examples must use https://example.com");
    if (/@/.test(field.example) && !/@example\.com$/.test(field.example)) err(where, "email examples must use example.com");
    if (NO_EXAMPLE_TYPES.includes(field.type)) warn(where, `example on a ${field.type} field`);
  } else if (!NO_EXAMPLE_TYPES.includes(field.type)) {
    warn(where, `no example on a ${field.type} field`);
  }
  checkOptions(where, field);
  if (!ctx.groups.has(field.group)) err(where, `group ${field.group} does not exist`);
  if (field.tab !== ctx.tab) err(where, `tab must be ${ctx.tab}`);
  if (!Array.isArray(field.sections) || !field.sections.length) err(where, "sections must be a non-empty array");
  else {
    if (new Set(field.sections).size !== field.sections.length) err(where, "duplicate sections");
    for (const s of field.sections) if (!SECTIONS.includes(s)) err(where, `unknown section ${s}`);
    if (ctx.sections && JSON.stringify(field.sections) !== JSON.stringify(ctx.sections)) err(where, `sections must be ${JSON.stringify(ctx.sections)}`);
    if (!ctx.sections && field.sections.some((s) => !ctx.allowedSections.includes(s))) err(where, "section outside its parent");
  }
  if (field.suggested !== null) {
    if (field.suggested !== "profile.currency") warn(where, `suggested value ${JSON.stringify(field.suggested)}`);
    else if (!["money", "money-range"].includes(field.type) && field.key !== "currency") err(where, "profile.currency only fits money fields or a currency code");
  }
  checkValidation(where, field);
  if (typeof field.showInList !== "boolean") err(where, "showInList must be boolean");
  if (typeof field.searchable !== "boolean") err(where, "searchable must be boolean");
}

function checkFieldRegistry(dir = DEFAULT_DIR) {
  errors.length = 0;
  warnings.length = 0;
  const files = {};
  for (const name of FILES) {
    const file = path.join(dir, `${name}.json`);
    const raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) err(name, "byte order mark");
    if (!raw.endsWith("\n")) err(name, "no final newline");
    raw.split("\n").forEach((line, i) => {
      if (/\t/.test(line)) err(`${name}:${i + 1}`, "tab character");
      if (/\s+$/.test(line)) err(`${name}:${i + 1}`, "trailing whitespace");
      if ((line.match(/^ */)[0].length) % 2) err(`${name}:${i + 1}`, "indent is not a multiple of 2");
    });
    try { files[name] = JSON.parse(raw); } catch (e) { err(name, `invalid JSON: ${e.message}`); }
  }

  const keyOwners = new Map(); // top-level key -> [{ file, field }]
  const activityIds = new Set();
  for (const name of FILES) {
    const data = files[name];
    if (!data) continue;
    const tab = name === "common" ? "core" : "details";
    if (data.scope !== name) err(name, `scope must be "${name}"`);
    if (data.version !== 1) err(name, "version must be 1");
    const allowedTop = ["scope", "version", "groups", "fields", "activities"];
    for (const k of Object.keys(data)) if (!allowedTop.includes(k)) err(name, `unknown top-level key ${k}`);

    const groups = new Set();
    const orders = [];
    (data.groups || []).forEach((g, i) => {
      const at = `${name}.groups[${i}]`;
      if (!SLUG.test(g.id || "")) err(at, `group id must be a slug: ${g.id}`);
      if (groups.has(g.id)) err(at, `duplicate group ${g.id}`);
      groups.add(g.id);
      checkLabel(`${at}.label`, g.label);
      checkText(`${at}.description`, g.description, { sentence: true });
      orders.push(g.order);
    });
    if (JSON.stringify([...orders].sort((a, b) => a - b)) !== JSON.stringify(orders.map((_, i) => i + 1))) err(name, "group order must run 1..n");
    const used = new Set((data.fields || []).map((f) => f.group));
    for (const g of groups) if (!used.has(g)) warn(name, `group ${g} has no fields`);

    const sectionCtx = name === "common" ? null : [name];
    (data.fields || []).forEach((field, i) => {
      const at = `${name}.fields[${i}] ${field.key}`;
      checkField(at, field, { groups, tab, sections: sectionCtx, allowedSections: SECTIONS, allowCoreTypes: name === "common" });
      if (!keyOwners.has(field.key)) keyOwners.set(field.key, []);
      keyOwners.get(field.key).push({ file: name, field });
    });

    if (!Array.isArray(data.activities)) err(name, "activities must be an array");
    (data.activities || []).forEach((act, i) => {
      const at = `${name}.activities[${i}] ${act.id}`;
      const allowed = ["id", "label", "description", "sections", "fields", "checklist"];
      for (const k of Object.keys(act)) if (!allowed.includes(k)) err(at, `unknown property ${k}`);
      if (!CAMEL.test(act.id || "")) err(at, "activity id must be camelCase");
      if (activityIds.has(act.id)) err(at, "duplicate activity id");
      activityIds.add(act.id);
      checkLabel(`${at}.label`, act.label);
      checkText(`${at}.description`, act.description, { sentence: true });
      if (!Array.isArray(act.sections) || !act.sections.length || act.sections.some((s) => !SECTIONS.includes(s))) err(at, "bad sections");
      if (name !== "common" && JSON.stringify(act.sections) !== JSON.stringify([name])) err(at, `sections must be ["${name}"]`);
      const keys = new Set();
      (act.fields || []).forEach((field, j) => {
        const fat = `${at}.fields[${j}] ${field.key}`;
        if (keys.has(field.key)) err(fat, "duplicate key within activity");
        keys.add(field.key);
        checkField(fat, field, { groups: new Set([act.id]), tab: "details", sections: act.sections, allowCoreTypes: name === "common" });
        if (field.showInList) err(fat, "activity fields never get a Targets column");
      });
      if (!act.fields || !act.fields.length) err(at, "activity needs fields");
      if ("checklist" in act) {
        const ids = new Set();
        act.checklist.forEach((doc, j) => {
          const dat = `${at}.checklist[${j}]`;
          if (Object.keys(doc).sort().join(",") !== "description,id,label") err(dat, "entries need id, label, description");
          if (!SLUG.test(doc.id || "")) err(dat, `id must be a slug: ${doc.id}`);
          if (ids.has(doc.id)) err(dat, `duplicate id ${doc.id}`);
          ids.add(doc.id);
          checkLabel(`${dat}.label`, doc.label);
          checkText(`${dat}.description`, doc.description, { sentence: true });
        });
      }
    });
  }

  // Cross-file key rules.
  const coreKeys = new Set((files.common?.fields || []).map((f) => f.key));
  for (const [key, owners] of keyOwners) {
    const where = owners.map((o) => o.file);
    if (owners.length > 1) {
      const expected = SHARED_KEYS[key];
      if (!expected || JSON.stringify([...where].sort()) !== JSON.stringify([...expected].sort())) {
        err(`key ${key}`, `appears in ${where.join(", ")} but is not a declared shared key`);
      }
      const types = new Set(owners.map((o) => o.field.type));
      if (types.size > 1) err(`key ${key}`, `shared key has different types: ${[...types].join(", ")}`);
    }
    if (coreKeys.has(key) && owners.some((o) => o.file !== "common")) err(`key ${key}`, "clashes with a core field");
  }
  for (const key of Object.keys(SHARED_KEYS)) if (!keyOwners.has(key) || keyOwners.get(key).length < 2) warn(`key ${key}`, "declared shared but not shared");

  // The commitment instrument must offer exactly the same options as the funding instrument.
  const fuInstrument = files.fu?.fields?.find((f) => f.key === "instrument");
  const commitInstrument = files.fu?.activities?.find((a) => a.id === "commitments")?.fields?.find((f) => f.key === "instrument");
  if (fuInstrument && commitInstrument && JSON.stringify(fuInstrument.options) !== JSON.stringify(commitInstrument.options)) {
    err("fu.commitments.instrument", "options differ from the FU instrument field");
  }
  return { errors: [...errors], warnings: [...warnings], files, keyOwners };
}

module.exports = { checkFieldRegistry, BASE_TYPES, CORE_TYPES };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || DEFAULT_DIR);
  const { files, keyOwners } = checkFieldRegistry(dir);
  // Summary.
  console.log(`Field registry check: ${dir}`);
  for (const name of FILES) {
    const data = files[name];
    if (!data) continue;
    const byGroup = (data.groups || []).map((g) => `${g.id} ${data.fields.filter((f) => f.group === g.id).length}`).join(", ");
    const acts = (data.activities || []).map((a) => `${a.id} (${a.fields.length} fields${a.checklist ? `, ${a.checklist.length} documents` : ""})`).join(", ") || "none";
    const inList = data.fields.filter((f) => f.showInList).map((f) => f.key).join(", ") || "none";
    console.log(`  ${name}: ${data.fields.length} fields [${byGroup}]; activities: ${acts}; showInList: ${inList}`);
  }
  const shared = [...keyOwners].filter(([, o]) => o.length > 1).map(([k, o]) => `${k} (${o.map((x) => x.file).join("+")})`);
  console.log(`  shared keys: ${shared.join(", ") || "none"}`);
  for (const w of warnings) console.log(`  warning  ${w}`);
  for (const e of errors) console.log(`  ERROR    ${e}`);
  console.log(errors.length ? `FAILED with ${errors.length} error(s)` : `OK (${warnings.length} warning(s))`);
  process.exitCode = errors.length ? 1 : 0;
}
