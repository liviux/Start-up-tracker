// Extra > Fields: your own fields for MK, PO and FU targets
// (window.StartupTrackerFieldsEditor).
//
// The definitions are shared by every startup and saved with PUT
// /api/fields/custom; each target keeps its values under `custom` and shows
// them in the target window's Extras tab. Deleting a field keeps the values on
// the targets, listed under "Other fields", so adding the field back with the
// same key brings them back.
(function () {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);

  const Fields = window.StartupTrackerFields;
  const Api = window.StartupTrackerApi;
  if (!Fields) {
    console.error("fields-editor.js needs fields.js first.");
    return;
  }
  const SECTION_LABELS = { get mk() { return t("ui.common.marketing"); }, get po() { return t("fieldsEditor.sectionLabels.programs"); }, get fu() { return t("ui.common.funding"); } };
  const TYPE_LABELS = {
    get text() { return t("fieldsEditor.typeLabels.shortText"); },
    get textarea() { return t("fieldsEditor.typeLabels.longText"); },
    get number() { return t("fieldsEditor.typeLabels.number"); },
    get money() { return t("fieldsEditor.typeLabels.amountAndCurrency"); },
    get percent() { return t("fieldsEditor.typeLabels.percent"); },
    get date() { return t("fieldsEditor.typeLabels.date"); },
    get datetime() { return t("fieldsEditor.typeLabels.dateAndTime"); },
    get url() { return t("ui.common.link"); },
    get email() { return t("fieldsEditor.typeLabels.email"); },
    get select() { return t("fieldsEditor.typeLabels.oneChoiceFromAList"); },
    get multiselect() { return t("fieldsEditor.typeLabels.severalChoicesFromAList"); },
    get tristate() { return t("fieldsEditor.typeLabels.yesNoOrUnknown"); },
    get person() { return t("fieldsEditor.typeLabels.person"); },
  };

  const view = { section: "mk", editing: "", status: "", statusKind: "", list: [] };
  let root = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "on") Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
      else if (key in node && typeof value !== "string") node[key] = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  async function load() {
    const response = await fetch(Api?.urls?.fields || "/api/fields", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    view.list = Array.isArray(payload.custom) ? payload.custom : [];
    Fields.setCustomFields(view.list);
  }

  async function save(list, message) {
    const response = await fetch(Api?.urls?.customFields || "/api/fields/custom", {
      method: "PUT",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: list, origin: "ui" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    view.list = payload.custom;
    Fields.setCustomFields(view.list);
    view.editing = "";
    setStatus(message, "ok");
  }

  function setStatus(text, kind = "") {
    view.status = text;
    view.statusKind = kind;
  }

  function sectionTabs() {
    return el("div", { className: "fields-editor-tabs", role: "tablist", "aria-label": t("fieldsEditor.sectionTabs.section") }, Fields.SECTIONS.map((section) => el("button", {
      type: "button",
      role: "tab",
      className: `fields-editor-tab${view.section === section ? " active" : ""}`,
      "aria-selected": String(view.section === section),
      dataset: { section },
      on: { click: () => {
        view.section = section;
        view.editing = "";
        draw();
      } },
    }, [el("span", { className: "section-dot", "aria-hidden": "true" }), ` ${SECTION_LABELS[section]}`])));
  }

  function optionsText(definition) {
    return (definition?.options || []).map((option) => (option.description ? `${option.label} | ${option.description}` : option.label)).join("\n");
  }

  function parseOptions(text) {
    return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [label, ...rest] = line.split("|");
      const clean = label.trim();
      return { value: clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || clean, label: clean, description: rest.join("|").trim() };
    });
  }

  function form(definition) {
    const isNew = !definition;
    const current = definition || { section: view.section, type: "text", label: "", description: "", example: "", group: "", options: [] };
    const label = el("input", { type: "text", name: "label", required: true, maxLength: 80, value: current.label, placeholder: t("fieldsEditor.form.eGPartnerTier") });
    const type = el("select", { name: "type" }, Fields.CUSTOM_TYPES.map((entry) => el("option", { value: entry, text: TYPE_LABELS[entry] || entry, selected: entry === current.type })));
    const description = el("textarea", { name: "description", rows: 2, maxLength: 400, placeholder: t("fieldsEditor.form.eGHowImportantThis") });
    description.value = current.description || "";
    const example = el("input", { type: "text", name: "example", maxLength: 120, value: current.example || "", placeholder: t("fieldsEditor.form.eGGold") });
    const group = el("input", { type: "text", name: "group", maxLength: 60, value: current.group || "", placeholder: t("fieldsEditor.form.eGPartnership") });
    const options = el("textarea", { name: "options", rows: 4, placeholder: t("fieldsEditor.form.oneChoicePerLineAdd") });
    options.value = optionsText(current);
    const optionsRow = el("label", { className: "fields-editor-options" }, [el("span", { className: "label-title", text: t("fieldsEditor.form.choices") }), options]);
    const syncOptions = () => {
      optionsRow.hidden = !["select", "multiselect"].includes(type.value);
    };
    type.addEventListener("change", syncOptions);
    syncOptions();
    const submit = async (event) => {
      event.preventDefault();
      const next = {
        id: current.id,
        key: current.key,
        section: current.section,
        label: label.value,
        type: type.value,
        description: description.value,
        example: example.value,
        group: group.value,
        options: parseOptions(options.value),
      };
      try {
        Fields.validateCustomField(next, view.list);
        const list = isNew ? [...view.list, next] : view.list.map((entry) => (entry.id === current.id ? next : entry));
        await save(list, isNew ? t("fieldsEditor.form.added", { value: next.label.trim() }) : t("fieldsEditor.form.saved", { value: next.label.trim() }));
      } catch (error) {
        setStatus(error.message, "error");
      }
      draw();
    };
    return el("form", { className: "fields-editor-form", on: { submit } }, [
      el("div", { className: "fields-editor-grid" }, [
        el("label", {}, [el("span", { className: "label-title", text: t("fieldsEditor.form.label") }), label]),
        el("label", {}, [el("span", { className: "label-title", text: t("fieldsEditor.form.type") }), type]),
        el("label", { className: "wide" }, [el("span", { className: "label-title", text: t("fieldsEditor.form.helpText") }), description, el("span", { className: "settings-hint", text: t("fieldsEditor.form.shownUnderTheFieldIn") })]),
        el("label", {}, [el("span", { className: "label-title", text: t("fieldsEditor.form.example") }), example, el("span", { className: "settings-hint", text: t("fieldsEditor.form.shownAsAPlaceholderNever") })]),
        el("label", {}, [el("span", { className: "label-title", text: t("fieldsEditor.form.group") }), group]),
        optionsRow,
      ]),
      isNew ? null : el("p", { className: "settings-hint", text: t("fieldsEditor.form.keyValuesAreStoredUnder", { key: current.key }) }),
      el("div", { className: "settings-row-actions" }, [
        el("button", { type: "submit", className: t("fieldsEditor.form.primaryButtonCompact"), text: isNew ? t("fieldsEditor.form.addField") : t("fieldsEditor.form.saveField") }),
        el("button", { type: "button", className: "secondary-button compact", text: t("fieldsEditor.form.cancel"), on: { click: () => {
          view.editing = "";
          draw();
        } } }),
      ]),
    ]);
  }

  function row(definition) {
    if (view.editing === definition.id) return el("li", { className: "fields-editor-item is-editing" }, [form(definition)]);
    return el("li", { className: "fields-editor-item" }, [
      el("div", {}, [
        el("strong", { text: definition.label }),
        el("span", { className: "fields-editor-meta", text: ` ${TYPE_LABELS[definition.type] || definition.type}${definition.group ? ` · ${definition.group}` : ""}` }),
        definition.description ? el("p", { className: "settings-hint", text: definition.description }) : null,
      ]),
      el("div", { className: "settings-row-actions" }, [
        el("button", { type: "button", className: "secondary-button compact", text: t("fieldsEditor.row.edit"), "aria-label": t("fieldsEditor.row.edit2", { label: definition.label }), on: { click: () => {
          view.editing = definition.id;
          draw();
        } } }),
        el("button", { type: "button", className: "danger-button compact", text: t("fieldsEditor.row.delete"), "aria-label": t("fieldsEditor.row.delete2", { label: definition.label }), on: { click: async () => {
          if (!window.confirm(t("fieldsEditor.row.deleteConfirm", { label: definition.label }))) return;
          try {
            await save(view.list.filter((entry) => entry.id !== definition.id), t("fieldsEditor.row.deleted", { label: definition.label }));
          } catch (error) {
            setStatus(error.message, "error");
          }
          draw();
        } } }),
      ]),
    ]);
  }

  function draw() {
    if (!root) return;
    const mine = view.list.filter((definition) => definition.section === view.section);
    root.replaceChildren(
      el("p", { className: "fields-editor-intro", text: t("fieldsEditor.draw.fieldsOfYourOwnFor") }),
      sectionTabs(),
      view.status ? el("p", { className: `fields-editor-status is-${view.statusKind || "info"}`, role: "status", text: view.status }) : el("p", { className: "fields-editor-status", role: "status" }),
      mine.length ? el("ul", { className: "fields-editor-list" }, mine.map(row)) : el("p", { className: "empty-text", text: t("fieldsEditor.draw.noFieldsOfYourOwn", { value: SECTION_LABELS[view.section] }) }),
      view.editing === "new" ? form(null) : el("button", { type: "button", className: "primary-button compact", text: t("fieldsEditor.draw.addAField", { value: SECTION_LABELS[view.section] }), on: { click: () => {
        view.editing = "new";
        setStatus("");
        draw();
      } } }),
    );
  }

  async function render(container) {
    root = container;
    if (!root) return;
    try {
      await load();
    } catch (error) {
      setStatus(t("fieldsEditor.render.couldNotReadTheFields", { message: error.message }), "error");
    }
    draw();
  }

  window.StartupTrackerFieldsEditor = Object.freeze({ render, parseOptions });
})();
