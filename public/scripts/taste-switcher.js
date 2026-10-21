// Colour mode (light, dark or the system's) and theme style.
//
// The choice lives on the server in settings.appearance, shared by every
// startup. It is mirrored to two localStorage keys so js/boot.js can paint the
// first frame in the right colours before anything loads:
//   startup-tracker-theme  "light" or "dark"; absent means "follow the system"
//   startup-tracker-taste  the theme style id
//
// UMD: browsers get window.StartupTrackerAppearance, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerAppearance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const THEME_KEY = "startup-tracker-theme";
  const TASTE_KEY = "startup-tracker-taste";
  const DEFAULT_TASTE = "studio";
  const MODES = Object.freeze(["system", "light", "dark"]);

  // The ten theme styles, in the order Settings lists them. Keep in step with
  // THEMES in lib/settings.js and the selectors in styles/taste-variants.css.
  const THEMES = Object.freeze([
    "studio",
    "kinpaku",
    "paper",
    "mirai",
    "aurora",
    "cyber",
    "soft-ui",
    "linear",
    "minimal",
    "classic",
  ]);

  // The first three variants were called a, b and c: A was Linear Precision,
  // B Apple Studio and C Stark Minimalist. A saved letter still means that.
  const LEGACY_TASTES = Object.freeze({ a: "linear", b: "studio", c: "minimal" });

  function normalizeTaste(value) {
    if (typeof value !== "string" || !value) return DEFAULT_TASTE;
    if (Object.prototype.hasOwnProperty.call(LEGACY_TASTES, value)) return LEGACY_TASTES[value];
    return THEMES.includes(value) ? value : DEFAULT_TASTE;
  }

  function normalizeMode(value) {
    return MODES.includes(value) ? value : "system";
  }

  // "light" or "dark" for a mode, given whether the system prefers dark.
  function resolveMode(mode, systemDark) {
    const normalized = normalizeMode(mode);
    if (normalized === "system") return systemDark ? "dark" : "light";
    return normalized;
  }

  // The two storage values that reproduce an appearance at first paint.
  function mirrorValues(appearance) {
    const mode = normalizeMode(appearance?.mode);
    return {
      theme: mode === "system" ? null : mode,
      taste: normalizeTaste(appearance?.theme),
    };
  }

  // The appearance the stored mirror describes (what boot.js painted).
  function readMirror(storage) {
    let theme = null;
    let taste = null;
    try {
      theme = storage?.getItem(THEME_KEY) ?? null;
      taste = storage?.getItem(TASTE_KEY) ?? null;
    } catch {
      // Storage can be blocked; fall back to the defaults.
    }
    return {
      mode: theme === "light" || theme === "dark" ? theme : "system",
      theme: normalizeTaste(taste),
    };
  }

  function writeMirror(storage, appearance) {
    const values = mirrorValues(appearance);
    try {
      if (values.theme) storage.setItem(THEME_KEY, values.theme);
      else storage.removeItem(THEME_KEY);
      storage.setItem(TASTE_KEY, values.taste);
    } catch {
      // The page still shows the choice; only the next first paint may differ.
    }
  }

  // ---- browser -------------------------------------------------------------

  const listeners = new Set();
  let current = null;
  let mediaQuery = null;

  // Reading localStorage itself throws where the browser blocks storage.
  function browserStorage() {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  }

  function systemPrefersDark() {
    try {
      return Boolean(root.matchMedia?.("(prefers-color-scheme: dark)").matches);
    } catch {
      return false;
    }
  }

  function paint(appearance) {
    const element = root.document?.documentElement;
    if (!element) return;
    element.setAttribute("data-theme", resolveMode(appearance.mode, systemPrefersDark()));
    element.setAttribute("data-taste", normalizeTaste(appearance.theme));
  }

  // Shows an appearance and remembers it for the next first paint. Saving it
  // on the server is the caller's job (js/settings.js).
  function apply(appearance) {
    current = { mode: normalizeMode(appearance?.mode), theme: normalizeTaste(appearance?.theme) };
    paint(current);
    const storage = browserStorage();
    if (storage) writeMirror(storage, current);
    listeners.forEach((listener) => {
      try {
        listener({ ...current, resolved: resolveMode(current.mode, systemPrefersDark()) });
      } catch {
        // One broken listener must not stop the others.
      }
    });
    return current;
  }

  function get() {
    if (!current) current = readMirror(browserStorage());
    return { ...current, resolved: resolveMode(current.mode, systemPrefersDark()) };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function init() {
    if (!root.document) return;
    apply(readMirror(browserStorage()));
    // "System" follows the computer when it switches between light and dark.
    try {
      mediaQuery = root.matchMedia?.("(prefers-color-scheme: dark)") || null;
      mediaQuery?.addEventListener?.("change", () => {
        if (get().mode === "system") apply(get());
      });
    } catch {
      mediaQuery = null;
    }
    // Another tab changed the appearance.
    root.addEventListener?.("storage", (event) => {
      if (event.key === THEME_KEY || event.key === TASTE_KEY) {
        current = readMirror(browserStorage());
        apply(current);
      }
    });
  }

  if (root.document) init();

  return Object.freeze({
    THEME_KEY,
    TASTE_KEY,
    DEFAULT_TASTE,
    MODES,
    THEMES,
    LEGACY_TASTES,
    normalizeTaste,
    normalizeMode,
    resolveMode,
    mirrorValues,
    readMirror,
    writeMirror,
    apply,
    get,
    subscribe,
  });
});
