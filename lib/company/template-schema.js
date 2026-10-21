"use strict";

// Checks a company template (content/company-templates/<id>.json) against the
// template schema: every step and obligation cites a source or says to check
// locally, amounts carry an effective date, due rules are ones the recurrence
// engine (lib/company/recurrence.js) can date, and the document template uses
// only fields that may appear in it. Errors make a template unusable;
// warnings are for the reviewer.

const FREQUENCIES = new Set(['monthly', 'quarterly', 'annual', 'once', 'on-event']);
const FIELD_TYPES = new Set([
  'text', 'textarea', 'markdown', 'number', 'money', 'money-range', 'percent', 'date', 'datetime',
  'time', 'url', 'email', 'select', 'multiselect', 'tristate', 'person', 'rating', 'list'
]);
const OPTION_TYPES = new Set(['select', 'multiselect', 'rating']);
const BANNED = ['seamless', 'leverage', 'robust', 'unlock', 'empower', 'game-changing'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][A-Za-z0-9]*$/;
const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TOP_KEYS = [
  'id', 'version', 'country', 'countryName', 'entityType', 'nameLocal', 'nameEnglish', 'currency',
  'bilingual', 'subdivision', 'disclaimer', 'verifiedOn', 'sources', 'conditions', 'profileFields',
  'people', 'setupSteps', 'obligations', 'expenseCategories', 'documentTemplate'
];
const OPTIONAL_TOP_KEYS = new Set(['draft']);

function isInt(n) {
  return Number.isInteger(n);
}

