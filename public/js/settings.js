// Settings: the panel behind the "Settings" button in the top bar.
//
// Sections on the left: Startup profile, Startups, Appearance, General,
// Statuses, AI agents, Backups, Recycle bin, About. The ones about the
// current startup show its name next to their title.
//
// The startup profile is part of the startup's own state (section "profile")
// and is saved through app.js's outbox like every other edit, as is the
// recycle bin. Everything else goes straight to the server: the startup list
// (/api/startups), the shared settings (/api/settings), backups, export and
// import. After a restore or an import that replaced this startup the page
// reloads, so nothing in memory predates it.
//
// UMD: the pure helpers are module.exports in Node (for tests); in the browser
// window.StartupTrackerSettingsPanel holds them and the panel mounts itself.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerSettingsPanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // ---- pure helpers (tested in Node) ---------------------------------------

  const SECTIONS = Object.freeze([
    { id: "profile", scope: "startup" },
    { id: "startups", scope: "global" },
    { id: "appearance", scope: "global" },
    { id: "general", scope: "global" },
    { id: "statuses", scope: "global" },
    { id: "agents", scope: "global" },
    { id: "backups", scope: "startup" },
    { id: "recycle", scope: "startup" },
    { id: "about", scope: "global" },
  ].map((section) => Object.freeze(section)));

  // Profile fields that "Copy settings from another startup" can copy. The
  // name and the icon are the new startup's own.
  const PROFILE_FIELDS = Object.freeze([
    "oneLiner",
    "description",
    "industry",
    "website",
    "links",
    "country",
    "companyTemplate",
    "entityType",
    "currency",
    "homeRegion",
    "aiContext",
    "maxNewTargetsPerDay",
  ]);

  const DEFAULT_MAX_NEW_TARGETS = 10;
  const MAX_NEW_TARGETS_LIMIT = 1000;

  const PROFILE_TEXT_LIMITS = Object.freeze({
    oneLiner: 160,
    description: 4000,
    industry: 120,
    website: 2000,
    country: 2,
    companyTemplate: 80,
    entityType: 80,
    currency: 3,
    homeRegion: 160,
    aiContext: 20000,
  });

  function cleanText(value, limit) {
    return String(value ?? "").slice(0, limit);
  }

  // A complete profile: every field present, text trimmed to its limit, the
  // daily target cap a whole number (10 when unset).
  function normalizeProfile(profile, normalizeLinks = (links) => (Array.isArray(links) ? links : [])) {
    const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
    const result = {};
    for (const [field, limit] of Object.entries(PROFILE_TEXT_LIMITS)) result[field] = cleanText(source[field], limit);
    result.country = result.country.toUpperCase();
    result.currency = result.currency.toUpperCase();
    result.links = normalizeLinks(source.links);
    const cap = Number(source.maxNewTargetsPerDay);
    result.maxNewTargetsPerDay = Number.isInteger(cap) && cap >= 0 && cap <= MAX_NEW_TARGETS_LIMIT ? cap : DEFAULT_MAX_NEW_TARGETS;
    // Fields a later part adds survive a save made by this version.
    for (const [field, value] of Object.entries(source)) {
      if (!Object.prototype.hasOwnProperty.call(result, field)) result[field] = value;
    }
    return result;
  }

  // The body of POST /api/backups/:id/restore for a scope.
  function buildRestoreRequest(scope, startupId, records = []) {
    if (scope === "database") return { scope: "database" };
    if (!startupId) throw new TypeError("A startup id is required.");
    if (scope === "startup") return { scope: "startup", startupId };
    if (scope === "records") {
      const list = (Array.isArray(records) ? records : [])
        .filter((record) => record && record.section && record.id !== undefined && record.id !== null && record.id !== "")
        .map((record) => ({ section: String(record.section), id: String(record.id) }));
      if (!list.length) throw new RangeError("Tick at least one record.");
      return { scope: "records", startupId, records: list };
    }
    throw new RangeError(`Unknown restore scope: ${scope}`);
  }

  // What an import can do with the file the server previewed.
  function importChoices(kind, preview) {
    if (kind === "database") return ["database"];
    const count = Array.isArray(preview?.startups) ? preview.startups.length : 0;
    return count === 1 ? ["new", "replace"] : ["new"];
  }

  // The Content-Type POST /api/import expects for a chosen file.
  function importContentType(fileName, type = "") {
    const name = String(fileName || "").toLowerCase();
    if (name.endsWith(".zip") || type === "application/zip" || type === "application/x-zip-compressed") return "application/zip";
    if (name.endsWith(".json") || type === "application/json") return "application/json";
    return "application/octet-stream";
  }

  // Sections with a record count, in the order given, without the empty ones.
  function countsList(counts) {
    if (!counts || typeof counts !== "object") return [];
    return Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .map(([section, count]) => ({ section, count }));
  }

  // The rows of a comparison that would change something.
  function changedSections(compare) {
    return (Array.isArray(compare?.sections) ? compare.sections : [])
      .filter((row) => row && (row.added || row.removed || row.changed));
  }

  // Only records that exist in the backup can be put back one by one.
  function restorableRecords(compare) {
    return (Array.isArray(compare?.records) ? compare.records : [])
      .filter((record) => record && record.id && record.change !== "removed");
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  // Time zones that contain every word of the query, case and "_" ignored.
  function filterTimeZones(query, zones) {
    const words = String(query || "").toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
    const list = Array.isArray(zones) ? zones : [];
    if (!words.length) return list.slice();
    return list.filter((zone) => {
      const haystack = zone.toLowerCase().replace(/_/g, " ");
      return words.every((word) => haystack.includes(word));
    });
  }

  function supportedValues(kind) {
    try {
      return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf(kind) : [];
    } catch {
      return [];
    }
  }

  function timeZoneList() {
    const zones = supportedValues("timeZone");
    if (!zones.includes("UTC")) zones.push("UTC");
    return zones.sort();
  }

  function displayNames(locale, type) {
    try {
      return new Intl.DisplayNames([locale || "en"], { type, fallback: "none" });
    } catch {
      return null;
    }
  }

  // ISO 4217 codes the runtime knows, with their names.
  function currencyOptions(locale) {
    const names = displayNames(locale, "currency");
    return supportedValues("currency")
      .map((code) => ({ code, name: names?.of(code) || code }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // Region codes that are not countries or territories.
  const NOT_COUNTRIES = new Set(["AC", "CP", "CQ", "DG", "EA", "EU", "EZ", "IC", "QO", "TA", "UN", "XA", "XB", "ZZ"]);

  // ISO 3166 country codes with names, from the runtime's own region names.
  function countryOptions(locale) {
    const names = displayNames(locale, "region");
    if (!names) return [];
    const options = [];
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        if (NOT_COUNTRIES.has(code)) continue;
        let name;
        try {
          name = names.of(code);
        } catch {
          name = undefined;
        }
        if (name && name !== code) options.push({ code, name });
      }
    }
    return options.sort((a, b) => a.name.localeCompare(b.name, locale || "en"));
  }

  // What a finished restore or import means for this page.
  //   { action: "reload" }            the current startup's data was replaced
  //   { action: "navigate", url }     go to another page
  //   { action: "stay" }              nothing this page shows changed
  function pageAfterReplace({ kind, mode, scope, currentStartupId, result, pageUrl }) {
    if (kind === "restore") return { action: "reload" };
    if (mode === "new") {
      const created = Array.isArray(result?.startups) ? result.startups[0] : null;
      return created?.id ? { action: "navigate", url: pageUrl(created.id) } : { action: "stay" };
    }
    if (mode === "replace" || scope === "startup") return { action: "reload" };
    if (mode === "database") {
      const stillThere = (Array.isArray(result?.startups) ? result.startups : []).some((startup) => startup.id === currentStartupId);
      return stillThere ? { action: "reload" } : { action: "navigate", url: "/" };
    }
    return { action: "reload" };
  }

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload.error || "";
      throw error;
    }
    return payload;
  }

  // The server calls behind the Backups section. `env` gives fetch, the
  // page's location, the API helper and the hook that saves the edit in
  // progress before the page goes away.
  function createBackupActions(env) {
    const { fetch: fetchImpl, location, api, startupId, prepareToLeave = async () => {} } = env;
    const send = (url, options = {}) => fetchImpl(url, { cache: "no-store", ...options }).then(readJson);
    const postJson = (url, body) => send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(body || {}), origin: "ui" }),
    });

    async function follow(outcome) {
      if (outcome.action === "stay") return outcome;
      await prepareToLeave();
      if (outcome.action === "reload") location.reload();
      else location.assign(outcome.url);
      return outcome;
    }

    return Object.freeze({
      list: () => send(api.urls.backupsFor(startupId)).then((payload) => (Array.isArray(payload.backups) ? payload.backups : [])),
      create: (label) => postJson(api.urls.backups, label ? { label } : {}),
      verify: (backupId) => postJson(api.urls.backupVerify(backupId)),
      compare: (backupId) => send(api.urls.backupCompare(backupId, startupId)),
      remove: (backupId) => send(api.urls.backup(backupId), { method: "DELETE" }),
      // Any restore replaces data this page holds, so the page starts again.
      async restore(backupId, scope, records) {
        const result = await postJson(api.urls.backupRestore(backupId), buildRestoreRequest(scope, startupId, records));
        await follow(pageAfterReplace({ kind: "restore", scope, currentStartupId: startupId, result: result.restored, pageUrl: api.pageUrl }));
        return result;
      },
      async previewImport(file) {
        return send(api.urls.import, {
          method: "POST",
          headers: { "Content-Type": importContentType(file?.name, file?.type) },
          body: file,
        });
      },
      async applyImport(token, mode) {
        const body = mode === "replace" ? { mode, startupId } : { mode };
        const result = await postJson(api.urls.importApply(token), body);
        await follow(pageAfterReplace({ kind: "import", mode, currentStartupId: startupId, result: result.imported, pageUrl: api.pageUrl }));
        return result;
      },
    });
  }

  // ---- status list edits (Settings > Statuses) ------------------------------
  //
  // `key` is "statuses" (grouped, shared by MK, PO, FU and Company) or
  // "campaignStatuses" (no groups). Every helper returns a new config.

  const STATUS_ID_LIMIT = 36;

  // An id for a new status, from its label: lower case letters, digits and _,
  // starting with a letter and unique among `taken`. Built-in ids never
  // change, and a custom one keeps the id it was given when its label changes.
  function statusIdFromLabel(label, taken = []) {
    let base = String(label || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(base)) base = base ? `status_${base}` : "status";
    base = base.slice(0, STATUS_ID_LIMIT).replace(/_+$/, "");
    const used = new Set(taken);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
    return id;
  }

  function cleanLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // A new entry goes after the last one of its group, so the list stays in
  // group order.
  function addStatusEntry(config, key, label, group) {
    const text = cleanLabel(label);
    if (!text) return config;
    const list = [...(config[key] || [])];
    const id = statusIdFromLabel(text, list.map((entry) => entry.id));
    const entry = key === "statuses" ? { id, group, label: text, description: "", custom: true } : { id, label: text, description: "" };
    let at = list.length;
    if (group) list.forEach((other, index) => { if (other.group === group) at = index + 1; });
    list.splice(at, 0, entry);
    return { ...config, [key]: list };
  }

  function updateStatusEntry(config, key, id, patch) {
    return { ...config, [key]: (config[key] || []).map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) };
  }

  // Up (-1) or down (+1) among the entries of the same group.
  function moveStatusEntry(config, key, id, delta) {
    const list = [...(config[key] || [])];
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) return config;
    const group = list[index].group;
    let other = index + delta;
    while (other >= 0 && other < list.length && list[other].group !== group) other += delta;
    if (other < 0 || other >= list.length) return config;
    [list[index], list[other]] = [list[other], list[index]];
    return { ...config, [key]: list };
  }

  // Where the records of a deleted entry can go: any other entry, the same
  // group first.
  function statusMoveTargets(config, key, id) {
    const list = config[key] || [];
    const own = list.find((entry) => entry.id === id);
    const others = list.filter((entry) => entry.id !== id);
    if (!own?.group) return others;
    return [...others.filter((entry) => entry.group === own.group), ...others.filter((entry) => entry.group !== own.group)];
  }

  function canDeleteStatusEntry(config, key, id) {
    const list = config[key] || [];
    if (list.length < 2) return false;
    if (key === "campaignStatuses") return list.some((entry) => entry.id === id);
    return Boolean(list.find((entry) => entry.id === id)?.custom);
  }

  const pure = {
    SECTIONS,
    PROFILE_FIELDS,
    DEFAULT_MAX_NEW_TARGETS,
    normalizeProfile,
    buildRestoreRequest,
    importChoices,
    importContentType,
    countsList,
    changedSections,
    restorableRecords,
    formatBytes,
    filterTimeZones,
    timeZoneList,
    currencyOptions,
    countryOptions,
    pageAfterReplace,
    createBackupActions,
    statusIdFromLabel,
    addStatusEntry,
    updateStatusEntry,
    moveStatusEntry,
    statusMoveTargets,
    canDeleteStatusEntry,
  };

  if (!root.document || !root.StartupTrackerApi) return Object.freeze(pure);

  // ---- browser ------------------------------------------------------------

  const Api = root.StartupTrackerApi;
  const I18n = root.StartupTrackerI18n;
  const Dates = root.StartupTrackerDates;
  const Settings = root.StartupTrackerSettings;
  const Appearance = root.StartupTrackerAppearance;
  const Icon = root.StartupTrackerIcon;
  const LinkTypes = root.StartupTrackerLinkTypes;
  const Recycle = root.StartupTrackerRecycle;
  const Statuses = root.StartupTrackerStatuses;
  const Sections = root.StartupTrackerSections;
  if (!I18n || !Dates || !Settings || !Icon || !LinkTypes || !Recycle || !Statuses || !Sections) {
    throw new Error("js/settings.js needs i18n, dates, settings-store, startup-icon, link-types, recycle, status-model and sections to load first");
  }
  const t = I18n.t;
  const SECTION_STORAGE_KEY = Api.globalStorageKey("settings-section");

  const ui = {
    button: root.document.querySelector("#settingsButton"),
    panel: root.document.querySelector("#settingsPanel"),
    nav: root.document.querySelector("#settingsNav"),
    content: root.document.querySelector("#settingsContent"),
    close: root.document.querySelector("#settingsClose"),
  };

  let activeSection = readStoredSection();
  let renderToken = 0;
  // Verification results of this page visit, by backup id.
  const verified = new Map();

  function readStoredSection() {
    try {
      const value = root.localStorage.getItem(SECTION_STORAGE_KEY);
      return SECTIONS.some((section) => section.id === value) ? value : "profile";
    } catch {
      return "profile";
    }
  }

  function storeSection(id) {
    try {
      root.localStorage.setItem(SECTION_STORAGE_KEY, id);
    } catch {
      // Remembering the section is a convenience only.
    }
  }

  function page() {
    return root.StartupTrackerPage || null;
  }

  function startupsModule() {
    return root.StartupTrackerStartups || null;
  }

  function currentStartup() {
    return startupsModule()?.current?.() || null;
  }

  function currentStartupName() {
    return currentStartup()?.name || Api.startupId;
  }

  // Elements are built, never parsed from strings, so record titles and
  // server text can never become markup.
  function el(tag, props = {}, children = []) {
    const node = root.document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "on") Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key in node && typeof value !== "string") node[key] = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    (Array.isArray(children) ? children : [children]).flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof root.Node ? child : String(child));
    });
    return node;
  }

  function icon(name) {
    const svg = root.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "settings-icon");
    const use = root.document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.appendChild(use);
    return svg;
  }

  let idSequence = 0;
  function uid(prefix) {
    idSequence += 1;
    return `${prefix}-${idSequence}`;
  }

  function field(labelText, control, hint) {
    const id = control.id || uid("settings-field");
    control.id = id;
    const hintNode = hint ? el("p", { className: "settings-hint", id: `${id}-hint`, text: hint }) : null;
    if (hintNode) control.setAttribute("aria-describedby", hintNode.id);
    return el("div", { className: "settings-field" }, [el("label", { for: id, text: labelText }), control, hintNode]);
  }

  function statusLine() {
    return el("p", { className: "settings-status", role: "status", "aria-live": "polite" });
  }

  function showStatus(node, message, kind = "") {
    if (!node) return;
    node.textContent = message || "";
    node.dataset.kind = kind;
  }

  function button(text, props = {}) {
    return el("button", { type: "button", className: "secondary-button", ...props }, props.icon ? [icon(props.icon), el("span", { text })] : text);
  }

  // A table row has room for four actions only when each one is an icon with
  // its name in the accessible label and the toolbar tooltip.
  function iconAction(label, iconName, options = {}) {
    return el("button", {
      type: "button",
      className: `icon-button${options.danger ? " danger-hover" : ""}`,
      "aria-label": label,
      "data-tooltip": label,
    }, icon(iconName));
  }

  function sectionTitle(id) {
    return t(`settings.sections.${id}`);
  }

  function sectionLabel(section) {
    const key = `settings.sectionNames.${section}`;
    return I18n.has(key) ? t(key) : section;
  }

  function formatInstant(value, options = {}) {
    if (!value) return "";
    const settings = Settings.get();
    return Dates.formatInstantAs(value, I18n.getLocale(), Settings.effectiveTimeZone(settings, Dates.defaultTimeZone()), settings.dateFormat, options);
  }

  function formatDay(value) {
    const settings = Settings.get();
    const text = String(value || "");
    const date = Dates.isDateString(text) ? text : Dates.partsIn(text, Settings.effectiveTimeZone(settings, Dates.defaultTimeZone())).date;
    return date ? Dates.formatDateAs(date, I18n.getLocale(), settings.dateFormat) : "";
  }

  function errorText(error) {
    return error?.message || String(error || "");
  }

  // ---- panel ---------------------------------------------------------------

  function renderNav() {
    if (!ui.nav) return;
    const name = currentStartupName();
    ui.nav.replaceChildren(...SECTIONS.map((section) => {
      const item = el("button", {
        type: "button",
        className: "settings-nav-item",
        dataset: { settingsSection: section.id },
        "aria-current": section.id === activeSection ? "page" : null,
      }, [
        el("span", { className: "settings-nav-title", text: sectionTitle(section.id) }),
        section.scope === "startup" ? el("span", { className: "settings-nav-startup", text: name }) : null,
      ]);
      return el("li", {}, item);
    }));
  }

  function heading(section, intro) {
    const startupTag = section.scope === "startup"
      ? el("span", { className: "settings-startup-tag" }, [el("span", { className: "visually-hidden", text: t("settings.forStartup") }), currentStartupName()])
      : null;
    return [
      el("h3", { className: "settings-section-title", id: `settings-heading-${section.id}`, tabindex: "-1" }, [sectionTitle(section.id), startupTag]),
      intro ? el("p", { className: "settings-intro", text: intro }) : null,
    ].filter(Boolean);
  }

  async function renderSection({ focusHeading = false } = {}) {
    if (!ui.content) return;
    const token = ++renderToken;
    const section = SECTIONS.find((entry) => entry.id === activeSection) || SECTIONS[0];
    const container = el("section", { className: `settings-section settings-section-${section.id}`, "aria-labelledby": `settings-heading-${section.id}` });
    ui.content.replaceChildren(container);
    try {
      await RENDERERS[section.id](container, section, () => token === renderToken);
    } catch (error) {
      if (token !== renderToken) return;
      container.replaceChildren(...heading(section), el("p", { className: "settings-error", role: "alert", text: t("settings.loadFailed", { error: errorText(error) }) }));
    }
    if (focusHeading && token === renderToken) container.querySelector(".settings-section-title")?.focus();
  }

  function selectSection(id, options = {}) {
    if (!SECTIONS.some((section) => section.id === id)) return;
    activeSection = id;
    storeSection(id);
    renderNav();
    renderSection(options);
  }

  function isOpen() {
    return Boolean(ui.panel?.open);
  }

  function open(sectionId) {
    if (!ui.panel || typeof ui.panel.showModal !== "function") return;
    if (sectionId) {
      activeSection = sectionId;
      storeSection(sectionId);
    }
    renderNav();
    if (!isOpen()) ui.panel.showModal();
    ui.button?.setAttribute("aria-expanded", "true");
    renderSection();
    ui.nav?.querySelector('[aria-current="page"]')?.focus();
  }

  function close() {
    if (isOpen()) ui.panel.close();
  }

  // The setup (js/setup-wizard.js) takes the screen, so Settings closes first.
  function openSetup(options) {
    const Wizard = root.StartupTrackerSetupWizard;
    if (!Wizard) return;
    close();
    Wizard.open(options);
  }

  function setupBlock(title, hint, label, options) {
    if (!root.StartupTrackerSetupWizard) return null;
    return el("div", { className: "settings-block" }, [
      el("h4", { text: title }),
      el("p", { className: "settings-hint", text: hint }),
      button(label, { className: "primary-button", on: { click: () => openSetup(options) } }),
    ]);
  }

  function bindPanel() {
    if (!ui.button || !ui.panel) return;
    ui.button.addEventListener("click", () => open());
    ui.close?.addEventListener("click", close);
    ui.panel.addEventListener("close", () => {
      ui.button.setAttribute("aria-expanded", "false");
      ui.button.focus();
    });
    // A click on the backdrop (the dialog element itself) closes it.
    ui.panel.addEventListener("click", (event) => {
      if (event.target === ui.panel) close();
    });
    ui.nav?.addEventListener("click", (event) => {
      const item = event.target.closest?.("[data-settings-section]");
      if (item) selectSection(item.dataset.settingsSection, { focusHeading: true });
    });
    ui.nav?.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...ui.nav.querySelectorAll("[data-settings-section]")];
      const index = items.indexOf(root.document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    });
    // The rest of the page re-renders on its own; an open section that shows
    // page data follows along.
    root.addEventListener("startup-tracker:data", () => {
      if (isOpen() && activeSection === "recycle") renderSection();
    });
    root.addEventListener("startup-tracker:startup", () => {
      if (isOpen()) {
        renderNav();
        if (activeSection === "profile") renderSection();
      }
    });
  }

  // ---- Startup profile -----------------------------------------------------

  const COUNTRY_CACHE = { locale: "", options: [] };
  function countries() {
    const locale = I18n.getLocale();
    if (COUNTRY_CACHE.locale !== locale) {
      COUNTRY_CACHE.locale = locale;
      COUNTRY_CACHE.options = countryOptions(locale);
    }
    return COUNTRY_CACHE.options;
  }

  async function patchStartup(id, body) {
    const response = await root.fetch(Api.urls.startup(id), {
      method: "PATCH",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, origin: "ui" }),
    });
    const payload = await readJson(response);
    await startupsModule()?.reload?.();
    return payload.startup;
  }

  function linkTypeSelect(selected) {
    const select = el("select", { className: "settings-link-type" });
    LinkTypes.GROUPS.forEach((group) => {
      const optgroup = el("optgroup", { label: t(`linkTypes.groups.${group.id}`) });
      group.types.forEach((type) => {
        optgroup.append(el("option", { value: type.id, text: t(`linkTypes.types.${type.id}`), selected: type.id === selected }));
      });
      select.append(optgroup);
    });
    select.value = LinkTypes.typeById(selected).id;
    return select;
  }

  function renderIconPreview(holder, startup) {
    const source = Icon.iconFor(startup);
    holder.replaceChildren(el("img", { src: source, alt: "", width: 64, height: 64 }));
  }

  function renderProfile(container, section) {
    const bridge = page();
    const startup = currentStartup();
    const profile = normalizeProfile(bridge?.getProfile?.(), LinkTypes.normalizeLinks);
    const status = statusLine();
    const save = (message) => {
      try {
        bridge.saveProfile(profile);
        showStatus(status, message || t("settings.saved"), "ok");
      } catch (error) {
        showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
      }
    };

    // Name: the startup list's own field.
    const nameInput = el("input", { type: "text", maxLength: 120, autocomplete: "organization", value: startup?.name || "" });
    nameInput.addEventListener("change", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        showStatus(status, t("startups.nameRequired"), "error");
        nameInput.value = currentStartup()?.name || "";
        return;
      }
      try {
        await patchStartup(Api.startupId, { name });
        renderNav();
        container.querySelector(".settings-startup-tag")?.lastChild?.replaceWith(name);
        showStatus(status, t("settings.saved"), "ok");
      } catch (error) {
        showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
      }
    });

    // Icon.
    const iconHolder = el("span", { className: "settings-icon-preview" });
    renderIconPreview(iconHolder, startup);
    const iconInput = el("input", { type: "file", accept: Icon.ACCEPT_ATTRIBUTE, className: "settings-file-input" });
    const iconStatus = el("p", { className: "settings-hint", id: uid("icon-hint"), text: t("settings.profile.iconHint") });
    iconInput.setAttribute("aria-describedby", iconStatus.id);
    iconInput.addEventListener("change", async () => {
      const file = iconInput.files?.[0];
      iconInput.value = "";
      if (!file) return;
      try {
        const dataUrl = await Icon.resizeIconFile(file);
        await patchStartup(Api.startupId, { icon: dataUrl });
        renderIconPreview(iconHolder, currentStartup());
        removeIcon.disabled = false;
        showStatus(status, t("settings.profile.iconSaved"), "ok");
      } catch (error) {
        const key = error.code === "unsupportedType" ? "settings.profile.iconType"
          : error.code === "tooLarge" ? "settings.profile.iconTooLarge" : "";
        showStatus(status, key ? t(key) : t("settings.saveFailed", { error: errorText(error) }), "error");
      }
    });
    const removeIcon = button(t("settings.profile.iconRemove"), {
      disabled: !Icon.safeIcon(startup?.icon),
      on: { click: async () => {
        try {
          await patchStartup(Api.startupId, { icon: "" });
          renderIconPreview(iconHolder, currentStartup());
          removeIcon.disabled = true;
          showStatus(status, t("settings.profile.iconRemoved"), "ok");
        } catch (error) {
          showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
        }
      } },
    });
    const iconField = el("div", { className: "settings-field settings-icon-field" }, [
      el("span", { className: "settings-label", id: uid("icon-label"), text: t("settings.profile.icon") }),
      el("div", { className: "settings-icon-row" }, [
        iconHolder,
        el("label", { className: "secondary-button settings-file-button" }, [icon("upload"), el("span", { text: t("settings.profile.iconUpload") }), iconInput]),
        removeIcon,
      ]),
      iconStatus,
    ]);

    // Plain text fields saved on change.
    const textField = (key, { multiline = false, rows = 3, type = "text", hint, autocomplete } = {}) => {
      const control = multiline
        ? el("textarea", { rows, maxLength: PROFILE_TEXT_LIMITS[key] })
        : el("input", { type, maxLength: PROFILE_TEXT_LIMITS[key], autocomplete: autocomplete || "off" });
      control.value = profile[key] || "";
      control.addEventListener("change", () => {
        profile[key] = control.value.trim();
        save();
      });
      return field(t(`settings.profile.${key}`), control, hint);
    };

    // {{CONSTRAINTS}}: the company and founders text every prompt carries
    // (Part 11). A counter with soft limits, a privacy note, and the topics
    // that make the text useful, each with a sentence to start from
    // (content/prompts/constraints-tips.json).
    const constraintsField = () => {
      const control = el("textarea", { rows: 10, maxLength: PROFILE_TEXT_LIMITS.aiContext });
      control.value = profile.aiContext || "";
      const counter = el("p", { className: "settings-hint constraints-counter", "aria-live": "polite" });
      const tipsHolder = el("div", { className: "constraints-tips" });
      let limits = { targetLength: 1000, softMinLength: 400, softMaxLength: 2500 };
      const count = () => {
        const length = control.value.trim().length;
        const advice = !length ? t("settings.profile.constraintsEmpty")
          : length < limits.softMinLength ? t("settings.profile.constraintsShort", { min: limits.softMinLength })
            : length > limits.softMaxLength ? t("settings.profile.constraintsLong", { max: limits.softMaxLength })
              : t("settings.profile.constraintsGood");
        counter.textContent = `${t("settings.profile.constraintsCount", { count: length, target: limits.targetLength })} ${advice}`;
        counter.classList.toggle("is-warning", Boolean(length) && (length < limits.softMinLength || length > limits.softMaxLength));
      };
      const commit = () => {
        profile.aiContext = control.value.trim();
        save();
      };
      control.addEventListener("input", count);
      control.addEventListener("change", commit);
      const insert = (text) => {
        const start = control.selectionStart ?? control.value.length;
        const end = control.selectionEnd ?? start;
        const before = control.value.slice(0, start);
        const glue = before && !before.endsWith("\n") ? "\n" : "";
        control.value = `${before}${glue}${text}${control.value.slice(end)}`;
        const caret = before.length + glue.length + text.length;
        control.focus();
        control.setSelectionRange(caret, caret);
        count();
        commit();
      };
      root.fetch("/content/prompts/constraints-tips.json", { cache: "no-cache" }).then((response) => (response.ok ? response.json() : null)).then((tips) => {
        if (!tips || !Array.isArray(tips.tips)) return;
        limits = { ...limits, ...tips };
        count();
        tipsHolder.replaceChildren(
          el("p", { className: "settings-hint", text: t("settings.profile.constraintsTipsIntro") }),
          el("ul", { className: "constraints-tip-list" }, tips.tips.map((tip) => el("li", {}, [
            el("button", { type: "button", className: "text-button", text: tip.topic, title: tip.starter, "aria-label": t("settings.profile.constraintsInsert", { topic: tip.topic }), on: { click: () => insert(tip.starter) } }),
            el("span", { className: "settings-hint", text: ` ${tip.why}.` }),
          ]))),
        );
      }).catch(() => {});
      count();
      const wrap = field(t("settings.profile.aiContext"), control, t("settings.profile.aiContextHint"));
      wrap.append(el("p", { className: "settings-hint constraints-privacy", text: t("settings.profile.constraintsPrivacy") }), counter, tipsHolder);
      return wrap;
    };

    const selectField = (key, options, { hint, emptyKey = "settings.profile.chooseLater" } = {}) => {
      const select = el("select", {}, [el("option", { value: "", text: t(emptyKey) }), ...options.map((option) => el("option", { value: option.value, text: option.text }))]);
      select.value = profile[key] || "";
      select.addEventListener("change", () => {
        profile[key] = select.value;
        save();
      });
      return field(t(`settings.profile.${key}`), select, hint);
    };

    // Links with a type each.
    const linkList = el("ul", { className: "settings-link-list" });
    const renderLinks = () => {
      linkList.replaceChildren(...profile.links.map((link, index) => {
        const typeSelect = linkTypeSelect(link.type);
        const typeIcon = el("span", { className: "settings-link-icon" }, icon(LinkTypes.typeById(link.type).icon));
        const urlInput = el("input", { type: "url", inputMode: "url", value: link.url, autocomplete: "off", maxLength: 2000 });
        const labelText = t("settings.profile.linkNumber", { number: index + 1 });
        typeSelect.setAttribute("aria-label", t("settings.profile.linkType", { link: labelText }));
        urlInput.setAttribute("aria-label", t("settings.profile.linkUrl", { link: labelText }));
        typeSelect.addEventListener("change", () => {
          link.type = typeSelect.value;
          typeIcon.replaceChildren(icon(LinkTypes.typeById(link.type).icon));
          save();
        });
        urlInput.addEventListener("change", () => {
          link.url = urlInput.value.trim();
          const detected = LinkTypes.detectLinkType(link.url);
          if (detected && detected !== link.type) {
            link.type = detected;
            typeSelect.value = detected;
            typeIcon.replaceChildren(icon(LinkTypes.typeById(detected).icon));
          }
          if (!link.url) {
            profile.links.splice(profile.links.indexOf(link), 1);
            renderLinks();
          }
          save();
        });
        const remove = el("button", {
          type: "button",
          className: "icon-button",
          "aria-label": t("settings.profile.linkRemove", { link: labelText }),
          on: { click: () => {
            profile.links.splice(profile.links.indexOf(link), 1);
            renderLinks();
            save();
            addLink.focus();
          } },
        }, icon("trash"));
        return el("li", { className: "settings-link-row" }, [typeIcon, typeSelect, urlInput, remove]);
      }));
    };
    // A new row is kept on screen only; it is saved once it has an address.
    const addLink = button(t("settings.profile.linkAdd"), {
      icon: "plus",
      on: { click: () => {
        const link = { id: LinkTypes.makeLinkId(), type: "website", url: "", label: "" };
        profile.links.push(link);
        renderLinks();
        linkList.querySelector("li:last-child input")?.focus();
      } },
    });
    renderLinks();

    const currencies = currencyOptions(I18n.getLocale()).map((option) => ({ value: option.code, text: `${option.code} · ${option.name}` }));
    const countryList = countries().map((option) => ({ value: option.code, text: option.name }));

    const capInput = el("input", { type: "number", min: 0, max: MAX_NEW_TARGETS_LIMIT, step: 1, inputMode: "numeric", value: String(profile.maxNewTargetsPerDay) });
    capInput.addEventListener("change", () => {
      const value = Number(capInput.value);
      if (!Number.isInteger(value) || value < 0 || value > MAX_NEW_TARGETS_LIMIT) {
        showStatus(status, t("settings.profile.maxNewTargetsInvalid", { max: MAX_NEW_TARGETS_LIMIT }), "error");
        capInput.value = String(profile.maxNewTargetsPerDay);
        return;
      }
      profile.maxNewTargetsPerDay = value;
      save();
    });

    const websiteInput = el("input", { type: "url", inputMode: "url", autocomplete: "url", maxLength: PROFILE_TEXT_LIMITS.website, value: profile.website });
    websiteInput.addEventListener("change", () => {
      profile.website = websiteInput.value.trim();
      save();
    });

    container.append(
      ...heading(section, t("settings.profile.intro")),
      el("div", { className: "settings-grid" }, [
        field(t("settings.profile.name"), nameInput),
        textField("oneLiner", { hint: t("settings.profile.oneLinerHint") }),
      ]),
      textField("description", { multiline: true, rows: 4 }),
      el("div", { className: "settings-grid" }, [
        textField("industry", { hint: t("settings.profile.industryHint") }),
        textField("homeRegion", { hint: t("settings.profile.homeRegionHint") }),
      ]),
      iconField,
      el("fieldset", { className: "settings-fieldset" }, [
        el("legend", { text: t("settings.profile.links") }),
        field(t("settings.profile.website"), websiteInput),
        linkList,
        addLink,
      ]),
      el("div", { className: "settings-grid" }, [
        selectField("country", countryList, { emptyKey: "settings.profile.notSet" }),
        selectField("currency", currencies, { emptyKey: "settings.profile.notSet" }),
        textField("entityType", { hint: t("settings.profile.companyLater") }),
      ]),
      constraintsField(),
      field(t("settings.profile.maxNewTargetsPerDay"), capInput, t("settings.profile.maxNewTargetsHint")),
      status,
    );
    if (!bridge?.saveProfile) {
      container.querySelectorAll("input, textarea, select").forEach((control) => { control.disabled = true; });
      showStatus(status, t("settings.profile.notReady"), "error");
    }
  }

  // ---- Startups ------------------------------------------------------------

  async function fetchStartupsWithCounts() {
    const payload = await root.fetch(Api.urls.startupsWithCounts, { cache: "no-store" }).then(readJson);
    return Array.isArray(payload.startups) ? payload.startups : [];
  }

  async function renderStartups(container, section, stillCurrent) {
    container.append(...heading(section, t("settings.startups.intro")));
    const status = statusLine();
    const listHolder = el("div", { className: "settings-table-wrap" }, el("p", { className: "settings-hint", text: t("settings.loading") }));
    container.append(listHolder);
    const list = await fetchStartupsWithCounts();
    if (!stillCurrent()) return;

    const refresh = async (message) => {
      await startupsModule()?.reload?.();
      await renderSection();
      if (message) showStatus(ui.content.querySelector(".settings-status"), message, "ok");
    };

    const rows = list.map((startup) => {
      const isCurrent = startup.id === Api.startupId;
      const nameCell = el("td", { className: "settings-startup-cell" },
        el("div", { className: "settings-startup-name" }, [
          el("span", { className: "settings-startup-title" }, [
            el("span", { className: "startup-icon settings-startup-icon", "aria-hidden": "true" }, el("img", { src: Icon.iconFor(startup), alt: "" })),
            el("span", { className: "settings-startup-label", text: startup.name }),
          ]),
          isCurrent ? el("span", { className: "settings-badge", text: t("settings.startups.current") }) : null,
          startup.archived ? el("span", { className: "settings-badge is-muted", text: t("settings.startups.archived") }) : null,
        ])
      );
      const actions = el("td", { className: "settings-row-actions" });
      const actionButtons = el("div", { className: "settings-startup-actions" });
      const detail = el("tr", { className: "settings-detail-row", hidden: true }, el("td", { colSpan: 5 }));

      const openDetail = (content) => {
        detail.firstChild.replaceChildren(content);
        detail.hidden = false;
        content.querySelector("input, button")?.focus();
      };
      const closeDetail = (focus) => {
        detail.hidden = true;
        detail.firstChild.replaceChildren();
        focus?.focus();
      };

      const renameButton = iconAction(t("settings.startups.renameNamed", { name: startup.name }), "edit");
      renameButton.addEventListener("click", () => {
        const input = el("input", { type: "text", maxLength: 120, value: startup.name });
        const form = el("form", { className: "settings-inline-form", novalidate: true }, [
          field(t("settings.startups.newName"), input),
          el("button", { type: "submit", className: "primary-button", text: t("settings.startups.saveName") }),
          button(t("startups.cancel"), { on: { click: () => closeDetail(renameButton) } }),
        ]);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) {
            showStatus(status, t("startups.nameRequired"), "error");
            return;
          }
          try {
            await patchStartup(startup.id, { name });
            await refresh(t("settings.startups.renamed", { name }));
          } catch (error) {
            showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
          }
        });
        openDetail(form);
      });

      const archiveButton = iconAction(
        t(startup.archived ? "settings.startups.unarchiveNamed" : "settings.startups.archiveNamed", { name: startup.name }),
        startup.archived ? "archive-restore" : "archive"
      );
      archiveButton.addEventListener("click", async () => {
        if (!startup.archived && isCurrent && !root.confirm(t("settings.startups.archiveCurrentConfirm", { name: startup.name }))) return;
        try {
          await patchStartup(startup.id, { archived: !startup.archived });
          if (!startup.archived && isCurrent) {
            await page()?.prepareToLeave?.();
            root.location.assign("/");
            return;
          }
          await refresh(t(startup.archived ? "settings.startups.unarchived" : "settings.startups.archivedDone", { name: startup.name }));
        } catch (error) {
          showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
        }
      });

      const deleteButton = iconAction(t("settings.startups.deleteNamed", { name: startup.name }), "trash", { danger: true });
      deleteButton.addEventListener("click", () => {
        const input = el("input", { type: "text", autocomplete: "off", spellcheck: "false" });
        const confirmButton = el("button", { type: "submit", className: "danger-button", text: t("settings.startups.deleteForever"), disabled: true });
        input.addEventListener("input", () => { confirmButton.disabled = input.value.trim() !== startup.name; });
        const form = el("form", { className: "settings-inline-form settings-danger-zone", novalidate: true }, [
          el("p", { text: t("settings.startups.deleteWarning", { name: startup.name }) }),
          field(t("settings.startups.typeName", { name: startup.name }), input),
          confirmButton,
          button(t("startups.cancel"), { on: { click: () => closeDetail(deleteButton) } }),
        ]);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (input.value.trim() !== startup.name) return;
          confirmButton.disabled = true;
          try {
            await root.fetch(Api.urls.startup(startup.id), { method: "DELETE", cache: "no-store" }).then(readJson);
            if (isCurrent) {
              root.location.assign("/");
              return;
            }
            await refresh(t("settings.startups.deleted", { name: startup.name }));
          } catch (error) {
            confirmButton.disabled = false;
            showStatus(status, t("settings.startups.deleteFailed", { error: errorText(error) }), "error");
          }
        });
        openDetail(form);
      });

      const openLabel = t("settings.startups.openNamed", { name: startup.name });
      const openLink = isCurrent || startup.archived ? null : el("a", {
        className: "icon-button",
        href: Api.pageUrl(startup.id),
        "aria-label": openLabel,
        "data-tooltip": openLabel,
      }, icon("forward"));
      if (openLink) {
        openLink.addEventListener("click", async (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          await page()?.prepareToLeave?.();
          root.location.assign(openLink.href);
        });
      }
      actionButtons.append(...[openLink, renameButton, archiveButton, deleteButton].filter(Boolean));
      actions.append(actionButtons);
      actions.dataset.label = t("settings.startups.actions");

      return [
        el("tr", {}, [
          nameCell,
          el("td", { dataset: { label: t("settings.startups.created") }, text: formatDay(startup.createdAt) }),
          el("td", { className: "is-number", dataset: { label: t("settings.startups.records") }, text: Number.isFinite(startup.recordCount) ? I18n.formatNumber(startup.recordCount) : "" }),
          el("td", { className: "is-number", dataset: { label: t("settings.startups.media") }, text: Number.isFinite(startup.mediaBytes) ? formatBytes(startup.mediaBytes) : "" }),
          actions,
        ]),
        detail,
      ];
    });

    const table = el("table", { className: "settings-table settings-startups-table" }, [
      el("caption", { className: "visually-hidden", text: t("settings.startups.tableCaption") }),
      el("thead", {}, el("tr", {}, [
        el("th", { scope: "col", text: t("settings.startups.name") }),
        el("th", { scope: "col", text: t("settings.startups.created") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.startups.records") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.startups.media") }),
        el("th", { scope: "col", text: t("settings.startups.actions") }),
      ])),
      el("tbody", {}, rows.flat()),
    ]);
    listHolder.replaceChildren(table);
    container.append(
      status,
      setupBlock(t("settings.startups.addTitle"), t("setup.addGuidedHint"), t("setup.addGuided"), { mode: "add" }),
      renderAddStartup(list, status),
    );
  }

  function renderAddStartup(list, status) {
    const nameInput = el("input", { type: "text", maxLength: 120, autocomplete: "off", required: true });
    const copyFrom = el("select", {}, [
      el("option", { value: "", text: t("startups.copyNothing") }),
      ...list.filter((startup) => !startup.archived).map((startup) => el("option", { value: startup.id, text: startup.name })),
    ]);
    const fieldBoxes = PROFILE_FIELDS.map((name) => {
      const box = el("input", { type: "checkbox", value: name, checked: true, id: uid("copy-field") });
      return el("label", { className: "settings-check", for: box.id }, [box, el("span", { text: t(`settings.profile.${name}`) })]);
    });
    const copyRecords = el("input", { type: "checkbox", id: uid("copy-records") });
    const copyOptions = el("fieldset", { className: "settings-fieldset", hidden: true }, [
      el("legend", { text: t("settings.startups.copyFields") }),
      el("div", { className: "settings-check-grid" }, fieldBoxes),
      el("label", { className: "settings-check", for: copyRecords.id }, [copyRecords, el("span", { text: t("settings.startups.copyRecords") })]),
      el("p", { className: "settings-hint", text: t("settings.startups.copyShared") }),
    ]);
    copyFrom.addEventListener("change", () => { copyOptions.hidden = !copyFrom.value; });
    const submit = el("button", { type: "submit", className: "primary-button", text: t("startups.create") });
    const form = el("form", { className: "settings-add-startup", novalidate: true }, [
      el("h4", { text: root.StartupTrackerSetupWizard ? t("settings.startups.addQuickTitle") : t("settings.startups.addTitle") }),
      el("div", { className: "settings-grid" }, [
        field(t("startups.nameLabel"), nameInput),
        field(t("startups.copyFromLabel"), copyFrom),
      ]),
      copyOptions,
      submit,
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        showStatus(status, t("startups.nameRequired"), "error");
        nameInput.focus();
        return;
      }
      const body = { name, origin: "ui" };
      if (copyFrom.value) {
        body.copySettingsFrom = copyFrom.value;
        body.copyProfileFields = fieldBoxes.map((label) => label.querySelector("input")).filter((box) => box.checked).map((box) => box.value);
        body.copyRecords = copyRecords.checked;
      }
      submit.disabled = true;
      try {
        const response = await root.fetch(Api.urls.startups, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await readJson(response);
        await startupsModule()?.reload?.();
        await renderSection();
        const message = ui.content.querySelector(".settings-status");
        if (message) {
          message.replaceChildren(t("settings.startups.addedNamed", { name: payload.startup.name }), " ", el("a", { href: Api.pageUrl(payload.startup.id), text: t("settings.startups.openNew") }));
          message.dataset.kind = "ok";
        }
      } catch (error) {
        submit.disabled = false;
        showStatus(status, t("startups.createFailed", { error: errorText(error) }), "error");
      }
    });
    return form;
  }

  // ---- Appearance ----------------------------------------------------------

  async function saveSettings(patch, status, message) {
    try {
      const settings = await Settings.save(patch);
      showStatus(status, message || t("settings.saved"), "ok");
      return settings;
    } catch (error) {
      showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
      return null;
    }
  }

  function renderAppearance(container, section) {
    const status = statusLine();
    const current = Appearance ? Appearance.get() : { mode: "system", theme: "studio" };
    const persist = async (patch) => {
      const next = { mode: current.mode, theme: current.theme, ...patch };
      current.mode = next.mode;
      current.theme = next.theme;
      Appearance?.apply(next);
      await saveSettings({ appearance: { mode: next.mode, theme: next.theme } }, status);
    };

    const name = uid("appearance-mode");
    const modes = el("fieldset", { className: "settings-fieldset settings-segmented" }, [
      el("legend", { text: t("settings.appearance.mode") }),
      ...["system", "light", "dark"].map((mode) => {
        const radio = el("input", { type: "radio", name, value: mode, id: uid("mode"), checked: current.mode === mode });
        radio.addEventListener("change", () => { if (radio.checked) persist({ mode }); });
        return el("label", { className: "settings-segment", for: radio.id }, [radio, el("span", { text: t(`settings.appearance.modes.${mode}`) })]);
      }),
    ]);

    const themeName = uid("appearance-theme");
    const themeThemes = Appearance?.THEMES || ["studio"];
    const themeLabel = (theme) => t(`settings.appearance.themes.${theme}.name`);
    const themes = el("fieldset", { className: "settings-fieldset" }, [
      el("legend", { text: t("settings.appearance.theme") }),
      el("p", { className: "settings-hint", text: t("settings.appearance.themeHint") }),
      el("div", { className: "taste-theme-grid settings-theme-grid" }, themeThemes.map((theme) => {
        const radio = el("input", { type: "radio", name: themeName, value: theme, id: uid("theme"), checked: current.theme === theme, className: "visually-hidden" });
        radio.addEventListener("change", () => {
          if (!radio.checked) return;
          container.querySelectorAll(".taste-theme-card").forEach((card) => card.classList.toggle("active", card.dataset.tasteVal === theme));
          persist({ theme });
        });
        const credit = Appearance?.THEME_CREDITS?.[theme];
        return el("label", { className: `taste-theme-card${current.theme === theme ? " active" : ""}`, for: radio.id, dataset: { tasteVal: theme } }, [
          radio,
          el("span", { className: "taste-theme-preview" }, [
            el("img", {
              src: Appearance?.previewPath?.(theme) || `/assets/theme-previews/${theme}.jpg`,
              alt: "",
              loading: "lazy",
              width: 720,
              height: 500,
            }),
          ]),
          el("span", { className: "taste-theme-body" }, [
            el("span", { className: "taste-theme-header" }, [
              el("span", { className: "taste-theme-name", text: themeLabel(theme) }),
              theme === "studio" ? el("span", { className: "taste-theme-badge default-badge", text: t("settings.appearance.default") }) : null,
            ]),
            el("span", { className: "taste-theme-desc", text: t(`settings.appearance.themes.${theme}.description`) }),
            credit ? el("span", { className: "taste-theme-credit", text: t("settings.appearance.themeCredit", { skill: credit }) }) : null,
          ]),
        ]);
      })),
    ]);
    container.append(...heading(section, t("settings.appearance.intro")), modes, themes, renderSectionColors(status), status);
  }

  // Section colours: the standard or colour-blind palette, and a colour per
  // section over it. A picked colour that reads below 4.5:1 as text on its
  // own tint gets a note; the page then uses a darker or lighter shade for
  // text.
  function renderSectionColors(status) {
    const wrap = el("fieldset", { className: "settings-fieldset settings-section-colors" });
    const draw = () => {
      const choice = Settings.get().sectionColors;
      const colors = Sections.colorsFor(choice);
      const save = async (patch) => {
        await saveSettings({ sectionColors: patch }, status);
        draw();
      };
      const paletteName = uid("section-palette");
      const palettes = el("div", { className: "settings-segmented" }, Sections.PALETTE_IDS.map((palette) => {
        const radio = el("input", { type: "radio", name: paletteName, value: palette, id: uid("palette"), checked: choice.palette === palette });
        radio.addEventListener("change", () => { if (radio.checked) save({ palette }); });
        return el("label", { className: "settings-segment", for: radio.id }, [radio, el("span", { text: t(`settings.appearance.palettes.${palette}`) })]);
      }));
      const rows = Sections.SECTIONS.map((section) => {
        const input = el("input", { type: "color", value: colors[section.id], id: uid("section-color") });
        input.addEventListener("change", () => save({ [section.id]: input.value }));
        const readable = Sections.readability(colors[section.id]);
        const low = Sections.MODES.filter((mode) => readable[mode].ratio < Sections.MIN_CONTRAST);
        // Only a picked colour gets the note: the palettes are checked by the tests.
        const note = choice[section.id] && low.length
          ? el("p", { className: "settings-hint settings-contrast-note", text: t("settings.appearance.lowContrast", {
            ratio: Math.min(...low.map((mode) => readable[mode].ratio)).toFixed(1),
            modes: low.map((mode) => t(`settings.appearance.modes.${mode}`)).join(", "),
          }) })
          : null;
        return el("div", { className: "settings-section-color" }, [
          el("span", { className: "section-chip", dataset: { section: section.id }, text: section.short }),
          el("label", { for: input.id, text: t(`sections.${section.id}.name`) }),
          input,
          choice[section.id] ? el("span", { className: "settings-badge", text: t("settings.appearance.custom") }) : null,
          note,
        ]);
      });
      const reset = button(t("settings.appearance.resetColors"), {
        icon: "reset",
        disabled: Sections.isStandard(choice) && choice.palette === "standard",
        on: { click: () => save({ palette: "standard", mk: "", po: "", fu: "", comp: "" }) },
      });
      wrap.replaceChildren(
        el("legend", { text: t("settings.appearance.sectionColors") }),
        el("p", { className: "settings-hint", text: t("settings.appearance.sectionColorsHint") }),
        palettes,
        el("div", { className: "settings-section-color-list" }, rows),
        el("div", { className: "settings-row-actions" }, [reset]),
      );
    };
    draw();
    return wrap;
  }

  // ---- General -------------------------------------------------------------

  function renderGeneral(container, section) {
    const settings = Settings.get();
    const status = statusLine();
    const save = (patch) => saveSettings(patch, status);
    const today = Dates.todayIn(Settings.effectiveTimeZone(settings, Dates.defaultTimeZone()));

    const appName = el("input", { type: "text", maxLength: 60, value: settings.appName, autocomplete: "off" });
    appName.addEventListener("change", () => {
      const value = appName.value.replace(/\s+/g, " ").trim();
      if (!value) {
        showStatus(status, t("settings.general.appNameRequired"), "error");
        appName.value = Settings.get().appName;
        return;
      }
      save({ appName: value });
    });

    const language = el("select", {}, [el("option", { value: "en", text: t("settings.general.languages.en") })]);
    language.value = "en";
    language.addEventListener("change", () => save({ language: language.value }));

    // Time zone: a searchable list; empty means the browser's zone.
    const zones = timeZoneList();
    const listId = uid("time-zones");
    const zoneInput = el("input", {
      type: "search",
      list: listId,
      autocomplete: "off",
      spellcheck: "false",
      value: settings.timeZone,
      placeholder: t("settings.general.browserZone", { zone: Dates.defaultTimeZone() }),
    });
    const zoneList = el("datalist", { id: listId }, zones.map((zone) => el("option", { value: zone })));
    zoneInput.addEventListener("change", () => {
      const value = zoneInput.value.trim();
      if (value && !zones.includes(value)) {
        const matches = filterTimeZones(value, zones);
        if (matches.length === 1) zoneInput.value = matches[0];
        else {
          showStatus(status, t("settings.general.zoneUnknown", { zone: value }), "error");
          return;
        }
      }
      save({ timeZone: zoneInput.value.trim() });
    });
    const useBrowserZone = button(t("settings.general.useBrowserZone"), {
      on: { click: () => {
        zoneInput.value = "";
        save({ timeZone: "" });
      } },
    });
    const zoneField = field(t("settings.general.timeZone"), zoneInput, t("settings.general.timeZoneHint"));
    zoneField.append(zoneList, useBrowserZone);

    const dateFormat = el("select", {}, Dates.DATE_FORMATS.map((format) => el("option", {
      value: format,
      text: t(`settings.general.dateFormats.${format === "system" ? "system" : format === "yyyy-MM-dd" ? "iso" : "short"}`, { example: Dates.formatDateAs(today, I18n.getLocale(), format) }),
    })));
    dateFormat.value = settings.dateFormat;
    dateFormat.addEventListener("change", () => save({ dateFormat: dateFormat.value }));

    const weekStart = el("select", {}, Dates.WEEK_STARTS.map((value) => el("option", { value, text: t(`settings.general.weekStarts.${value}`) })));
    weekStart.value = settings.weekStart;
    weekStart.addEventListener("change", () => save({ weekStart: weekStart.value }));

    const pageSize = el("input", { type: "number", min: 10, max: 200, step: 1, inputMode: "numeric", value: String(settings.pageSize) });
    pageSize.addEventListener("change", () => {
      const value = Number(pageSize.value);
      if (!Number.isInteger(value) || value < 10 || value > 200) {
        showStatus(status, t("settings.general.pageSizeInvalid"), "error");
        pageSize.value = String(Settings.get().pageSize);
        return;
      }
      save({ pageSize: value });
    });

    const yourName = el("input", { type: "text", maxLength: 80, value: settings.yourName, autocomplete: "name", placeholder: t("settings.general.you") });
    yourName.addEventListener("change", () => save({ yourName: yourName.value.replace(/\s+/g, " ").trim() }));

    const network = el("input", { type: "checkbox", checked: settings.network, id: uid("network") });
    network.addEventListener("change", () => save({ network: network.checked }));

    const scope = el("select", {}, ["startup", "all"].map((value) => el("option", { value, text: t(value === "all" ? "scope.all" : "scope.this") })));
    scope.value = settings.defaultScope;
    scope.addEventListener("change", () => save({ defaultScope: scope.value }));

    container.append(
      ...heading(section, t("settings.general.intro")),
      el("div", { className: "settings-grid" }, [
        field(t("settings.general.appName"), appName, t("settings.general.appNameHint")),
        field(t("settings.general.language"), language),
      ]),
      zoneField,
      el("div", { className: "settings-grid" }, [
        field(t("settings.general.dateFormat"), dateFormat),
        field(t("settings.general.weekStart"), weekStart),
        field(t("settings.general.pageSize"), pageSize, t("settings.general.pageSizeHint")),
        field(t("settings.general.yourName"), yourName, t("settings.general.yourNameHint")),
        field(t("settings.general.defaultScope"), scope, t("settings.general.defaultScopeHint")),
      ]),
      el("div", { className: "settings-field" }, [
        el("label", { className: "settings-check", for: network.id }, [network, el("span", { text: t("settings.general.network") })]),
        el("p", { className: "settings-hint", text: t("settings.general.networkHint") }),
      ]),
      status,
    );
  }

  // ---- Statuses ------------------------------------------------------------
  //
  // One list for every startup. Each change saves the whole list at once, and
  // the page's dropdowns, badges and filters follow. Deleting asks where the
  // records go and moves them first, in every startup.

  async function sendStatuses(url, method, body) {
    return readJson(await root.fetch(url, {
      method,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, origin: "ui" }),
    }));
  }

  async function renderStatuses(container, section, isCurrent) {
    const payload = await readJson(await root.fetch(Api.urls.statuses, { cache: "no-store" }));
    if (!isCurrent()) return;
    let config = payload.statuses;
    const priorities = payload.priorities?.priorities || [];
    const status = statusLine();
    const body = el("div", { className: "settings-statuses" });
    // Which entry has its delete form open, as "key:id".
    let deleting = "";

    const after = async (next, options = {}) => {
      config = next;
      await page()?.applyStatusList?.(config, options);
    };

    const save = async (next, focusSelector) => {
      try {
        const result = await sendStatuses(Api.urls.statuses, "PUT", { statuses: next });
        await after(result.statuses);
        showStatus(status, t("settings.saved"), "ok");
      } catch (error) {
        showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
      }
      draw();
      if (focusSelector) body.querySelector(focusSelector)?.focus();
    };

    const remove = async (key, entry, moveTo) => {
      const kind = key === "campaignStatuses" ? "campaign" : "status";
      try {
        const result = await sendStatuses(Api.urls.statusDelete(kind, entry.id), "POST", { moveTo });
        deleting = "";
        await after(result.statuses, { recordsMoved: result.moved > 0 });
        const target = (config[key] || []).find((other) => other.id === moveTo);
        showStatus(status, t(kind === "campaign" ? "settings.statuses.deletedCampaign" : "settings.statuses.deleted", { status: entry.label, target: target?.label || moveTo, count: result.moved }), "ok");
      } catch (error) {
        showStatus(status, t("settings.saveFailed", { error: errorText(error) }), "error");
      }
      draw();
    };

    function deleteForm(key, entry) {
      const targets = statusMoveTargets(config, key, entry.id);
      const select = el("select", {}, targets.map((target) => el("option", { value: target.id, text: target.label })));
      const confirm = el("button", {
        type: "button",
        className: "danger-button",
        text: t("settings.statuses.deleteConfirm"),
        on: { click: () => remove(key, entry, select.value) },
      });
      const cancel = button(t("settings.statuses.cancel"), { on: { click: () => { deleting = ""; draw(); } } });
      return el("div", { className: "settings-inline-form settings-status-delete" }, [
        field(t(key === "campaignStatuses" ? "settings.statuses.moveCampaignsTo" : "settings.statuses.moveTo", { status: entry.label }), select),
        el("div", { className: "settings-row-actions" }, [confirm, cancel]),
      ]);
    }

    function entryRow(key, entry, index, siblings) {
      const rowKey = `${key}:${entry.id}`;
      const labelInput = el("input", { type: "text", maxLength: 60, value: entry.label, "aria-label": t("settings.statuses.label", { status: entry.label }), dataset: { statusLabel: rowKey } });
      labelInput.addEventListener("change", () => {
        const value = cleanLabel(labelInput.value);
        if (!value) {
          labelInput.value = entry.label;
          showStatus(status, t("settings.statuses.labelRequired"), "error");
          return;
        }
        save(updateStatusEntry(config, key, entry.id, { label: value }));
      });
      const descriptionInput = el("textarea", { rows: 1, className: "settings-status-description", maxLength: 300, placeholder: t("settings.statuses.descriptionPlaceholder"), "aria-label": t("settings.statuses.description", { status: entry.label }) }, entry.description || "");
      descriptionInput.addEventListener("change", () => save(updateStatusEntry(config, key, entry.id, { description: descriptionInput.value.replace(/\s+/g, " ").trim() })));
      const move = (delta, direction) => el("button", {
        type: "button",
        className: "icon-button",
        disabled: delta < 0 ? index === 0 : index === siblings.length - 1,
        "aria-label": t(`settings.statuses.${direction}`, { status: entry.label }),
        dataset: { statusMove: `${rowKey}:${direction}` },
        on: { click: () => save(moveStatusEntry(config, key, entry.id, delta), `[data-status-move="${rowKey}:${direction}"]:not([disabled])`) },
      }, icon(delta < 0 ? "chevron-up" : "chevron-down"));
      const deletable = canDeleteStatusEntry(config, key, entry.id);
      const removeButton = deletable
        ? el("button", {
          type: "button",
          className: "icon-button",
          "aria-label": t("settings.statuses.delete", { status: entry.label }),
          "aria-expanded": String(deleting === rowKey),
          on: { click: () => { deleting = deleting === rowKey ? "" : rowKey; draw(); } },
        }, icon("trash"))
        : el("span", { className: "settings-badge", title: t("settings.statuses.builtInHelp"), text: t("settings.statuses.builtIn") });
      return el("li", { className: "settings-status-row" }, [
        el("div", { className: "settings-status-fields" }, [
          key === "statuses" ? el("span", { className: Statuses.badgeClass(entry.id), "aria-hidden": "true", text: entry.label }) : null,
          labelInput,
          descriptionInput,
        ]),
        el("div", { className: "settings-row-actions" }, [move(-1, "moveUp"), move(1, "moveDown"), removeButton]),
        deleting === rowKey ? deleteForm(key, entry) : null,
      ]);
    }

    function addForm(key, group, groupLabel) {
      const input = el("input", { type: "text", maxLength: 60, placeholder: t("settings.statuses.newPlaceholder") });
      const add = () => {
        const label = cleanLabel(input.value);
        if (!label) {
          input.focus();
          return;
        }
        const next = addStatusEntry(config, key, label, group);
        const added = next[key].find((entry) => !(config[key] || []).some((other) => other.id === entry.id));
        save(next, added ? `[data-status-label="${key}:${added.id}"]` : "");
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          add();
        }
      });
      return el("div", { className: "settings-inline-form" }, [
        field(group ? t("settings.statuses.addTo", { group: groupLabel }) : t("settings.statuses.addCampaign"), input),
        button(t("settings.statuses.add"), { icon: "plus", on: { click: add } }),
      ]);
    }

    function draw() {
      const groups = config.groups.map((group) => {
        const entries = config.statuses.filter((entry) => entry.group === group.id);
        return el("section", { className: "settings-block settings-status-group", dataset: { statusGroup: group.id } }, [
          el("h4", {}, [el("span", { className: `status-group-label status-group-${group.id.replace(/_/g, "-")}`, text: group.label })]),
          group.description ? el("p", { className: "settings-hint", text: group.description }) : null,
          el("ul", { className: "settings-status-list" }, entries.map((entry, index) => entryRow("statuses", entry, index, entries))),
          addForm("statuses", group.id, group.label),
        ]);
      });
      const campaigns = el("section", { className: "settings-block settings-status-group", dataset: { statusGroup: "campaigns" } }, [
        el("h4", { text: t("settings.statuses.campaignsTitle") }),
        el("p", { className: "settings-hint", text: t("settings.statuses.campaignsHint") }),
        el("ul", { className: "settings-status-list" }, config.campaignStatuses.map((entry, index) => entryRow("campaignStatuses", entry, index, config.campaignStatuses))),
        addForm("campaignStatuses", "", ""),
      ]);
      const priorityList = el("section", { className: "settings-block" }, [
        el("h4", { text: t("settings.statuses.prioritiesTitle") }),
        el("p", { className: "settings-hint", text: t("settings.statuses.prioritiesHint") }),
        el("ol", { className: "settings-priority-list" }, priorities.map((priority) => el("li", { text: priority.label }))),
      ]);
      body.replaceChildren(...groups, campaigns, priorityList);
    }

    draw();
    container.append(...heading(section, t("settings.statuses.intro")), body, status);
  }

  // ---- AI agents (js/agents-settings.js) -----------------------------------

  function renderAgents(container, section, isCurrent) {
    const AgentsSettings = root.StartupTrackerAgentsSettings;
    if (!AgentsSettings?.render) throw new Error("js/agents-settings.js did not load");
    return AgentsSettings.render(container, section, { el, t, Api, heading, isCurrent, formatInstant, errorText });
  }

  // ---- Backups -------------------------------------------------------------

  function backupActions() {
    return createBackupActions({
      fetch: (...args) => root.fetch(...args),
      location: root.location,
      api: Api,
      startupId: Api.startupId,
      prepareToLeave: () => page()?.prepareToLeave?.() || Promise.resolve(),
    });
  }

  function backupTitle(backup) {
    const date = formatInstant(backup.createdAt, { seconds: true });
    return backup.label ? t("backups.nameWithLabel", { date, label: backup.label }) : date;
  }

  function renderCountsSummary(counts) {
    const list = countsList(counts);
    if (!list.length) return el("span", { className: "settings-hint", text: t("settings.backups.noRecords") });
    return el("ul", { className: "settings-counts" }, list.map(({ section, count }) => el("li", {}, [
      el("span", { text: sectionLabel(section) }),
      el("span", { className: "is-number", text: I18n.formatNumber(count) }),
    ])));
  }

  function renderCompare(result, selection) {
    const rows = changedSections(result);
    const wrap = el("div", { className: "settings-compare" });
    if (!rows.length) {
      wrap.append(el("p", { text: t("settings.backups.compareSame") }));
      return wrap;
    }
    wrap.append(el("table", { className: "settings-table settings-compare-table" }, [
      el("caption", { text: t("settings.backups.compareCaption") }),
      el("thead", {}, el("tr", {}, [
        el("th", { scope: "col", text: t("settings.backups.section") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.backups.current") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.backups.inBackup") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.backups.added") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.backups.removed") }),
        el("th", { scope: "col", className: "is-number", text: t("settings.backups.changed") }),
      ])),
      el("tbody", {}, rows.map((row) => el("tr", {}, [
        el("th", { scope: "row", text: sectionLabel(row.section) }),
        el("td", { className: "is-number", text: row.current === null ? "" : String(row.current) }),
        el("td", { className: "is-number", text: row.backup === null ? "" : String(row.backup) }),
        el("td", { className: "is-number", text: String(row.added) }),
        el("td", { className: "is-number", text: String(row.removed) }),
        el("td", { className: "is-number", text: String(row.changed) }),
      ]))),
    ]));
    const records = Array.isArray(result.records) ? result.records : [];
    if (records.length) {
      const list = el("ul", { className: "settings-compare-records" }, records.map((record) => {
        const restorable = record.id && record.change !== "removed";
        const label = `${record.title || record.id || sectionLabel(record.section)}`;
        const change = el("span", { className: `settings-change is-${record.change}`, text: t(`settings.backups.changes.${record.change}`) });
        const where = el("span", { className: "settings-hint", text: sectionLabel(record.section) });
        if (!restorable) return el("li", {}, [change, el("span", { text: label }), where]);
        const box = el("input", { type: "checkbox", id: uid("compare-record") });
        box.addEventListener("change", () => {
          const key = `${record.section}\u0000${record.id}`;
          if (box.checked) selection.set(key, { section: record.section, id: record.id });
          else selection.delete(key);
          wrap.dispatchEvent(new root.CustomEvent("selection"));
        });
        return el("li", {}, el("label", { className: "settings-check", for: box.id }, [box, change, el("span", { text: label }), where]));
      }));
      wrap.append(el("h5", { text: t("settings.backups.differentRecords") }), el("p", { className: "settings-hint", text: t("settings.backups.tickHint") }), list);
      if (result.truncated) wrap.append(el("p", { className: "settings-hint", text: t("settings.backups.truncated", { count: records.length }) }));
    }
    return wrap;
  }

  function renderRestoreForm(backup, actions, status, selection, getCompare) {
    const name = uid("restore-scope");
    const scopes = ["startup", "database", "records"];
    const radios = scopes.map((scope) => el("input", { type: "radio", name, value: scope, id: uid("scope"), checked: scope === "startup" }));
    const recordsHint = el("p", { className: "settings-hint" });
    const updateRecordsHint = () => {
      recordsHint.textContent = getCompare()
        ? t("settings.backups.selectedCount", { count: selection.size })
        : t("settings.backups.compareFirst");
      radios[2].disabled = !getCompare();
    };
    updateRecordsHint();
    const submit = el("button", { type: "submit", className: "danger-button", text: t("settings.backups.restoreConfirm") });
    const form = el("form", { className: "settings-inline-form settings-restore-form", novalidate: true }, [
      el("fieldset", { className: "settings-fieldset" }, [
        el("legend", { text: t("settings.backups.restoreWhat") }),
        ...scopes.map((scope, index) => el("label", { className: "settings-check", for: radios[index].id }, [
          radios[index],
          el("span", {}, [
            el("span", { text: t(`settings.backups.scopes.${scope}`, { name: currentStartupName() }) }),
            el("span", { className: "settings-hint", text: t(`settings.backups.scopeHints.${scope}`) }),
          ]),
        ])),
        recordsHint,
      ]),
      el("p", { className: "settings-hint", text: t("settings.backups.safetyFirst") }),
      submit,
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const scope = radios.find((radio) => radio.checked)?.value || "startup";
      if (scope === "records" && selection.size === 0) {
        showStatus(status, t("settings.backups.tickFirst"), "error");
        return;
      }
      const confirmKey = scope === "database" ? "settings.backups.confirmDatabase" : scope === "records" ? "settings.backups.confirmRecords" : "settings.backups.confirmStartup";
      if (!root.confirm(t(confirmKey, { name: currentStartupName(), backup: backupTitle(backup), count: selection.size }))) return;
      submit.disabled = true;
      showStatus(status, t("settings.backups.restoring"));
      try {
        await actions.restore(backup.id, scope, [...selection.values()]);
        showStatus(status, t("backups.restored"), "ok");
      } catch (error) {
        submit.disabled = false;
        showStatus(status, t("settings.backups.restoreFailed", { error: errorText(error) }), "error");
      }
    });
    form.updateRecordsHint = updateRecordsHint;
    return form;
  }

  function renderBackupItem(backup, actions, status, reload) {
    const item = el("li", { className: "settings-backup" });
    const detail = el("div", { className: "settings-backup-detail" });
    const selection = new Map();
    let compareResult = null;
    let restoreForm = null;

    const verifyBadge = () => {
      const result = verified.get(backup.id);
      if (!result) return null;
      return el("span", { className: `settings-badge ${result.ok ? "is-ok" : "is-error"}` }, [
        el("span", { "aria-hidden": "true", text: result.ok ? "✓ " : "! " }),
        result.ok ? t("settings.backups.verified") : t("settings.backups.verifyProblems", { count: result.problems.length }),
      ]);
    };
    const header = el("div", { className: "settings-backup-header" });
    const renderHeader = () => {
      header.replaceChildren(...[
        el("strong", { text: backupTitle(backup) }),
        el("span", { className: `settings-badge kind-${backup.kind}`, text: t(`settings.backups.kinds.${backup.kind}`) }),
        backup.complete === false ? el("span", { className: "settings-badge is-error", text: t("settings.backups.incomplete") }) : null,
        verifyBadge(),
        el("span", { className: "settings-hint", text: t("settings.backups.size", {
          database: formatBytes(backup.databaseBytes),
          media: formatBytes(backup.mediaBytes),
          files: backup.mediaFiles || 0,
        }) }),
      ].filter(Boolean));
    };
    renderHeader();

    const verifyButton = button(t("settings.backups.verify"));
    verifyButton.addEventListener("click", async () => {
      verifyButton.disabled = true;
      showStatus(status, t("settings.backups.verifying"));
      try {
        const result = await actions.verify(backup.id);
        const ok = result.verified ?? result.ok;
        verified.set(backup.id, { ok: Boolean(ok), problems: Array.isArray(result.problems) ? result.problems : [] });
        renderHeader();
        showStatus(status, ok ? t("settings.backups.verifiedDone") : t("settings.backups.verifyFailed", { problems: (result.problems || []).join("; ") }), ok ? "ok" : "error");
      } catch (error) {
        showStatus(status, t("settings.backups.verifyFailed", { problems: errorText(error) }), "error");
      } finally {
        verifyButton.disabled = false;
      }
    });

    const compareButton = button(t("settings.backups.compare"), { "aria-expanded": "false" });
    const compareHolder = el("div", { hidden: true });
    compareButton.addEventListener("click", async () => {
      if (!compareHolder.hidden) {
        compareHolder.hidden = true;
        compareButton.setAttribute("aria-expanded", "false");
        return;
      }
      compareButton.disabled = true;
      try {
        compareResult = await actions.compare(backup.id);
        selection.clear();
        const view = renderCompare(compareResult, selection);
        view.addEventListener("selection", () => restoreForm?.updateRecordsHint());
        compareHolder.replaceChildren(view);
        compareHolder.hidden = false;
        compareButton.setAttribute("aria-expanded", "true");
        restoreForm?.updateRecordsHint();
      } catch (error) {
        showStatus(status, t("settings.backups.compareFailed", { error: errorText(error) }), "error");
      } finally {
        compareButton.disabled = false;
      }
    });

    const restoreButton = button(t("settings.backups.restore"), { "aria-expanded": "false", disabled: backup.complete === false });
    const restoreHolder = el("div", { hidden: true });
    restoreButton.addEventListener("click", () => {
      if (!restoreHolder.hidden) {
        restoreHolder.hidden = true;
        restoreButton.setAttribute("aria-expanded", "false");
        return;
      }
      restoreForm = renderRestoreForm(backup, actions, status, selection, () => compareResult);
      restoreHolder.replaceChildren(restoreForm);
      restoreHolder.hidden = false;
      restoreButton.setAttribute("aria-expanded", "true");
      restoreForm.querySelector("input")?.focus();
    });

    const download = el("a", { className: "secondary-button", href: Api.urls.backupDownload(backup.id), download: "", text: t("settings.backups.download") });

    const deleteButton = el("button", { type: "button", className: "danger-button", text: t("settings.backups.delete") });
    deleteButton.addEventListener("click", async () => {
      if (!root.confirm(t("settings.backups.confirmDelete", { backup: backupTitle(backup) }))) return;
      deleteButton.disabled = true;
      try {
        await actions.remove(backup.id);
        await reload(t("settings.backups.deleted"));
      } catch (error) {
        deleteButton.disabled = false;
        showStatus(status, t("settings.backups.deleteFailed", { error: errorText(error) }), "error");
      }
    });

    const countsDetails = el("details", { className: "settings-backup-counts" }, [
      el("summary", { text: t("settings.backups.countsFor", { name: currentStartupName(), count: countsList(backup.counts).reduce((total, entry) => total + entry.count, 0) }) }),
      renderCountsSummary(backup.counts),
    ]);

    detail.append(compareHolder, restoreHolder);
    item.append(
      header,
      countsDetails,
      el("div", { className: "settings-row-actions" }, [verifyButton, compareButton, restoreButton, download, deleteButton]),
      detail,
    );
    return item;
  }

  async function renderBackups(container, section, stillCurrent) {
    const actions = backupActions();
    const settings = Settings.get();
    const status = statusLine();
    container.append(...heading(section, t("settings.backups.intro")));

    // Back up now.
    const labelInput = el("input", { type: "text", maxLength: 60, autocomplete: "off", pattern: "[A-Za-z0-9 ._-]*" });
    const backupNow = el("button", { type: "submit", className: "primary-button" }, [icon("save"), el("span", { text: t("settings.backups.backUpNow") })]);
    const createHint = el("p", { className: "settings-hint", id: uid("backup-label-hint"), text: t("settings.backups.labelHint") });
    labelInput.setAttribute("aria-describedby", createHint.id);
    const createForm = el("form", { className: "settings-inline-form settings-backup-create", novalidate: true }, [
      field(t("settings.backups.label"), labelInput),
      backupNow,
    ]);

    const listHolder = el("ul", { className: "settings-backup-list", "aria-busy": "true" }, el("li", { className: "settings-hint", text: t("settings.loading") }));
    const reload = async (message) => {
      listHolder.setAttribute("aria-busy", "true");
      try {
        const backups = await actions.list();
        listHolder.replaceChildren(...(backups.length
          ? backups.map((backup) => renderBackupItem(backup, actions, status, reload))
          : [el("li", { className: "settings-hint", text: t("settings.backups.none") })]));
        if (message) showStatus(status, message, "ok");
      } catch (error) {
        listHolder.replaceChildren(el("li", { className: "settings-error", text: t("settings.backups.loadFailed", { error: errorText(error) }) }));
      } finally {
        listHolder.setAttribute("aria-busy", "false");
      }
    };

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const label = labelInput.value.trim().replace(/\s+/g, "-");
      if (label && !/^[A-Za-z0-9._-]+$/.test(label)) {
        showStatus(status, t("settings.backups.labelInvalid"), "error");
        labelInput.focus();
        return;
      }
      backupNow.disabled = true;
      showStatus(status, t("settings.backups.creating"));
      try {
        await page()?.prepareToLeave?.();
        const result = await actions.create(label);
        labelInput.value = "";
        await reload(result.skipped ? t("settings.backups.skipped") : t("settings.backups.created"));
      } catch (error) {
        showStatus(status, t("settings.backups.createFailed", { error: errorText(error) }), "error");
      } finally {
        backupNow.disabled = false;
      }
    });

    // How many to keep.
    const keepInput = (key) => {
      const input = el("input", { type: "number", min: 1, max: 1000, step: 1, inputMode: "numeric", value: String(settings.backups[key]) });
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 1 || value > 1000) {
          showStatus(status, t("settings.backups.keepInvalid"), "error");
          input.value = String(Settings.get().backups[key]);
          return;
        }
        saveSettings({ backups: { [key]: value } }, status);
      });
      return field(t(`settings.backups.${key}`), input, t(`settings.backups.${key}Hint`));
    };
    const intervalInput = () => {
      const input = el("input", { type: "number", min: 1, max: 8760, step: 1, inputMode: "numeric", value: String(settings.backups.intervalHours) });
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 1 || value > 8760) {
          showStatus(status, t("settings.backups.intervalInvalid"), "error");
          input.value = String(Settings.get().backups.intervalHours);
          return;
        }
        saveSettings({ backups: { intervalHours: value } }, status);
      });
      return field(t("settings.backups.intervalHours"), input, t("settings.backups.intervalHoursHint"));
    };

    // Export: plain download links.
    const exportLink = (href, text) => el("a", { className: "secondary-button", href, download: "" }, [icon("download"), el("span", { text })]);
    // Sensitive company values (bank accounts, ID numbers) stay out of the
    // zip and JSON exports unless ticked; the database file holds everything.
    const sensitiveBox = el("input", { type: "checkbox" });
    const exportLinks = [
      [(options) => Api.urls.exportStartup(Api.startupId, "zip", options), t("settings.backups.exportStartupZip", { name: currentStartupName() })],
      [(options) => Api.urls.exportStartup(Api.startupId, "json", options), t("settings.backups.exportStartupJson", { name: currentStartupName() })],
      [(options) => Api.urls.exportAll("zip", undefined, options), t("settings.backups.exportAllZip")],
      [(options) => Api.urls.exportAll("json", undefined, options), t("settings.backups.exportAllJson")],
    ].map(([href, text]) => ({ href, link: exportLink(href({}), text) }));
    sensitiveBox.addEventListener("change", () => {
      for (const entry of exportLinks) entry.link.href = entry.href({ includeSensitive: sensitiveBox.checked });
    });
    const exportGroup = el("div", { className: "settings-block" }, [
      el("h4", { text: t("settings.backups.exportTitle") }),
      el("p", { className: "settings-hint", text: t("settings.backups.exportHint") }),
      el("label", { className: "settings-check" }, [sensitiveBox, el("span", { text: t("settings.backups.includeSensitive") })]),
      el("div", { className: "settings-row-actions" }, [
        ...exportLinks.map((entry) => entry.link),
        exportLink(Api.urls.exportAll("sqlite"), t("settings.backups.exportDatabase")),
      ]),
    ]);

    container.append(
      el("div", { className: "settings-block" }, [el("h4", { text: t("settings.backups.nowTitle") }), createForm, createHint]),
      status,
      el("div", { className: "settings-block" }, [el("h4", { text: t("settings.backups.listTitle") }), listHolder]),
      el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.backups.keepTitle") }),
        el("label", { className: "settings-check" }, [
          el("input", { type: "checkbox", checked: settings.backups.automatic !== false, on: { change: (event) => saveSettings({ backups: { automatic: event.target.checked } }, status) } }),
          el("span", { text: t("settings.backups.automatic") }),
        ]),
        el("div", { className: "settings-grid" }, [intervalInput(), keepInput("keepAutomatic"), keepInput("keepSafety")]),
        el("p", { className: "settings-hint", text: t("settings.backups.pinnedHint") }),
      ]),
      exportGroup,
      renderImport(actions),
    );
    await reload();
    if (!stillCurrent()) return;
  }

  function renderImport(actions) {
    const status = statusLine();
    const fileInput = el("input", { type: "file", accept: ".zip,.json,.sqlite,application/zip,application/json", className: "settings-file-input" });
    const preview = el("div", { className: "settings-import-preview" });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      preview.replaceChildren();
      showStatus(status, t("settings.import.reading", { file: file.name }));
      try {
        const result = await actions.previewImport(file);
        showStatus(status, "");
        preview.replaceChildren(renderImportPreview(result, actions, status));
        preview.querySelector("button")?.focus();
      } catch (error) {
        showStatus(status, t("settings.import.failed", { error: errorText(error) }), "error");
      } finally {
        fileInput.value = "";
      }
    });
    return el("div", { className: "settings-block" }, [
      el("h4", { text: t("settings.import.title") }),
      el("p", { className: "settings-hint", text: t("settings.import.hint") }),
      el("label", { className: "secondary-button settings-file-button" }, [icon("upload"), el("span", { text: t("settings.import.choose") }), fileInput]),
      status,
      preview,
    ]);
  }

  function renderImportPreview(result, actions, status) {
    const wrap = el("div", { className: "settings-import-card" });
    const info = result.preview || {};
    if (result.kind === "database") {
      wrap.append(
        el("p", { text: t("settings.import.databaseSummary", { count: info.startupCount || 0, records: info.recordCount || 0 }) }),
        Array.isArray(info.startups) && info.startups.length ? el("p", { className: "settings-hint", text: info.startups.join(", ") }) : null,
      );
    } else {
      (Array.isArray(info.startups) ? info.startups : []).forEach((entry) => {
        wrap.append(el("div", { className: "settings-import-startup" }, [
          el("strong", { text: entry.name }),
          el("span", { className: "settings-hint", text: t("settings.import.mediaFiles", { count: entry.mediaFiles || 0 }) }),
          renderCountsSummary(entry.sections),
          Array.isArray(entry.unmappedStatuses) && entry.unmappedStatuses.length
            ? el("p", { className: "settings-hint settings-import-unmapped" }, t("settings.import.unmapped", { statuses: entry.unmappedStatuses.map((status) => `${status.id} (${status.count})`).join(", ") }))
            : null,
        ]));
      });
      if (info.exportedAt) wrap.append(el("p", { className: "settings-hint", text: t("settings.import.exportedAt", { date: formatInstant(info.exportedAt) }) }));
    }
    const choices = importChoices(result.kind, info);
    const buttons = choices.map((mode) => {
      const label = t(`settings.import.modes.${mode}`, { name: currentStartupName() });
      const control = el("button", { type: "button", className: mode === "new" ? "primary-button" : "danger-button", text: label });
      control.addEventListener("click", async () => {
        if (mode !== "new" && !root.confirm(t(`settings.import.confirm.${mode}`, { name: currentStartupName() }))) return;
        buttons.forEach((entry) => { entry.disabled = true; });
        showStatus(status, t("settings.import.applying"));
        try {
          await actions.applyImport(result.token, mode);
          showStatus(status, t("settings.import.done"), "ok");
        } catch (error) {
          buttons.forEach((entry) => { entry.disabled = false; });
          showStatus(status, t("settings.import.failed", { error: errorText(error) }), "error");
        }
      });
      return control;
    });
    wrap.append(el("p", { className: "settings-hint", text: t("settings.import.safetyFirst") }), el("div", { className: "settings-row-actions" }, buttons));
    return wrap;
  }

  // ---- Recycle bin ---------------------------------------------------------

  function renderRecycle(container, section) {
    const bridge = page();
    const status = statusLine();
    const settings = Settings.get();
    const groups = bridge?.getRecycleBin ? bridge.getRecycleBin() : [];
    const total = groups.reduce((sum, group) => sum + group.records.length, 0);

    const retention = el("select", {}, Recycle.RETENTION_CHOICES.map((days) => el("option", {
      value: days === null ? "keep" : String(days),
      text: days === null ? t("settings.recycle.keepForever") : t("settings.recycle.days", { count: days }),
    })));
    const currentDays = settings.recycleBin.retentionDays;
    if (currentDays !== null && !Recycle.RETENTION_CHOICES.includes(currentDays)) {
      retention.append(el("option", { value: String(currentDays), text: t("settings.recycle.days", { count: currentDays }) }));
    }
    retention.value = currentDays === null ? "keep" : String(currentDays);
    retention.addEventListener("change", () => {
      saveSettings({ recycleBin: { retentionDays: retention.value === "keep" ? null : Number(retention.value) } }, status);
    });

    const emptyButton = el("button", { type: "button", className: "danger-button", disabled: total === 0 }, [icon("trash"), el("span", { text: t("settings.recycle.empty") })]);
    emptyButton.addEventListener("click", () => {
      if (!root.confirm(t("settings.recycle.confirmEmpty", { count: total, name: currentStartupName() }))) return;
      bridge.emptyBin();
      showStatus(status, t("settings.recycle.emptied"), "ok");
    });

    const list = total
      ? groups.map((group) => el("section", { className: "settings-bin-group", "aria-label": t(`settings.recycle.groups.${group.group}`) }, [
        el("h4", {}, [
          Sections.byId(group.group) ? el("span", { className: "section-chip", dataset: { section: group.group }, "aria-hidden": "true", text: Sections.byId(group.group).short }) : null,
          Sections.byId(group.group) ? " " : null,
          t(`settings.recycle.groups.${group.group}`),
          el("span", { className: "settings-count", text: ` (${group.records.length})` }),
        ]),
        el("ul", { className: "settings-bin-list" }, group.records.map((record) => {
          const title = record.title || t("settings.recycle.untitled");
          return el("li", { className: "settings-bin-item" }, [
            el("div", {}, [
              el("strong", { text: title }),
              el("span", { className: "settings-hint", text: record.deletedAt ? t("settings.recycle.deletedAt", { date: formatInstant(record.deletedAt) }) : "" }),
            ]),
            el("div", { className: "settings-row-actions" }, [
              button(t("settings.recycle.restore"), {
                "aria-label": t("settings.recycle.restoreNamed", { name: title }),
                on: { click: () => {
                  bridge.restoreFromBin(record.section, record.id);
                  showStatus(status, t("settings.recycle.restored", { name: title }), "ok");
                } },
              }),
              el("button", {
                type: "button",
                className: "danger-button",
                text: t("settings.recycle.deleteForever"),
                "aria-label": t("settings.recycle.deleteForeverNamed", { name: title }),
                on: { click: () => {
                  if (!root.confirm(t("settings.recycle.confirmDelete", { name: title }))) return;
                  bridge.deleteFromBin(record.section, record.id);
                  showStatus(status, t("settings.recycle.deletedForever", { name: title }), "ok");
                } },
              }),
            ]),
          ]);
        })),
      ]))
      : [el("p", { className: "settings-empty", text: t("settings.recycle.emptyState") })];

    container.append(
      ...heading(section, t("settings.recycle.intro")),
      el("div", { className: "settings-grid" }, [field(t("settings.recycle.retention"), retention, t("settings.recycle.retentionHint"))]),
      el("div", { className: "settings-row-actions" }, [emptyButton]),
      status,
      ...list,
    );
    if (!bridge?.getRecycleBin) showStatus(status, t("settings.profile.notReady"), "error");
  }

  // ---- About ---------------------------------------------------------------

  async function renderAbout(container, section, stillCurrent) {
    const status = statusLine();
    container.append(...heading(section));
    const facts = el("dl", { className: "settings-facts" });
    container.append(facts);
    const fill = (about) => {
      const integrity = about.integrity || {};
      const integrityText = !integrity.checkedAt ? t("settings.about.notChecked")
        : integrity.ok ? t("settings.about.integrityOk", { date: formatInstant(integrity.checkedAt) })
          : t("settings.about.integrityProblems", { date: formatInstant(integrity.checkedAt), problems: (integrity.problems || []).join("; ") });
      const rows = [
        ["version", about.version],
        ["dataFolder", about.dataFolder],
        ["databasePath", about.databasePath],
        ["mediaDir", about.mediaDir],
        ["backupDir", about.backupDir],
        ["port", about.port],
        ["schemaVersion", about.schemaVersion],
        ["databaseBytes", formatBytes(about.databaseBytes)],
        ["integrity", integrityText],
      ];
      facts.replaceChildren(...rows.flatMap(([key, value]) => [
        el("dt", { text: t(`settings.about.${key}`) }),
        el("dd", { className: ["dataFolder", "databasePath", "mediaDir", "backupDir"].includes(key) ? "is-path" : "", text: value === undefined || value === null ? "" : String(value) }),
      ]));
    };
    const about = await root.fetch(Api.urls.about, { cache: "no-store" }).then(readJson);
    if (!stillCurrent()) return;
    fill(about);

    const verify = button(t("settings.about.verify"));
    verify.addEventListener("click", async () => {
      verify.disabled = true;
      showStatus(status, t("settings.about.verifying"));
      try {
        const result = await root.fetch(Api.urls.aboutVerify, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin: "ui" }),
        }).then(readJson);
        fill(result);
        showStatus(status, result.integrity?.ok ? t("settings.about.verifyOk") : t("settings.about.verifyProblems"), result.integrity?.ok ? "ok" : "error");
      } catch (error) {
        showStatus(status, t("settings.about.verifyFailed", { error: errorText(error) }), "error");
      } finally {
        verify.disabled = false;
      }
    });

    // Updates: the cached answer on open, a fresh one on "Check for updates
    // now". Installing stays a terminal command.
    const updateText = el("p", { className: "settings-hint", role: "status" });
    const showUpdate = (update) => {
      if (!update.configured) {
        updateText.textContent = t("settings.about.updateNotConfigured");
        return;
      }
      const parts = [];
      if (update.available) parts.push(t("settings.about.updateAvailable", { latest: update.latest, current: update.current }));
      else if (update.checkedAt) parts.push(t("settings.about.updateLatest", { current: update.current, date: formatInstant(update.checkedAt) }));
      else parts.push(t("settings.about.updateNotChecked"));
      if (update.error) parts.push(t("settings.about.updateFailed", { error: update.error }));
      updateText.textContent = parts.join(" ");
    };
    const checkUpdate = button(t("settings.about.updateCheckNow"));
    checkUpdate.addEventListener("click", async () => {
      checkUpdate.disabled = true;
      updateText.textContent = t("settings.about.updateChecking");
      try {
        const body = await root.fetch(Api.urls.aboutUpdate, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin: "ui" }),
        }).then(readJson);
        showUpdate(body.update);
      } catch (error) {
        updateText.textContent = t("settings.about.updateFailed", { error: errorText(error) });
      } finally {
        checkUpdate.disabled = false;
      }
    });
    root.fetch(Api.urls.aboutUpdate, { cache: "no-store" }).then(readJson).then((body) => {
      if (stillCurrent()) showUpdate(body.update);
    }).catch(() => {});

    const command = "node tools/about.js";
    const commandCode = el("code", { className: "settings-command", text: command });
    const copy = button(t("settings.about.copy"), { "aria-label": t("settings.about.copyNamed", { command }) });
    copy.addEventListener("click", async () => {
      try {
        await root.navigator.clipboard.writeText(command);
        showStatus(status, t("settings.about.copied"), "ok");
      } catch {
        const range = root.document.createRange();
        range.selectNodeContents(commandCode);
        const selection = root.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        showStatus(status, t("settings.about.copyManually"));
      }
    });

    const docs = ["docs/setup.md", "docs/startups.md", "docs/cli.md", "docs/api.md", "docs/security.md", "docs/development.md"];
    container.append(
      el("div", { className: "settings-row-actions" }, [verify]),
      status,
      el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.about.updatesTitle") }),
        updateText,
        el("div", { className: "settings-row-actions" }, [checkUpdate]),
      ]),
      el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.about.terminalTitle") }),
        el("p", { className: "settings-hint", text: t("settings.about.terminalHint") }),
        el("div", { className: "settings-command-row" }, [commandCode, copy]),
      ]),
      el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.about.docsTitle") }),
        el("p", { className: "settings-hint", text: t("settings.about.docsHint") }),
        el("ul", { className: "settings-doc-list" }, docs.map((path) => el("li", {}, el("code", { text: path })))),
        el("p", { text: t("settings.about.repository") }),
        el("p", {}, [t("settings.about.license"), " ", el("code", { text: "LICENSE" })]),
      ]),
      setupBlock(t("setup.runAgain"), t("setup.runAgainHint"), t("setup.runAgain"), { mode: "full", step: "welcome", startupId: Api.startupId }),
    );
  }

  const RENDERERS = {
    profile: renderProfile,
    startups: renderStartups,
    appearance: renderAppearance,
    general: renderGeneral,
    statuses: renderStatuses,
    agents: renderAgents,
    backups: renderBackups,
    recycle: renderRecycle,
    about: renderAbout,
  };

  // ---- the app name, everywhere it shows -----------------------------------

  function applyAppName(settings) {
    const name = settings.appName || Settings.DEFAULTS.appName;
    root.document.querySelectorAll("[data-app-name]").forEach((node) => { node.textContent = name; });
  }

  function mount() {
    bindPanel();
    applyAppName(Settings.get());
    Settings.subscribe((settings, previous) => {
      applyAppName(settings);
      if (Appearance && JSON.stringify(settings.appearance) !== JSON.stringify(previous?.appearance)) {
        Appearance.apply(settings.appearance);
      }
    });
    Settings.load().catch(() => {
      // The cached copy stays in use; the next page load tries again.
    });
  }

  I18n.ready.then(() => {
    if (Api.hasStartup) mount();
  });

  return Object.freeze({ ...pure, open, close, isOpen });
});
