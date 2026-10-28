// The setup (window.StartupTrackerSetupWizard): what the app needs the first
// time it opens, step by step in the browser.
//
//   Welcome, Basics (time zone, date format, appearance, language), Your
//   startup, Links, AI context, What to track (one page per section), AI
//   agents, Backups, Done.
//
// Every step is saved when you leave it, and the step reached is kept on the
// server (/api/setup), so a reload or another tab continues where it stopped.
// Only the startup name and the time zone are required; everything else has
// Skip. "Add startup" runs the startup steps only (Your startup to What to
// track) for another startup.
//
// What can be tested without a browser is exported on its own.
//
// UMD: browsers get window.StartupTrackerSetupWizard, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerSetupWizard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const FULL_STEPS = Object.freeze(["welcome", "basics", "startup", "links", "context", "track-mk", "track-po", "track-fu", "agents", "backups", "done"]);
  const ADD_STEPS = Object.freeze(["startup", "links", "context", "track-mk", "track-po", "track-fu", "done"]);
  const REQUIRED = Object.freeze({ basics: ["timeZone"], startup: ["name"] });
  const TRACK_SECTIONS = Object.freeze({ "track-mk": "mk", "track-po": "po", "track-fu": "fu" });

  // ---- what can be tested -----------------------------------------------------

  function stepsFor(mode) {
    return mode === "add" ? ADD_STEPS : FULL_STEPS;
  }

  // The step to open the setup on: the one saved, unless it needs a startup
  // that is not there (it was deleted), then "Your startup".
  function resumeStep(mode, saved, startupId) {
    const steps = stepsFor(mode);
    if (!steps.includes(saved)) return steps[0];
    if (!startupId && steps.indexOf(saved) > steps.indexOf("startup")) return "startup";
    return saved;
  }

  // A zone from the list, or one the date formatter accepts ("UTC" is not
  // in every browser's list), like the server's check in lib/settings.js.
  function isTimeZone(value, zones = []) {
    if (!value) return false;
    if (zones.includes(value)) return true;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }

  // Where a step sits: { index, total, percent, first, last }.
  function progress(mode, step) {
    const steps = stepsFor(mode);
    const index = Math.max(0, steps.indexOf(step));
    return { index, total: steps.length, percent: Math.round((index / (steps.length - 1)) * 100), first: index === 0, last: index === steps.length - 1 };
  }

  function neighbour(mode, step, direction) {
    const steps = stepsFor(mode);
    const index = steps.indexOf(step);
    return steps[Math.min(steps.length - 1, Math.max(0, (index === -1 ? 0 : index) + direction))];
  }

  // Skip is offered on every step but the first and the last, and never on a
  // step whose required field is empty (the startup name, the time zone).
  function canSkip(step) {
    return step !== "welcome" && step !== "done" && !REQUIRED[step];
  }

  // Which required fields are still empty.
  function missing(step, values) {
    return (REQUIRED[step] || []).filter((field) => !String(values?.[field] ?? "").trim());
  }

  // The nodes a startup starts with: every node the library marks
  // "recommended" (with its ancestors, so it shows).
  function recommendedSelection(nodes) {
    const byId = new Map((nodes || []).map((node) => [node.id, node]));
    const out = new Set();
    for (const node of nodes || []) {
      if (!node.recommended) continue;
      for (let current = node; current; current = current.parentId ? byId.get(current.parentId) : null) out.add(current.id);
    }
    return out;
  }

  // The tree of one section, for the "What to track" pages.
  function sectionTree(nodes, section) {
    const list = (nodes || []).filter((node) => node.section === section);
    const children = new Map();
    for (const node of list) {
      const key = node.parentId || "";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node);
    }
    for (const group of children.values()) group.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
    const build = (node) => ({ node, children: (children.get(node.id) || []).map(build) });
    return (children.get("") || []).map(build);
  }

  // Ticks a node with everything under it (and its ancestors), or unticks
  // it with everything under it. Returns a new set.
  function setBranch(selection, nodes, id, on) {
    const byId = new Map((nodes || []).map((node) => [node.id, node]));
    const next = new Set(selection);
    const under = [id];
    for (let index = 0; index < under.length; index += 1) {
      for (const node of nodes || []) if (node.parentId === under[index]) under.push(node.id);
    }
    if (on) {
      under.forEach((entry) => next.add(entry));
      for (let current = byId.get(id); current; current = current.parentId ? byId.get(current.parentId) : null) next.add(current.id);
    } else {
      under.forEach((entry) => next.delete(entry));
    }
    return next;
  }

  // Skip on a "What to track" page: that section goes back to the
  // Recommended nodes; the other sections keep what was picked.
  function skipSection(selection, nodes, section) {
    const inSection = new Set((nodes || []).filter((node) => node.section === section).map((node) => node.id));
    const others = [...selection].filter((id) => !inSection.has(id));
    const recommended = recommendedSelection((nodes || []).filter((node) => node.section === section));
    return new Set([...others, ...recommended]);
  }

  // The parts of a "What to track" page, in order. "Turn everything on" comes
  // only after the notice about the time it takes, as an explicit choice.
  const TRACK_PARTS = Object.freeze(["notice", "everything", "search", "tree"]);

  // The sidebar badge and whether the setup opens by itself on page load.
  function badgeState(setup) {
    const needed = Boolean(setup?.needsSetup);
    return { hidden: !needed, autoOpen: needed && Boolean(setup?.open) };
  }

  // "12 of 40 on" for a section.
  function countOn(selection, nodes, section) {
    const list = (nodes || []).filter((node) => node.section === section);
    return { on: list.filter((node) => selection.has(node.id)).length, total: list.length };
  }

  // The currency a country or template suggests.
  function suggestCurrency({ template = null, country = "" } = {}) {
    if (template?.currency) return template.currency;
    const byCountry = { US: "USD", GB: "GBP", JP: "JPY", CN: "CNY", IN: "INR", CA: "CAD", BR: "BRL", RO: "RON", CH: "CHF", AU: "AUD", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN" };
    const euro = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
    const code = String(country || "").toUpperCase();
    if (euro.includes(code)) return "EUR";
    return byCountry[code] || "";
  }

  // The templates to offer for a country: its own country first, then every
  // other country in name order, each group holding its legal forms. Generic
  // stays a separate option at the end.
  function templatesFor(templates, country) {
    const list = Array.isArray(templates) ? templates.filter((template) => !template.draft) : [];
    const code = String(country || "").toUpperCase();
    const own = list.filter((template) => template.country === code);
    const rest = list.filter((template) => template.country !== code && template.id !== "generic");
    const groups = [];
    const seen = new Set();
    for (const template of [...own, ...rest]) {
      const key = template.country || "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entries = list.filter((entry) => entry.country === key).sort((a, b) => String(a.nameEnglish).localeCompare(String(b.nameEnglish)));
      groups.push({ country: key, countryName: entries[0]?.countryName || key, templates: entries });
    }
    return { own, rest, groups, generic: list.find((template) => template.id === "generic") || null };
  }

  const pure = { FULL_STEPS, ADD_STEPS, TRACK_SECTIONS, TRACK_PARTS, stepsFor, resumeStep, isTimeZone, progress, neighbour, canSkip, missing, recommendedSelection, sectionTree, setBranch, skipSection, countOn, badgeState, suggestCurrency, templatesFor };

  if (!root.document) return Object.freeze(pure);

  // ---- browser ----------------------------------------------------------------

  const I18n = root.StartupTrackerI18n;
  const Api = root.StartupTrackerApi;
  const t = (key, params) => I18n.t(key, params);

  async function request(url, { method = "GET", body } = {}) {
    const response = await root.fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok || parsed.ok === false) throw Object.assign(new Error(parsed.error || parsed.message || `HTTP ${response.status}`), { code: parsed.code || "", status: response.status });
    return parsed;
  }

  function h(tag, props = {}, children = []) {
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

  function field(label, control, hint = "") {
    return h("label", { className: "setup-field" }, [h("span", { className: "setup-label", text: label }), control, hint ? h("span", { className: "setup-hint", text: hint }) : null]);
  }

  // Reads a startup's state and writes whole sections with their revision.
  async function readStartupState(startupId) {
    const body = await request(Api.startupApiUrl(startupId, "state"));
    return { state: body.state || {}, revisionMap: body.revisionMap || { sections: {}, records: {} } };
  }

  async function writeSections(startupId, sections) {
    const { revisionMap } = await readStartupState(startupId);
    const operations = Object.entries(sections).map(([section, value]) => ({ type: "replaceSection", section, value, baseRevision: Number(revisionMap.sections?.[section] || 0) }));
    await request(Api.startupApiUrl(startupId, "state/operations"), { method: "PATCH", body: { protocolVersion: 2, operations, origin: "ui", label: t("setup.saveLabel") } });
  }

  // The favicon and the tab title while you edit the startup step, as they
  // will look ("<startup> · <app name>").
  function previewIdentity(name, icon) {
    const Icon = root.StartupTrackerIcon;
    const favicon = root.document.querySelector("#appFavicon");
    if (favicon && Icon) {
      const href = icon || Icon.monogramDataUrl(name || "?");
      favicon.href = href;
      favicon.type = Icon.iconMimeType(href) || "image/svg+xml";
    }
    const app = root.StartupTrackerSettings?.get?.().appName || t("app.name");
    root.document.title = name ? t("startups.pageTitle", { name, app }) : app;
  }

  // Opens the setup. options: { mode: "full" | "add", step, startupId,
  // onFinish(startupId), onClose() }.
  async function open(options = {}) {
    const mode = options.mode === "add" ? "add" : "full";
    const saved = mode === "full" ? (await request(Api.urls.setup).catch(() => null))?.setup : null;
    const startupId = options.startupId || (mode === "full" ? saved?.startupId || Api.startupId || "" : "");
    const ui = {
      mode,
      step: options.step || resumeStep(mode, saved?.step, startupId),
      startupId,
      skipped: new Set(saved?.skipped || []),
      error: "",
      busy: false,
      cache: {},
      values: {},
    };
    let dialog = root.document.querySelector("#setupWizard");
    if (dialog) dialog.remove();
    dialog = h("dialog", { id: "setupWizard", className: "setup-wizard", "aria-labelledby": "setupWizardTitle" });
    root.document.body.appendChild(dialog);

    function remember(patch) {
      if (ui.mode !== "full") return Promise.resolve();
      return request(Api.urls.setup, { method: "PUT", body: patch }).catch(() => {});
    }

    async function cached(key, load) {
      if (!(key in ui.cache)) ui.cache[key] = await load();
      return ui.cache[key];
    }

    // ---- steps: each returns { title, intro, body, save() } -------------------

    const builders = {
      welcome: async () => ({
        title: t("setup.welcome.title"),
        intro: t("setup.welcome.intro"),
        body: h("ul", { className: "setup-points" }, ["one", "two", "three"].map((key) => h("li", { text: t(`setup.welcome.points.${key}`) }))),
      }),

      basics: async () => {
        const Settings = root.StartupTrackerSettings;
        const Dates = root.StartupTrackerDates;
        const Appearance = root.StartupTrackerAppearance;
        await Settings.load().catch(() => null);
        const current = Settings.get();
        const detected = Dates.defaultTimeZone();
        const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [detected];
        const zone = h("input", { type: "search", list: "setupZones", value: current.timeZone || detected, required: true, spellcheck: "false", autocomplete: "off" });
        const zoneList = h("datalist", { id: "setupZones" }, zones.map((value) => h("option", { value })));
        const today = Dates.todayIn(current.timeZone || detected);
        const dateFormat = h("select", {}, Dates.DATE_FORMATS.map((format) => h("option", {
          value: format,
          text: t(`settings.general.dateFormats.${format === "system" ? "system" : format === "yyyy-MM-dd" ? "iso" : "short"}`, { example: Dates.formatDateAs(today, I18n.getLocale(), format) }),
          selected: current.dateFormat === format,
        })));
        let selectedTheme = Appearance.normalizeTaste(current.appearance?.theme);
        const modeSelect = h("select", {}, Appearance.MODES.map((id) => h("option", { value: id, text: t(`settings.appearance.modes.${id}`), selected: current.appearance?.mode === id })));
        const preview = () => Appearance.apply?.({ mode: modeSelect.value, theme: selectedTheme });
        const themeGrid = h("div", { className: "taste-theme-grid setup-theme-grid", role: "radiogroup", "aria-label": t("setup.basics.theme") }, Appearance.THEMES.map((id) => {
          const input = h("input", { type: "radio", name: "setupTheme", value: id, id: `setup-theme-${id}`, className: "visually-hidden", checked: selectedTheme === id });
          input.addEventListener("change", () => {
            if (!input.checked) return;
            selectedTheme = id;
            themeGrid.querySelectorAll(".taste-theme-card").forEach((card) => card.classList.toggle("active", card.dataset.tasteVal === id));
            preview();
          });
          const credit = Appearance.THEME_CREDITS?.[id];
          return h("label", { className: `taste-theme-card${selectedTheme === id ? " active" : ""}`, for: input.id, dataset: { tasteVal: id } }, [
            input,
            h("span", { className: "taste-theme-preview" }, [
              h("img", {
                src: Appearance.previewPath(id),
                alt: "",
                loading: "lazy",
                width: 720,
                height: 500,
              }),
            ]),
            h("span", { className: "taste-theme-body" }, [
              h("span", { className: "taste-theme-header" }, [
                h("span", { className: "taste-theme-name", text: t(`settings.appearance.themes.${id}.name`) }),
                id === "studio" ? h("span", { className: "taste-theme-badge default-badge", text: t("settings.appearance.default") }) : null,
              ]),
              h("span", { className: "taste-theme-desc", text: t(`settings.appearance.themes.${id}.description`) }),
              credit ? h("span", { className: "taste-theme-credit", text: t("settings.appearance.themeCredit", { skill: credit }) }) : null,
            ]),
          ]);
        }));
        modeSelect.addEventListener("change", preview);
        const themeField = h("div", { className: "setup-field setup-theme-field" }, [
          h("span", { className: "setup-label", text: t("setup.basics.theme") }),
          themeGrid,
        ]);
        const language = h("select", {}, [h("option", { value: "en", text: t("settings.general.languages.en") })]);
        ui.values.basics = () => ({ timeZone: zone.value.trim() });
        return {
          title: t("setup.basics.title"),
          intro: t("setup.basics.intro"),
          body: [
            field(t("setup.basics.timeZone"), zone, t("setup.basics.timeZoneHint", { zone: detected })),
            zoneList,
            field(t("setup.basics.dateFormat"), dateFormat),
            themeField,
            field(t("setup.basics.mode"), modeSelect),
            field(t("setup.basics.language"), language, t("setup.basics.languageHint")),
          ],
          save: async () => {
            const value = zone.value.trim();
            if (!isTimeZone(value, zones)) throw new Error(t("setup.basics.badZone", { zone: value }));
            await Settings.save({ timeZone: value, dateFormat: dateFormat.value, appearance: { theme: selectedTheme, mode: modeSelect.value }, language: language.value });
          },
        };
      },

      startup: async () => {
        const Panel = root.StartupTrackerSettingsPanel;
        const Icon = root.StartupTrackerIcon;
        const listing = await cached("templates", () => request(Api.urls.companyTemplates).catch(() => ({ templates: [] })));
        let startup = null;
        let profile = {};
        let company = {};
        if (ui.startupId) {
          const list = (await request(Api.urls.startups)).startups || [];
          startup = list.find((entry) => entry.id === ui.startupId) || null;
          if (startup) {
            const { state } = await readStartupState(ui.startupId);
            profile = state.profile || {};
            company = state.companyProfile || {};
          }
        }
        let icon = startup?.icon || "";
        const name = h("input", { type: "text", maxLength: 120, required: true, value: startup?.name || "", autocomplete: "off" });
        const oneLiner = h("input", { type: "text", maxLength: 160, value: profile.oneLiner || "" });
        const description = h("textarea", { rows: 3, maxLength: 4000 });
        description.value = profile.description || "";
        const industry = h("input", { type: "text", maxLength: 120, value: profile.industry || "", placeholder: t("setup.startup.industryPlaceholder") });
        const website = h("input", { type: "url", maxLength: 2000, value: profile.website || "", placeholder: "https://" });
        const countries = Panel?.countryOptions ? Panel.countryOptions(I18n.getLocale()) : [];
        const country = h("select", {}, [h("option", { value: "", text: t("setup.startup.pickCountry") }), ...countries.map((entry) => h("option", { value: entry.code, text: entry.name, selected: profile.country === entry.code }))]);
        const template = h("select");
        const subdivision = h("select");
        const subdivisionRow = field(t("setup.startup.subdivision"), subdivision);
        const currency = h("input", { type: "text", maxLength: 3, value: profile.currency || "", placeholder: "EUR", autocomplete: "off" });
        const homeRegion = h("input", { type: "text", maxLength: 160, value: profile.homeRegion || "", placeholder: t("setup.startup.homeRegionPlaceholder") });
        const iconPreview = h("img", { className: "setup-icon-preview", alt: "", width: 48, height: 48 });
        const iconInput = h("input", { type: "file", accept: Icon.ACCEPT_ATTRIBUTE });
        const iconError = h("span", { className: "setup-error", role: "alert" });
        const showIcon = () => {
          iconPreview.src = icon || (Icon ? Icon.monogramDataUrl(name.value || "?") : "");
          previewIdentity(name.value.trim(), icon);
        };
        iconInput.addEventListener("change", async () => {
          const file = iconInput.files?.[0];
          if (!file) return;
          iconError.textContent = "";
          try {
            icon = await Icon.resizeIconFile(file);
            showIcon();
          } catch (error) {
            iconError.textContent = error.code === "unsupportedType" ? t("settings.profile.iconType") : error.code === "tooLarge" ? t("settings.profile.iconTooLarge") : error.message;
          }
        });
        name.addEventListener("input", showIcon);

        const fillTemplates = () => {
          const groups = templatesFor(listing.templates, country.value);
          const entityType = (entry) => {
            if (!entry.entityType || typeof entry.entityType !== "object") return entry.entityType || "";
            return entry.entityType[I18n.getLocale()] || entry.entityType.en || "";
          };
          const option = (entry) => h("option", { value: entry.id, text: `${entityType(entry)} · ${entry.nameEnglish}`, selected: company.templateId === entry.id });
          template.replaceChildren(
            h("option", { value: "", text: t("setup.startup.noTemplate") }),
            h("option", { value: "not-incorporated", text: t("setup.startup.notIncorporated"), selected: company.incorporated === false }),
            ...groups.groups.map((group) => h("optgroup", { label: group.countryName }, group.templates.map(option))),
            groups.generic ? h("option", { value: "generic", text: t("setup.startup.generic"), selected: company.templateId === "generic" }) : null,
          );
        };
        const fillSubdivisions = async () => {
          const id = template.value;
          subdivisionRow.hidden = true;
          if (!id || id === "not-incorporated") return;
          const full = await cached(`template:${id}`, () => request(Api.urls.companyTemplate(id)).then((body) => body.template).catch(() => null));
          if (!currency.value && full) currency.value = suggestCurrency({ template: full, country: country.value });
          if (!full?.subdivision?.options?.length) return;
          subdivision.replaceChildren(h("option", { value: "", text: t("company.profile.pickSubdivision") }), ...full.subdivision.options.map((entry) => h("option", { value: entry.code, text: entry.name, selected: company.subdivision === entry.code })));
          subdivisionRow.querySelector(".setup-label").textContent = full.subdivision.label;
          subdivisionRow.hidden = false;
        };
        country.addEventListener("change", () => {
          fillTemplates();
          if (!currency.value) currency.value = suggestCurrency({ country: country.value });
          fillSubdivisions();
        });
        template.addEventListener("change", fillSubdivisions);
        fillTemplates();
        await fillSubdivisions();
        showIcon();
        ui.values.startup = () => ({ name: name.value.trim() });
        return {
          title: ui.mode === "add" ? t("setup.startup.addTitle") : t("setup.startup.title"),
          intro: t("setup.startup.intro"),
          body: [
            field(t("setup.startup.name"), name),
            h("div", { className: "setup-icon-row" }, [iconPreview, field(t("setup.startup.icon"), iconInput, t("setup.startup.iconHint")), iconError]),
            field(t("setup.startup.oneLiner"), oneLiner),
            field(t("setup.startup.description"), description),
            h("div", { className: "setup-row" }, [field(t("setup.startup.industry"), industry), field(t("setup.startup.website"), website)]),
            h("div", { className: "setup-row" }, [field(t("setup.startup.country"), country), field(t("setup.startup.template"), template, t("setup.startup.templateHint"))]),
            subdivisionRow,
            h("div", { className: "setup-row" }, [field(t("setup.startup.currency"), currency), field(t("setup.startup.homeRegion"), homeRegion)]),
          ],
          save: async () => {
            const body = { name: name.value.trim(), icon };
            if (ui.startupId) await request(Api.urls.startup(ui.startupId), { method: "PATCH", body: { ...body, origin: "ui" } });
            else {
              const created = await request(Api.urls.startups, { method: "POST", body });
              ui.startupId = created.startup.id;
              ui.selection = null;
            }
            const picked = template.value;
            const full = picked && picked !== "not-incorporated" ? ui.cache[`template:${picked}`] : null;
            const nextProfile = {
              ...profile,
              oneLiner: oneLiner.value.trim(),
              description: description.value.trim(),
              industry: industry.value.trim(),
              website: website.value.trim(),
              country: country.value,
              currency: currency.value.trim().toUpperCase(),
              homeRegion: homeRegion.value.trim(),
              companyTemplate: full ? full.id : "",
              entityType: full && full.id !== "generic" ? full.entityType : profile.entityType || "",
            };
            const nextCompany = { ...company, templateId: full ? full.id : "", subdivision: subdivisionRow.hidden ? "" : subdivision.value, incorporated: picked !== "not-incorporated" };
            await writeSections(ui.startupId, { profile: nextProfile, companyProfile: nextCompany });
            await remember({ startupId: ui.startupId });
            await root.StartupTrackerStartups?.reload?.();
          },
        };
      },

      links: async () => {
        const LinkTypes = root.StartupTrackerLinkTypes;
        const { state } = await readStartupState(ui.startupId);
        let links = LinkTypes.normalizeLinks(state.profile?.links);
        const list = h("ol", { className: "setup-links" });
        const typeSelect = (value) => h("select", { "aria-label": t("setup.links.type") }, LinkTypes.GROUPS.map((group) => h("optgroup", { label: t(`linkTypes.groups.${group.id}`) }, group.types.map((type) => h("option", { value: type.id, text: t(`linkTypes.types.${type.id}`), selected: type.id === value })))));
        const iconOf = (typeId) => {
          const svg = root.document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("class", "setup-link-icon");
          svg.setAttribute("aria-hidden", "true");
          const use = root.document.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute("href", `#icon-${LinkTypes.typeById(typeId).icon}`);
          svg.appendChild(use);
          return svg;
        };
        const draw = () => {
          list.replaceChildren(...links.map((link, index) => {
            const type = typeSelect(link.type);
            type.addEventListener("change", () => {
              link.type = type.value;
              draw();
            });
            const url = h("input", { type: "url", value: link.url, "aria-label": t("setup.links.url") });
            url.addEventListener("change", () => {
              link.url = url.value.trim();
              const detected = LinkTypes.detectLinkType(link.url);
              if (detected && (link.type === "other" || link.type === "website")) link.type = detected;
              draw();
            });
            return h("li", { className: "setup-link" }, [
              iconOf(link.type), type, url,
              h("button", { type: "button", className: "icon-button", "aria-label": t("setup.links.up"), disabled: index === 0, text: "↑", on: { click: () => { [links[index - 1], links[index]] = [links[index], links[index - 1]]; draw(); } } }),
              h("button", { type: "button", className: "icon-button", "aria-label": t("setup.links.down"), disabled: index === links.length - 1, text: "↓", on: { click: () => { [links[index + 1], links[index]] = [links[index], links[index + 1]]; draw(); } } }),
              h("button", { type: "button", className: "icon-button", "aria-label": t("setup.links.remove"), text: "×", on: { click: () => { links.splice(index, 1); draw(); } } }),
            ]);
          }));
        };
        const newUrl = h("input", { type: "url", placeholder: t("setup.links.pastePlaceholder"), "aria-label": t("setup.links.url") });
        const newType = typeSelect(links.length ? "other" : "website");
        newUrl.addEventListener("input", () => {
          const detected = LinkTypes.detectLinkType(newUrl.value);
          if (detected) newType.value = detected;
        });
        const add = () => {
          const url = newUrl.value.trim();
          if (!url) return;
          links.push({ id: LinkTypes.makeLinkId(), type: newType.value, url, label: "" });
          draw();
          setAdding(false);
          addToggle.focus();
        };
        newUrl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        });
        const addRow = h("div", { className: "setup-link-add", hidden: true }, [
          newType,
          newUrl,
          h("button", { type: "button", className: "secondary-button compact", text: t("setup.links.addConfirm"), on: { click: add } }),
          h("button", { type: "button", className: "text-button", text: t("setup.links.cancel"), on: { click: () => setAdding(false) } }),
        ]);
        const addToggle = h("button", {
          type: "button",
          className: "secondary-button compact",
          text: t("setup.links.add"),
          on: { click: () => setAdding(true) },
        });
        // The add form only appears when asked for, so it can be dismissed
        // without adding anything.
        const setAdding = (adding) => {
          addToggle.hidden = adding;
          addRow.hidden = !adding;
          if (adding) {
            newType.value = links.length ? "other" : "website";
            newUrl.focus();
          } else {
            newUrl.value = "";
          }
        };
        draw();
        return {
          title: t("setup.links.title"),
          intro: t("setup.links.intro"),
          body: [list, addToggle, addRow],
          save: async () => {
            if (!addRow.hidden && newUrl.value.trim()) add();
            const { state: fresh } = await readStartupState(ui.startupId);
            await writeSections(ui.startupId, { profile: { ...(fresh.profile || {}), links: LinkTypes.normalizeLinks(links) } });
          },
        };
      },

      context: async () => {
        const { state } = await readStartupState(ui.startupId);
        const tips = await cached("tips", () => root.fetch("/content/prompts/constraints-tips.json", { cache: "no-cache" }).then((response) => (response.ok ? response.json() : null)).catch(() => null));
        const text = h("textarea", { rows: 10, maxLength: 20000, className: "setup-context" });
        text.value = state.profile?.aiContext || "";
        const counter = h("span", { className: "setup-hint" });
        const count = () => {
          counter.textContent = t("setup.context.counter", { count: text.value.length, target: tips?.targetLength || 1000 });
        };
        text.addEventListener("input", count);
        count();
        const tipButtons = (tips?.tips || []).map((tip) => h("button", {
          type: "button",
          className: "text-button",
          title: tip.why,
          text: tip.topic,
          on: { click: () => {
            const start = text.selectionStart ?? text.value.length;
            const before = text.value.slice(0, start);
            const insert = `${before && !before.endsWith("\n") ? "\n" : ""}${tip.starter}`;
            text.setRangeText(insert, start, text.selectionEnd ?? start, "end");
            text.focus();
            count();
          } },
        }));
        return {
          title: t("setup.context.title"),
          intro: t("setup.context.intro"),
          body: [text, counter, tips?.privacyNote ? h("p", { className: "setup-hint", text: tips.privacyNote }) : null, h("div", { className: "setup-tips" }, tipButtons)],
          save: async () => {
            const { state: fresh } = await readStartupState(ui.startupId);
            await writeSections(ui.startupId, { profile: { ...(fresh.profile || {}), aiContext: text.value.trim() } });
          },
        };
      },

      agents: async () => {
        const holder = h("div", { className: "setup-agents" });
        const AgentsSettings = root.StartupTrackerAgentsSettings;
        if (AgentsSettings?.render) {
          await AgentsSettings.render(holder, { id: "agents" }, {
            el: h,
            t,
            Api,
            heading: () => [],
            isCurrent: () => ui.step === "agents" && dialog.isConnected,
            formatInstant: (value) => (value ? new Date(value).toLocaleString(I18n.getLocale()) : ""),
            errorText: (error) => error?.message || String(error || ""),
          }).catch((error) => holder.replaceChildren(h("p", { className: "setup-error", role: "alert", text: t("setup.agents.failed", { error: error.message }) })));
        }
        return { title: t("setup.agents.title"), intro: t("setup.agents.intro"), body: holder };
      },

      backups: async () => {
        const Settings = root.StartupTrackerSettings;
        const current = Settings.get().backups || {};
        const about = await cached("about", () => request(Api.urls.about).catch(() => ({})));
        const automatic = h("input", { type: "checkbox", checked: current.automatic !== false });
        const hours = h("input", { type: "number", min: 1, max: 8760, step: 1, inputMode: "numeric", value: String(current.intervalHours || 6) });
        const keep = h("input", { type: "number", min: 1, max: 1000, step: 1, value: String(current.keepAutomatic || 20) });
        return {
          title: t("setup.backups.title"),
          intro: t("setup.backups.intro"),
          body: [
            h("label", { className: "setup-check" }, [automatic, h("span", { text: t("settings.backups.automatic") })]),
            h("div", { className: "setup-row" }, [
              field(t("setup.backups.every"), hours, t("setup.backups.everyHint")),
              field(t("setup.backups.keep"), keep, t("setup.backups.keepHint")),
            ]),
            about.dataFolder ? h("p", {}, [t("setup.backups.folder"), " ", h("code", { text: about.dataFolder })]) : null,
            h("p", { className: "setup-hint", text: t("setup.backups.hint") }),
          ],
          save: async () => {
            const value = Number(keep.value);
            if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error(t("settings.backups.keepInvalid"));
            const interval = Number(hours.value);
            if (!Number.isInteger(interval) || interval < 1 || interval > 8760) throw new Error(t("settings.backups.intervalInvalid"));
            await Settings.save({ backups: { automatic: automatic.checked, intervalHours: interval, keepAutomatic: value } });
          },
        };
      },

      done: async () => {
        const setupInfo = await request(Api.urls.setup).catch(() => ({}));
        const list = (await request(Api.urls.startups).catch(() => ({ startups: [] }))).startups || [];
        const startup = list.find((entry) => entry.id === ui.startupId);
        const skipped = [...ui.skipped].filter((step) => stepsFor(ui.mode).includes(step));
        const demoButton = setupInfo.demo
          ? h("button", { type: "button", className: "secondary-button", text: t("setup.done.removeDemo"), on: { click: () => act(async () => {
            await request(Api.urls.demo, { method: "DELETE" });
            await root.StartupTrackerStartups?.reload?.();
            await show("done");
          }) } })
          : h("button", { type: "button", className: "secondary-button", text: t("setup.done.addDemo"), on: { click: () => act(async () => {
            await request(Api.urls.demo, { method: "POST", body: {} });
            await root.StartupTrackerStartups?.reload?.();
            await show("done");
          }) } });
        return {
          title: t("setup.done.title"),
          intro: startup ? t("setup.done.intro", { name: startup.name }) : t("setup.done.introNoStartup"),
          body: [
            skipped.length ? h("p", { className: "setup-hint", text: t("setup.done.skipped", { steps: skipped.map((step) => t(`setup.steps.${step}`)).join(", ") }) }) : null,
            h("div", { className: "setup-done-actions" }, [
              h("button", { type: "button", className: "primary-button", text: t("setup.done.open"), on: { click: () => finish(ui.startupId) } }),
              ui.mode === "full" ? h("button", { type: "button", className: "secondary-button", text: t("setup.done.another"), on: { click: () => act(async () => {
                ui.mode = "add";
                ui.startupId = "";
                ui.selection = null;
                await show("startup");
              }) } }) : null,
              demoButton,
              setupInfo.demo ? h("a", { className: "secondary-button", href: Api.pageUrl(setupInfo.demo.id), text: t("setup.done.openDemo") }) : null,
            ]),
          ],
        };
      },
    };

    // What to track, one page per section.
    for (const [step, section] of Object.entries(TRACK_SECTIONS)) {
      builders[step] = async () => {
        const library = await cached("taxonomy", () => request(Api.urls.taxonomy));
        const nodes = library.nodes || [];
        if (!ui.selection) {
          const { state } = await readStartupState(ui.startupId);
          ui.selection = Array.isArray(state.enabledTaxonomy?.enabled) ? new Set(state.enabledTaxonomy.enabled) : recommendedSelection(nodes);
        }
        const search = h("input", { type: "search", placeholder: t("setup.track.search"), "aria-label": t("setup.track.search") });
        const counter = h("p", { className: "setup-counter", role: "status" });
        const treeHolder = h("div", { className: "setup-tree" });
        const countText = () => {
          const { on, total } = countOn(ui.selection, nodes, section);
          counter.textContent = t("setup.track.counter", { on, total });
        };
        const drawTree = () => {
          const query = search.value.trim().toLowerCase();
          const matches = (entry) => !query || `${entry.node.name} ${entry.node.description || ""}`.toLowerCase().includes(query) || entry.children.some(matches);
          const branch = (entry) => {
            if (!matches(entry)) return null;
            const box = h("input", { type: "checkbox", checked: ui.selection.has(entry.node.id), "aria-describedby": `setup-desc-${entry.node.id.replace(/\W/g, "-")}` });
            box.addEventListener("change", () => {
              ui.selection = setBranch(ui.selection, nodes, entry.node.id, box.checked);
              drawTree();
            });
            const kids = entry.children.map(branch).filter(Boolean);
            const allNone = entry.children.length ? h("span", { className: "setup-branch-actions" }, [
              h("button", { type: "button", className: "text-button", text: t("setup.track.all"), on: { click: () => { ui.selection = setBranch(ui.selection, nodes, entry.node.id, true); drawTree(); } } }),
              h("button", { type: "button", className: "text-button", text: t("setup.track.none"), on: { click: () => { ui.selection = setBranch(ui.selection, nodes, entry.node.id, false); drawTree(); } } }),
            ]) : null;
            return h("li", { className: `setup-node setup-node-${entry.node.level}` }, [
              h("div", { className: "setup-node-row" }, [
                h("label", {}, [box, h("span", { className: "setup-node-name", text: entry.node.name })]),
                entry.node.recommended ? h("span", { className: "setup-recommended", text: t("setup.track.recommended") }) : null,
                allNone,
              ]),
              entry.node.description ? h("p", { className: "setup-node-description", id: `setup-desc-${entry.node.id.replace(/\W/g, "-")}`, text: entry.node.description }) : null,
              kids.length ? h("ul", {}, kids) : null,
            ]);
          };
          treeHolder.replaceChildren(h("ul", { className: "setup-tree-root" }, sectionTree(nodes, section).map(branch).filter(Boolean)));
          countText();
        };
        search.addEventListener("input", drawTree);
        drawTree();
        const everything = h("button", {
          type: "button",
          className: "secondary-button compact",
          text: t("setup.track.everything"),
          on: { click: () => {
            for (const node of nodes) if (node.section === section) ui.selection.add(node.id);
            drawTree();
          } },
        });
        const parts = {
          notice: h("p", { className: "setup-notice", role: "note", text: t("setup.track.notice") }),
          everything,
          search: h("div", { className: "setup-row" }, [search, counter]),
          tree: treeHolder,
        };
        return {
          title: t(`setup.track.title.${section}`),
          intro: t("setup.track.intro"),
          body: TRACK_PARTS.map((part) => parts[part]),
          save: async () => {
            await writeSections(ui.startupId, { enabledTaxonomy: { enabled: [...ui.selection] } });
          },
          // Skip keeps the recommended selection for this section.
          skip: async () => {
            ui.selection = skipSection(ui.selection, nodes, section);
            await writeSections(ui.startupId, { enabledTaxonomy: { enabled: [...ui.selection] } });
          },
        };
      };
    }

    // ---- drawing and moving ----

    let current = null;

    async function show(step) {
      ui.step = step;
      ui.error = "";
      dialog.replaceChildren(h("div", { className: "setup-loading", role: "status", text: t("setup.loading") }));
      try {
        current = await builders[step]();
      } catch (error) {
        current = { title: t("setup.failedTitle"), intro: error.message, body: [] };
      }
      draw();
      remember({ step, open: true });
    }

    function draw() {
      const info = progress(ui.mode, ui.step);
      const error = h("p", { className: "setup-error", role: "alert", text: ui.error });
      const next = h("button", {
        type: "button",
        className: "primary-button",
        text: ui.step === "welcome" ? t("setup.start") : info.last ? t("setup.finish") : t("setup.next"),
        on: { click: () => go(1) },
      });
      dialog.replaceChildren(h("div", { className: "setup-shell" }, [
        h("header", { className: "setup-header" }, [
          h("div", { className: "setup-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": info.percent, "aria-label": t("setup.progress", { step: info.index + 1, total: info.total }) }, h("span", { style: `width: ${info.percent}%` })),
          h("p", { className: "setup-step-name", text: t("setup.progress", { step: info.index + 1, total: info.total }) + ` · ${t(`setup.steps.${ui.step}`)}` }),
          h("button", { type: "button", className: "setup-close", "aria-label": t("setup.close"), text: "×", on: { click: () => close() } }),
        ]),
        h("main", { className: "setup-body" }, [
          h("h2", { id: "setupWizardTitle", text: current.title }),
          current.intro ? h("p", { className: "setup-intro", text: current.intro }) : null,
          ...(Array.isArray(current.body) ? current.body : [current.body]),
          error,
        ]),
        h("footer", { className: "setup-footer" }, [
          info.first ? h("span") : h("button", { type: "button", className: "secondary-button", text: t("setup.back"), on: { click: () => go(-1) } }),
          h("span", { className: "setup-spacer" }),
          canSkip(ui.step) && !info.last ? h("button", { type: "button", className: "text-button", text: t("setup.skip"), on: { click: () => skip() } }) : null,
          info.last && ui.mode === "full" ? null : next,
        ]),
      ]));
      const first = dialog.querySelector(".setup-body input, .setup-body select, .setup-body textarea, .setup-footer .primary-button");
      first?.focus();
    }

    // One action at a time: the footer and the Done buttons wait for it.
    function setBusy(busy) {
      ui.busy = busy;
      dialog.setAttribute("aria-busy", busy ? "true" : "false");
      dialog.querySelectorAll(".setup-footer button, .setup-done-actions button").forEach((button) => {
        button.disabled = busy;
      });
    }

    async function act(task) {
      if (ui.busy) return;
      setBusy(true);
      try {
        await task();
      } catch (error) {
        ui.error = error.message;
        draw();
      } finally {
        setBusy(false);
      }
    }

    function go(direction) {
      return act(async () => {
        if (direction > 0) {
          const empty = missing(ui.step, ui.values[ui.step]?.());
          if (empty.length) throw new Error(t(`setup.required.${empty[0]}`));
          if (current?.save) await current.save();
          ui.skipped.delete(ui.step);
          remember({ skipped: [...ui.skipped] });
          if (progress(ui.mode, ui.step).last) {
            finish(ui.startupId);
            return;
          }
          // Steps after the startup step need a startup.
          if (!ui.startupId && stepsFor(ui.mode).indexOf(neighbour(ui.mode, ui.step, 1)) > stepsFor(ui.mode).indexOf("startup")) throw new Error(t("setup.required.name"));
        }
        const target = neighbour(ui.mode, ui.step, direction);
        if (target === "done") await remember({ completed: ui.mode === "full" ? true : undefined });
        await show(target);
      });
    }

    function skip() {
      return act(async () => {
        if (current?.skip) await current.skip();
        ui.skipped.add(ui.step);
        await remember({ skipped: [...ui.skipped] });
        const target = neighbour(ui.mode, ui.step, 1);
        if (target === "done" && ui.mode === "full") await remember({ completed: true });
        await show(target);
      });
    }

    function close() {
      remember({ open: false });
      dialog.close();
      dialog.remove();
      previewIdentity(root.StartupTrackerStartups?.current?.()?.name || "", root.StartupTrackerStartups?.current?.()?.icon || "");
      options.onClose?.();
    }

    function finish(startupId) {
      remember({ open: false, completed: ui.mode === "full" ? true : undefined });
      dialog.close();
      dialog.remove();
      options.onFinish?.(startupId);
      if (startupId && startupId !== Api.startupId) root.location.assign(Api.pageUrl(startupId));
      else root.location.reload();
    }

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.showModal();
    await show(ui.step);
    return { close };
  }

  // The sidebar badge: shown while the setup is not finished; it opens the
  // setup again where it stopped. The setup opens by itself on a page load
  // when it was still on screen.
  async function watchBadge() {
    const badge = root.document.querySelector("#finishSetupButton");
    let info;
    try {
      info = await request(Api.urls.setup);
    } catch {
      return null;
    }
    const setup = info.setup;
    const state = badgeState(setup);
    if (badge) {
      badge.hidden = state.hidden;
      badge.onclick = () => open({ mode: "full" });
    }
    if (state.autoOpen) open({ mode: "full" });
    return setup;
  }

  return Object.freeze({ ...pure, open, watchBadge });
});
