// Translation layer.
//
// Strings live in content/i18n/<locale>.json as nested objects; a key such as
// "app.name" walks that tree. A value that is an object of plural categories
// ({ "one": "...", "other": "..." }) is picked with Intl.PluralRules from the
// `count` parameter. "{name}" placeholders are filled from params. A missing key
// returns the key itself, so a gap shows up on screen instead of breaking it.
//
// Markup opts in with data-i18n (text), data-i18n-html (text with inline
// markup such as <code>, from en.json only), data-i18n-placeholder,
// data-i18n-title, data-i18n-aria-label, data-i18n-tooltip and
// data-i18n-alt. They are applied once the strings load, and
// applyTranslations(root) does the same for markup rendered later.
//
// The pseudo-locale (?pseudo-locale=1 in the address) shows every string as
// ⟦its key⟧, so any plain English left on screen is a string that does not
// come from en.json yet.
//
// UMD: browsers get window.StartupTrackerI18n, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DEFAULT_LOCALE = "en";
  // Only English ships until a later part adds more.
  const AVAILABLE_LOCALES = Object.freeze(["en"]);
  const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
  const ATTRIBUTE_BINDINGS = Object.freeze([
    { attribute: "data-i18n-placeholder", target: "placeholder" },
    { attribute: "data-i18n-title", target: "title" },
    { attribute: "data-i18n-aria-label", target: "aria-label" },
    { attribute: "data-i18n-tooltip", target: "data-tooltip" },
    { attribute: "data-i18n-alt", target: "alt" },
  ]);
  const PSEUDO_LOCALE = "qps";

  let locale = DEFAULT_LOCALE;
  let strings = {};
  const warnedKeys = new Set();
  const pluralRulesCache = new Map();

  function getLocale() {
    return locale;
  }

  function getAvailableLocales() {
    return AVAILABLE_LOCALES.slice();
  }

  function isPluralObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.includes("other") && keys.every((key) => PLURAL_CATEGORIES.has(key) && typeof value[key] === "string");
  }

  function lookup(key) {
    if (typeof key !== "string" || !key) return undefined;
    let node = strings;
    for (const segment of key.split(".")) {
      if (!node || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
      node = node[segment];
    }
    return typeof node === "string" || isPluralObject(node) ? node : undefined;
  }

  function has(key) {
    return lookup(key) !== undefined;
  }

  function warnMissing(key) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    if (typeof console !== "undefined" && console.warn && typeof window !== "undefined") {
      console.warn(`Missing translation: ${key}`);
    }
  }

  function pluralCategory(count) {
    let rules = pluralRulesCache.get(locale);
    if (!rules) {
      rules = new Intl.PluralRules(locale);
      pluralRulesCache.set(locale, rules);
    }
    return rules.select(Number(count));
  }

  function fill(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
        ? String(params[name])
        : match
    ));
  }

  const numberFormatCache = new Map();

  // Formats a number in the current locale. Formatters are cached because
  // building one costs far more than using it.
  function formatNumber(value, options) {
    const key = `${locale}|${options ? JSON.stringify(options) : ""}`;
    let formatter = numberFormatCache.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, options);
      if (numberFormatCache.size >= 64) numberFormatCache.clear();
      numberFormatCache.set(key, formatter);
    }
    return formatter.format(Number(value) || 0);
  }

  // t("calendar.itemCount", { count: 3 }) -> "3 items".
  function t(key, params) {
    const value = lookup(key);
    if (value === undefined) {
      warnMissing(key);
      return String(key);
    }
    if (typeof value === "string") return fill(value, params);
    const count = params && params.count !== undefined ? Number(params.count) : Number.NaN;
    const template = Number.isFinite(count) ? (value[pluralCategory(count)] ?? value.other) : value.other;
    // A count reads in the locale's number format ("1,200 items").
    const filled = Number.isFinite(count) ? { ...params, count: formatNumber(count) } : params;
    return fill(template, filled);
  }

  function setStrings(nextStrings, nextLocale = locale) {
    strings = nextStrings && typeof nextStrings === "object" ? nextStrings : {};
    locale = nextLocale || DEFAULT_LOCALE;
    warnedKeys.clear();
  }

  // The same tree with every string replaced by ⟦key⟧. Placeholders stay
  // inside the brackets ("⟦calendar.itemCount|{count}⟧"), so the values they
  // get are not mistaken for untranslated text.
  function pseudoStrings(tree, prefix = "") {
    const out = {};
    for (const [name, value] of Object.entries(tree || {})) {
      const key = prefix ? `${prefix}.${name}` : name;
      const mark = (text) => {
        const params = [...new Set(String(text).match(/\{\w+\}/g) || [])];
        return `⟦${key}${params.length ? `|${params.join("")}` : ""}⟧`;
      };
      if (typeof value === "string") out[name] = mark(value);
      else if (isPluralObject(value)) out[name] = Object.fromEntries(Object.entries(value).map(([category, text]) => [category, mark(text)]));
      else if (value && typeof value === "object") out[name] = pseudoStrings(value, key);
    }
    return out;
  }

  // Applies data-i18n* attributes inside root (and on root itself). A key with
  // no string leaves the markup's own English text in place.
  function applyTranslations(rootNode) {
    const scope = rootNode || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelectorAll !== "function") return 0;
    const selector = ["data-i18n", "data-i18n-html", ...ATTRIBUTE_BINDINGS.map((binding) => binding.attribute)].map((name) => `[${name}]`).join(",");
    const nodes = Array.from(scope.querySelectorAll(selector));
    if (typeof scope.matches === "function" && scope.matches(selector)) nodes.unshift(scope);
    let applied = 0;
    for (const node of nodes) {
      const textKey = node.getAttribute("data-i18n");
      if (textKey) {
        if (has(textKey)) {
          node.textContent = t(textKey);
          applied += 1;
        } else {
          warnMissing(textKey);
        }
      }
      const htmlKey = node.getAttribute("data-i18n-html");
      if (htmlKey) {
        if (has(htmlKey)) {
          node.innerHTML = t(htmlKey);
          applied += 1;
        } else {
          warnMissing(htmlKey);
        }
      }
      for (const binding of ATTRIBUTE_BINDINGS) {
        const key = node.getAttribute(binding.attribute);
        if (!key) continue;
        if (has(key)) {
          node.setAttribute(binding.target, t(key));
          applied += 1;
        } else {
          warnMissing(key);
        }
      }
    }
    return applied;
  }

  // Loads the strings for the current locale. Never rejects: a failed load
  // leaves the page in the English text written in the markup.
  function load(nextLocale = DEFAULT_LOCALE) {
    const target = AVAILABLE_LOCALES.includes(nextLocale) ? nextLocale : DEFAULT_LOCALE;
    if (typeof fetch !== "function") return Promise.resolve(false);
    return fetch(`/content/i18n/${target}.json`, { headers: { Accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (pseudoRequested()) setStrings(pseudoStrings(data), PSEUDO_LOCALE);
        else setStrings(data, target);
        if (typeof document !== "undefined") {
          if (document.documentElement) document.documentElement.setAttribute("lang", target);
          applyTranslations(document);
        }
        return true;
      })
      .catch((error) => {
        if (typeof console !== "undefined" && console.warn) console.warn(`Could not load translations (${target}): ${error.message}`);
        return false;
      });
  }

  function pseudoRequested() {
    try {
      return typeof location !== "undefined" && new URLSearchParams(location.search).get("pseudo-locale") === "1";
    } catch {
      return false;
    }
  }

  const isBrowserPage = typeof window !== "undefined" && typeof document !== "undefined" && root === window;
  const ready = isBrowserPage ? load(DEFAULT_LOCALE) : Promise.resolve(false);
  // Under Node (tests, the server's shared modules) the English strings are
  // there from the start.
  if (!isBrowserPage && typeof module === "object" && module.exports && typeof module.require === "function") {
    try {
      setStrings(module.require("../../content/i18n/en.json"), DEFAULT_LOCALE);
    } catch {
      // Without the file, keys show; tests that need strings set their own.
    }
  }

  return Object.freeze({
    DEFAULT_LOCALE,
    t,
    has,
    getLocale,
    getAvailableLocales,
    setStrings,
    applyTranslations,
    formatNumber,
    pseudoStrings,
    load,
    ready,
  });
});
