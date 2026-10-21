// Option lists shared by every startup: media types, the feedback lists,
// research link groups and the Programs documents checklist.
//
// The shipped lists are content/options.json (the documents checklist comes
// from content/fields/po.json). An edited list is kept whole in the global
// "optionLists" section and replaces the shipped one; removing an option never
// changes the records that use it, which then show its id until it comes back.
//
// UMD: browsers get window.StartupTrackerOptions, Node gets module.exports
// (lib/options.js checks lists with the same rules before saving them).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerOptions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);

  const FEEDBACK_BLOCKS = Object.freeze(["", "person", "journey", "assumption"]);

  // Every list, where it is edited, and the extra property its options carry.
  const LISTS = Object.freeze([
    { name: "mediaTypes", page: "media" },
    { name: "feedbackTypes", page: "feedback", extra: { key: "block", values: FEEDBACK_BLOCKS } },
    { name: "feedbackSources", page: "feedback" },
    { name: "feedbackStages", page: "feedback" },
    { name: "feedbackAreas", page: "feedback" },
    { name: "feedbackEvidence", page: "feedback" },
    { name: "feedbackRelationships", page: "feedback" },
    { name: "feedbackJourneySteps", page: "feedback" },
    { name: "feedbackVerdicts", page: "feedback" },
    { name: "researchGroups", page: "research", extra: { key: "linkType" } },
    { name: "documentChecklist", page: "fields" },
  ].map((spec) => Object.freeze(spec)));
  const LIST_NAMES = Object.freeze(LISTS.map((spec) => spec.name));
  const MAX_OPTIONS = 100;
  const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

  class OptionError extends Error {
    constructor(message, code = "badOptions") {
      super(message);
      this.name = "OptionError";
      this.code = code;
      this.statusCode = 400;
    }
  }

  function specOf(name) {
    return LISTS.find((spec) => spec.name === name) || null;
  }

  // "Logo or brand" -> "logo-or-brand"; a taken id gets -2, -3...
  function idFromLabel(label, taken = []) {
    const base = String(label || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "option";
    const used = new Set(taken);
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  // One list, checked: unique ids, a label on each option, known extras.
  function validateList(name, list) {
    const spec = specOf(name);
    if (!spec) throw new OptionError(t("options.validateList.unknownOptionList", { name }), "unknownList");
    if (!Array.isArray(list)) throw new OptionError(t("options.validateList.mustBeAList", { name }));
    if (!list.length) throw new OptionError("A list needs at least one option.", "emptyList");
    if (list.length > MAX_OPTIONS) throw new OptionError(t("options.validateList.aListCanHoldUp", { MAX_OPTIONS }), "tooMany");
    const seen = new Set();
    return list.map((option) => {
      if (!option || typeof option !== "object") throw new OptionError("Each option must be an object.");
      const label = String(option.label || "").trim();
      if (!label) throw new OptionError("Each option needs a label.", "labelRequired");
      if (label.length > 80) throw new OptionError("A label can be up to 80 characters.", "labelTooLong");
      const id = String(option.id || "").trim() || idFromLabel(label, seen);
      if (!ID_PATTERN.test(id)) throw new OptionError(t("options.validateList.isNotAValidId", { id }), "badId");
      if (seen.has(id)) throw new OptionError(t("options.validateList.twoOptionsUseTheId", { id }), "duplicateId");
      seen.add(id);
      const clean = { id, label };
      const description = String(option.description || "").trim();
      if (description) clean.description = description.slice(0, 400);
      if (spec.extra) {
        const value = String(option[spec.extra.key] ?? "").trim();
        if (spec.extra.values && !spec.extra.values.includes(value)) {
          throw new OptionError(t("options.validateList.mustBeOneOfOr", { key: spec.extra.key, value: spec.extra.values.filter(Boolean).join(", ") }), "badExtra");
        }
        clean[spec.extra.key] = value;
      }
      return clean;
    });
  }

  // ---- the lists in use (browser) ---------------------------------------------

  let defaults = {};
  let stored = {};

  function setDefaults(next) {
    defaults = next && typeof next === "object" ? next : {};
  }

  function setStored(next) {
    stored = next && typeof next === "object" && !Array.isArray(next) ? next : {};
  }

  function list(name) {
    const value = Array.isArray(stored[name]) ? stored[name] : defaults[name];
    return Array.isArray(value) ? value : [];
  }

  function isEdited(name) {
    return Array.isArray(stored[name]);
  }

  function find(name, id) {
    return list(name).find((option) => option.id === id) || null;
  }

  // The label of an option, or the stored value itself when its option was
  // removed (so a record never shows an empty field).
  function label(name, id) {
    return find(name, id)?.label || String(id || "");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  // <option> tags for a list. A selected value that is no longer in the list
  // stays selectable, so saving the form does not change it.
  function optionsHtml(name, selected = "", { allLabel = "", emptyLabel = null } = {}) {
    const options = list(name);
    const parts = [];
    if (allLabel) parts.push(`<option value="all"${selected === "all" ? " selected" : ""}>${escapeHtml(allLabel)}</option>`);
    if (emptyLabel !== null) parts.push(`<option value=""${selected === "" ? " selected" : ""}>${escapeHtml(emptyLabel)}</option>`);
    for (const option of options) {
      const title = option.description ? ` title="${escapeHtml(option.description)}"` : "";
      parts.push(`<option value="${escapeHtml(option.id)}"${option.id === selected ? " selected" : ""}${title}>${escapeHtml(option.label)}</option>`);
    }
    if (selected && selected !== "all" && !options.some((option) => option.id === selected)) {
      parts.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`);
    }
    return parts.join("");
  }

  // Loads the lists in use from the server (GET /api/options).
  async function load(fetchImpl = fetch, url = "/api/options") {
    const response = await fetchImpl(url, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    setDefaults(body.defaults);
    setStored(body.stored);
    return body;
  }

  return Object.freeze({
    LISTS,
    LIST_NAMES,
    FEEDBACK_BLOCKS,
    MAX_OPTIONS,
    OptionError,
    specOf,
    idFromLabel,
    validateList,
    setDefaults,
    setStored,
    list,
    isEdited,
    find,
    label,
    optionsHtml,
    load,
  });
});
