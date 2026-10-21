// The startup around the tracker: the switcher in the sidebar, the page title
// and favicon, the "New startup" dialog, and the screen that creates the first
// startup when there is none.
//
// Switching is always a full page load to /s/<id>/, so the tracker on this
// page (app.js) only ever holds one startup's state and outbox.
(function () {
  "use strict";

  const Api = window.StartupTrackerApi;
  const I18n = window.StartupTrackerI18n;
  const Icon = window.StartupTrackerIcon;
  const Settings = window.StartupTrackerSettings;
  if (!Api || !I18n || !Icon || !Settings) {
    throw new Error("js/api.js, js/i18n.js, js/settings-store.js and js/startup-icon.js must load before js/startups.js");
  }
  const t = I18n.t;

  let startups = [];
  let current = null;
  const outboxStatus = new Map();
  let listPromise = null;

  function openStartups() {
    return startups.filter((startup) => startup && !startup.archived);
  }

  // The uploaded icon, or the monogram of the startup's initials.
  function iconElement(startup, className) {
    const holder = document.createElement("span");
    holder.className = className;
    holder.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.src = Icon.iconFor(startup);
    image.alt = "";
    holder.appendChild(image);
    return holder;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function loadStartups() {
    listPromise ||= fetchJson(Api.urls.startups).then((payload) => {
      startups = Array.isArray(payload.startups) ? payload.startups : [];
      return startups;
    });
    return listPromise;
  }

  async function createStartup(body) {
    const payload = await fetchJson(Api.urls.startups, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, origin: "ui" }),
    });
    return payload.startup;
  }

  // app.js registers a hook that saves the open edit into this startup's own
  // outbox before the page goes away.
  async function leaveTo(url) {
    const prepare = window.StartupTrackerPage?.prepareToLeave;
    if (typeof prepare === "function") {
      try {
        await prepare();
      } catch {
        // The browser's own unload handling still flushes the autosave.
      }
    }
    window.location.assign(url);
  }

  // ---- Title, favicon, breadcrumb and footer -----------------------------

  // "<startup> · <app name>", and the startup's icon (or its monogram) as
  // the favicon. The app name is a shared setting (Settings > General).
  function applyIdentity() {
    const name = current?.name || "";
    const app = Settings.get().appName || t("app.name");
    document.title = name ? t("startups.pageTitle", { name, app }) : app;
    const favicon = document.querySelector("#appFavicon");
    if (favicon && current) {
      const icon = Icon.iconFor(current);
      favicon.href = icon;
      favicon.type = Icon.iconMimeType(icon) || "image/svg+xml";
    }
    const breadcrumb = document.querySelector("#breadcrumbStartup");
    if (breadcrumb) breadcrumb.textContent = name;
  }

  function applyVersion() {
    const label = document.querySelector("#appVersionLabel");
    if (label) label.textContent = t("app.version", { version: Api.APP_VERSION });
  }

  // ---- Switcher -----------------------------------------------------------

  const switcher = {
    root: document.querySelector("#startupSwitcher"),
    button: document.querySelector("#startupSwitcherButton"),
    name: document.querySelector("#startupSwitcherName"),
    icon: document.querySelector("#startupSwitcherIcon"),
    menu: document.querySelector("#startupSwitcherMenu"),
  };

  function outboxMarker(status) {
    if (!status?.hasUnsynced) return null;
    const marker = document.createElement("span");
    marker.className = `startup-unsynced${status.conflicted ? " is-conflict" : ""}`;
    const parts = [];
    if (status.conflicted) parts.push(t("startups.conflicted", { count: status.conflicted }));
    if (status.pending) parts.push(t("startups.unsynced", { count: status.pending }));
    // A symbol and words, so the state never depends on colour alone.
    const symbol = document.createElement("span");
    symbol.className = "startup-unsynced-symbol";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = status.conflicted ? "!" : "↑";
    const text = document.createElement("span");
    text.textContent = parts.join(", ");
    marker.append(symbol, text);
    return marker;
  }

  function renderSwitcherButton() {
    if (!switcher.button) return;
    if (switcher.name) switcher.name.textContent = current?.name || Api.startupId;
    if (switcher.icon) {
      const icon = iconElement(current, "startup-icon");
      icon.id = "startupSwitcherIcon";
      switcher.icon.replaceWith(icon);
      switcher.icon = icon;
    }
  }

  function renderSwitcherMenu() {
    if (!switcher.menu) return;
    const items = openStartups().map((startup) => {
      const link = document.createElement("a");
      link.className = "startup-menu-item";
      link.href = Api.pageUrl(startup.id);
      link.setAttribute("role", "menuitem");
      link.tabIndex = -1;
      link.dataset.startupId = startup.id;
      if (startup.id === Api.startupId) link.setAttribute("aria-current", "page");
      const name = document.createElement("span");
      name.className = "startup-menu-name";
      name.textContent = startup.name;
      link.append(iconElement(startup, "startup-icon"), name);
      if (startup.id !== Api.startupId) {
        const marker = outboxMarker(outboxStatus.get(startup.id));
        if (marker) link.appendChild(marker);
      }
      return link;
    });
    const separator = document.createElement("div");
    separator.className = "startup-menu-separator";
    separator.setAttribute("role", "separator");
    const create = document.createElement("button");
    create.type = "button";
    create.className = "startup-menu-item startup-menu-new";
    create.setAttribute("role", "menuitem");
    create.tabIndex = -1;
    create.dataset.startupAction = "new";
    create.textContent = t("startups.newStartup");
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "startup-menu-item startup-menu-manage";
    manage.setAttribute("role", "menuitem");
    manage.tabIndex = -1;
    manage.dataset.startupAction = "manage";
    manage.textContent = t("startups.manage");
    switcher.menu.replaceChildren(...items, separator, create, manage);
  }

  // Reads every other startup's outbox from its own cache database. A startup
  // this browser never opened has no database, and none is created here.
  async function refreshOutboxMarkers() {
    const others = openStartups().filter((startup) => startup.id !== Api.startupId);
    const results = await Promise.all(others.map(async (startup) => [startup.id, await Api.readOutboxStatus(startup.id)]));
    let changed = false;
    results.forEach(([id, status]) => {
      const before = outboxStatus.get(id);
      if (!before || before.pending !== status.pending || before.conflicted !== status.conflicted) changed = true;
      outboxStatus.set(id, status);
    });
    if (changed && isMenuOpen()) {
      const focusedId = document.activeElement?.dataset?.startupId;
      const focusedAction = document.activeElement?.dataset?.startupAction;
      renderSwitcherMenu();
      const again = focusedId
        ? switcher.menu.querySelector(`[data-startup-id="${CSS.escape(focusedId)}"]`)
        : focusedAction ? switcher.menu.querySelector(`[data-startup-action="${CSS.escape(focusedAction)}"]`) : null;
      again?.focus();
    }
  }

  function menuItems() {
    return switcher.menu ? [...switcher.menu.querySelectorAll('[role="menuitem"]')] : [];
  }

  function isMenuOpen() {
    return Boolean(switcher.menu && !switcher.menu.hidden);
  }

  function openMenu(focus = "first") {
    if (!switcher.menu || !switcher.button) return;
    renderSwitcherMenu();
    switcher.menu.hidden = false;
    switcher.button.setAttribute("aria-expanded", "true");
    switcher.root?.classList.add("open");
    const items = menuItems();
    const target = focus === "last"
      ? items[items.length - 1]
      : items.find((item) => item.getAttribute("aria-current") === "page") || items[0];
    target?.focus();
    refreshOutboxMarkers();
  }

  function closeMenu({ returnFocus = false } = {}) {
    if (!isMenuOpen()) return;
    switcher.menu.hidden = true;
    switcher.button.setAttribute("aria-expanded", "false");
    switcher.root?.classList.remove("open");
    if (returnFocus) switcher.button.focus();
  }

  function moveFocus(step) {
    const items = menuItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = index < 0 ? 0 : (index + step + items.length) % items.length;
    items[next].focus();
  }

  function bindSwitcher() {
    if (!switcher.button || !switcher.menu) return;
    switcher.button.addEventListener("click", () => {
      if (isMenuOpen()) closeMenu();
      else openMenu();
    });
    switcher.button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? "last" : "first");
      }
    });
    switcher.menu.addEventListener("keydown", (event) => {
      const items = menuItems();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ returnFocus: true });
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === "Tab") {
        closeMenu();
      } else if (event.key === " " && document.activeElement?.matches?.("a[role='menuitem']")) {
        event.preventDefault();
        document.activeElement.click();
      }
    });
    switcher.menu.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-startup-action]");
      if (action?.dataset.startupAction === "new") {
        event.preventDefault();
        closeMenu();
        openNewStartupDialog();
        return;
      }
      if (action?.dataset.startupAction === "manage") {
        event.preventDefault();
        closeMenu();
        window.StartupTrackerSettingsPanel?.open?.("startups");
        return;
      }
      const link = event.target.closest?.("a[data-startup-id]");
      if (!link) return;
      // Plain clicks go through the same leave path as every other switch.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      closeMenu();
      if (link.dataset.startupId !== Api.startupId) leaveTo(link.href);
    });
    document.addEventListener("click", (event) => {
      if (isMenuOpen() && !switcher.root.contains(event.target)) closeMenu();
    });
  }

  // ---- New startup dialog -------------------------------------------------

  const dialog = {
    root: document.querySelector("#newStartupDialog"),
    form: document.querySelector("#newStartupForm"),
    name: document.querySelector("#newStartupName"),
    copyFrom: document.querySelector("#newStartupCopyFrom"),
    error: document.querySelector("#newStartupError"),
    submit: document.querySelector("#newStartupSubmit"),
    cancel: document.querySelector("#newStartupCancel"),
  };

  function fillCopyFromOptions() {
    if (!dialog.copyFrom) return;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("startups.copyNothing");
    const options = openStartups().map((startup) => {
      const option = document.createElement("option");
      option.value = startup.id;
      option.textContent = startup.name;
      return option;
    });
    dialog.copyFrom.replaceChildren(none, ...options);
    dialog.copyFrom.value = "";
  }

  function openNewStartupDialog() {
    if (!dialog.root || typeof dialog.root.showModal !== "function") return;
    dialog.form?.reset();
    fillCopyFromOptions();
    showError(dialog.error, "");
    setBusy(dialog.submit, false);
    dialog.root.showModal();
    dialog.name?.focus();
  }

  function showError(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? t("startups.creating") : t("startups.create");
  }

  function bindNewStartupDialog() {
    if (!dialog.root || !dialog.form) return;
    dialog.cancel?.addEventListener("click", () => dialog.root.close());
    dialog.root.addEventListener("close", () => switcher.button?.focus());
    dialog.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = dialog.name.value.trim();
      if (!name) {
        showError(dialog.error, t("startups.nameRequired"));
        dialog.name.focus();
        return;
      }
      setBusy(dialog.submit, true);
      showError(dialog.error, "");
      try {
        const startup = await createStartup({ name, copySettingsFrom: dialog.copyFrom?.value || "" });
        await leaveTo(Api.pageUrl(startup.id));
      } catch (error) {
        setBusy(dialog.submit, false);
        showError(dialog.error, t("startups.createFailed", { error: error.message }));
      }
    });
  }

  // ---- No startup in the address ------------------------------------------

  // The one opened last, or the first in the list.
  function pickStartup(list) {
    const open = list.filter((startup) => startup && !startup.archived);
    if (!open.length) return null;
    const opened = open.filter((startup) => startup.lastOpenedAt);
    if (!opened.length) return open[0];
    return opened.reduce((latest, startup) => (String(startup.lastOpenedAt) > String(latest.lastOpenedAt) ? startup : latest));
  }

  function showFirstStartupScreen() {
    const screen = document.querySelector("#firstStartupScreen");
    const form = document.querySelector("#firstStartupForm");
    const input = document.querySelector("#firstStartupName");
    const error = document.querySelector("#firstStartupError");
    const submit = document.querySelector("#firstStartupSubmit");
    if (!screen || !form || !input) return;
    screen.hidden = false;
    input.focus();
    if (form.dataset.bound) return;
    form.dataset.bound = "1";
    const setupButton = document.querySelector("#firstStartupSetup");
    if (setupButton) setupButton.hidden = !window.StartupTrackerSetupWizard;
    setupButton?.addEventListener("click", () => {
      screen.hidden = true;
      openSetup();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        showError(error, t("startups.nameRequired"));
        input.focus();
        return;
      }
      setBusy(submit, true);
      showError(error, "");
      try {
        const startup = await createStartup({ name });
        window.location.assign(Api.pageUrl(startup.id));
      } catch (failure) {
        setBusy(submit, false);
        showError(error, t("startups.createFailed", { error: failure.message }));
        input.focus();
      }
    });
  }

  async function startWithoutStartup() {
    document.documentElement.setAttribute("data-no-startup", "");
    let list;
    try {
      list = await loadStartups();
    } catch {
      const screen = document.querySelector("#firstStartupScreen");
      if (screen) screen.hidden = false;
      showError(document.querySelector("#firstStartupError"), t("startups.loadFailed"));
      return;
    }
    const target = pickStartup(list);
    if (target) {
      window.location.replace(Api.pageUrl(target.id));
      return;
    }
    // The setup (js/setup-wizard.js) replaces the plain "Create your first
    // startup" screen, which stays as the way back when the setup is closed.
    if (window.StartupTrackerSetupWizard) openSetup();
    else showFirstStartupScreen();
  }

  function openSetup() {
    window.StartupTrackerSetupWizard.open({ mode: "full", onClose: showFirstStartupScreen }).catch(showFirstStartupScreen);
  }

  // ---- A startup's page ---------------------------------------------------

  async function startOnStartupPage() {
    bindSwitcher();
    bindNewStartupDialog();
    renderSwitcherButton();
    // Recorded once per page load; "/" sends you back to the one opened last.
    fetchJson(Api.urls.startup(Api.startupId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opened: true, origin: "ui" }),
      // Survives a quick switch away from the page.
      keepalive: true,
    }).catch(() => {});
    try {
      await loadStartups();
    } catch {
      return;
    }
    current = startups.find((startup) => startup.id === Api.startupId) || null;
    applyIdentity();
    renderSwitcherButton();
    renderSwitcherMenu();
    refreshOutboxMarkers();
    window.dispatchEvent(new CustomEvent("startup-tracker:startup", { detail: current }));
    // The "Finish setup" badge, and the setup itself when it was on screen.
    window.StartupTrackerSetupWizard?.watchBadge();
  }

  // Reads the list again after Settings changed it (a rename, an icon, an
  // archived startup) and shows the result everywhere.
  async function reload() {
    listPromise = null;
    try {
      await loadStartups();
    } catch {
      return startups.slice();
    }
    if (Api.hasStartup) {
      current = startups.find((startup) => startup.id === Api.startupId) || current;
      applyIdentity();
      renderSwitcherButton();
      if (isMenuOpen()) renderSwitcherMenu();
      window.dispatchEvent(new CustomEvent("startup-tracker:startup", { detail: current }));
    }
    return startups.slice();
  }

  // What app.js reads to label this startup's own entries in combined views,
  // and what Settings uses to show and refresh the list.
  window.StartupTrackerStartups = Object.freeze({
    current: () => current,
    list: () => startups.slice(),
    pickStartup,
    reload,
  });

  // A new app name shows in the browser tab at once.
  Settings.subscribe(() => applyIdentity());

  I18n.ready.then(() => {
    applyVersion();
    if (Api.hasStartup) startOnStartupPage();
    else startWithoutStartup();
  });
})();