// Checks one parsed template. `fileName` (without .json) must match its id
// when given; `text` is the file as written, for the formatting check.
function checkTemplate(t, { fileName = null, text = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);
  const summary = { id: t && t.id, steps: 0, obligations: 0, sources: 0, checkLocally: [] };

  if (text !== null) {
    text.split("\n").forEach((line, i) => {
      const lead = line.match(/^[ \t]*/)[0];
      if (lead.includes("\t")) err(`line ${i + 1}: tab in indentation`);
      else if (lead.length % 2 !== 0) err(`line ${i + 1}: indentation is not a multiple of 2 spaces`);
    });
    if (text !== JSON.stringify(t, null, 2) + "\n") warn("formatting differs from JSON.stringify(value, null, 2) plus a final newline");
  }

  if (!t || typeof t !== "object" || Array.isArray(t)) {
    err('top level is not an object');
    return { summary, errors, warnings };
  }

  // Bilingual templates use { en, ro } objects for user-facing text.
  const languages = t.bilingual && Array.isArray(t.bilingual.languages) ? t.bilingual.languages : null;
  const isText = (v) => {
    if (languages) {
      return v !== null && typeof v === 'object' && languages.every((l) => typeof v[l] === 'string' && v[l].trim());
    }
    return typeof v === 'string' && v.trim().length > 0;
  };

  for (const k of TOP_KEYS) if (!(k in t)) err(`missing top-level key "${k}"`);
  for (const k of Object.keys(t)) {
    if (!TOP_KEYS.includes(k) && !OPTIONAL_TOP_KEYS.has(k)) warn(`unexpected top-level key "${k}"`);
  }
  if ('draft' in t && typeof t.draft !== 'boolean') err('"draft" must be a boolean');

  if (fileName !== null && t.id !== fileName) err(`id "${t.id}" does not match the file name "${fileName}"`);
  if (typeof t.id !== 'string' || !SLUG_RE.test(t.id)) err('id must be a lowercase slug');
  if (!isInt(t.version) || t.version < 1) err('version must be an integer >= 1');
  const isGeneric = t.id === 'generic';

  if (isGeneric) {
    if (t.country !== null) err('generic: country must be null');
  } else {
    if (typeof t.country !== 'string' || !/^[A-Z]{2}$/.test(t.country)) err('country must be an ISO 3166-1 alpha-2 code');
    if (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)) err('currency must be a three-letter code');
  }
  if (t.currency !== null && (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency))) {
    err('currency must be null or a three-letter code');
  }
  if (t.verifiedOn !== null && !(typeof t.verifiedOn === 'string' && DATE_RE.test(t.verifiedOn))) {
    err('verifiedOn must be YYYY-MM-DD or null');
  }
  const disclaimerText = languages && t.disclaimer ? t.disclaimer.en : t.disclaimer;
  if (typeof disclaimerText !== 'string' || !disclaimerText.startsWith('Not legal or tax advice')) {
    err('disclaimer must start with "Not legal or tax advice"');
  }
  if (t.bilingual !== null && !languages) err('bilingual must be null or { "languages": [...] }');

  // Subdivision
  const subdivisionCodes = new Set();
  if (t.subdivision !== null && t.subdivision !== undefined) {
    const s = t.subdivision;
    if (!isText(s.label)) err('subdivision.label is missing');
    if (typeof s.required !== 'boolean') err('subdivision.required must be a boolean');
    if (!Array.isArray(s.options) || s.options.length === 0) err('subdivision.options must be a non-empty array');
    for (const o of s.options || []) {
      if (typeof o.code !== 'string' || !SUBDIVISION_RE.test(o.code)) err(`subdivision option code "${o.code}" is not ISO 3166-2`);
      else if (t.country && !o.code.startsWith(t.country + '-')) err(`subdivision option "${o.code}" is not in ${t.country}`);
      if (subdivisionCodes.has(o.code)) err(`duplicate subdivision option "${o.code}"`);
      subdivisionCodes.add(o.code);
      if (!isText(o.name)) err(`subdivision option "${o.code}" has no name`);
    }
  }

  // Sources
  const sourceIds = new Set();
  if (!Array.isArray(t.sources)) err('sources must be an array');
  for (const s of t.sources || []) {
    const where = `source "${s.id}"`;
    if (typeof s.id !== 'string' || !SLUG_RE.test(s.id)) err(`${where}: id must be a lowercase slug`);
    if (sourceIds.has(s.id)) err(`${where}: duplicate id`);
    sourceIds.add(s.id);
    if (!isText(s.title)) err(`${where}: title missing`);
    if (!isText(s.publisher)) err(`${where}: publisher missing`);
    if (typeof s.url !== 'string' || !/^https:\/\/[^\s]+$/.test(s.url)) err(`${where}: url must be an https URL`);
    if (s.verifiedOn === null) {
      if (s.checkLocally !== true) err(`${where}: verifiedOn is null, so the source must carry checkLocally: true`);
    } else if (!(typeof s.verifiedOn === 'string' && DATE_RE.test(s.verifiedOn))) {
      err(`${where}: verifiedOn must be YYYY-MM-DD or null`);
    }
  }
  summary.sources = sourceIds.size;
  if (!isGeneric && sourceIds.size === 0) err('a country template needs at least one source');

  const checkSourceRefs = (where, ids) => {
    if (!Array.isArray(ids)) {
      err(`${where}: sourceIds must be an array`);
      return [];
    }
    for (const id of ids) if (!sourceIds.has(id)) err(`${where}: sourceIds entry "${id}" is not in sources`);
    return ids;
  };

  // Conditions
  const conditionIds = new Set();
  if (!Array.isArray(t.conditions)) err('conditions must be an array');
  for (const c of t.conditions || []) {
    if (typeof c.id !== 'string' || !SLUG_RE.test(c.id)) err(`condition "${c.id}": id must be a lowercase slug`);
    if (conditionIds.has(c.id)) err(`condition "${c.id}": duplicate id`);
    conditionIds.add(c.id);
    if (!isText(c.label)) err(`condition "${c.id}": label missing`);
    if (!isText(c.description)) err(`condition "${c.id}": description missing`);
  }

  // Profile fields
  const fieldsByKey = new Map();
  if (!Array.isArray(t.profileFields) || t.profileFields.length === 0) err('profileFields must be a non-empty array');
  for (const f of t.profileFields || []) {
    const where = `profile field "${f.key}"`;
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) err(`${where}: key must be camelCase`);
    if (fieldsByKey.has(f.key)) err(`${where}: duplicate key`);
    fieldsByKey.set(f.key, f);
    if (!isText(f.label)) err(`${where}: label missing`);
    if (!isText(f.description)) err(`${where}: description missing`);
    const example = languages && f.example && typeof f.example === 'object' ? f.example.en : f.example;
    if (typeof example !== 'string' || (example !== '' && !example.startsWith('e.g. '))) {
      err(`${where}: example must be "" or start with "e.g. "`);
    }
    if (!FIELD_TYPES.has(f.type)) err(`${where}: unknown type "${f.type}"`);
    if (OPTION_TYPES.has(f.type)) {
      if (!Array.isArray(f.options) || f.options.length === 0) err(`${where}: ${f.type} needs options`);
      for (const o of f.options || []) if (!isText(o.description)) err(`${where}: option "${o.value}" has no description`);
    } else if ('options' in f) {
      err(`${where}: options are only for select, multiselect and rating`);
    }
    if (typeof f.group !== 'string' || !f.group) err(`${where}: group missing`);
    if (typeof f.sensitive !== 'boolean') err(`${where}: sensitive must be a boolean`);
    if (typeof f.includeInDocument !== 'boolean') err(`${where}: includeInDocument must be a boolean`);
    if (f.sensitive === true && f.includeInDocument === true) warn(`${where}: a sensitive field is included in the document`);
    checkSourceRefs(where, f.sourceIds);
  }

  // People
  if (!t.people || !Array.isArray(t.people.roles) || t.people.roles.length === 0) err('people.roles must be a non-empty array');
  const roleIds = new Set();
  for (const r of (t.people && t.people.roles) || []) {
    if (typeof r.id !== 'string' || !SLUG_RE.test(r.id)) err(`role "${r.id}": id must be a lowercase slug`);
    if (roleIds.has(r.id)) err(`role "${r.id}": duplicate id`);
    roleIds.add(r.id);
    if (!isText(r.label)) err(`role "${r.id}": label missing`);
    if (!isText(r.description)) err(`role "${r.id}": description missing`);
  }
  if (!t.people || !Array.isArray(t.people.fields) || !t.people.fields.every((x) => typeof x === 'string')) {
    err('people.fields must be an array of field names');
  }

  // Setup steps
  const stepIds = new Set();
  if (!Array.isArray(t.setupSteps)) err('setupSteps must be an array');
  for (const s of t.setupSteps || []) {
    if (stepIds.has(s.id)) err(`step "${s.id}": duplicate id`);
    stepIds.add(s.id);
  }
  for (const s of t.setupSteps || []) {
    const where = `step "${s.id}"`;
    if (typeof s.id !== 'string' || !SLUG_RE.test(s.id)) err(`${where}: id must be a lowercase slug`);
    if (!isText(s.title)) err(`${where}: title missing`);
    if (!isText(s.description)) err(`${where}: description missing`);
    if (!isText(s.authority)) err(`${where}: authority missing`);
    if (typeof s.checkLocally !== 'boolean') err(`${where}: checkLocally must be a boolean`);
    const refs = checkSourceRefs(where, s.sourceIds);
    if (refs.length === 0 && s.checkLocally !== true) err(`${where}: no source and checkLocally is not true`);
    if (s.checkLocally === true) summary.checkLocally.push(`step:${s.id}`);
    if (s.typicalCost !== null && s.typicalCost !== undefined) {
      const c = s.typicalCost;
      if (c.amount !== null && typeof c.amount !== 'number') err(`${where}: typicalCost.amount must be a number or null`);
      if (typeof c.amount === 'number' && !(typeof c.effectiveDate === 'string' && DATE_RE.test(c.effectiveDate))) {
        err(`${where}: typicalCost.amount needs an effectiveDate (YYYY-MM-DD)`);
      }
      if (c.amount === null && !isText(c.note)) err(`${where}: typicalCost without an amount needs a note`);
      if (typeof c.amount === 'number' && refs.length === 0) err(`${where}: an amount needs a source`);
    }
    if (!Array.isArray(s.dependsOn)) err(`${where}: dependsOn must be an array`);
    for (const d of s.dependsOn || []) {
      if (d === s.id) err(`${where}: depends on itself`);
      else if (!stepIds.has(d)) err(`${where}: dependsOn "${d}" is not a step id`);
    }
  }
  // Dependency cycles
  const steps = new Map((t.setupSteps || []).map((s) => [s.id, s]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      err(`setup steps have a dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    for (const d of (steps.get(id) && steps.get(id).dependsOn) || []) if (steps.has(d)) visit(d, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of steps.keys()) visit(id, []);
  summary.steps = stepIds.size;

  // Obligations
  const obligationIds = new Set();
  if (!Array.isArray(t.obligations)) err('obligations must be an array');
  for (const o of t.obligations || []) {
    const where = `obligation "${o.id}"`;
    if (typeof o.id !== 'string' || !SLUG_RE.test(o.id)) err(`${where}: id must be a lowercase slug`);
    if (obligationIds.has(o.id)) err(`${where}: duplicate id`);
    obligationIds.add(o.id);
    if (!isText(o.title)) err(`${where}: title missing`);
    if (!isText(o.description)) err(`${where}: description missing`);
    if (!isText(o.authority)) err(`${where}: authority missing`);
    if (!FREQUENCIES.has(o.frequency)) err(`${where}: unknown frequency "${o.frequency}"`);
    checkDue(o.due, o.frequency, where, err, warn, isText);
    if (!Array.isArray(o.conditions)) err(`${where}: conditions must be an array`);
    for (const c of o.conditions || []) if (!conditionIds.has(c)) err(`${where}: condition "${c}" is not in conditions`);
    if (!Array.isArray(o.subdivisions)) err(`${where}: subdivisions must be an array`);
    for (const code of o.subdivisions || []) {
      if (!t.subdivision) err(`${where}: lists subdivision "${code}" but the template has no subdivision`);
      else if (!subdivisionCodes.has(code)) err(`${where}: subdivision "${code}" is not in subdivision.options`);
    }
    if (typeof o.checkLocally !== 'boolean') err(`${where}: checkLocally must be a boolean`);
    const refs = checkSourceRefs(where, o.sourceIds);
    if (refs.length === 0 && o.checkLocally !== true) err(`${where}: no source and checkLocally is not true`);
    if (o.checkLocally === true) summary.checkLocally.push(`obligation:${o.id}`);
  }
  summary.obligations = obligationIds.size;

  if (isGeneric) {
    if ((t.setupSteps || []).length !== 0) err('generic: setupSteps must be empty');
    if ((t.obligations || []).length !== 0) err('generic: obligations must be empty');
  } else {
    if (summary.steps < 6 || summary.steps > 12) warn(`${summary.steps} setup steps (spec: about 6 to 12)`);
    if (summary.obligations < 6 || summary.obligations > 15) warn(`${summary.obligations} obligations (spec: about 6 to 15)`);
  }

  // Expense categories
  const categoryIds = new Set();
  if (!Array.isArray(t.expenseCategories) || t.expenseCategories.length === 0) err('expenseCategories must be a non-empty array');
  for (const c of t.expenseCategories || []) {
    if (typeof c.id !== 'string' || !SLUG_RE.test(c.id)) err(`expense category "${c.id}": id must be a lowercase slug`);
    if (categoryIds.has(c.id)) err(`expense category "${c.id}": duplicate id`);
    categoryIds.add(c.id);
    if (!isText(c.label)) err(`expense category "${c.id}": label missing`);
  }
  if (!categoryIds.has('other')) warn('no "other" expense category');

  // Document template placeholders
  const doc = languages && t.documentTemplate && typeof t.documentTemplate === 'object' ? t.documentTemplate.en : t.documentTemplate;
  if (typeof doc !== 'string' || !doc.trim()) {
    err('documentTemplate must be a non-empty string');
  } else {
    const used = new Set();
    for (const m of doc.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) used.add(m[1]);
    if (!used.has('people')) warn('documentTemplate has no {{people}} placeholder');
    for (const key of used) {
      if (key === 'people') continue;
      const f = fieldsByKey.get(key);
      if (!f) err(`documentTemplate uses {{${key}}}, which is not a profile field`);
      else if (f.sensitive) err(`documentTemplate uses sensitive field {{${key}}}`);
      else if (!f.includeInDocument) err(`documentTemplate uses {{${key}}}, which has includeInDocument: false`);
    }
    for (const [key, f] of fieldsByKey) {
      if (f.includeInDocument && !f.sensitive && !used.has(key)) warn(`profile field "${key}" has includeInDocument: true but is not in documentTemplate`);
    }
    const stray = doc.replace(/\{\{\s*[^{}\s]+\s*\}\}/g, '');
    if (/\{\{|\}\}/.test(stray)) err('documentTemplate has an unbalanced {{ or }}');
  }

  // Wording: banned words and em dashes in every string
  let emDashes = 0;
  const walk = (v, where) => {
    if (typeof v === 'string') {
      for (const word of BANNED) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(v)) err(`${where}: uses the word "${word}"`);
      }
      emDashes += (v.match(/—/g) || []).length;
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k);
    }
  };
  walk(t, '');
  if (emDashes > 3) warn(`${emDashes} em dashes in the file (spec: few)`);

  return { summary, errors, warnings };
}

function checkDue(due, frequency, where, err, warn, isText) {
  if (!due || typeof due !== 'object') {
    err(`${where}: due is missing`);
    return;
  }
  const allow = (keys) => {
    for (const k of Object.keys(due)) if (!keys.includes(k)) err(`${where}: due has an unexpected key "${k}"`);
  };
  const isDay = (d, words) => (isInt(d) && d >= 1 && d <= 31) || words.includes(d);
  switch (due.rule) {
    case 'relative-to-period-end':
      allow(['rule', 'months', 'day']);
      if (!isInt(due.months) || due.months < 0) err(`${where}: due.months must be an integer >= 0`);
      if (!isDay(due.day, ['last'])) err(`${where}: due.day must be 1-31 or "last"`);
      if (!['monthly', 'quarterly', 'annual'].includes(frequency)) err(`${where}: relative-to-period-end needs a monthly, quarterly or annual frequency`);
      break;
    case 'relative-to-period-start':
      allow(['rule', 'months', 'day']);
      if (!isInt(due.months) || due.months < 0) err(`${where}: due.months must be an integer >= 0`);
      if (!isDay(due.day, ['last'])) err(`${where}: due.day must be 1-31 or "last"`);
      if (!['monthly', 'quarterly', 'annual'].includes(frequency)) err(`${where}: relative-to-period-start needs a monthly, quarterly or annual frequency`);
      break;
    case 'relative-to-fiscal-year-end':
      allow(['rule', 'months', 'day']);
      if (!isInt(due.months)) err(`${where}: due.months must be an integer`);
      if (!isDay(due.day, ['last', 'same'])) err(`${where}: due.day must be 1-31, "last" or "same"`);
      if (!['annual', 'once'].includes(frequency)) warn(`${where}: relative-to-fiscal-year-end with frequency "${frequency}"`);
      break;
    case 'relative-to-anniversary':
      allow(['rule', 'of', 'months', 'days']);
      if (due.of !== 'incorporation') err(`${where}: due.of must be "incorporation"`);
      if (!isInt(due.months) || !isInt(due.days)) err(`${where}: due.months and due.days must be integers`);
      if (frequency !== 'annual') warn(`${where}: relative-to-anniversary with frequency "${frequency}"`);
      break;
    case 'fixed-date':
      allow(['rule', 'month', 'day']);
      // A monthly fixed date names only the day ("the 16th of every month").
      if (frequency === 'monthly' && due.month === undefined) {
        if (!isDay(due.day, [])) err(`${where}: due.day must be 1-31`);
        break;
      }
      if (!isInt(due.month) || due.month < 1 || due.month > 12) err(`${where}: due.month must be 1-12`);
      else if (!isInt(due.day) || due.day < 1 || due.day > DAYS_IN_MONTH[due.month - 1]) err(`${where}: due.day is not a valid day of month ${due.month}`);
      if (!['annual', 'once', 'monthly'].includes(frequency)) warn(`${where}: fixed-date with frequency "${frequency}"`);
      break;
    case 'relative-to-event':
      allow(['rule', 'days', 'event']);
      if (!isInt(due.days) || due.days < 0) err(`${where}: due.days must be an integer >= 0`);
      if (!isText(due.event)) err(`${where}: due.event must describe the event`);
      if (frequency !== 'on-event') err(`${where}: relative-to-event needs frequency "on-event"`);
      break;
    case 'manual':
      allow(['rule']);
      break;
    default:
      err(`${where}: unknown due rule "${due.rule}"`);
  }
  if (frequency === 'on-event' && !['relative-to-event', 'manual'].includes(due.rule)) {
    err(`${where}: an on-event obligation uses relative-to-event or manual`);
  }
}

module.exports = { checkTemplate, checkDue };
