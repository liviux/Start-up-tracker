// One section page for Marketing, Programs and Funding
// (window.StartupTrackerSectionPage): the header metrics, the Focus queue,
// the Add target form and the read-only Targets table, the same in every
// section. index.html holds the same skeleton three times; this file draws
// into it from what the page tells it about each target (hooks.describe).
//
// The rules that need no browser are exported on their own and tested in
// Node: the saved views, the filters, sorting, paging and the row and card
// markup.
//
// UMD: browsers get window.StartupTrackerSectionPage, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerSectionPage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("./i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);
  // A translated string inside HTML: the text is escaped, the parameters go
  // in as given (they are HTML already).
  const tHtml = (key, params) => escapeHtml(t(key)).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match));

  const PRIORITIES = Object.freeze(["Very High", "High", "Medium", "Low", "Very Low"]);
  const PAGE_SIZES = Object.freeze([10, 20, 50]);
  const FOCUS_PAGE_SIZE = 6;

  // The same saved views in every section.
  const SAVED_VIEWS = Object.freeze([
    { id: "all", get label() { return t("sectionPage.savedViews.allTargets"); } },
    { id: "overdue", get label() { return t("sectionPage.savedViews.overdue"); } },
    { id: "due-week", get label() { return t("sectionPage.savedViews.dueThisWeek"); } },
    { id: "due-month", get label() { return t("sectionPage.savedViews.dueThisMonth"); } },
    { id: "waiting", get label() { return t("sectionPage.savedViews.waitingForAnAnswer"); } },
    { id: "no-next-action", get label() { return t("sectionPage.savedViews.noNextAction"); } },
    { id: "high", get label() { return t("sectionPage.savedViews.highAndVeryHigh"); } },
    { id: "no-campaign", get label() { return t("sectionPage.savedViews.noCampaign"); } },
  ]);

  // Columns in the same order everywhere; "value" only where a section has
  // amounts (FU asks, PO cash on offer). These show until other columns are
  // picked; any other field of the section can be shown as a column too,
  // under the id "field:<key>".
  const FIELD_COLUMN = "field:";
  const COLUMNS = Object.freeze([
    { id: "priority", get label() { return t("ui.common.priority"); }, sort: true },
    { id: "name", get label() { return t("ui.common.name"); }, sort: true },
    { id: "category", get label() { return t("sectionPage.columns.category"); }, sort: true },
    { id: "status", get label() { return t("ui.common.status"); }, sort: true },
    { id: "date", get label() { return t("ui.common.nextAction"); }, sort: true },
    { id: "campaign", get label() { return t("ui.common.campaign"); }, sort: true },
    { id: "tags", get label() { return t("ui.common.tags"); }, sort: false },
    { id: "value", get label() { return t("ui.common.value2"); }, sort: true },
  ]);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  function addDays(date, days) {
    const [year, month, day] = date.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return next.toISOString().slice(0, 10);
  }

  // ---- what can be tested ---------------------------------------------------

  // `row` is what hooks.describe returns: { id, name, organization, link,
  // categoryPath, categoryCount, status, open, waiting, priority,
  // nextActionDate, nextActionTime, nextAction, campaignId, campaignName,
  // owner, tags, value: { text, sort }, search }.
  function matchesView(viewId, row, today) {
    switch (viewId) {
      case "overdue": return row.open && Boolean(row.nextActionDate) && row.nextActionDate < today;
      case "due-week": return row.open && Boolean(row.nextActionDate) && row.nextActionDate >= today && row.nextActionDate <= addDays(today, 7);
      case "due-month": return row.open && Boolean(row.nextActionDate) && row.nextActionDate.slice(0, 7) === today.slice(0, 7);
      case "waiting": return row.waiting;
      case "no-next-action": return row.open && !row.nextActionDate && !String(row.nextAction || "").trim();
      case "high": return row.priority === "Very High" || row.priority === "High";
      case "no-campaign": return !row.campaignId;
      default: return true;
    }
  }

  // The rows a filter keeps. `filters` holds { view, search, statuses (a
  // test of a status, or null for all), priority, campaign, today }; the
  // search reads every word in names, notes, tags, links and the rest of
  // row.search. `extra(row)` may add a check (the category tabs).
  function filterRows(rows, filters, extra = () => true) {
    const words = String(filters.search || "").toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((row) => {
      if (!matchesView(filters.view || "all", row, filters.today)) return false;
      if (filters.statuses && !filters.statuses(row.status)) return false;
      if (filters.priority && filters.priority !== "all" && row.priority !== filters.priority) return false;
      if (filters.campaign && filters.campaign !== "all" && (row.campaignId || "") !== filters.campaign) return false;
      if (words.length) {
        const text = String(row.search || "").toLowerCase();
        if (!words.every((word) => text.includes(word))) return false;
      }
      return extra(row);
    });
  }

  const PRIORITY_RANK = new Map(PRIORITIES.map((priority, index) => [priority, index]));

  const isBlank = (value) => value === null || value === undefined || value === "";

  // A field column's values: numbers by size, text in alphabetical order.
  // Empty values are put last by sortRows, whichever way it sorts.
  function compareValues(left, right) {
    if (isBlank(left) || isBlank(right)) return isBlank(left) - isBlank(right);
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right), undefined, { numeric: true });
  }

  function compareBy(column, a, b, valueOf) {
    if (column.startsWith(FIELD_COLUMN)) return compareValues(valueOf?.(a, column), valueOf?.(b, column));
    switch (column) {
      case "priority": return (PRIORITY_RANK.get(a.priority) ?? 2) - (PRIORITY_RANK.get(b.priority) ?? 2);
      case "name": return String(a.name).localeCompare(String(b.name));
      case "category": return String(a.categoryPath).localeCompare(String(b.categoryPath));
      case "status": return (a.statusRank ?? 0) - (b.statusRank ?? 0) || String(a.status).localeCompare(String(b.status));
      case "campaign": return String(a.campaignName || "").localeCompare(String(b.campaignName || ""));
      case "value": return (a.value?.sort ?? -1) - (b.value?.sort ?? -1);
      default: {
        // Next action: dated first, earliest first.
        // A plain comparison: locale collation would put "~" before digits.
        const left = a.nextActionDate ? `${a.nextActionDate}T${a.nextActionTime || "99:99"}` : "~";
        const right = b.nextActionDate ? `${b.nextActionDate}T${b.nextActionTime || "99:99"}` : "~";
        return left < right ? -1 : left > right ? 1 : 0;
      }
    }
  }

  // Sorted by the chosen column, or by default open first, then the next
  // action date, then priority. `valueOf(row, column)` reads a field column.
  function sortRows(rows, sort, valueOf) {
    const list = rows.slice();
    if (sort?.column) {
      const direction = sort.direction === "desc" ? -1 : 1;
      const field = sort.column.startsWith(FIELD_COLUMN);
      return list.sort((a, b) => (field ? isBlank(valueOf?.(a, sort.column)) - isBlank(valueOf?.(b, sort.column)) : 0)
        || direction * compareBy(sort.column, a, b, valueOf)
        || compareBy("date", a, b));
    }
    return list.sort((a, b) => (Number(b.open) - Number(a.open)) || compareBy("date", a, b) || compareBy("priority", a, b) || compareBy("name", a, b));
  }

  // One page of rows and the line under the table. "Showing 1-0 of 0" never
  // appears: an empty list says so.
  function pageOf(rows, page, pageSize) {
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);
    const start = (current - 1) * pageSize;
    const items = rows.slice(start, start + pageSize);
    const label = total ? t("sectionPage.pageOf.showingOf", { value: start + 1, value2: start + items.length, total }) : t("sectionPage.pageOf.noTargetsToShow");
    return { items, page: current, pages, total, label };
  }

  // The Focus queue: targets with a next action date, on the day ("on") or
  // up to it ("by"), soonest first. Without a date, every dated target.
  function focusRows(rows, { date, mode, statuses }) {
    return rows
      .filter((row) => (!statuses || statuses(row.status)) && row.nextActionDate)
      .filter((row) => !date || (mode === "by" ? row.nextActionDate <= date : row.nextActionDate === date))
      .sort((a, b) => compareBy("date", a, b) || compareBy("priority", a, b));
  }

  function priorityPill(priority) {
    return priority ? `<span class="priority-pill" data-priority="${escapeHtml(priority)}">${escapeHtml(priority)}</span>` : "";
  }

  // The standard columns a section shows: all but "value" in Marketing.
  function defaultColumns(showValue) {
    return COLUMNS.filter((column) => column.id !== "value" || showValue).map((column) => column.id);
  }

  // A read-only table row with the columns asked for, standard ones and
  // field columns (`fieldText(row, id)`, named by `fieldLabel(id)` where a
  // narrow screen shows each row as a card). The name is a button, so the row
  // opens from the keyboard too; an external link inside the row opens that
  // link only.
  function rowHtml(row, { showValue = false, statusHtml = (status) => escapeHtml(status), formatDate = (date) => date, columns = null, fieldText = () => "", fieldLabel = () => "" } = {}) {
    const when = row.nextActionDate ? `${formatDate(row.nextActionDate)}${row.nextActionTime ? ` ${row.nextActionTime}` : ""}` : "";
    const cells = {
      priority: `<td class="sp-priority">${priorityPill(row.priority)}</td>`,
      name: `<td class="sp-name">
        <div class="sp-name-line">
          <button type="button" class="sp-open" data-sp-open="${escapeHtml(row.id)}">${escapeHtml(row.name || "Untitled target")}</button>
          ${row.link ? `<a class="sp-external" href="${escapeHtml(row.link)}" target="_blank" rel="noreferrer noopener" data-sp-external aria-label="${tHtml("sectionPage.rowHtml.openTheLinkOf", { name: escapeHtml(row.name) })}" title="${escapeHtml(row.link)}">↗</a>` : ""}
        </div>
        ${row.organization ? `<span class="sp-organization">${escapeHtml(row.organization)}</span>` : ""}
      </td>`,
      category: `<td class="sp-category">${row.categoryPath ? `<span>${escapeHtml(row.categoryPath)}</span>` : `<span class="sp-muted">${escapeHtml(t("sectionPage.rowHtml.uncategorized"))}</span>`}${row.categoryFlag ? ` <span class="taxonomy-flag">${escapeHtml(row.categoryFlag)}</span>` : ""}${row.categoryCount > 1 ? ` <span class="sp-more" title="${escapeHtml(t("sectionPage.moreCategories", { count: row.categoryCount - 1 }))}">+${row.categoryCount - 1}</span>` : ""}</td>`,
      status: `<td class="sp-status">${statusHtml(row.status)}</td>`,
      date: `<td class="sp-date">${when ? `<span>${escapeHtml(when)}</span>` : ""}${row.nextAction ? `<span class="sp-next">${escapeHtml(row.nextAction)}</span>` : ""}</td>`,
      campaign: `<td class="sp-campaign">${escapeHtml(row.campaignName || "")}</td>`,
      tags: `<td class="sp-tags">${(row.tags || []).map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`).join("")}</td>`,
      value: `<td class="sp-value">${escapeHtml(row.value?.text || "")}</td>`,
    };
    const fieldCell = (id) => {
      const text = fieldText(row, id);
      return `<td class="sp-field" data-label="${escapeHtml(fieldLabel(id))}">${text ? `<div class="sp-field-text" title="${escapeHtml(text)}">${escapeHtml(text)}</div>` : ""}</td>`;
    };
    const shown = (columns || defaultColumns(showValue)).map((id) => cells[id] ?? fieldCell(id));
    return `<tr class="sp-row" data-sp-row="${escapeHtml(row.id)}" data-status-group="${escapeHtml(row.statusGroup || "")}">${shown.join("")}</tr>`;
  }

  // The Columns dropdown: a search box, then a checkbox per column, grouped.
  // `groups` is [{ label, columns: [{ id, label }] }].
  function columnPickerHtml(groups, visible) {
    const on = new Set(visible);
    return `
      <details class="sp-columns" data-sp-columns-menu>
        <summary class="secondary-button">${escapeHtml(t("sectionPage.columns.button"))} <span class="tab-count">${visible.length}</span></summary>
        <div class="sp-columns-panel">
          <input type="search" data-sp-columns-search placeholder="${escapeHtml(t("sectionPage.columns.search"))}" aria-label="${escapeHtml(t("sectionPage.columns.search"))}">
          <div class="sp-columns-groups">
            ${groups.map((group) => `
              <fieldset class="sp-columns-group">
                <legend>${escapeHtml(group.label)}</legend>
                <div class="sp-columns-choices">${group.columns.map((column) => `<label class="sp-columns-choice" data-sp-column-label="${escapeHtml(column.label.toLowerCase())}"><input type="checkbox" data-sp-column="${escapeHtml(column.id)}"${on.has(column.id) ? " checked" : ""}> <span>${escapeHtml(column.label)}</span></label>`).join("")}</div>
              </fieldset>`).join("")}
          </div>
          <button type="button" class="text-button" data-sp-columns-reset>${escapeHtml(t("sectionPage.columns.reset"))}</button>
        </div>
      </details>`;
  }

  function focusCardHtml(row, { statusHtml = (status) => escapeHtml(status), formatDate = (date) => date } = {}) {
    const when = row.nextActionDate ? `${formatDate(row.nextActionDate)}${row.nextActionTime ? ` ${row.nextActionTime}` : ""}` : "";
    return `<div class="focus-item sp-focus-item${row.link ? " has-link" : ""}" data-sp-open="${escapeHtml(row.id)}" role="button" tabindex="0">
      <div class="focus-item-main">
        <strong>${escapeHtml(row.name || "Untitled target")}</strong>
        ${row.categoryPath ? `<span class="focus-sub" title="${escapeHtml(row.categoryPath)}">${escapeHtml(row.categoryPath)}</span>` : ""}
        <div class="focus-meta">
          ${statusHtml(row.status)}
          ${priorityPill(row.priority)}
          ${when ? `<span class="focus-when">${escapeHtml(when)}</span>` : ""}
          ${row.campaignName ? `<span>${escapeHtml(row.campaignName)}</span>` : ""}
          ${row.owner ? `<span>${escapeHtml(row.owner)}</span>` : ""}
        </div>
        ${row.nextAction ? `<span class="focus-next" title="${escapeHtml(row.nextAction)}">${escapeHtml(row.nextAction)}</span>` : ""}
      </div>
      ${row.link ? `<a class="focus-link-open" href="${escapeHtml(row.link)}" target="_blank" rel="noreferrer noopener" data-sp-external aria-label="${escapeHtml(t("sectionPage.focusCardHtml.openTheLink"))}">↗</a>` : ""}
    </div>`;
  }

  // The same pager as the other lists: the range, Previous, the page and Next.
  function paginationHtml(info) {
    if (!info.total) return "";
    if (info.pages <= 1) return `<span class="page-summary">${escapeHtml(info.label)}</span>`;
    return `<span class="page-summary">${escapeHtml(info.label)}</span>
      <button class="secondary-button" type="button" data-sp-page="${info.page - 1}"${info.page <= 1 ? " disabled" : ""}>${escapeHtml(t("sectionPage.paginationHtml.previous"))}</button>
      <span class="page-summary">${tHtml("sectionPage.paginationHtml.page", { page: info.page, pages: info.pages })}</span>
      <button class="secondary-button" type="button" data-sp-page="${info.page + 1}"${info.page >= info.pages ? " disabled" : ""}>${escapeHtml(t("sectionPage.paginationHtml.next"))}</button>`;
  }

  // ---- the page ---------------------------------------------------------------

  // hooks: records(), describe(record), today(), statusHtml(id),
  // statusOptionsHtml(selected), defaultStatus(), formatDate(date),
  // campaigns() [{ id, name }], metrics(records) [{ label, value, help }],
  // matchesTabs(record), fieldColumns() [{ label, columns: [{ id, label }] }]
  // (the fields that can be added as columns, grouped), fieldText(record, id)
  // and fieldSort(record, id), open(id), add(values, { openDetails }),
  // taxonomyValue(), resetTaxonomy(), statusFilter (StartupTrackerStatusFilter),
  // statusSelection: { defaults(), all(), matches(selection, id), restore(list) },
  // loadUi(), saveUi(ui), changed() after a filter change.
  function create(page, hooks) {
    const q = (selector) => page.querySelector(selector);
    const section = page.dataset.section;
    const showValue = section !== "mk";
    const ui = {
      search: "",
      view: "all",
      priority: "all",
      campaign: "all",
      statuses: null,
      // The columns picked in the Columns dropdown; null shows the standard ones.
      columns: null,
      page: 1,
      pageSize: 10,
      sort: { column: "", direction: "asc" },
      focus: { date: "", mode: "by", statuses: null, page: 1 },
      collapsed: { focus: false, form: true, table: false },
      ...(hooks.loadUi?.() || {}),
    };
    ui.focus = { date: "", mode: "by", statuses: null, page: 1, ...(ui.focus || {}) };
    // Settings > General sets the rows per page until a size is picked here.
    if (!ui.pageSizePicked && hooks.defaultPageSize) ui.pageSize = Number(hooks.defaultPageSize()) || 10;
    if (ui.focus.date === undefined || ui.focus.date === "") ui.focus.date = hooks.today();
    const selection = (list) => (Array.isArray(list) ? hooks.statusSelection.restore(list) : hooks.statusSelection.defaults());
    const fieldText = (row, id) => hooks.fieldText?.(row.record, id.slice(FIELD_COLUMN.length)) ?? "";
    const sortValue = (row, id) => hooks.fieldSort?.(row.record, id.slice(FIELD_COLUMN.length));
    let lastRows = [];

    function save() {
      hooks.saveUi?.({ ...ui, focus: { ...ui.focus } });
    }

    function rows() {
      return (hooks.records() || []).map((record) => ({ ...hooks.describe(record), record }));
    }

    // ---- header -------------------------------------------------------------

    function renderMetrics(all) {
      const holder = q("[data-sp-metrics]");
      if (!holder) return;
      holder.innerHTML = (hooks.metrics?.(all.map((row) => row.record)) || [])
        .map((metric) => `<article class="metric-card"${metric.help ? ` title="${escapeHtml(metric.help)}"` : ""}><span class="metric-value">${metricValueHtml(metric.value)}</span><span class="metric-label">${escapeHtml(metric.label)}</span></article>`)
        .join("");
    }

    // A currency code is a unit, not part of the number: set it smaller so
    // "GBP 295K" stays on one line inside a narrow summary cell.
    function metricValueHtml(value) {
      const text = String(value ?? "");
      const match = text.match(/^([A-Z]{3})\s+(.+)$/);
      return match
        ? `<span class="metric-currency">${escapeHtml(match[1])}</span><span class="metric-amount">${escapeHtml(match[2])}</span>`
        : escapeHtml(text);
    }

    // ---- focus queue ----------------------------------------------------------

    function renderFocus(all) {
      const list = q("[data-sp-focus-list]");
      if (!list) return;
      const statuses = selection(ui.focus.statuses);
      const matches = (status) => hooks.statusSelection.matches(statuses, status);
      const on = focusRows(all, { date: ui.focus.date, mode: "on", statuses: matches });
      const by = focusRows(all, { date: ui.focus.date, mode: "by", statuses: matches });
      const shown = ui.focus.mode === "on" ? on : by;
      for (const button of page.querySelectorAll("[data-sp-focus-mode]")) {
        const active = button.dataset.spFocusMode === ui.focus.mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        const count = button.querySelector(".tab-count");
        if (count) count.textContent = String(button.dataset.spFocusMode === "on" ? on.length : by.length);
      }
      const dateInput = q("[data-sp-focus-date]");
      if (dateInput) dateInput.value = ui.focus.date || "";
      hooks.statusFilter?.render(q("[data-sp-focus-statuses]"), {
        selection: statuses,
        counts: countStatuses(all),
        onChange: (next) => {
          ui.focus.statuses = [...next];
          ui.focus.page = 1;
          save();
          renderFocus(lastRows);
        },
      });
      const info = pageOf(shown, ui.focus.page, FOCUS_PAGE_SIZE);
      ui.focus.page = info.page;
      list.style.setProperty("--focus-rows", String(Math.max(1, Math.ceil(info.items.length / 2))));
      list.innerHTML = info.items.length
        ? info.items.map((row) => focusCardHtml(row, { statusHtml: hooks.statusHtml, formatDate: hooks.formatDate })).join("")
        : `<div class="focus-empty-state"><strong>${escapeHtml(ui.focus.date ? (ui.focus.mode === "on" ? t("sectionPage.create.nothingOn", { date: hooks.formatDate(ui.focus.date) }) : t("sectionPage.create.nothingDueBy", { date: hooks.formatDate(ui.focus.date) })) : t("sectionPage.create.noDatedNextActions"))}</strong><span class="focus-meta">${escapeHtml(t("sectionPage.create.pickAnotherDaySwitchBetween"))}</span></div>`;
      const pages = q("[data-sp-focus-pages]");
      if (pages) pages.innerHTML = info.pages > 1 ? paginationHtml(info).replaceAll("data-sp-page=", "data-sp-focus-page=") : "";
    }

    function countStatuses(all) {
      const counts = new Map();
      for (const row of all) counts.set(row.statusKey || row.status, (counts.get(row.statusKey || row.status) || 0) + 1);
      return counts;
    }

    // ---- targets table ----------------------------------------------------------

    function fillSelect(select, options, value) {
      if (!select) return;
      select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
      select.value = value;
    }

    function renderControls(all) {
      const search = q("[data-sp-search]");
      if (search && search !== root.document?.activeElement) search.value = ui.search;
      fillSelect(q("[data-sp-view]"), SAVED_VIEWS.map((view) => ({ value: view.id, label: view.label })), ui.view);
      fillSelect(q("[data-sp-priority]"), [{ value: "all", label: t("sectionPage.create.allPriorities") }, ...PRIORITIES.map((priority) => ({ value: priority, label: priority }))], ui.priority);
      const campaigns = hooks.campaigns?.() || [];
      if (ui.campaign !== "all" && ui.campaign !== "none" && !campaigns.some((campaign) => campaign.id === ui.campaign)) ui.campaign = "all";
      fillSelect(q("[data-sp-campaign]"), [{ value: "all", label: t("sectionPage.create.allCampaigns") }, ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))], ui.campaign);
      const sizes = [...new Set([...PAGE_SIZES, ui.pageSize])].sort((a, b) => a - b);
      fillSelect(q("[data-sp-page-size]"), sizes.map((size) => ({ value: String(size), label: String(size) })), String(ui.pageSize));
      hooks.statusFilter?.render(q("[data-sp-statuses]"), {
        selection: ui.statuses ? hooks.statusSelection.restore(ui.statuses) : hooks.statusSelection.all(),
        counts: countStatuses(all),
        onChange: (next) => {
          ui.statuses = [...next];
          ui.page = 1;
          save();
          renderTable(lastRows);
        },
      });
      renderColumnPicker();
    }

    // ---- columns --------------------------------------------------------------

    // Every column the table can show, grouped: the standard ones first.
    function columnGroups() {
      const standard = COLUMNS.filter((column) => column.id !== "value" || showValue)
        .map((column) => ({ id: column.id, label: column.id === "value" ? hooks.valueLabel || column.label : column.label, sort: column.sort }));
      const fields = (hooks.fieldColumns?.() || []).map((group) => ({ ...group, columns: group.columns.map((column) => ({ ...column, sort: true })) }));
      return [{ label: t("sectionPage.columns.table"), columns: standard }, ...fields];
    }

    // The columns shown, in the order of the dropdown. A picked column that
    // the section no longer has is left out.
    function visibleColumns() {
      const all = columnGroups().flatMap((group) => group.columns);
      if (!Array.isArray(ui.columns)) return all.filter((column) => defaultColumns(showValue).includes(column.id));
      const picked = new Set(ui.columns);
      const shown = all.filter((column) => picked.has(column.id));
      return shown.length ? shown : all.filter((column) => column.id === "name");
    }

    // Drawn once; later renders only tick the boxes, so a box keeps the focus
    // while the table changes behind it.
    function renderColumnPicker() {
      const holder = q("[data-sp-columns]");
      if (!holder) return;
      const groups = columnGroups();
      const visible = visibleColumns().map((column) => column.id);
      const signature = JSON.stringify(groups.map((group) => [group.label, group.columns.map((column) => column.id)]));
      if (holder.dataset.signature !== signature) {
        holder.dataset.signature = signature;
        holder.innerHTML = columnPickerHtml(groups, visible);
        return;
      }
      for (const box of holder.querySelectorAll("[data-sp-column]")) box.checked = visible.includes(box.dataset.spColumn);
      const count = holder.querySelector("summary .tab-count");
      if (count) count.textContent = String(visible.length);
    }

    function filterColumnChoices(text) {
      const query = String(text || "").trim().toLowerCase();
      for (const choice of page.querySelectorAll("[data-sp-column-label]")) choice.hidden = Boolean(query) && !choice.dataset.spColumnLabel.includes(query);
      for (const group of page.querySelectorAll(".sp-columns-group")) group.hidden = ![...group.querySelectorAll("[data-sp-column-label]")].some((choice) => !choice.hidden);
    }

    function renderHead() {
      const head = q("[data-sp-head]");
      if (!head) return;
      head.innerHTML = visibleColumns().map((column) => {
        const sorted = ui.sort.column === column.id;
        const aria = sorted ? (ui.sort.direction === "desc" ? "descending" : "ascending") : "none";
        const css = column.id.startsWith(FIELD_COLUMN) ? "sp-col-field" : `sp-col-${column.id}`;
        return column.sort
          ? `<th scope="col" class="${css}" aria-sort="${aria}"><button type="button" class="sp-sort" data-sp-sort="${escapeHtml(column.id)}">${escapeHtml(column.label)}<span class="sp-sort-mark" aria-hidden="true">${sorted ? (ui.sort.direction === "desc" ? "▼" : "▲") : ""}</span></button></th>`
          : `<th scope="col" class="${css}">${escapeHtml(column.label)}</th>`;
      }).join("");
    }

    function filtered(all) {
      const statuses = ui.statuses ? hooks.statusSelection.restore(ui.statuses) : null;
      return filterRows(all, {
        view: ui.view,
        search: ui.search,
        statuses: statuses ? (status) => hooks.statusSelection.matches(statuses, status) : null,
        priority: ui.priority,
        campaign: ui.campaign,
        today: hooks.today(),
      }, (row) => !hooks.matchesTabs || hooks.matchesTabs(row.record));
    }

    function renderTable(all) {
      renderControls(all);
      renderHead();
      const body = q("[data-sp-rows]");
      if (!body) return;
      const info = pageOf(sortRows(filtered(all), ui.sort, sortValue), ui.page, ui.pageSize);
      ui.page = info.page;
      const visible = visibleColumns();
      const columns = visible.map((column) => column.id);
      const labels = new Map(visible.map((column) => [column.id, column.label]));
      // The standard columns share the width between them; added fields let
      // every column take the room it needs.
      body.closest("table")?.classList.toggle("has-field-columns", columns.some((id) => id.startsWith(FIELD_COLUMN)));
      body.innerHTML = info.items.map((row) => rowHtml(row, { showValue, statusHtml: hooks.statusHtml, formatDate: hooks.formatDate, columns, fieldText, fieldLabel: (id) => labels.get(id) || "" })).join("");
      const empty = q("[data-sp-empty]");
      if (empty) empty.hidden = info.total > 0;
      const pages = q("[data-sp-pages]");
      if (pages) pages.innerHTML = paginationHtml(info);
    }

    function render() {
      const all = rows();
      lastRows = all;
      renderMetrics(all);
      renderFocus(all);
      renderTable(all);
      renderForm();
      applyCollapsed();
    }

    // ---- add form ----------------------------------------------------------------

    function renderForm() {
      const form = q("[data-sp-form]");
      if (!form) return;
      // The status list can change in Settings; the choice made here stays.
      const status = form.elements.status;
      if (status) status.innerHTML = hooks.statusOptionsHtml(status.value || hooks.defaultStatus());
      const campaign = form.elements.campaignId;
      if (campaign) {
        const value = campaign.value;
        campaign.innerHTML = `<option value="">${escapeHtml(t("sectionPage.create.noCampaign"))}</option>${(hooks.campaigns?.() || []).map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</option>`).join("")}`;
        campaign.value = value;
      }
    }

    function formValues() {
      const form = q("[data-sp-form]");
      const value = (name) => String(form.elements[name]?.value || "").trim();
      return {
        name: value("name"),
        organization: value("organization"),
        link: value("link"),
        taxonomy: hooks.taxonomyValue?.() || [],
        status: value("status") || hooks.defaultStatus(),
        priority: value("priority") || "Medium",
        nextAction: value("nextAction"),
        nextActionDate: value("nextActionDate"),
        nextActionTime: value("nextActionTime"),
        campaignId: value("campaignId"),
        tags: value("tags").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
      };
    }

    function resetForm() {
      const form = q("[data-sp-form]");
      form.reset();
      if (form.elements.status) form.elements.status.innerHTML = hooks.statusOptionsHtml(hooks.defaultStatus());
      if (form.elements.priority) form.elements.priority.value = "Medium";
      hooks.resetTaxonomy?.();
    }

    function submit(openDetails) {
      const form = q("[data-sp-form]");
      const values = formValues();
      const status = q("[data-sp-form-status]");
      if (!values.name && !openDetails) {
        if (status) status.textContent = t("sectionPage.create.giveTheTargetAName");
        form.elements.name.focus();
        return;
      }
      const added = hooks.add(values, { openDetails });
      if (added && !openDetails) {
        resetForm();
        if (status) status.textContent = t("sectionPage.create.added", { name: values.name });
        form.elements.name.focus();
      }
    }

    // ---- panels -------------------------------------------------------------------

    function applyCollapsed() {
      for (const toggle of page.querySelectorAll("[data-sp-toggle]")) {
        const name = toggle.dataset.spToggle;
        const collapsed = Boolean(ui.collapsed[name]);
        toggle.classList.toggle("collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        const body = page.querySelector(`#${toggle.getAttribute("aria-controls")}`);
        if (body) body.classList.toggle("collapsed", collapsed);
      }
    }

    // ---- events -----------------------------------------------------------------------

    function changed() {
      ui.page = 1;
      save();
      renderTable(lastRows);
    }

    page.addEventListener("click", (event) => {
      const target = event.target.closest("button, a, [data-sp-open]");
      if (!target || !page.contains(target)) return;
      if (target.matches("[data-sp-external]")) {
        event.stopPropagation();
        return;
      }
      if (target.dataset.spToggle) {
        ui.collapsed[target.dataset.spToggle] = !ui.collapsed[target.dataset.spToggle];
        save();
        applyCollapsed();
        return;
      }
      if (target.dataset.spSort) {
        const column = target.dataset.spSort;
        if (ui.sort.column !== column) ui.sort = { column, direction: "asc" };
        else if (ui.sort.direction === "asc") ui.sort = { column, direction: "desc" };
        else ui.sort = { column: "", direction: "asc" };
        save();
        renderTable(lastRows);
        return;
      }
      if (target.dataset.spPage) {
        ui.page = Number(target.dataset.spPage);
        save();
        renderTable(lastRows);
        q("[data-sp-panel='table']")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
        return;
      }
      if (target.dataset.spFocusPage) {
        ui.focus.page = Number(target.dataset.spFocusPage);
        renderFocus(lastRows);
        return;
      }
      if (target.dataset.spFocusMode) {
        ui.focus.mode = target.dataset.spFocusMode;
        ui.focus.page = 1;
        save();
        renderFocus(lastRows);
        return;
      }
      if (target.dataset.spFocusStep) {
        ui.focus.date = addDays(ui.focus.date || hooks.today(), Number(target.dataset.spFocusStep));
        ui.focus.page = 1;
        save();
        renderFocus(lastRows);
        return;
      }
      if (target.matches("[data-sp-focus-today]")) {
        ui.focus.date = hooks.today();
        ui.focus.page = 1;
        save();
        renderFocus(lastRows);
        return;
      }
      if (target.matches("[data-sp-focus-clear]")) {
        ui.focus.date = "";
        ui.focus.page = 1;
        save();
        renderFocus(lastRows);
        return;
      }
      if (target.matches("[data-sp-columns-reset]")) {
        ui.columns = null;
        save();
        renderTable(lastRows);
        return;
      }
      if (target.matches("[data-sp-add-open]")) {
        submit(true);
        return;
      }
      if (target.dataset.spOpen) {
        hooks.open(target.dataset.spOpen);
      }
    });

    // A click anywhere on a row (not on its link) opens the target.
    page.addEventListener("click", (event) => {
      if (event.defaultPrevented) return;
      const row = event.target.closest("[data-sp-row]");
      if (!row || event.target.closest("a, button")) return;
      hooks.open(row.dataset.spRow);
    });

    page.addEventListener("keydown", (event) => {
      const card = event.target.closest(".sp-focus-item[data-sp-open]");
      if (card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        hooks.open(card.dataset.spOpen);
        return;
      }
      const menu = event.target.closest("[data-sp-columns-menu]");
      if (menu?.open && event.key === "Escape") {
        event.preventDefault();
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });

    page.addEventListener("input", (event) => {
      if (event.target.matches("[data-sp-search]")) {
        ui.search = event.target.value;
        changed();
      } else if (event.target.matches("[data-sp-columns-search]")) {
        filterColumnChoices(event.target.value);
      }
    });

    // The Columns dropdown closes on a click anywhere else.
    root.document?.addEventListener("click", (event) => {
      const menu = q("[data-sp-columns-menu]");
      if (menu?.open && !menu.contains(event.target)) menu.open = false;
    });

    page.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("[data-sp-column]")) {
        ui.columns = [...page.querySelectorAll("[data-sp-column]:checked")].map((box) => box.dataset.spColumn);
        save();
        renderTable(lastRows);
        return;
      }
      if (target.matches("[data-sp-view]")) ui.view = target.value;
      else if (target.matches("[data-sp-priority]")) ui.priority = target.value;
      else if (target.matches("[data-sp-campaign]")) ui.campaign = target.value;
      else if (target.matches("[data-sp-page-size]")) {
        ui.pageSize = Number(target.value) || 10;
        ui.pageSizePicked = true;
      }
      else if (target.matches("[data-sp-focus-date]")) {
        ui.focus.date = target.value;
        ui.focus.page = 1;
        save();
        renderFocus(lastRows);
        return;
      } else return;
      changed();
    });

    const form = q("[data-sp-form]");
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(false);
    });
    form?.addEventListener("reset", () => {
      window.setTimeout(() => {
        if (form.elements.status) form.elements.status.innerHTML = hooks.statusOptionsHtml(hooks.defaultStatus());
        hooks.resetTaxonomy?.();
      }, 0);
    });

    // Shows one target in the table: clears the filters that hide it and
    // pages to it.
    function showRecord(id) {
      Object.assign(ui, { search: "", view: "all", priority: "all", campaign: "all", statuses: null });
      ui.collapsed.table = false;
      const all = rows();
      const ordered = sortRows(filtered(all), ui.sort, sortValue);
      const index = ordered.findIndex((row) => row.id === id);
      ui.page = index >= 0 ? Math.floor(index / ui.pageSize) + 1 : 1;
      save();
      render();
      const row = q(`[data-sp-row="${String(id).replace(/["\\]/g, "\\$&")}"]`);
      if (row) {
        row.scrollIntoView?.({ block: "center", behavior: "smooth" });
        row.classList.add("highlighted-target-row");
        root.setTimeout?.(() => row.classList.remove("highlighted-target-row"), 3000);
      }
      return Boolean(row);
    }

    function setDefaultPageSize(size) {
      const value = Number(size);
      if (ui.pageSizePicked || !Number.isInteger(value) || value < 1) return;
      ui.pageSize = value;
      ui.page = 1;
    }

    return { render, renderForm, showRecord, resetForm, setDefaultPageSize, ui };
  }

  return {
    PRIORITIES,
    PAGE_SIZES,
    SAVED_VIEWS,
    COLUMNS,
    matchesView,
    filterRows,
    sortRows,
    pageOf,
    focusRows,
    rowHtml,
    defaultColumns,
    columnPickerHtml,
    focusCardHtml,
    paginationHtml,
    create,
  };
});
