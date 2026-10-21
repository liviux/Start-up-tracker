// The target window: one window for every target in MK, PO and FU
// (window.StartupTrackerRecordWindow), drawn from the field registry
// (js/fields.js).
//
// Six tabs, the same in every section:
//   Overview  the header, the link, the rendered notes and "All details"
//   Edit      quick status and priority, the Markdown notes with a preview
//   Details   the core fields, the section's field groups, then the activity
//             (milestones, the update log, documents, commitments, payments)
//   Links     the record's links (js/links-model.js) and "Create linked..."
//   Extras    custom fields, and "Other fields": keys no field claims
//   History   the record's timeline
//
// The window edits a copy of the record. Save hands the copy to the page
// (hooks.save), which stores it like any other edit; Cancel, Esc or the close
// button drop it after asking when something changed. A draft (a target not
// saved yet) is created on its first Save.
//
// What can be tested without a browser is exported on its own: the tab ids,
// the change check and the update log rule.
//
// UMD: browsers get window.StartupTrackerRecordWindow, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerRecordWindow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);
  // A translated string inside HTML: the text is escaped, the parameters go
  // in as given (they are HTML already).
  const tHtml = (key, params) => escapeHtml(t(key)).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match));

  const Fields = root.StartupTrackerFields || (typeof module === "object" ? module.require("./fields.js") : null);

  const TABS = Object.freeze([
    { id: "overview", get label() { return t("recordWindow.tabs.overview"); } },
    { id: "edit", get label() { return t("recordWindow.tabs.edit"); } },
    { id: "details", get label() { return t("recordWindow.tabs.details"); } },
    { id: "links", get label() { return t("ui.common.links"); } },
    { id: "extras", get label() { return t("recordWindow.tabs.extras"); } },
    { id: "history", get label() { return t("recordWindow.tabs.history"); } },
  ]);
  const TAB_IDS = Object.freeze(TABS.map((tab) => tab.id));
  const SECTION_LABELS = Object.freeze({ get mk() { return t("ui.common.marketing"); }, get po() { return t("recordWindow.sectionLabels.programs"); }, get fu() { return t("ui.common.funding"); } });
  const PRIORITIES = Object.freeze(["Very High", "High", "Medium", "Low", "Very Low"]);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  // ---- what can be tested -----------------------------------------------------

  function everyField(section) {
    return [
      ...Fields.coreFields(section),
      Fields.findField(section, "notes"),
      ...Fields.detailGroups(section).flatMap((group) => group.fields),
      ...Fields.customFields(section),
    ].filter(Boolean);
  }

  // Whether the copy differs from the record it was opened with. Each field is
  // compared as the window reads it, so opening a record and touching nothing
  // never counts as a change, even when the stored value is written another way.
  function changedFields(section, original, work) {
    const changed = [];
    for (const field of everyField(section)) {
      if (stable(Fields.getValue(section, original, field)) !== stable(Fields.getValue(section, work, field))) changed.push(field.key);
    }
    for (const activity of Fields.activities(section)) {
      const collection = Fields.activityStorage(activity).collection;
      if (stable(original?.[collection] || []) !== stable(work?.[collection] || [])) changed.push(collection);
    }
    if (stable(Fields.otherFields(section, original)) !== stable(Fields.otherFields(section, work))) changed.push("otherFields");
    return changed;
  }

  function isDirty(section, original, work) {
    return changedFields(section, original, work).length > 0;
  }

  // A new update log entry also moves the target on: its status, and its next
  // action when the entry names one.
  function applyUpdateLogEntry(section, work, values) {
    const field = (key) => Fields.findField(section, key);
    if (values.statusAfter) Fields.setValue(section, work, field("status"), values.statusAfter);
    if (values.nextAction) Fields.setValue(section, work, field("nextAction"), values.nextAction);
    if (values.nextActionDate) Fields.setValue(section, work, field("nextActionDate"), values.nextActionDate);
    return work;
  }

  function nameOf(section, record) {
    return Fields.getValue(section, record, Fields.findField(section, "name") || { key: "name", type: "text", group: "core" }) || "";
  }

  // ---- the window -----------------------------------------------------------------

  let hooks = {};
  let overlay = null;
  let current = null;

  // Sets the page's hooks and builds the window, so its panes exist before
  // the page binds anything to them.
  function configure(nextHooks) {
    hooks = { ...hooks, ...nextHooks };
    if (root.document?.getElementById("recordWindow")) ensureOverlay();
  }

  function field(section, key) {
    return Fields.findField(section, key);
  }

  function value(key) {
    const definition = field(current.section, key);
    return definition ? Fields.getValue(current.section, current.work, definition) : undefined;
  }

  function helpers() {
    return {
      formatDate: hooks.formatDate,
      formatDateTime: hooks.formatDateTime,
      formatNumber: hooks.formatNumber,
      label: (definition, entry) => {
        if (definition.type === "status") return hooks.statusLabel ? hooks.statusLabel(entry) : entry;
        if (definition.type === "campaign") return hooks.campaignName ? hooks.campaignName(entry) : entry;
        if (definition.type === "round") return hooks.roundName ? hooks.roundName(entry) : entry;
        if (definition.type === "taxonomy") return hooks.taxonomyLabel ? hooks.taxonomyLabel(entry) : entry.join(", ");
        return undefined;
      },
    };
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = root.document.getElementById("recordWindow");
    overlay.innerHTML = `
      <div class="modal-card record-window-card" role="dialog" aria-modal="true" aria-labelledby="recordWindowTitle">
        <div class="modal-header record-window-header">
          <div class="record-window-heading">
            <span class="section-chip" data-rw-section></span>
            <h2 id="recordWindowTitle"></h2>
          </div>
          <div class="record-window-header-actions">
            <button class="secondary-button compact" type="button" data-rw-show-in-list>${escapeHtml(t("recordWindow.ensureOverlay.showInList"))}</button>
            <button class="close-modal-btn" type="button" data-rw-close aria-label="${escapeHtml(t("recordWindow.ensureOverlay.close"))}">
              <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="record-window-tabs" role="tablist" aria-label="${escapeHtml(t("recordWindow.ensureOverlay.target"))}">
          ${TABS.map((tab) => `<button type="button" role="tab" class="record-window-tab" id="recordWindowTab-${tab.id}" data-rw-tab="${tab.id}" aria-controls="recordWindowPane-${tab.id}" aria-selected="false" tabindex="-1">${tab.label}</button>`).join("")}
        </div>
        <div class="modal-body record-window-body">
          ${TABS.map((tab) => `<section class="record-window-pane" role="tabpanel" id="recordWindowPane-${tab.id}" data-rw-pane="${tab.id}" aria-labelledby="recordWindowTab-${tab.id}" hidden></section>`).join("")}
        </div>
        <div class="modal-footer record-window-footer">
          <button class="danger-button" type="button" data-rw-delete>${escapeHtml(t("recordWindow.ensureOverlay.moveToRecycleBin"))}</button>
          <span class="record-window-state" data-rw-state aria-live="polite"></span>
          <button class="secondary-button" type="button" data-rw-cancel>${escapeHtml(t("recordWindow.ensureOverlay.cancel"))}</button>
          <button class="primary-button" type="button" data-rw-save>${escapeHtml(t("recordWindow.ensureOverlay.save"))}</button>
        </div>
      </div>`;
    overlay.addEventListener("click", onClick);
    overlay.addEventListener("input", onEdit);
    overlay.addEventListener("change", onEdit);
    overlay.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) requestClose();
    });
    return overlay;
  }

  function q(selector) {
    return overlay.querySelector(selector);
  }

  // Opens a record. `record` null with `draft` opens an unsaved target filled
  // from `draft` (the add form's values).
  function open({ section, record = null, draft = null, tab = "overview" }) {
    if (!Fields.SECTIONS.includes(section)) throw new Error(t("recordWindow.open.unknownSection", { section }));
    if (current && !requestClose()) return false;
    ensureOverlay();
    const isDraft = !record;
    const base = isDraft ? { id: hooks.newId ? hooks.newId() : `draft-${Date.now()}`, ...(draft || {}) } : record;
    current = {
      section,
      draft: isDraft,
      original: clone(base),
      work: clone(base),
      tab: TAB_IDS.includes(tab) ? tab : "overview",
      editing: {},
      taxonomyPicker: null,
    };
    q("[data-rw-section]").textContent = SECTION_LABELS[section];
    q("[data-rw-section]").dataset.section = section;
    overlay.querySelector(".record-window-card").dataset.section = section;
    q("[data-rw-delete]").hidden = isDraft;
    q("[data-rw-show-in-list]").hidden = isDraft || !hooks.showInList;
    renderTitle();
    overlay.hidden = false;
    void overlay.offsetHeight;
    overlay.classList.add("open");
    selectTab(current.tab, { focus: false });
    q(`[data-rw-tab="${current.tab}"]`)?.focus();
    return true;
  }

  function renderTitle() {
    const name = nameOf(current.section, current.work);
    q("#recordWindowTitle").textContent = current.draft ? (name ? t("recordWindow.renderTitle.new", { name }) : t("recordWindow.renderTitle.newTarget")) : (name || t("recordWindow.renderTitle.untitledTarget"));
    updateState();
  }

  function updateState() {
    if (!current) return;
    const dirty = current.draft || isDirty(current.section, current.original, current.work);
    q("[data-rw-state]").textContent = current.draft ? t("recordWindow.updateState.notSavedYet") : dirty ? t("recordWindow.updateState.unsavedChanges") : "";
    q("[data-rw-save]").textContent = current.draft ? t("ui.common.addTarget") : t("recordWindow.updateState.save");
  }

  function selectTab(tabId, { focus = true } = {}) {
    current.tab = tabId;
    for (const tab of TAB_IDS) {
      const button = q(`[data-rw-tab="${tab}"]`);
      const pane = q(`[data-rw-pane="${tab}"]`);
      const active = tab === tabId;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle("active", active);
      pane.hidden = !active;
      // Status and priority show in two tabs; only the open tab holds controls.
      if (!active) pane.innerHTML = "";
    }
    renderPane(tabId);
    q(".record-window-body").scrollTop = 0;
    if (focus) q(`[data-rw-tab="${tabId}"]`)?.focus();
  }

  function renderPane(tabId) {
    const pane = q(`[data-rw-pane="${tabId}"]`);
    if (tabId === "overview") pane.innerHTML = overviewHtml();
    else if (tabId === "edit") renderEdit(pane);
    else if (tabId === "details") renderDetails(pane);
    else if (tabId === "links") renderLinks(pane);
    else if (tabId === "extras") renderExtras(pane);
    else if (tabId === "history") renderHistory(pane);
  }

  // ---- Overview ---------------------------------------------------------------------

  function fieldText(definition, entry) {
    return Fields.formatValue(definition, entry, helpers());
  }

  function overviewHtml() {
    const { section, work } = current;
    const status = value("status");
    const link = value("link");
    const facts = ["priority", "nextActionDate", "nextAction", "deadline", "organization", "owner", "campaignId"]
      .map((key) => field(section, key))
      .filter(Boolean)
      .map((definition) => {
        let text = fieldText(definition, Fields.getValue(section, work, definition));
        if (definition.key === "nextActionDate" && text && value("nextActionTime")) text += ` ${value("nextActionTime")}`;
        return text ? `<div class="record-window-fact"><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(text)}</strong></div>` : "";
      })
      .join("");
    const notes = value("notes");
    return `
      <div class="record-window-overview">
        <div class="record-window-summary">
          ${status && hooks.statusBadgeHtml ? hooks.statusBadgeHtml(status) : ""}
          ${hooks.taxonomyLabel && (work.taxonomy || []).length ? `<span class="record-window-path">${escapeHtml(hooks.taxonomyLabel(work.taxonomy.slice(0, 1)))}</span>` : ""}
        </div>
        ${facts ? `<div class="record-window-facts">${facts}</div>` : ""}
        ${link ? `<a class="record-window-link-banner" href="${escapeHtml(link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(link)}</a>` : ""}
        <div class="markdown-rendered record-window-notes">${notes ? (hooks.renderMarkdown ? hooks.renderMarkdown(notes) : escapeHtml(notes)) : `<p class="empty-text">${escapeHtml(t("recordWindow.overviewHtml.noNotesYetWriteThem"))}</p>`}</div>
        <h3 class="record-window-subheading">${escapeHtml(t("recordWindow.overviewHtml.allDetails"))}</h3>
        ${allDetailsHtml()}
      </div>`;
  }

  function definitionList(rows) {
    const filled = rows.filter((row) => row[1]);
    if (!filled.length) return "";
    return `<dl class="record-window-dl">${filled.map(([label, text]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd>`).join("")}</dl>`;
  }

  function allDetailsHtml() {
    const { section, work } = current;
    const blocks = [];
    const core = definitionList(Fields.coreFields(section)
      .filter((definition) => !["id", "name", "notes"].includes(definition.key))
      .map((definition) => [definition.label, fieldText(definition, Fields.getValue(section, work, definition))]));
    if (core) blocks.push(`<section><h4>${escapeHtml(t("recordWindow.allDetailsHtml.basics"))}</h4>${core}</section>`);
    for (const group of Fields.detailGroups(section)) {
      const list = definitionList(group.fields.map((definition) => [definition.label, fieldText(definition, Fields.getValue(section, work, definition))]));
      if (list) blocks.push(`<section><h4>${escapeHtml(group.label)}</h4>${list}</section>`);
    }
    const custom = definitionList(Fields.customFields(section).map((definition) => [definition.label, fieldText(definition, Fields.getValue(section, work, definition))]));
    if (custom) blocks.push(`<section><h4>${escapeHtml(t("ui.common.yourFields"))}</h4>${custom}</section>`);
    for (const activity of Fields.activities(section)) {
      const entries = Fields.activityEntries(work, activity);
      if (activity.checklist) {
        const rows = entries.filter((entry) => entry.status && entry.status !== "Unknown").map((entry) => [documentLabel(activity, entry.id), fieldText(activity.fields[0], Fields.readEntryValue(activity, activity.fields[0], entry))]);
        const list = definitionList(rows);
        if (list) blocks.push(`<section><h4>${escapeHtml(activity.label)}</h4>${list}</section>`);
      } else if (entries.length) {
        blocks.push(`<section><h4>${escapeHtml(activity.label)}</h4><ul class="record-window-entries">${entries.map((entry) => `<li>${escapeHtml(entrySummary(activity, entry))}</li>`).join("")}</ul></section>`);
      }
    }
    const linked = hooks.linkedSummary && !current.draft ? hooks.linkedSummary(section, work.id) : [];
    if (linked.length) blocks.push(`<section><h4>${escapeHtml(t("ui.common.links"))}</h4><ul class="record-window-entries">${linked.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>`);
    const changed = [work.createdAt ? t("recordWindow.allDetailsHtml.created", { value: hooks.formatDateTime ? hooks.formatDateTime(work.createdAt) : work.createdAt }) : "", work.updatedAt ? t("recordWindow.allDetailsHtml.lastChanged", { value: hooks.formatDateTime ? hooks.formatDateTime(work.updatedAt) : work.updatedAt }) : ""].filter(Boolean).join(", ");
    if (changed) blocks.push(`<p class="record-window-history-summary">${tHtml("recordWindow.historySummary", { changes: escapeHtml(changed) })}</p>`);
    return blocks.length ? `<div class="record-window-all-details">${blocks.join("")}</div>` : `<p class="empty-text">${escapeHtml(t("recordWindow.allDetailsHtml.nothingFilledInYetThe"))}</p>`;
  }

  function entrySummary(activity, entry) {
    return (activity.fields || [])
      .map((definition) => fieldText(definition, Fields.readEntryValue(activity, definition, entry)))
      .filter(Boolean)
      .join(" · ");
  }

  function documentLabel(activity, id) {
    const known = (activity.checklist || []).find((entry) => entry.id === id);
    if (known) return known.label;
    const text = String(id || "").replace(/[-_]+/g, " ").trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : t("recordWindow.documentLabel.document");
  }

  // ---- Edit -------------------------------------------------------------------------

  function renderEdit(pane) {
    const { section } = current;
    pane.innerHTML = `
      <div class="record-window-quick">
        ${fieldRowHtml(field(section, "status"))}
        ${fieldRowHtml(field(section, "priority"))}
      </div>
      <div class="record-window-editor">
        <label class="record-window-notes-input">
          <span class="label-title">${escapeHtml(t("recordWindow.renderEdit.notes"))}</span>
          <textarea data-rw-notes rows="14" placeholder="${escapeHtml(t("recordWindow.renderEdit.writeInMarkdownBoldLists"))}">${escapeHtml(value("notes"))}</textarea>
        </label>
        <div class="record-window-preview">
          <span class="label-title">${escapeHtml(t("recordWindow.renderEdit.preview"))}</span>
          <div class="markdown-rendered" data-rw-notes-preview></div>
        </div>
      </div>`;
    updateNotesPreview();
  }

  function updateNotesPreview() {
    const preview = q("[data-rw-notes-preview]");
    if (!preview) return;
    const notes = value("notes");
    preview.innerHTML = notes ? (hooks.renderMarkdown ? hooks.renderMarkdown(notes) : escapeHtml(notes)) : `<p class="empty-text">${escapeHtml(t("recordWindow.updateNotesPreview.thePreviewShowsHere"))}</p>`;
  }

  // ---- Details ------------------------------------------------------------------------

  // One field with its label, its help (always shown in this window) and a
  // suggested value, which is saved only once "Use" is pressed.
  function fieldRowHtml(definition, { prefix = "rw-" } = {}) {
    if (!definition) return "";
    const { section, work } = current;
    const id = `${prefix}${definition.key}`;
    const helpId = `${id}-help`;
    const entry = Fields.getValue(section, work, definition);
    let control;
    switch (definition.type) {
      case "readonly-id":
        control = `<div class="field-control field-control-id" data-field="id"><input type="text" id="${escapeHtml(id)}" value="${escapeHtml(current.draft ? t("recordWindow.fieldRowHtml.givenWhenSaved") : work.id)}" readonly aria-describedby="${helpId}"><button type="button" class="icon-button" data-rw-copy-id title="${escapeHtml(t("recordWindow.fieldRowHtml.copyId"))}" aria-label="${escapeHtml(t("recordWindow.fieldRowHtml.copyId"))}"${current.draft ? " disabled" : ""}>⧉</button></div>`;
        break;
      case "taxonomy":
        control = `<div class="field-control field-control-taxonomy" data-field="taxonomy"><div data-rw-taxonomy aria-labelledby="${escapeHtml(id)}-label"></div></div>`;
        break;
      case "status":
        control = `<div class="field-control" data-field="${escapeHtml(definition.key)}"><select id="${escapeHtml(id)}" data-field-input="${escapeHtml(definition.key)}" aria-describedby="${helpId}">${hooks.statusOptionsHtml ? hooks.statusOptionsHtml(entry) : `<option>${escapeHtml(entry)}</option>`}</select></div>`;
        break;
      case "priority":
        control = `<div class="field-control" data-field="priority"><select id="${escapeHtml(id)}" data-field-input="priority" aria-describedby="${helpId}">${PRIORITIES.map((priority) => `<option value="${priority}"${priority === (entry || "Medium") ? " selected" : ""}>${priority}</option>`).join("")}</select></div>`;
        break;
      case "campaign":
      case "round": {
        const options = (definition.type === "campaign" ? hooks.campaignOptions : hooks.roundOptions)?.() || [];
        control = `<div class="field-control" data-field="${escapeHtml(definition.key)}"><select id="${escapeHtml(id)}" data-field-input="${escapeHtml(definition.key)}" aria-describedby="${helpId}"><option value="">${definition.type === "campaign" ? t("recordWindow.fieldRowHtml.noCampaign") : t("recordWindow.fieldRowHtml.noRound")}</option>${options.map((option) => `<option value="${escapeHtml(option.id)}"${option.id === entry ? " selected" : ""}>${escapeHtml(option.name)}</option>`).join("")}${entry && !options.some((option) => option.id === entry) ? `<option value="${escapeHtml(entry)}" selected>${tHtml("recordWindow.fieldRowHtml.notFound", { entry: escapeHtml(entry) })}</option>` : ""}</select></div>`;
        break;
      }
      case "tags":
        control = `<div class="field-control" data-field="tags"><input type="text" id="${escapeHtml(id)}" data-field-input="tags" aria-describedby="${helpId}" value="${escapeHtml((entry || []).join(", "))}" placeholder="${escapeHtml(t("recordWindow.fieldRowHtml.eGLaunchPriorityPartner"))}"></div>`;
        break;
      case "repeat":
        control = `<div class="field-control field-control-repeat" data-field="repeat"><span>${escapeHtml(t("recordWindow.fieldRowHtml.every"))}</span><input type="number" min="1" step="1" data-part="interval" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-label" aria-describedby="${helpId}" value="${entry.interval || ""}" placeholder="3"><select data-part="unit" aria-label="${escapeHtml(t("recordWindow.fieldRowHtml.repeatUnit"))}"><option value="">${escapeHtml(t("recordWindow.fieldRowHtml.doesNotRepeat"))}</option>${["days", "weeks", "months"].map((unit) => `<option value="${unit}"${entry.unit === unit ? " selected" : ""}>${unit}</option>`).join("")}</select></div>`;
        break;
      default:
        control = Fields.inputHtml(definition, entry, { idPrefix: prefix, describedBy: helpId, currency: hooks.suggestion ? hooks.suggestion({ key: "currency", suggested: "profile.currency" }) : "" });
    }
    const suggestion = suggestionHtml(definition, entry);
    const labelTag = ["multiselect", "taxonomy", "repeat"].includes(definition.type) ? "span" : "label";
    return `
      <div class="field-row field-row-${escapeHtml(definition.type)}" data-field-row="${escapeHtml(definition.key)}">
        <${labelTag} class="field-label" id="${escapeHtml(id)}-label"${labelTag === "label" ? ` for="${escapeHtml(id)}"` : ""}>${escapeHtml(definition.label)}${definition.validation?.required ? ` <span class="field-required" aria-hidden="true">*</span>` : ""}</${labelTag}>
        ${control}
        ${suggestion}
        ${definition.description ? `<p class="field-help" id="${escapeHtml(helpId)}">${escapeHtml(definition.description)}</p>` : ""}
      </div>`;
  }

  function suggestionHtml(definition, entry) {
    if (!definition.suggested || !hooks.suggestion) return "";
    const suggested = hooks.suggestion(definition);
    if (!suggested) return "";
    const isMoney = definition.type === "money" || definition.type === "money-range";
    const missing = isMoney ? !entry?.currency : Fields.isEmpty(definition, entry);
    if (!missing) return "";
    return `<p class="field-suggestion"><span>${escapeHtml(t("recordWindow.suggestionHtml.suggested"))} <em>${escapeHtml(suggested)}</em></span> <button type="button" class="text-button" data-rw-use-suggestion="${escapeHtml(definition.key)}">${escapeHtml(t("recordWindow.suggestionHtml.use"))}</button></p>`;
  }

  function renderDetails(pane) {
    const { section } = current;
    const core = Fields.coreFields(section).filter((definition) => definition.key !== "notes");
    const groups = Fields.detailGroups(section);
    pane.innerHTML = `
      <section class="record-window-group record-window-core" aria-label="${escapeHtml(t("recordWindow.renderDetails.basics"))}">
        <div class="field-grid">${core.map((definition) => fieldRowHtml(definition)).join("")}</div>
      </section>
      ${groups.map((group) => `
        <details class="record-window-group" data-rw-group="${escapeHtml(group.id)}"${current.openGroups?.has(group.id) ? " open" : ""}>
          <summary><span>${escapeHtml(group.label)}</span>${groupCount(group)}</summary>
          ${group.description ? `<p class="record-window-group-help">${escapeHtml(group.description)}</p>` : ""}
          <div class="field-grid">${group.fields.map((definition) => fieldRowHtml(definition)).join("")}</div>
        </details>`).join("")}
      ${Fields.activities(section).map(activityHtml).join("")}`;
    mountTaxonomy(pane);
  }

  function groupCount(group) {
    const filled = group.fields.filter((definition) => !Fields.isEmpty(definition, Fields.getValue(current.section, current.work, definition))).length;
    return `<span class="record-window-count">${filled ? t("recordWindow.groupCount.ofFilled", { filled, length: group.fields.length }) : t("recordWindow.groupCount.fields", { count: group.fields.length })}</span>`;
  }

  function mountTaxonomy(pane) {
    const holder = pane.querySelector("[data-rw-taxonomy]");
    if (!holder || !hooks.mountTaxonomyPicker) return;
    current.taxonomyPicker = hooks.mountTaxonomyPicker(holder, current.section, current.work.taxonomy || [], (list) => {
      current.work.taxonomy = list;
      if (hooks.applyTaxonomy) hooks.applyTaxonomy(current.work, list, current.section);
      updateState();
    });
  }

  // ---- activity groups ----------------------------------------------------------------

  function activityHtml(activity) {
    const entries = Fields.activityEntries(current.work, activity);
    const open = current.openGroups?.has(activity.id) ? " open" : "";
    if (activity.checklist) return documentsHtml(activity, entries, open);
    const editing = current.editing[activity.id];
    const rows = entries.map((entry, index) => `
      <li class="record-window-entry">
        <span>${escapeHtml(entrySummary(activity, entry)) || t("recordWindow.activityHtml.empty")}</span>
        <span class="record-window-entry-actions">
          <button type="button" class="text-button" data-rw-entry-edit="${escapeHtml(activity.id)}" data-index="${index}">${escapeHtml(t("recordWindow.activityHtml.edit"))}</button>
          <button type="button" class="text-button danger-text" data-rw-entry-remove="${escapeHtml(activity.id)}" data-index="${index}">${escapeHtml(t("recordWindow.activityHtml.remove"))}</button>
        </span>
      </li>`).join("");
    const adding = editing !== undefined;
    const entry = adding && editing >= 0 ? entries[editing] : {};
    const form = adding ? `
      <div class="record-window-entry-form" data-rw-entry-form="${escapeHtml(activity.id)}">
        <div class="field-grid">${activity.fields.map((definition) => entryFieldHtml(activity, definition, entry)).join("")}</div>
        <div class="record-window-entry-buttons">
          <button type="button" class="primary-button compact" data-rw-entry-save="${escapeHtml(activity.id)}">${editing >= 0 ? t("recordWindow.activityHtml.updateEntry") : t("recordWindow.activityHtml.addEntry")}</button>
          <button type="button" class="secondary-button compact" data-rw-entry-cancel="${escapeHtml(activity.id)}">${escapeHtml(t("recordWindow.activityHtml.cancel"))}</button>
        </div>
      </div>` : `<button type="button" class="secondary-button compact" data-rw-entry-add="${escapeHtml(activity.id)}">${activity.id === "updateLog" ? t("recordWindow.activityHtml.logUpdate") : t("ui.common.add")}</button>`;
    return `
      <details class="record-window-group record-window-activity" data-rw-group="${escapeHtml(activity.id)}"${open || adding ? " open" : ""}>
        <summary><span>${escapeHtml(activity.label)}</span><span class="record-window-count">${entries.length || "none"}</span></summary>
        ${activity.description ? `<p class="record-window-group-help">${escapeHtml(activity.description)}</p>` : ""}
        ${rows ? `<ul class="record-window-entries">${rows}</ul>` : ""}
        ${form}
      </details>`;
  }

  function entryFieldHtml(activity, definition, entry) {
    const prefix = `rw-${activity.id}-`;
    const id = `${prefix}${definition.key}`;
    const stored = Fields.readEntryValue(activity, definition, entry);
    let control;
    if (definition.type === "status") {
      control = `<div class="field-control" data-field="${escapeHtml(definition.key)}"><select id="${escapeHtml(id)}" data-field-input="${escapeHtml(definition.key)}"><option value="">${escapeHtml(t("recordWindow.entryFieldHtml.unchanged"))}</option>${hooks.statusOptionsHtml ? hooks.statusOptionsHtml(stored, { includeCurrent: false }) : ""}</select></div>`;
    } else {
      const suggested = definition.suggested && hooks.suggestion ? hooks.suggestion(definition) : "";
      const startValue = Fields.isEmpty(definition, stored) && definition.key === "currency" && suggested ? suggested : stored;
      control = Fields.inputHtml(definition, startValue, { idPrefix: prefix, describedBy: `${id}-help` });
    }
    const labelTag = definition.type === "multiselect" ? "span" : "label";
    return `<div class="field-row" data-field-row="${escapeHtml(definition.key)}">
      <${labelTag} class="field-label"${labelTag === "label" ? ` for="${escapeHtml(id)}"` : ""}>${escapeHtml(definition.label)}${definition.validation?.required ? ` <span class="field-required" aria-hidden="true">*</span>` : ""}</${labelTag}>
      ${control}
      ${definition.description ? `<p class="field-help" id="${escapeHtml(id)}-help">${escapeHtml(definition.description)}</p>` : ""}
    </div>`;
  }

  function documentsHtml(activity, entries, open) {
    const statusField = activity.fields.find((definition) => definition.key === "status");
    const linkField = activity.fields.find((definition) => definition.key === "link");
    const notesField = activity.fields.find((definition) => definition.key === "notes");
    const ids = [...(activity.checklist || []).map((entry) => entry.id), ...entries.map((entry) => entry.id).filter((id) => !(activity.checklist || []).some((known) => known.id === id))];
    const rows = ids.map((docId) => {
      const entry = entries.find((candidate) => candidate.id === docId) || { id: docId };
      const known = (activity.checklist || []).find((candidate) => candidate.id === docId);
      return `<tr data-rw-document="${escapeHtml(docId)}">
        <th scope="row"${known?.description ? ` title="${escapeHtml(known.description)}"` : ""}>${escapeHtml(documentLabel(activity, docId))}</th>
        <td>${Fields.inputHtml({ ...statusField, label: t("recordWindow.documentsHtml.status", { activity: documentLabel(activity, docId) }) }, Fields.readEntryValue(activity, statusField, entry), { idPrefix: `rw-doc-${docId}-` })}</td>
        <td>${Fields.inputHtml({ ...linkField, example: "https://..." }, Fields.readEntryValue(activity, linkField, entry), { idPrefix: `rw-doc-${docId}-` })}</td>
        <td>${Fields.inputHtml({ ...notesField, example: "" }, Fields.readEntryValue(activity, notesField, entry), { idPrefix: `rw-doc-${docId}-` })}</td>
      </tr>`;
    }).join("");
    const filled = entries.filter((entry) => entry.status && entry.status !== "Unknown").length;
    return `
      <details class="record-window-group record-window-activity" data-rw-group="${escapeHtml(activity.id)}"${open}>
        <summary><span>${escapeHtml(activity.label)}</span><span class="record-window-count">${filled ? `${filled} tracked` : t("recordWindow.documentsHtml.noneTracked")}</span></summary>
        ${activity.description ? `<p class="record-window-group-help">${escapeHtml(activity.description)}</p>` : ""}
        <div class="record-window-table-wrap"><table class="record-window-documents">
          <thead><tr><th scope="col">${escapeHtml(t("recordWindow.documentsHtml.document"))}</th><th scope="col">${escapeHtml(statusField.label)}</th><th scope="col">${escapeHtml(linkField.label)}</th><th scope="col">${escapeHtml(notesField.label)}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </details>`;
  }

  function readDocumentRow(activity, row) {
    const docId = row.dataset.rwDocument;
    const values = {};
    for (const definition of activity.fields) values[definition.key] = Fields.readInput(definition, row);
    const entries = Fields.activityEntries(current.work, activity);
    const index = entries.findIndex((entry) => entry.id === docId);
    const empty = activity.fields.every((definition) => Fields.isEmpty(definition, values[definition.key]));
    const next = entries.slice();
    if (empty) {
      if (index >= 0) next.splice(index, 1);
    } else {
      const written = Fields.writeEntry(activity, index >= 0 ? entries[index] : { id: docId }, values);
      if (index >= 0) next[index] = written;
      else next.push(written);
    }
    current.work[Fields.activityStorage(activity).collection] = next;
  }

  function saveEntry(activityId) {
    const activity = Fields.activities(current.section).find((entry) => entry.id === activityId);
    const form = q(`[data-rw-entry-form="${activityId}"]`);
    if (!activity || !form) return;
    const values = {};
    for (const definition of activity.fields) values[definition.key] = Fields.readInput(definition, form);
    const missing = activity.fields.filter((definition) => definition.validation?.required && Fields.isEmpty(definition, values[definition.key]));
    if (missing.length) {
      setNotice(t("recordWindow.saveEntry.fillInFirst", { value: missing.map((definition) => definition.label).join(", ") }));
      form.querySelector(`[data-field="${missing[0].key}"] [data-field-input], [data-field="${missing[0].key}"] input`)?.focus();
      return;
    }
    const collection = Fields.activityStorage(activity).collection;
    const entries = Fields.activityEntries(current.work, activity).slice();
    const index = current.editing[activityId];
    if (index >= 0) {
      entries[index] = Fields.writeEntry(activity, entries[index], values);
    } else {
      const entry = Fields.writeEntry(activity, { id: hooks.newId ? hooks.newId() : `entry-${Date.now()}` }, values);
      if (activityId === "updateLog") entry.loggedAt = new Date().toISOString();
      entries.push(entry);
      if (activityId === "updateLog") applyUpdateLogEntry(current.section, current.work, values);
    }
    current.work[collection] = entries;
    delete current.editing[activityId];
    keepGroupOpen(activityId);
    setNotice("");
    renderPane("details");
    updateState();
  }

  function keepGroupOpen(id) {
    current.openGroups = current.openGroups || new Set();
    current.openGroups.add(id);
  }

  // ---- Links ----------------------------------------------------------------------------

  function renderLinks(pane) {
    const { section, work } = current;
    if (current.draft) {
      pane.innerHTML = `<p class="empty-text">${escapeHtml(t("recordWindow.renderLinks.addTheTargetFirstThen"))}</p>`;
      return;
    }
    pane.innerHTML = `
      <div class="record-window-links" data-rw-links></div>
      <div class="record-window-create-linked">
        <span class="label-title">${escapeHtml(t("recordWindow.renderLinks.createALinkedTarget"))}</span>
        <div class="record-window-create-buttons">
          ${Fields.SECTIONS.map((other) => `<button type="button" class="secondary-button compact" data-rw-create-linked="${other}" data-section="${other}"><span class="section-dot" aria-hidden="true"></span> ${tHtml("recordWindow.renderLinks.in", { value: SECTION_LABELS[other] })}</button>`).join("")}
        </div>
      </div>`;
    if (hooks.renderLinks) hooks.renderLinks(pane.querySelector("[data-rw-links]"), section, work.id);
  }

  // ---- Extras ---------------------------------------------------------------------------

  function renderExtras(pane) {
    const { section, work } = current;
    const custom = Fields.customFields(section);
    const groups = new Map();
    for (const definition of custom) {
      const name = definition.group || t("ui.common.yourFields");
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(definition);
    }
    const other = Fields.otherFields(section, work);
    pane.innerHTML = `
      ${custom.length ? [...groups].map(([name, list]) => `
        <section class="record-window-group">
          <h4>${escapeHtml(name)}</h4>
          <div class="field-grid">${list.map((definition) => fieldRowHtml(definition, { prefix: "rw-custom-" })).join("")}</div>
        </section>`).join("") : `<p class="empty-text">${tHtml("recordWindow.noCustomFields", { section: escapeHtml(SECTION_LABELS[section]) })}</p>`}
      <section class="record-window-group record-window-other">
        <h4>${escapeHtml(t("recordWindow.renderExtras.otherFields"))}</h4>
        <p class="record-window-group-help">${escapeHtml(t("recordWindow.renderExtras.valuesThisTargetHoldsThat"))}</p>
        ${other.length ? `<div class="field-grid">${other.map(otherFieldHtml).join("")}</div>` : `<p class="empty-text">${escapeHtml(t("recordWindow.renderExtras.none"))}</p>`}
      </section>`;
  }

  function otherLabel(key) {
    const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function otherFieldHtml(entry, index) {
    const id = `rw-other-${index}`;
    const editable = typeof entry.value === "string" || typeof entry.value === "number" || typeof entry.value === "boolean";
    const shown = editable ? String(entry.value) : JSON.stringify(entry.value, null, 2);
    const where = entry.place === "details" ? "detail" : entry.place === "extraParams" ? t("recordWindow.otherFieldHtml.extraParameter") : entry.place === "custom" ? t("recordWindow.otherFieldHtml.customField") : "field";
    return `<div class="field-row" data-rw-other="${escapeHtml(entry.place)}:${escapeHtml(entry.key)}">
      <label class="field-label" for="${id}">${escapeHtml(otherLabel(entry.key))}</label>
      ${editable
        ? `<div class="field-control"><input type="text" id="${id}" data-rw-other-input data-kind="${typeof entry.value}" value="${escapeHtml(shown)}"></div>`
        : `<pre class="record-window-other-value" id="${id}">${escapeHtml(shown)}</pre>`}
      <p class="field-help">${tHtml("recordWindow.otherFieldHtml.older", { where })} <code>${escapeHtml(entry.key)}</code>.</p>
    </div>`;
  }

  function readOther(input) {
    const row = input.closest("[data-rw-other]");
    const [place, ...rest] = row.dataset.rwOther.split(":");
    const key = rest.join(":");
    const kind = input.dataset.kind;
    let next = input.value;
    if (kind === "number") next = input.value.trim() === "" ? "" : Number(input.value);
    if (kind === "boolean") next = /^(true|yes|1)$/i.test(input.value.trim());
    if (place === "flat") current.work[key] = next;
    else current.work[place] = { ...(current.work[place] || {}), [key]: next };
  }

  // ---- History ----------------------------------------------------------------------------

  function renderHistory(pane) {
    if (current.draft) {
      pane.innerHTML = `<p class="empty-text">${escapeHtml(t("recordWindow.renderHistory.addTheTargetFirstIts"))}</p>`;
      return;
    }
    if (hooks.renderHistory) hooks.renderHistory(pane, current.section, current.work.id);
  }

  // ---- events -------------------------------------------------------------------------------

  function setNotice(text) {
    const element = q("[data-rw-state]");
    if (text) element.textContent = text;
    else updateState();
  }

  function onEdit(event) {
    if (!current) return;
    const target = event.target;
    if (target.closest("[data-rw-pane='history']") || target.closest("[data-rw-links]") || target.closest("[data-rw-taxonomy]")) return;
    if (target.closest("[data-rw-entry-form]")) return;
    if (target.matches("[data-rw-notes]")) {
      Fields.setValue(current.section, current.work, field(current.section, "notes"), target.value);
      updateNotesPreview();
      updateState();
      return;
    }
    if (target.matches("[data-rw-other-input]")) {
      if (event.type === "change") readOther(target);
      updateState();
      return;
    }
    const documentRow = target.closest("[data-rw-document]");
    if (documentRow) {
      const activity = Fields.activities(current.section).find((entry) => entry.checklist);
      if (activity) readDocumentRow(activity, documentRow);
      updateState();
      return;
    }
    const holder = target.closest("[data-field]");
    if (!holder) return;
    const definition = field(current.section, holder.dataset.field);
    if (!definition) return;
    let next;
    if (definition.type === "repeat") next = { interval: holder.querySelector("[data-part=interval]").value, unit: holder.querySelector("[data-part=unit]").value };
    else if (["status", "priority", "campaign", "round"].includes(definition.type)) next = holder.querySelector("select").value;
    else if (definition.type === "tags") next = hooks.normalizeTags ? hooks.normalizeTags(holder.querySelector("input").value) : holder.querySelector("input").value.split(",");
    else next = Fields.readInput(definition, holder.parentElement);
    if (next === undefined) return;
    Fields.setValue(current.section, current.work, definition, next);
    // The same field can sit in two tabs (status and priority in Edit and
    // Details); the other copy is redrawn when its tab opens.
    if (definition.key === "name") renderTitle();
    else updateState();
  }

  function onClick(event) {
    if (!current) return;
    const target = event.target.closest("button, a, summary");
    if (!target) return;
    const tab = target.dataset.rwTab;
    if (tab) {
      selectTab(tab);
      return;
    }
    if (target.matches("summary")) {
      const group = target.parentElement.dataset.rwGroup;
      if (group) {
        current.openGroups = current.openGroups || new Set();
        // The toggle happens after this click; record the state it is going to.
        if (target.parentElement.open) current.openGroups.delete(group);
        else current.openGroups.add(group);
      }
      return;
    }
    if (target.matches("[data-rw-close], [data-rw-cancel]")) {
      requestClose();
      return;
    }
    if (target.matches("[data-rw-save]")) {
      save();
      return;
    }
    if (target.matches("[data-rw-delete]")) {
      if (hooks.remove && hooks.remove({ section: current.section, record: current.original })) close();
      return;
    }
    if (target.matches("[data-rw-show-in-list]")) {
      const { section, work } = current;
      if (requestClose()) hooks.showInList?.(section, work.id);
      return;
    }
    if (target.matches("[data-rw-copy-id]")) {
      root.navigator?.clipboard?.writeText(current.work.id).then(() => setNotice(t("recordWindow.onClick.idCopied")), () => setNotice(t("recordWindow.onClick.couldNotCopyTheId")));
      return;
    }
    if (target.dataset.rwUseSuggestion) {
      const definition = field(current.section, target.dataset.rwUseSuggestion);
      const suggested = hooks.suggestion?.(definition);
      if (definition && suggested) {
        const now = Fields.getValue(current.section, current.work, definition);
        const next = definition.type === "money" || definition.type === "money-range" ? { ...now, currency: suggested } : suggested;
        Fields.setValue(current.section, current.work, definition, next);
        renderPane(current.tab);
        updateState();
      }
      return;
    }
    if (target.dataset.rwEntryAdd) {
      current.editing[target.dataset.rwEntryAdd] = -1;
      keepGroupOpen(target.dataset.rwEntryAdd);
      renderPane("details");
      q(`[data-rw-entry-form="${target.dataset.rwEntryAdd}"] input, [data-rw-entry-form="${target.dataset.rwEntryAdd}"] select`)?.focus();
      return;
    }
    if (target.dataset.rwEntryEdit) {
      current.editing[target.dataset.rwEntryEdit] = Number(target.dataset.index);
      keepGroupOpen(target.dataset.rwEntryEdit);
      renderPane("details");
      return;
    }
    if (target.dataset.rwEntryRemove) {
      const activity = Fields.activities(current.section).find((entry) => entry.id === target.dataset.rwEntryRemove);
      const collection = Fields.activityStorage(activity).collection;
      const entries = Fields.activityEntries(current.work, activity).slice();
      entries.splice(Number(target.dataset.index), 1);
      current.work[collection] = entries;
      keepGroupOpen(activity.id);
      renderPane("details");
      updateState();
      return;
    }
    if (target.dataset.rwEntrySave) {
      saveEntry(target.dataset.rwEntrySave);
      return;
    }
    if (target.dataset.rwEntryCancel) {
      delete current.editing[target.dataset.rwEntryCancel];
      renderPane("details");
      return;
    }
    if (target.dataset.rwCreateLinked) {
      hooks.createLinked?.({ section: target.dataset.rwCreateLinked, from: { section: current.section, record: current.work } });
    }
  }

  // Tab and Shift+Tab go round inside the open window, as in any modal.
  function keepFocusInside(event) {
    const card = overlay?.querySelector(".record-window-card");
    if (!card) return;
    const focusable = [...card.querySelectorAll("button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.closest("[hidden]") && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = root.document.activeElement;
    if (event.shiftKey && (active === first || !card.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !card.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeyDown(event) {
    if (!current) return;
    if (event.key === "Tab") {
      keepFocusInside(event);
      return;
    }
    if (event.key === "Escape") {
      // A dropdown or picker inside the window closes first; it stops the
      // event when it handles it.
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const target = event.target;
      if (target.matches("input:not([type=checkbox]):not([type=radio])") && !target.closest(".item-picker, .taxonomy-picker, [data-rw-entry-form]")) {
        event.preventDefault();
        // The value of the box Enter was pressed in counts.
        target.dispatchEvent(new root.Event("change", { bubbles: true }));
        save();
      } else if (target.matches("input") && target.closest("[data-rw-entry-form]")) {
        event.preventDefault();
        saveEntry(target.closest("[data-rw-entry-form]").dataset.rwEntryForm);
      }
      return;
    }
    if (event.target.matches("[role=tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = TAB_IDS.indexOf(current.tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? TAB_IDS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TAB_IDS.length) % TAB_IDS.length;
      selectTab(TAB_IDS[next]);
    }
  }

  function save() {
    if (!current) return false;
    const { section, work } = current;
    const missing = everyField(section).filter((definition) => definition.validation?.required && Fields.isEmpty(definition, Fields.getValue(section, work, definition)));
    if (missing.length) {
      setNotice(t("recordWindow.save.isNeeded", { value: missing.map((definition) => definition.label).join(", ") }));
      selectTab("details");
      q(`[data-field-row="${missing[0].key}"] input, [data-field-row="${missing[0].key}"] select`)?.focus();
      return false;
    }
    const pending = Object.keys(current.editing);
    if (pending.length) {
      setNotice(t("recordWindow.save.addOrCancelTheEntry"));
      return false;
    }
    if (!current.draft && !isDirty(section, current.original, work)) {
      close();
      return true;
    }
    const saved = hooks.save ? hooks.save({ section, record: clone(work), draft: current.draft, original: current.original }) : work;
    if (!saved) return false;
    close();
    return true;
  }

  function requestClose() {
    if (!current) return true;
    const dirty = isDirty(current.section, current.original, current.work) || Object.keys(current.editing).length > 0;
    const draftTouched = current.draft && dirty;
    if ((dirty || draftTouched) && !root.confirm(t("recordWindow.requestClose.discardTheChangesYouMade"))) return false;
    close();
    return true;
  }

  function close() {
    if (!overlay || !current) return;
    current = null;
    overlay.classList.remove("open");
    overlay.hidden = true;
    for (const pane of overlay.querySelectorAll("[data-rw-pane]")) pane.innerHTML = "";
    hooks.onClose?.();
  }

  // Redraws the open tab, after something outside the window changed the
  // record (a link added, a value restored from History).
  function refresh(record) {
    if (!current) return;
    if (record) {
      current.original = clone(record);
      current.work = clone(record);
    }
    renderTitle();
    renderPane(current.tab);
  }

  function state() {
    if (!current) return null;
    return { section: current.section, id: current.work.id, draft: current.draft, tab: current.tab, dirty: isDirty(current.section, current.original, current.work) };
  }

  return {
    TABS,
    TAB_IDS,
    PRIORITIES,
    changedFields,
    isDirty,
    applyUpdateLogEntry,
    nameOf,
    configure,
    open,
    close,
    requestClose,
    refresh,
    selectTab: (tabId) => current && selectTab(tabId),
    state,
    save,
  };
});
