// The settings shared by every startup (GET and PATCH /api/settings), as the
// browser sees them.
//
// The page needs some of them before the server has answered: the time zone,
// the date format and the week start shape the very first render. So the last
// settings the server sent are kept in localStorage and used until the fresh
// copy arrives; a change is announced with the "startup-tracker:settings"
// window event.
//
// UMD: browsers get window.StartupTrackerSettings, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const STORAGE_KEY = "startup-tracker-settings";
  const EVENT_NAME = "startup-tracker:settings";

  // Kept in step with DEFAULT_SETTINGS in lib/settings.js.
  const DEFAULTS = Object.freeze({
    appName: "Startup Tracker",
    language: "en",
    timeZone: "",
    dateFormat: "system",
    weekStart: "monday",
    pageSize: 25,
    yourName: "",
    network: true,
    defaultScope: "startup",
    appearance: Object.freeze({ mode: "system", theme: "studio" }),
    sectionColors: Object.freeze({ palette: "standard", mk: "", po: "", fu: "", comp: "" }),
    backups: Object.freeze({ automatic: true, keepAutomatic: 20, keepSafety: 20 }),
    recycleBin: Object.freeze({ retentionDays: 30 }),
  });

  const NESTED = new Set(["appearance", "sectionColors", "backups", "recycleBin"]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  // A value of the default's type is taken; anything else keeps the default.
  // The server validates for real, this only keeps a damaged cache harmless.
  function resolve(stored) {
    const result = clone(DEFAULTS);
    if (!isPlainObject(stored)) return result;
    for (const key of Object.keys(DEFAULTS)) {
      const value = stored[key];
      if (value === undefined) continue;
      if (NESTED.has(key)) {
        if (!isPlainObject(value)) continue;
        for (const inner of Object.keys(DEFAULTS[key])) {
          const innerValue = value[inner];
          if (innerValue === undefined) continue;
          if (key === "recycleBin" && inner === "retentionDays" && innerValue === null) result[key][inner] = null;
          else if (typeof innerValue === typeof DEFAULTS[key][inner]) result[key][inner] = innerValue;
        }
      } else if (typeof value === typeof DEFAULTS[key]) {
        result[key] = value;
      }
    }
    return result;
  }

  // The same rule as the server: a patch replaces top-level values and merges
  // the nested objects one level deep.
  function merge(current, patch) {
    const next = clone(current);
    if (!isPlainObject(patch)) return next;
    for (const [key, value] of Object.entries(patch)) {
      next[key] = NESTED.has(key) && isPlainObject(value) ? { ...(next[key] || {}), ...value } : value;
    }
    return next;
  }

  // "" means the browser's own zone.
  function effectiveTimeZone(settings, browserZone) {
    return (settings && typeof settings.timeZone === "string" && settings.timeZone) || browserZone || "UTC";
  }

  // Search and the calendar call the two scopes "this" and "all".
  function defaultScopeChoice(settings) {
    return settings?.defaultScope === "all" ? "all" : "this";
  }

  // "Calendar · Acme · Startup Tracker" without the parts that are empty.
  function pageTitle(startupName, appName) {
    const app = String(appName || DEFAULTS.appName).trim() || DEFAULTS.appName;
    const name = String(startupName || "").trim();
    return name ? `${name} · ${app}` : app;
  }

  // ---- browser -------------------------------------------------------------

  let current = null;
  let loadPromise = null;

  function storage() {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  }

  function readCache() {
    try {
      const text = storage()?.getItem(STORAGE_KEY);
      return text ? resolve(JSON.parse(text)) : resolve(null);
    } catch {
      return resolve(null);
    }
  }

  function writeCache(settings) {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // The page keeps working; the next load waits for the server instead.
    }
  }

  function announce(previous) {
    if (typeof root.dispatchEvent !== "function" || typeof root.CustomEvent !== "function") return;
    root.dispatchEvent(new root.CustomEvent(EVENT_NAME, { detail: { settings: get(), previous } }));
  }

  function accept(settings) {
    const previous = current ? clone(current) : null;
    current = resolve(settings);
    writeCache(current);
    if (JSON.stringify(previous) !== JSON.stringify(current)) announce(previous);
    return get();
  }

  function get() {
    if (!current) current = readCache();
    return clone(current);
  }

  function urls() {
    return root.StartupTrackerApi?.urls || { settings: "/api/settings" };
  }

  async function request(method, body) {
    const response = await root.fetch(urls().settings, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.field = payload.field || "";
      throw error;
    }
    return payload;
  }

  // Reads the settings from the server once per page (force reads again).
  function load({ force = false } = {}) {
    if (!loadPromise || force) {
      loadPromise = request("GET").then((payload) => accept(payload.settings)).catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  // Saves only the keys in patch. The answer is the full stored result.
  async function save(patch) {
    const payload = await request("PATCH", { settings: patch, origin: "ui" });
    return accept(payload.settings);
  }

  function subscribe(listener) {
    if (typeof root.addEventListener !== "function") return () => {};
    const handler = (event) => listener(event.detail.settings, event.detail.previous);
    root.addEventListener(EVENT_NAME, handler);
    return () => root.removeEventListener(EVENT_NAME, handler);
  }

  return Object.freeze({
    STORAGE_KEY,
    EVENT_NAME,
    DEFAULTS,
    resolve,
    merge,
    effectiveTimeZone,
    defaultScopeChoice,
    pageTitle,
    get,
    load,
    save,
    subscribe,
    accept,
  });
});
