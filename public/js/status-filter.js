// The shared status filter: one chip per status group showing All, k/n or
// Off with a count, a popover with the group's statuses as checkboxes, All
// and None per group, and "Select all / none". Every focus queue, Targets
// list and the calendar use it, so a filter reads the same everywhere.
(function () {
  "use strict";

  const Statuses = window.StartupTrackerStatuses;
  const I18n = window.StartupTrackerI18n;
  if (!Statuses || !I18n) {
    console.error("status-filter.js needs status-model.js and i18n.js first.");
    return;
  }
  const t = I18n.t;
  const UNMAPPED = Statuses.UNMAPPED;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  const CHEVRON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

  // Groups shown in the filter: the four status groups, plus "Unmapped" when
  // some record carries a status the list does not know.
  function filterGroups(counts) {
    const groups = Statuses.groups().map((group) => ({
      id: group.id,
      label: group.label,
      description: group.description,
      statuses: Statuses.inGroup(group.id).map((id) => ({ id, label: Statuses.label(id), description: Statuses.description(id) })),
    }));
    if ((counts.get(UNMAPPED) || 0) > 0) {
      groups.push({ id: UNMAPPED, label: t("statusFilter.unmapped"), description: t("statusFilter.unmappedHelp"), statuses: [{ id: UNMAPPED, label: t("statusFilter.unmapped"), description: t("statusFilter.unmappedHelp") }] });
    }
    return groups;
  }

  function stateText(state) {
    if (state === "all") return t("statusFilter.all");
    if (state === "off") return t("statusFilter.off");
    return state;
  }

  // Renders into `bar` and calls onChange(nextSelection) on every change.
  // The bar keeps which popovers were open across re-renders.
  function render(bar, { selection, counts = new Map(), onChange, title = t("statusFilter.title") }) {
    if (!bar) return;
    bar.classList.add("manager-focus-grouped-bar", "status-filter");
    const shellOpen = bar.querySelector(".manager-focus-filter-shell")?.open ?? false;
    const openGroups = new Set(Array.from(bar.querySelectorAll(".manager-focus-filter-group[open]")).map((details) => details.dataset.groupId));
    const groups = filterGroups(counts);
    const everyId = groups.flatMap((group) => group.statuses.map((status) => status.id));
    const chosen = everyId.filter((id) => selection.has(id)).length;
    const shellText = chosen === everyId.length ? t("statusFilter.allSelected") : chosen === 0 ? t("statusFilter.none") : t("statusFilter.someSelected", { chosen, total: everyId.length });

    bar.innerHTML = `
      <details class="manager-focus-filter-shell" ${shellOpen ? "open" : ""}>
        <summary class="manager-focus-filter-shell-summary">
          <span class="manager-focus-filter-shell-title">${escapeHtml(title)}</span>
          <span class="manager-focus-filter-shell-trailing">
            <span class="manager-focus-filter-shell-state">${escapeHtml(shellText)}</span>
            <span class="manager-focus-filter-shell-chevron">${CHEVRON}</span>
          </span>
        </summary>
        <div class="manager-focus-filter-shell-body">
          <div class="manager-focus-filter-groups">
            <div class="manager-focus-filter-groups-list">
              ${groups.map((group) => {
                const state = Statuses.groupState(selection, group.id);
                const count = group.statuses.reduce((sum, status) => sum + (counts.get(status.id) || 0), 0);
                const allOn = state === "all";
                return `
                  <details class="manager-focus-filter-group" data-group-id="${escapeHtml(group.id)}" data-selection-state="${state === "all" ? "all" : state === "off" ? "none" : "some"}" ${openGroups.has(group.id) ? "open" : ""}>
                    <summary class="manager-focus-filter-summary" title="${escapeHtml(group.description || "")}">
                      <span class="manager-focus-filter-summary-body">
                        <span class="manager-focus-filter-summary-name status-group-label status-group-${escapeHtml(group.id.replace(/_/g, "-"))}">${escapeHtml(group.label)}</span>
                        <span class="manager-focus-filter-summary-trailing">
                          <span class="manager-focus-filter-summary-state">${escapeHtml(stateText(state))}</span>
                          <span class="manager-focus-filter-summary-count" aria-label="${escapeHtml(t("statusFilter.countLabel", { count }))}">${count}</span>
                        </span>
                      </span>
                      <span class="manager-focus-filter-chevron-btn" role="button" tabindex="0" aria-expanded="${openGroups.has(group.id)}" aria-label="${escapeHtml(t("statusFilter.toggleGroup", { group: group.label }))}">${CHEVRON}</span>
                    </summary>
                    <div class="manager-focus-filter-panel">
                      <div class="manager-focus-filter-panel-header">
                        <span class="manager-focus-filter-panel-title">${escapeHtml(group.label)}</span>
                        <div class="manager-focus-filter-panel-actions">
                          <button class="manager-focus-filter-mini-btn" type="button" data-status-group-action="${escapeHtml(group.id)}" data-value="all" ${allOn ? "disabled" : ""}>${escapeHtml(t("statusFilter.all"))}</button>
                          <button class="manager-focus-filter-mini-btn" type="button" data-status-group-action="${escapeHtml(group.id)}" data-value="none" ${state === "off" ? "disabled" : ""}>${escapeHtml(t("statusFilter.noneButton"))}</button>
                        </div>
                      </div>
                      <div class="manager-focus-filter-options">
                        ${group.statuses.map((status) => {
                          const checked = selection.has(status.id);
                          return `
                            <label class="focus-filter-label ${checked ? "active" : ""}" title="${escapeHtml(status.description)}">
                              <input type="checkbox" value="${escapeHtml(status.id)}" data-status-filter-option ${checked ? "checked" : ""}>
                              <span class="${status.id === UNMAPPED ? "status-badge status-group-unmapped" : Statuses.badgeClass(status.id)}">${escapeHtml(status.label)} (${counts.get(status.id) || 0})</span>
                            </label>`;
                        }).join("")}
                      </div>
                    </div>
                  </details>`;
              }).join("")}
            </div>
            <div class="manager-focus-filter-bulk-actions">
              <button class="manager-focus-filter-btn manager-focus-bulk-toggle" type="button" data-status-filter-bulk="${chosen === everyId.length ? "none" : "all"}">
                <span class="bulk-toggle-prefix">${escapeHtml(t("statusFilter.select"))}</span>
                <span class="bulk-toggle-option ${chosen === everyId.length ? "" : "active"}">${escapeHtml(t("statusFilter.selectAll"))}</span>
                <span class="bulk-toggle-separator">/</span>
                <span class="bulk-toggle-option ${chosen === everyId.length ? "active" : ""}">${escapeHtml(t("statusFilter.selectNone"))}</span>
              </button>
            </div>
          </div>
        </div>
      </details>`;

    const change = (next) => onChange(next);

    // Clicking a group's name turns the whole group on or off; the chevron
    // opens its popover, by mouse or keyboard.
    bar.querySelectorAll(".manager-focus-filter-summary").forEach((summary) => {
      summary.addEventListener("click", (event) => {
        if (event.target.closest(".manager-focus-filter-chevron-btn")) return;
        event.preventDefault();
        const groupId = summary.closest("details")?.dataset.groupId;
        if (!groupId) return;
        change(Statuses.setGroup(selection, groupId, Statuses.groupState(selection, groupId) !== "all"));
      });
    });
    bar.querySelectorAll(".manager-focus-filter-chevron-btn").forEach((chevron) => {
      chevron.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const details = chevron.closest("details");
        details.open = !details.open;
        chevron.setAttribute("aria-expanded", String(details.open));
      });
      chevron.closest("details").addEventListener("toggle", (event) => {
        chevron.setAttribute("aria-expanded", String(event.currentTarget.open));
      });
    });
    bar.querySelectorAll("[data-status-group-action]").forEach((button) => {
      button.addEventListener("click", () => change(Statuses.setGroup(selection, button.dataset.statusGroupAction, button.dataset.value === "all")));
    });
    bar.querySelectorAll("[data-status-filter-option]").forEach((box) => {
      box.addEventListener("change", () => change(Statuses.toggle(selection, box.value)));
    });
    bar.querySelectorAll("[data-status-filter-bulk]").forEach((button) => {
      button.addEventListener("click", () => change(button.dataset.statusFilterBulk === "all" ? Statuses.allSelection() : new Set()));
    });
  }

  window.StartupTrackerStatusFilter = { render, filterGroups };
})();
