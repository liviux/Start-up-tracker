// The field registry (content/fields/*.json) as the page and the tests use it
// (window.StartupTrackerFields).
//
// Every target has the same core fields (name, organization, link, status...)
// in MK, PO and FU, then its section's detail fields in groups, then the
// startup's own custom fields. This file knows where each one is stored on a
// record, turns what an input holds into a stored value and back, and builds
// the inputs. The record window (js/record-window.js) draws them.
//
// Where values live:
// - core fields flat on the record. The sections stored some of them under
//   older names before the registry existed (MK `platform` for the name, FU
//   `opportunity` and `funder`...); STORAGE maps those, so records keep the
//   keys every other part of the app reads.
// - detail fields in `record.details`, except a few FU ones that were already
//   flat on its records.
// - custom fields (Extra > Fields) in `record.custom`.
// Keys no definition knows stay on the record untouched; otherFields() lists
// them for the window's "Other fields".
//
// Numbers keep empty and 0 apart: empty (null) means unknown, 0 is a value.
// Examples are placeholders only and are never read back as values.
//
// UMD: browsers get window.StartupTrackerFields, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerFields = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);
  // A translated string inside HTML: the text is escaped, the parameters go
  // in as given (they are HTML already).
  const tHtml = (key, params) => escapeHtml(t(key)).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match));

  const SECTIONS = Object.freeze(["mk", "po", "fu"]);
  const TYPES = Object.freeze(["text", "textarea", "markdown", "number", "money", "money-range", "percent", "date", "datetime", "time", "url", "email", "select", "multiselect", "tristate", "person", "rating", "list"]);
  const CUSTOM_TYPES = Object.freeze(["text", "textarea", "number", "money", "percent", "date", "datetime", "url", "email", "select", "multiselect", "tristate", "person"]);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME = /^\d{2}:\d{2}$/;
  const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const CURRENCY = /^[A-Z]{3}$/;

  // Where a field is stored when it is not `details[key]` (detail fields) or
  // `record[key]` (core fields).
  const STORAGE = Object.freeze({
    mk: { name: "platform", nextActionDate: "date", nextActionTime: "time" },
    po: { link: "applicationLink" },
    fu: {
      name: "opportunity",
      organization: "funder",
      link: "funderLink",
      // FU detail fields its records already held flat.
      contactName: "contactName",
      contactRole: "contactRole",
      contactEmail: "contactEmail",
      introducer: "introducer",
      lastContactDate: "lastContactDate",
      expectedCloseDate: "expectedCloseDate",
      probabilityPercent: "probability",
      outcomeReason: "lossReason",
      askAmount: { amount: "askAmount", currency: "askCurrency" },
    },
  });

  // Keys a section keeps flat on its records for the app's own use; anything
  // else flat that no field claims shows under "Other fields".
  const INTERNAL_KEYS = new Set([
    "id", "createdAt", "updatedAt", "deletedAt", "taxonomy", "category", "subcategory", "subcategories", "type",
    "details", "custom", "extraParams", "documents", "timeEntries", "activityLog", "commitments", "payments",
    "repeatInterval", "repeatUnit", "hasRepeated", "status", "priority", "tags", "notes", "campaignId",
  ]);
  const INTERNAL_BY_SECTION = Object.freeze({
    mk: new Set(["platform", "date", "time"]),
    po: new Set(["applicationLink"]),
    fu: new Set(["opportunity", "funder", "funderLink", "askAmount", "askCurrency", "probability", "lossReason", "sourceType", "roundId"]),
  });

  // Activity entries keep the shape their records already had: a field's
  // stored key and, for some options, the stored value.
  const ACTIVITY_STORAGE = Object.freeze({
    milestones: { collection: "timeEntries", keys: {}, values: {} },
    updateLog: {
      collection: "activityLog",
      keys: { whatHappened: "type" },
      values: { whatHappened: { research: "verification", sent: "application", reply: "response", "follow-up": "follow-up", meeting: "meeting", published: "published", decision: "decision", other: "other" } },
    },
    commitments: {
      collection: "commitments",
      keys: {},
      values: { state: { verbal: "Verbal", written: "Written", conditional: "Conditional", signed: "Signed" } },
    },
    payments: {
      collection: "payments",
      keys: { dueDate: "date" },
      values: { status: { expected: "Expected", scheduled: "Scheduled", invoiced: "Invoiced", "partially-received": "Partially Received", received: "Received", delayed: "Delayed", cancelled: "Cancelled" } },
    },
    documents: {
      collection: "documents",
      keys: {},
      values: { status: { "not-needed": "Not required", "to-do": "Required", drafting: "In progress", ready: "Ready", submitted: "Submitted", "needs-changes": "Needs changes", accepted: "Accepted" } },
    },
  });

  // Older keys whose value has exactly one new home. Moved once when a
  // record is loaded, and only into an empty field; the old key goes, since
  // the value now lives in the new one. Anything else stays where it was.
  const MOVES = Object.freeze({
    mk: [
      ["extraParams", "impressions", "reach"],
      ["extraParams", "clicks", "clicks"],
      ["extraParams", "installs", "conversions"],
      ["extraParams", "sentiment", "sentiment"],
      ["extraParams", "lastContactDate", "lastContactDate"],
      ["extraParams", "followUpCount", "followUps"],
      ["extraParams", "responseType", "response"],
      ["extraParams", "cost", "cost"],
      ["extraParams", "effortHours", "effortHours"],
      ["extraParams", "bestTime", "bestTime"],
      ["extraParams", "scheduledFor", "scheduledFor"],
      ["extraParams", "actuallyPostedAt", "postedAt"],
      ["extraParams", "language", "language"],
      ["extraParams", "region", "region"],
      ["extraParams", "targetAudience", "audience"],
      ["extraParams", "targetProblem", "problem"],
    ],
    po: [
      ["details", "providerOrg", "organization"],
      ["details", "internalOwner", "owner"],
      ["details", "actionOwner", "owner"],
      ["details", "nextAction", "nextAction"],
      ["details", "refCallId", "referenceId"],
      ["details", "lastVerifiedAt", "lastVerified"],
      ["details", "evidenceSource", "evidence"],
      ["details", "appUrl", "applicationUrl"],
      ["details", "appId", "applicationId"],
      ["details", "submissionDate", "submittedOn"],
      ["details", "interviewDate", "interviewOn"],
      ["details", "incorpCountry", "incorporationCountry"],
      ["details", "appLanguage", "applicationLanguage"],
      ["details", "maxCompanyAge", "maxCompanyAgeYears"],
      ["details", "sectorReq", "sectorRules"],
      ["details", "founderTimeCommitment", "timeCommitment"],
      ["details", "prepHours", "effortHours"],
      ["details", "probability", "probabilityPercent"],
      ["details", "incorpReq", "incorporationRequired"],
      ["extraParams", "deadline", "deadline"],
      ["extraParams", "effortHours", "effortHours"],
      ["extraParams", "learnings", "lessonsLearned"],
      ["extraParams", "timeCommitment", "timeCommitment"],
      ["extraParams", "applicationWindowOpen", "opensOn"],
    ],
    fu: [
      ["extraParams", "instrument", "instrument"],
      ["extraParams", "investorThesis", "thesis"],
      ["extraParams", "sectorFocus", "sectors"],
      ["extraParams", "geographicMandate", "geography"],
      ["extraParams", "portfolioConflict", "portfolioConflicts"],
      ["extraParams", "opportunityUrl", "sourceUrl"],
      ["extraParams", "introductionBy", "introducer"],
      ["extraParams", "warmth", "relationship"],
      ["extraParams", "boardSeatRequired", "boardSeat"],
      ["extraParams", "valuationCap", "valuationOrCap"],
      ["extraParams", "dilutionPercent", "dilutionPercent"],
      ["extraParams", "interestRatePercent", "interestRatePercent"],
      ["extraParams", "repaymentTermMonths", "termMonths"],
      ["extraParams", "termSheetDate", "termSheetDate"],
      ["extraParams", "learnings", "lessonsLearned"],
    ],
  });

  let registry = { common: { fields: [], groups: [], activities: [] }, mk: { fields: [], groups: [], activities: [] }, po: { fields: [], groups: [], activities: [] }, fu: { fields: [], groups: [], activities: [] } };
  let customDefinitions = [];

  function setRegistry(next) {
    const empty = { fields: [], groups: [], activities: [] };
    registry = {
      common: { ...empty, ...(next?.common || {}) },
      mk: { ...empty, ...(next?.mk || {}) },
      po: { ...empty, ...(next?.po || {}) },
      fu: { ...empty, ...(next?.fu || {}) },
    };
  }

  // The registry and the custom fields from the server, or the shipped files
  // when it cannot answer (then without custom fields).
  async function load(fetchImpl = fetch) {
    try {
      const response = await fetchImpl("/api/fields", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setRegistry(body.registry);
      setCustomFields(body.custom);
      return body;
    } catch {
      const files = await Promise.all(["common", ...SECTIONS].map((name) => fetchImpl(`/content/fields/${name}.json`).then((response) => response.json()).catch(() => null)));
      setRegistry({ common: files[0], mk: files[1], po: files[2], fu: files[3] });
      setCustomFields([]);
      return { registry, custom: [] };
    }
  }

  // ---- custom fields --------------------------------------------------------

  class FieldError extends Error {
    constructor(message, code = "badField") {
      super(message);
      this.name = "FieldError";
      this.code = code;
      this.statusCode = 400;
    }
  }

  function keyFromLabel(label) {
    const words = String(label || "").normalize("NFKD").replace(/[^\w\s]/g, " ").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const key = words.map((word, index) => (index ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join("").replace(/^[^a-z]+/, "");
    return key.slice(0, 48);
  }

  // A custom field definition, checked: { id, section, key, label,
  // description, example, type, options, group }.
  function validateCustomField(definition, existing = []) {
    if (!definition || typeof definition !== "object") throw new FieldError(t("fields.validateCustomField.aFieldMustBeAn"));
    const section = definition.section;
    if (!SECTIONS.includes(section)) throw new FieldError(t("fields.validateCustomField.sectionMustBeOneOf", { value: SECTIONS.join(", ") }));
    const label = String(definition.label || "").trim();
    if (!label) throw new FieldError(t("fields.validateCustomField.aFieldNeedsALabel"), "labelRequired");
    if (label.length > 80) throw new FieldError(t("fields.validateCustomField.aLabelCanBeUp"), "labelTooLong");
    const key = String(definition.key || keyFromLabel(label)).trim();
    if (!/^[a-z][a-zA-Z0-9]{0,47}$/.test(key)) throw new FieldError(t("fields.validateCustomField.theKeyMustStartWith"), "badKey");
    const builtIn = [...fieldsOf("common", section), ...fieldsOf(section, section)].some((field) => field.key === key);
    if (builtIn) throw new FieldError(t("fields.validateCustomField.isAlreadyAFieldOf", { key }), "keyTaken");
    if (existing.some((other) => other.id !== definition.id && other.section === section && other.key === key)) throw new FieldError(t("fields.validateCustomField.anotherCustomFieldAlreadyUses", { key }), "keyTaken");
    const type = definition.type || "text";
    if (!CUSTOM_TYPES.includes(type)) throw new FieldError(t("fields.validateCustomField.typeMustBeOneOf", { value: CUSTOM_TYPES.join(", ") }), "badType");
    let options = [];
    if (type === "select" || type === "multiselect") {
      options = (Array.isArray(definition.options) ? definition.options : [])
        .map((option) => (typeof option === "string" ? { value: option, label: option } : option))
        .map((option) => ({ value: String(option?.value ?? option?.label ?? "").trim(), label: String(option?.label ?? option?.value ?? "").trim(), description: String(option?.description || "").trim() }))
        .filter((option) => option.value);
      if (!options.length) throw new FieldError(t("fields.validateCustomField.aListFieldNeedsAt"), "optionsRequired");
      if (new Set(options.map((option) => option.value)).size !== options.length) throw new FieldError(t("fields.validateCustomField.twoOptionsHaveTheSame"), "duplicateOption");
    }
    return {
      id: String(definition.id || `field-${section}-${key}`),
      section,
      key,
      label,
      description: String(definition.description || "").trim().slice(0, 400),
      example: String(definition.example || "").trim().slice(0, 120),
      type,
      options,
      group: String(definition.group || "").trim().slice(0, 60),
    };
  }

  function setCustomFields(list) {
    customDefinitions = [];
    for (const definition of Array.isArray(list) ? list : []) {
      try {
        customDefinitions.push(validateCustomField(definition, customDefinitions));
      } catch {
        // A broken definition is left out; its values stay under Other fields.
      }
    }
  }

  function customFields(section) {
    return customDefinitions
      .filter((definition) => definition.section === section)
      .map((definition) => ({ ...definition, sections: [section], tab: "extras", custom: true, suggested: null, validation: null, showInList: false, searchable: true }));
  }

  // ---- the registry -----------------------------------------------------------

  function fieldsOf(file, section) {
    return (registry[file]?.fields || []).filter((field) => !field.sections || field.sections.includes(section));
  }

  // The core block of the Details tab, in registry order. Notes are edited
  // in the Edit tab and are left out.
  function coreFields(section) {
    return fieldsOf("common", section).filter((field) => field.group === "core");
  }

  // The section's detail fields, in their groups' order.
  function detailGroups(section) {
    const groups = (registry[section]?.groups || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const fields = fieldsOf(section, section);
    return groups
      .map((group) => ({ ...group, fields: fields.filter((field) => field.group === group.id) }))
      .filter((group) => group.fields.length);
  }

  function activities(section) {
    return [...(registry.common?.activities || []), ...(registry[section]?.activities || [])]
      .filter((activity) => !activity.sections || activity.sections.includes(section))
      .map((activity) => (activity.checklist && documentChecklist ? { ...activity, checklist: documentChecklist } : activity));
  }

  // The Programs documents checklist as edited in Extra > Fields (shared by
  // every startup; js/options.js keeps it as the "documentChecklist" list).
  // null goes back to the shipped list in content/fields/po.json.
  let documentChecklist = null;
  function setDocumentChecklist(list) {
    documentChecklist = Array.isArray(list)
      ? list.map((entry) => ({ id: String(entry?.id || ""), label: String(entry?.label || entry?.id || ""), description: String(entry?.description || "") })).filter((entry) => entry.id)
      : null;
  }

  function shippedDocumentChecklist() {
    const activity = [...(registry.common?.activities || []), ...(registry.po?.activities || [])].find((entry) => entry.checklist);
    return activity ? activity.checklist.map((entry) => ({ ...entry })) : [];
  }

  function findField(section, key) {
    return [...coreFields(section), ...fieldsOf("common", section), ...fieldsOf(section, section), ...customFields(section)].find((field) => field.key === key) || null;
  }

  function where(section, field) {
    if (field.custom) return { place: "custom", key: field.key };
    if (field.key === "repeat") return { place: "repeat" };
    const stored = STORAGE[section]?.[field.key];
    if (stored && typeof stored === "object") return { place: "flat-money", ...stored };
    if (stored) return { place: "flat", key: stored };
    if (field.group === "core" || field.group === "notes" || field.tab === "core") return { place: "flat", key: field.key };
    return { place: "details", key: field.key };
  }

  // ---- values ---------------------------------------------------------------

  function numberOrNull(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value).trim().replace(/\s/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
    if (!text) return null;
    const number = Number(text.replace(",", "."));
    return Number.isFinite(number) ? number : null;
  }

  function currencyOf(value) {
    const text = String(value || "").trim().toUpperCase();
    return CURRENCY.test(text) ? text : "";
  }

  function optionValues(field) {
    return (field.options || []).map((option) => String(option.value));
  }

  // Matches a stored value to an option: its value, its label, or the same
  // words written as a slug ("Partially Received" is "partially-received").
  function matchOption(field, value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const values = optionValues(field);
    if (values.includes(text)) return text;
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const byLabel = (field.options || []).find((option) => String(option.label).toLowerCase() === text.toLowerCase());
    if (byLabel) return String(byLabel.value);
    if (values.includes(slug)) return slug;
    return null;
  }

  // What a field holds, from any input or stored value. Unknown select values
  // are kept as they are, so opening a record never loses one.
  function normalize(field, raw) {
    const type = field.type;
    if (type === "number" || type === "percent") {
      const number = numberOrNull(raw);
      if (number === null) return null;
      return type === "percent" ? Math.min(100, Math.max(0, number)) : number;
    }
    if (type === "rating") {
      const number = numberOrNull(raw);
      return number !== null && optionValues(field).includes(String(number)) ? number : null;
    }
    if (type === "money") {
      const value = raw && typeof raw === "object" ? raw : { amount: raw };
      return { amount: numberOrNull(value.amount), currency: currencyOf(value.currency) };
    }
    if (type === "money-range") {
      const value = raw && typeof raw === "object" ? raw : {};
      return { min: numberOrNull(value.min), max: numberOrNull(value.max), currency: currencyOf(value.currency) };
    }
    if (type === "date") return DATE.test(String(raw || "").trim()) ? String(raw).trim() : "";
    if (type === "time") return TIME.test(String(raw || "").trim()) ? String(raw).trim() : "";
    if (type === "datetime") {
      const text = String(raw || "").trim().replace(" ", "T").slice(0, 16);
      if (DATETIME.test(text)) return text;
      return DATE.test(text) ? text : "";
    }
    if (type === "tristate") {
      const text = String(raw ?? "").trim().toLowerCase();
      if (raw === true || ["yes", "true", "y"].includes(text)) return "yes";
      if (raw === false || ["no", "false", "n"].includes(text)) return "no";
      return "";
    }
    if (type === "select" || type === "status" || type === "priority") {
      if (raw === null || raw === undefined) return "";
      if (type !== "select") return String(raw).trim();
      const matched = matchOption(field, raw);
      return matched === null ? String(raw).trim() : matched;
    }
    if (type === "multiselect" || type === "list" || type === "tags") {
      const list = Array.isArray(raw) ? raw : String(raw ?? "").split(type === "list" ? /\n/ : /[,\n]/);
      const out = [];
      for (const entry of list) {
        const text = String(entry ?? "").trim();
        if (!text) continue;
        const value = type === "multiselect" ? (matchOption(field, text) ?? text) : text;
        if (!out.includes(value)) out.push(value);
      }
      return out;
    }
    if (type === "repeat") {
      const value = raw && typeof raw === "object" ? raw : {};
      const interval = Math.max(0, Math.floor(numberOrNull(value.interval) || 0));
      const unit = ["days", "weeks", "months"].includes(value.unit) ? value.unit : "";
      return interval && unit ? { interval, unit } : { interval: 0, unit: "" };
    }
    if (type === "taxonomy") return Array.isArray(raw) ? raw.map(String) : [];
    return String(raw ?? "").trim();
  }

  function isEmpty(field, value) {
    if (value === null || value === undefined || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (field.type === "money") return value.amount === null || value.amount === undefined;
    if (field.type === "money-range") return (value.min === null || value.min === undefined) && (value.max === null || value.max === undefined);
    if (field.type === "repeat") return !value.interval || !value.unit;
    return false;
  }

  function getValue(section, record, field) {
    const at = where(section, field);
    const source = record || {};
    if (at.place === "repeat") return normalize({ type: "repeat" }, { interval: source.repeatInterval, unit: source.repeatUnit });
    if (at.place === "flat-money") return normalize(field, { amount: source[at.amount], currency: source[at.currency] });
    const holder = at.place === "flat" ? source : (source[at.place] || {});
    return normalize(field, holder[at.key]);
  }

  // Writes a value where the field lives. An empty detail or custom value is
  // removed rather than stored as "".
  function setValue(section, record, field, raw) {
    const at = where(section, field);
    const value = normalize(field, raw);
    if (at.place === "repeat") {
      record.repeatInterval = value.interval;
      record.repeatUnit = value.unit;
      return record;
    }
    if (at.place === "flat-money") {
      record[at.amount] = value.amount === null ? 0 : value.amount;
      if (value.currency) record[at.currency] = value.currency;
      return record;
    }
    if (at.place === "flat") {
      record[at.key] = value;
      return record;
    }
    const holder = record[at.place] && typeof record[at.place] === "object" ? record[at.place] : (record[at.place] = {});
    if (isEmpty(field, value)) delete holder[at.key];
    else holder[at.key] = value;
    return record;
  }

  // ---- activity entries -------------------------------------------------------

  function activityStorage(activity) {
    return ACTIVITY_STORAGE[activity.id] || { collection: activity.id, keys: {}, values: {} };
  }

  function activityEntries(record, activity) {
    const list = record?.[activityStorage(activity).collection];
    return Array.isArray(list) ? list : [];
  }

  function readEntryValue(activity, field, entry) {
    const storage = activityStorage(activity);
    const stored = entry?.[storage.keys[field.key] || field.key];
    const map = storage.values[field.key];
    if (map) {
      const back = Object.entries(map).find(([, storedValue]) => storedValue === stored);
      if (back) return back[0];
    }
    return normalize(field, stored);
  }

  // Writes one entry's values in its stored shape; keys no field claims stay.
  function writeEntry(activity, entry, values) {
    const storage = activityStorage(activity);
    const next = { ...(entry || {}) };
    for (const field of activity.fields || []) {
      if (!(field.key in values)) continue;
      const value = normalize(field, values[field.key]);
      const map = storage.values[field.key];
      next[storage.keys[field.key] || field.key] = map && map[value] !== undefined ? map[value] : value;
    }
    return next;
  }

  // ---- older keys ---------------------------------------------------------------

  // Moves the older keys of MOVES into their new fields. Returns the record
  // (a copy when something moved) and whether it changed.
  function migrate(section, record) {
    if (!record || typeof record !== "object") return { record, changed: false };
    let next = null;
    for (const [place, oldKey, newKey] of MOVES[section] || []) {
      const holder = (next || record)[place];
      if (!holder || typeof holder !== "object" || !Object.prototype.hasOwnProperty.call(holder, oldKey)) continue;
      const field = findField(section, newKey);
      if (!field) continue;
      const value = normalize(field, holder[oldKey]);
      if (isEmpty(field, value) || (field.type === "select" && matchOption(field, value) === null)) continue;
      if (!isEmpty(field, getValue(section, next || record, field))) continue;
      next = next || { ...record, details: { ...(record.details || {}) }, extraParams: { ...(record.extraParams || {}) } };
      setValue(section, next, field, value);
      delete next[place][oldKey];
    }
    return next ? { record: next, changed: true } : { record, changed: false };
  }

  // Values on a record that no field definition claims: older detail keys,
  // older extra parameters, custom values whose field was deleted and flat
  // keys the app does not use. Each { place, key, value }.
  function otherFields(section, record) {
    if (!record) return [];
    const claimed = new Set();
    const all = [...fieldsOf("common", section), ...fieldsOf(section, section), ...customFields(section)];
    for (const field of all) {
      const at = where(section, field);
      if (at.place === "flat-money") {
        claimed.add(`flat:${at.amount}`);
        claimed.add(`flat:${at.currency}`);
      } else if (at.key) claimed.add(`${at.place}:${at.key}`);
    }
    const out = [];
    for (const [key, value] of Object.entries(record)) {
      if (INTERNAL_KEYS.has(key) || INTERNAL_BY_SECTION[section]?.has(key) || claimed.has(`flat:${key}`)) continue;
      if (value === undefined) continue;
      out.push({ place: "flat", key, value });
    }
    for (const place of ["details", "extraParams", "custom"]) {
      const holder = record[place];
      if (!holder || typeof holder !== "object") continue;
      for (const [key, value] of Object.entries(holder)) {
        if (claimed.has(`${place}:${key}`)) continue;
        if (value === null || value === undefined || value === "") continue;
        out.push({ place, key, value });
      }
    }
    return out;
  }

  // ---- display ------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  function optionLabel(field, value) {
    const option = (field.options || []).find((entry) => String(entry.value) === String(value));
    return option ? option.label : String(value);
  }

  // A value as text, for the Overview and "All details". `helpers` may give
  // formatDate(date), formatDateTime(value), formatNumber(n), label(field, value).
  function formatValue(field, value, helpers = {}) {
    if (isEmpty(field, value)) return "";
    const number = (n) => (helpers.formatNumber ? helpers.formatNumber(n) : String(n));
    const date = (d) => (helpers.formatDate ? helpers.formatDate(d) : d);
    if (helpers.label) {
      const custom = helpers.label(field, value);
      if (custom !== undefined && custom !== null) return custom;
    }
    switch (field.type) {
      case "number": return number(value);
      case "percent": return `${number(value)}%`;
      case "money": return [value.currency, number(value.amount)].filter(Boolean).join(" ");
      case "money-range": {
        const parts = [value.min, value.max].filter((entry) => entry !== null && entry !== undefined);
        const range = value.min !== null && value.max !== null && value.min !== value.max ? `${number(value.min)} to ${number(value.max)}` : number(parts[0]);
        return [value.currency, range].filter(Boolean).join(" ");
      }
      case "date": return date(value);
      case "datetime": return helpers.formatDateTime ? helpers.formatDateTime(value) : value.replace("T", " ");
      case "select":
      case "rating": return optionLabel(field, value);
      case "multiselect": return value.map((entry) => optionLabel(field, entry)).join(", ");
      case "list":
      case "tags": return value.join(", ");
      case "tristate": return value === "yes" ? t("fields.formatValue.yes") : t("fields.formatValue.no");
      case "repeat": return t("fields.formatValue.every", { interval: value.interval, value: value.interval === 1 ? value.unit.replace(/s$/, "") : value.unit });
      default: return String(value);
    }
  }

  // ---- inputs -------------------------------------------------------------------

  function attrs(field, idPrefix) {
    return `id="${escapeHtml(`${idPrefix}${field.key}`)}" data-field-input="${escapeHtml(field.key)}"`;
  }

  function placeholder(field) {
    return field.example ? ` placeholder="${escapeHtml(field.example)}"` : "";
  }

  function optionsHtml(field, value, { emptyLabel = t("fields.optionsHtml.notSet") } = {}) {
    const values = optionValues(field);
    const unknown = value !== "" && value !== null && value !== undefined && !values.includes(String(value));
    return [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...(field.options || []).map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(value) ? " selected" : ""}${option.description ? ` title="${escapeHtml(option.description)}"` : ""}>${escapeHtml(option.label)}</option>`),
      unknown ? `<option value="${escapeHtml(value)}" selected>${tHtml("fields.optionsHtml.notInTheList", { value: escapeHtml(value) })}</option>` : "",
    ].join("");
  }

  // The input for one field, without its label. Every control sits inside an
  // element with data-field="key", which readInput() reads back.
  function inputHtml(field, value, { idPrefix = "field-", describedBy = "", currency = "" } = {}) {
    const described = describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : "";
    const base = `${attrs(field, idPrefix)}${described}`;
    const wrap = (inner, extraClass = "") => `<div class="field-control field-control-${escapeHtml(field.type)}${extraClass}" data-field="${escapeHtml(field.key)}" data-field-type="${escapeHtml(field.type)}">${inner}</div>`;
    const currencyInput = (current) => `<input type="text" class="field-currency" data-part="currency" maxlength="3" autocomplete="off" aria-label="${escapeHtml(t("fields.inputHtml.currency"))}"${described} value="${escapeHtml(current)}" placeholder="${escapeHtml(currency || "EUR")}">`;
    switch (field.type) {
      case "textarea":
      case "markdown":
        return wrap(`<textarea ${base} rows="3"${placeholder(field)}>${escapeHtml(value)}</textarea>`);
      case "list":
        return wrap(`<textarea ${base} rows="3"${placeholder(field)}>${escapeHtml((value || []).join("\n"))}</textarea>`);
      case "number":
        return wrap(`<input type="number" step="any" ${base}${placeholder(field)} value="${value === null ? "" : escapeHtml(value)}">`);
      case "percent":
        return wrap(`<input type="number" step="any" min="0" max="100" ${base}${placeholder(field)} value="${value === null ? "" : escapeHtml(value)}"><span class="field-suffix" aria-hidden="true">%</span>`);
      case "money":
        return wrap(`<input type="number" step="any" data-part="amount" ${base}${placeholder(field)} value="${value?.amount === null || value?.amount === undefined ? "" : escapeHtml(value.amount)}">${currencyInput(value?.currency || "")}`);
      case "money-range":
        return wrap(`<input type="number" step="any" data-part="min" ${base} aria-label="${tHtml("fields.inputHtml.minimum", { label: escapeHtml(field.label) })}" placeholder="${escapeHtml(t("fields.inputHtml.min"))}" value="${value?.min === null || value?.min === undefined ? "" : escapeHtml(value.min)}"><span class="field-range-to">${escapeHtml(t("fields.inputHtml.to"))}</span><input type="number" step="any" data-part="max" aria-label="${tHtml("fields.inputHtml.maximum", { label: escapeHtml(field.label) })}"${described} placeholder="${escapeHtml(t("fields.inputHtml.max"))}" value="${value?.max === null || value?.max === undefined ? "" : escapeHtml(value.max)}">${currencyInput(value?.currency || "")}`);
      case "date":
        return wrap(`<input type="date" ${base} value="${escapeHtml(value)}">`);
      case "datetime":
        return wrap(`<input type="datetime-local" ${base} value="${escapeHtml(DATE.test(value) ? `${value}T00:00` : value)}">`);
      case "time":
        return wrap(`<input type="time" ${base} value="${escapeHtml(value)}">`);
      case "url":
        return wrap(`<input type="url" ${base}${placeholder(field)} value="${escapeHtml(value)}">`);
      case "email":
        return wrap(`<input type="email" ${base}${placeholder(field)} value="${escapeHtml(value)}">`);
      case "select":
      case "rating":
        return wrap(`<select ${base}>${optionsHtml(field, value)}</select>`);
      case "tristate":
        return wrap(`<select ${base}><option value=""${value ? "" : " selected"}>${escapeHtml(t("fields.inputHtml.unknown"))}</option><option value="yes"${value === "yes" ? " selected" : ""}>${escapeHtml(t("fields.inputHtml.yes"))}</option><option value="no"${value === "no" ? " selected" : ""}>${escapeHtml(t("fields.inputHtml.no"))}</option></select>`);
      case "multiselect": {
        const picked = new Set((value || []).map(String));
        const known = optionValues(field);
        const boxes = (field.options || []).map((option) => `<label class="field-choice"${option.description ? ` title="${escapeHtml(option.description)}"` : ""}><input type="checkbox" value="${escapeHtml(option.value)}"${picked.has(String(option.value)) ? " checked" : ""}> <span>${escapeHtml(option.label)}</span></label>`);
        const unknown = [...picked].filter((entry) => !known.includes(entry)).map((entry) => `<label class="field-choice is-unknown"><input type="checkbox" value="${escapeHtml(entry)}" checked> <span>${tHtml("fields.inputHtml.notInTheList", { entry: escapeHtml(entry) })}</span></label>`);
        return wrap(`<div class="field-choices" role="group" ${attrs(field, idPrefix)}${described} aria-label="${escapeHtml(field.label)}">${[...boxes, ...unknown].join("")}</div>`);
      }
      default:
        return wrap(`<input type="text" ${base}${placeholder(field)} value="${escapeHtml(value)}">`);
    }
  }

  // Reads one field's control back. `container` holds the data-field element.
  function readInput(field, container) {
    const holder = container.querySelector(`[data-field="${field.key}"]`);
    if (!holder) return undefined;
    const part = (name) => holder.querySelector(`[data-part="${name}"]`)?.value ?? "";
    const control = holder.querySelector("[data-field-input]");
    switch (field.type) {
      case "money": return normalize(field, { amount: part("amount"), currency: part("currency") });
      case "money-range": return normalize(field, { min: part("min"), max: part("max"), currency: part("currency") });
      case "multiselect": return normalize(field, [...holder.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value));
      case "datetime": return normalize(field, control?.value || "");
      default: return normalize(field, control ? control.value : "");
    }
  }

  return {
    SECTIONS,
    TYPES,
    CUSTOM_TYPES,
    STORAGE,
    MOVES,
    FieldError,
    load,
    setRegistry,
    setCustomFields,
    customFields,
    validateCustomField,
    keyFromLabel,
    coreFields,
    detailGroups,
    activities,
    setDocumentChecklist,
    shippedDocumentChecklist,
    findField,
    where,
    normalize,
    isEmpty,
    getValue,
    setValue,
    activityEntries,
    activityStorage,
    readEntryValue,
    writeEntry,
    migrate,
    otherFields,
    formatValue,
    optionLabel,
    inputHtml,
    readInput,
  };
});
