// The field registry (content/fields/*.json) as the page and the tests use it
// (window.StartupTrackerFields).
//
// Every target has the same core fields (name, organization, link, status...)
// in MK, PO and FU, then its section's detail fields in groups, then its own
// custom fields: label and value pairs that belong to that one target. This
// file knows where each one is stored on a record, turns what an input holds
// into a stored value and back, and builds the inputs. The record window
// (js/record-window.js) draws them.
//
// Where values live: core fields flat on the record, detail fields in
// `record.details`, custom fields in `record.customFields` as a list of
// { label, value }, and the entries of an activity (the timeline, and FU
// commitments and payments) in a list named after the activity.
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
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME = /^\d{2}:\d{2}$/;
  const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const CURRENCY = /^[A-Z]{3}$/;
  // A custom field's label and value, as the Details tab takes them.
  const CUSTOM_LABEL_MAX = 80;
  const CUSTOM_VALUE_MAX = 4000;

  let registry = { common: { fields: [], groups: [], activities: [] }, mk: { fields: [], groups: [], activities: [] }, po: { fields: [], groups: [], activities: [] }, fu: { fields: [], groups: [], activities: [] } };

  function setRegistry(next) {
    const empty = { fields: [], groups: [], activities: [] };
    registry = {
      common: { ...empty, ...(next?.common || {}) },
      mk: { ...empty, ...(next?.mk || {}) },
      po: { ...empty, ...(next?.po || {}) },
      fu: { ...empty, ...(next?.fu || {}) },
    };
  }

  // The registry from the server, or the shipped files when it cannot answer.
  async function load(fetchImpl = fetch) {
    try {
      const response = await fetchImpl("/api/fields", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setRegistry(body.registry);
      return body;
    } catch {
      const files = await Promise.all(["common", ...SECTIONS].map((name) => fetchImpl(`/content/fields/${name}.json`).then((response) => response.json()).catch(() => null)));
      setRegistry({ common: files[0], mk: files[1], po: files[2], fu: files[3] });
      return { registry };
    }
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
      .filter((activity) => !activity.sections || activity.sections.includes(section));
  }

  function findField(section, key) {
    return [...fieldsOf("common", section), ...fieldsOf(section, section)].find((field) => field.key === key) || null;
  }

  function where(section, field) {
    if (field.key === "repeat") return { place: "repeat" };
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

  // Matches a typed value to an option: its value or its label.
  function matchOption(field, value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (optionValues(field).includes(text)) return text;
    const byLabel = (field.options || []).find((option) => String(option.label).toLowerCase() === text.toLowerCase());
    return byLabel ? String(byLabel.value) : null;
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
    const holder = at.place === "flat" ? source : (source[at.place] || {});
    return normalize(field, holder[at.key]);
  }

  // Writes a value where the field lives. An empty detail value is removed
  // rather than stored as "".
  function setValue(section, record, field, raw) {
    const at = where(section, field);
    const value = normalize(field, raw);
    if (at.place === "repeat") {
      record.repeatInterval = value.interval;
      record.repeatUnit = value.unit;
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

  // ---- custom fields --------------------------------------------------------

  // A target's own label and value pairs, as text, in their order. A pair
  // with neither a label nor a value is dropped.
  function customFieldsOf(record) {
    return (Array.isArray(record?.customFields) ? record.customFields : [])
      .map((entry) => ({
        label: String(entry?.label ?? "").trim().slice(0, CUSTOM_LABEL_MAX),
        value: String(entry?.value ?? "").trim().slice(0, CUSTOM_VALUE_MAX),
      }))
      .filter((entry) => entry.label || entry.value);
  }

  // ---- activity entries -------------------------------------------------------

  function activityEntries(record, activity) {
    const list = record?.[activity.id];
    return Array.isArray(list) ? list : [];
  }

  function readEntryValue(activity, field, entry) {
    return normalize(field, entry?.[field.key]);
  }

  // Writes one entry's values; keys no field claims stay.
  function writeEntry(activity, entry, values) {
    const next = { ...(entry || {}) };
    for (const field of activity.fields || []) {
      if (field.key in values) next[field.key] = normalize(field, values[field.key]);
    }
    return next;
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
    load,
    setRegistry,
    coreFields,
    detailGroups,
    activities,
    findField,
    where,
    normalize,
    isEmpty,
    getValue,
    setValue,
    customFieldsOf,
    activityEntries,
    readEntryValue,
    writeEntry,
    formatValue,
    optionLabel,
    inputHtml,
    readInput,
  };
});
