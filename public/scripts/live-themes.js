// The live theme switcher: a small bar floating at the top centre of the
// screen, one keyed button per theme and a close button. Settings → Appearance
// opens it with "Try themes live"; it stays open while you move around the app
// and across reloads in the same tab until closed. Picking a key applies and
// saves the theme, exactly like the cards in Settings.
//
// UMD: browsers get window.StartupTrackerLiveThemes, Node gets the pure helpers.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerLiveThemes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const SESSION_KEY = "startup-tracker-live-themes";

  // The options shown in the bar, in the same order as Settings. The three-
  // letter key lives in the appearance module so the list has one home.
  function themeOptions(Appearance) {
    if (!Appearance?.THEMES) return [];
    return Appearance.THEMES.map((id) => ({
      id,
      code: Appearance.THEME_CODES?.[id] || id.slice(0, 3).toUpperCase(),
    }));
  }

  // The button after the current one, for arrow keys. -1 when nothing is open.
  function neighbourIndex(count, index, direction) {
    if (!Number.isInteger(count) || count <= 0) return -1;
    const current = Number.isInteger(index) && index >= 0 && index < count ? index : 0;
    return (current + (direction < 0 ? -1 : 1) + count) % count;
  }

  function nextTheme(ids, current, direction) {
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const index = ids.indexOf(current);
    return ids[neighbourIndex(ids.length, index, direction)] || null;
  }

  function isBarOpen(node) {
    return Boolean(node && node.isConnected);
  }

  const pure = {
    SESSION_KEY,
    themeOptions,
    neighbourIndex,
    nextTheme,
    isBarOpen,
  };

  if (!root.document || !root.StartupTrackerAppearance) return Object.freeze(pure);

  // ---- browser -------------------------------------------------------------

  const Appearance = root.StartupTrackerAppearance;
  const I18n = root.StartupTrackerI18n;
  const Settings = root.StartupTrackerSettings;
  const doc = root.document;
  const listeners = new Set();
  let bar = null;
  let flashTimer = null;
  // Clicking several keys quickly must not let an earlier response overwrite
  // a later choice, so the saves go out one after another.
  let saveQueue = Promise.resolve();

  // The bar can be opened before translations finish loading; a readable
  // fallback keeps it usable instead of showing a key.
  function t(key, fallback, params) {
    const text = I18n?.t?.(key, params);
    return text && text !== key ? text : fallback;
  }

  function themeName(id) {
    return t(`settings.appearance.themes.${id}.name`, id);
  }

  function announce() {
    const open = isOpen();
    doc.documentElement.classList.toggle("live-themes-on", open);
    listeners.forEach((listener) => {
      try {
        listener(open);
      } catch {
        // One broken listener must not stop the bar.
      }
    });
    if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
      root.dispatchEvent(new root.CustomEvent("startup-tracker:live-themes", { detail: { open } }));
    }
  }

  function setPressed() {
    if (!bar) return;
    const current = Appearance.get().theme;
    bar.querySelectorAll("[data-live-theme]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.liveTheme === current));
    });
  }

  function showName(button) {
    if (!bar || !button) return;
    bar.querySelectorAll(".show-name").forEach((node) => node.classList.remove("show-name"));
    button.classList.add("show-name");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => button.classList.remove("show-name"), 1600);
  }

  function pick(id, button) {
    if (!Appearance.THEMES.includes(id)) return;
    const current = Appearance.get();
    const next = { mode: current.mode, theme: id };
    Appearance.apply(next);
    showName(button);
    setPressed();
    if (Settings?.save) {
      saveQueue = saveQueue
        .catch(() => {})
        .then(() => Settings.save({ appearance: { mode: next.mode, theme: next.theme } }))
        .catch(() => {
          // The preview stays applied; the next load uses the saved choice.
        });
    }
  }

  function onKey(event) {
    if (!bar) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...bar.querySelectorAll("[data-live-theme]")];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(doc.activeElement);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else next = neighbourIndex(buttons.length, index, event.key === "ArrowRight" ? 1 : -1);
    if (next >= 0) {
      event.preventDefault();
      buttons[next].focus();
    }
  }

  function build() {
    const node = doc.createElement("div");
    node.id = "liveThemeBar";
    node.className = "live-theme-bar";
    node.setAttribute("role", "toolbar");
    node.setAttribute("aria-label", t("settings.appearance.tryLiveTitle", "Try themes live"));

    const mark = doc.createElement("span");
    mark.className = "live-theme-bar-mark";
    mark.setAttribute("aria-hidden", "true");
    node.append(mark);

    const list = doc.createElement("div");
    list.className = "live-theme-bar-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", t("settings.appearance.tryLiveTitle", "Try themes live"));
    for (const option of themeOptions(Appearance)) {
      const name = themeName(option.id);
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.liveTheme = option.id;
      button.dataset.name = name;
      button.dataset.short = option.code.slice(0, 2);
      button.textContent = option.code;
      button.setAttribute("aria-label", t("settings.appearance.tryLiveTheme", "Try the {name} theme", { name }));
      button.setAttribute("aria-pressed", "false");
      list.append(button);
    }
    node.append(list);

    const closeButton = doc.createElement("button");
    closeButton.type = "button";
    closeButton.className = "live-theme-bar-close";
    closeButton.dataset.name = t("settings.appearance.tryLiveClose", "Close");
    closeButton.setAttribute("aria-label", t("settings.appearance.tryLiveClose", "Close"));
    closeButton.textContent = "×";
    node.append(closeButton);

    node.addEventListener("click", (event) => {
      const button = event.target.closest?.("button");
      if (!button) return;
      if (button.dataset.liveTheme) pick(button.dataset.liveTheme, button);
      else close();
    });
    node.addEventListener("keydown", onKey);
    return node;
  }

  function open(options = {}) {
    try {
      root.sessionStorage?.setItem(SESSION_KEY, "1");
    } catch {
      // Storage can be blocked; the bar still opens for this page.
    }
    if (bar && !bar.isConnected) bar = null;
    if (bar) {
      if (options.focus !== false) {
        const current = Appearance.get().theme;
        bar.querySelector(`[data-live-theme="${CSS.escape(current)}"]`)?.focus();
      }
      setPressed();
      return bar;
    }
    bar = build();
    doc.body.append(bar);
    announce();
    setPressed();
    if (options.focus !== false) {
      const current = Appearance.get().theme;
      const button = bar.querySelector(`[data-live-theme="${CSS.escape(current)}"]`);
      button?.focus();
    }
    return bar;
  }

  function close() {
    try {
      root.sessionStorage?.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clean up.
    }
    clearTimeout(flashTimer);
    flashTimer = null;
    if (bar) bar.remove();
    bar = null;
    announce();
    // The trigger is inside Settings, which the bar closes on the way in.
    // Return focus to the Settings button so keyboard users keep their place.
    root.document.querySelector("#settingsButton")?.focus?.();
  }

  function toggle() {
    if (isOpen()) close();
    else open();
    return isOpen();
  }

  function isOpen() {
    return Boolean(bar && bar.isConnected);
  }

  function sync() {
    if (!bar) return;
    // Theme names may arrive with the translations after the bar was built.
    for (const button of bar.querySelectorAll("[data-live-theme]")) {
      const name = themeName(button.dataset.liveTheme);
      button.dataset.name = name;
      button.setAttribute("aria-label", t("settings.appearance.tryLiveTheme", "Try the {name} theme", { name }));
    }
    setPressed();
  }

  function restore() {
    let wasOpen = false;
    try {
      wasOpen = root.sessionStorage?.getItem(SESSION_KEY) === "1";
    } catch {
      wasOpen = false;
    }
    if (wasOpen) open({ focus: false });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  Appearance.subscribe?.(setPressed);
  const ready = I18n?.ready || Promise.resolve();
  ready.then(() => {
    restore();
    sync();
  }).catch(() => restore());

  return Object.freeze({
    ...pure,
    open,
    close,
    toggle,
    isOpen,
    sync,
    restore,
    subscribe,
  });
});
