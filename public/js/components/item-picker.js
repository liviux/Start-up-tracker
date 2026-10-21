// ItemPicker: one dropdown for picking records instead of long lists
// (window.StartupTrackerItemPicker).
//
//   const picker = ItemPicker.create(holder, {
//     multiple: true,
//     kinds: ["mk", "po", "fu"],            // what can be picked
//     source: (query, { kinds, limit }) => ({ items, total }),
//     describe: (ref) => item or null,      // for the chips
//     value: [{ kind, id }],
//     onChange: (value) => {},
//   });
//
// Picked records show as chips; typing filters the dropdown; results are
// grouped by kind with the section dot, a status badge and a second line.
// Results come in pages of 20 with "Show more", recently picked first. It
// follows the ARIA combobox pattern (arrow keys, Enter, Escape, Backspace on
// an empty box removes the last chip) and raises "input" and "change" on the
// holder like a native control, so a window's unsaved-changes guard sees it.
//
// The state and the markup are plain functions (createCore, listHtml,
// chipsHtml) so the tests can run them without a browser.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerItemPicker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Strings come from content/i18n/en.json through js/i18n.js, found when
  // first used (some scripts load before it).
  const i18n = () => (typeof module === "object" && module.exports ? module.require("../i18n.js") : globalThis.StartupTrackerI18n);
  const t = (key, params) => i18n().t(key, params);
  // A translated string inside HTML: the text is escaped, the parameters go
  // in as given (they are HTML already).
  const tHtml = (key, params) => escapeHtml(t(key)).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match));

  const PAGE_SIZE = 20;
  const RECENT_LIMIT = 12;
  let sequence = 0;

  const KIND_LABELS = {
    get mk() { return t("ui.common.marketing"); },
    get po() { return t("itemPicker.kindLabels.programs"); },
    get fu() { return t("ui.common.funding"); },
    get comp() { return t("itemPicker.kindLabels.companySteps"); },
    get expense() { return t("itemPicker.kindLabels.companyExpenses"); },
    get media() { return t("itemPicker.kindLabels.media"); },
    get feedback() { return t("itemPicker.kindLabels.feedback"); },
    get campaign() { return t("ui.common.campaigns"); },
    get research() { return t("itemPicker.kindLabels.researchLinks"); },
    get option() { return t("itemPicker.kindLabels.options"); },
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  function refKey(ref) {
    return `${ref.kind}:${ref.id}`;
  }

  function parseKey(key) {
    const index = String(key).indexOf(":");
    return { kind: key.slice(0, index), id: key.slice(index + 1) };
  }

  // ---- state ------------------------------------------------------------------

  function createCore({ multiple = true, kinds = [], source, describe = null, value = [], recent = [], pageSize = PAGE_SIZE, labels = {} } = {}) {
    const core = {
      id: `item-picker-${++sequence}`,
      multiple,
      kinds,
      labels: { ...KIND_LABELS, ...labels },
      pageSize,
      query: "",
      kindFilter: "all",
      limit: pageSize,
      open: false,
      active: -1,
      value: (Array.isArray(value) ? value : value ? [value] : []).map((ref) => ({ kind: ref.kind, id: String(ref.id) })),
      recent: recent.slice(0, RECENT_LIMIT),
      results: { items: [], total: 0 },
    };

    core.refresh = () => {
      const wanted = core.kindFilter === "all" ? core.kinds : [core.kindFilter];
      const answer = source(core.query, { kinds: wanted, limit: core.limit }) || { items: [], total: 0 };
      let items = (answer.items || []).slice(0, core.limit);
      // With nothing typed, the recently picked come first, even when the
      // source would have listed them further down.
      if (!core.query.trim() && core.recent.length) {
        const order = new Map(core.recent.map((key, index) => [key, index]));
        const recentItems = describe
          ? core.recent.map(parseKey).filter((ref) => wanted.includes(ref.kind)).map(describe).filter(Boolean)
          : [];
        const recentKeys = new Set(recentItems.map(refKey));
        items = [...recentItems, ...items.filter((item) => !recentKeys.has(refKey(item)))]
          .sort((a, b) => (order.has(refKey(a)) ? order.get(refKey(a)) : Infinity) - (order.has(refKey(b)) ? order.get(refKey(b)) : Infinity))
          .slice(0, core.limit);
      }
      core.results = { items, total: Math.max(answer.total || 0, items.length) };
      if (core.active >= core.optionCount()) core.active = core.optionCount() - 1;
      return core.results;
    };

    core.hasMore = () => core.results.total > core.results.items.length;
    core.optionCount = () => core.results.items.length + (core.hasMore() ? 1 : 0);
    core.isSelected = (ref) => core.value.some((entry) => refKey(entry) === refKey(ref));

    core.setQuery = (query) => {
      core.query = String(query || "");
      core.limit = core.pageSize;
      core.open = true;
      core.active = -1;
      core.refresh();
    };

    core.setKindFilter = (kind) => {
      core.kindFilter = kind === "all" || core.kinds.includes(kind) ? kind : "all";
      core.limit = core.pageSize;
      core.active = -1;
      core.refresh();
    };

    core.showMore = () => {
      core.limit += core.pageSize;
      core.refresh();
    };

    // Picks or unpicks a result. Single selection replaces and closes.
    core.choose = (ref) => {
      const key = refKey(ref);
      if (core.multiple) {
        core.value = core.isSelected(ref) ? core.value.filter((entry) => refKey(entry) !== key) : [...core.value, { kind: ref.kind, id: String(ref.id) }];
      } else {
        core.value = [{ kind: ref.kind, id: String(ref.id) }];
        core.open = false;
        core.active = -1;
      }
      core.recent = [key, ...core.recent.filter((entry) => entry !== key)].slice(0, RECENT_LIMIT);
      return true;
    };

    core.remove = (ref) => {
      const before = core.value.length;
      core.value = core.value.filter((entry) => refKey(entry) !== refKey(ref));
      return core.value.length !== before;
    };

    // A key pressed in the box. Returns what happened: "move", "choose",
    // "more", "close", "remove" or "" (nothing; let the key through).
    core.key = (name) => {
      const count = core.optionCount();
      if (name === "ArrowDown") {
        if (!core.open) {
          core.open = true;
          core.refresh();
        }
        core.active = Math.min(core.active + 1, core.optionCount() - 1);
        return "move";
      }
      if (name === "ArrowUp") {
        if (!core.open) return "";
        core.active = Math.max(core.active - 1, 0);
        return "move";
      }
      if (name === "Home" && core.open && count) {
        core.active = 0;
        return "move";
      }
      if (name === "End" && core.open && count) {
        core.active = count - 1;
        return "move";
      }
      if (name === "Enter") {
        if (!core.open || core.active < 0) return "";
        if (core.active >= core.results.items.length) {
          core.showMore();
          return "more";
        }
        core.choose(core.results.items[core.active]);
        return "choose";
      }
      if (name === "Escape") {
        if (!core.open) return "";
        core.open = false;
        core.active = -1;
        return "close";
      }
      if (name === "Backspace" && !core.query && core.value.length) {
        core.value = core.value.slice(0, -1);
        return "remove";
      }
      return "";
    };

    core.optionId = (index) => `${core.id}-option-${index}`;
    core.activeId = () => (core.open && core.active >= 0 ? core.optionId(core.active) : "");
    core.refresh();
    return core;
  }

  // ---- markup --------------------------------------------------------------------

  function chipsHtml(core, describe) {
    if (!core.value.length) return "";
    return core.value.map((ref) => {
      const item = describe(ref);
      const title = item?.title || ref.id;
      return `<li class="item-picker-chip" data-section="${escapeHtml(item?.section || "")}" data-kind="${escapeHtml(ref.kind)}">
        <span class="item-picker-chip-kind">${escapeHtml(item?.kindLabel || core.labels[ref.kind] || ref.kind)}</span>
        <span class="item-picker-chip-title">${escapeHtml(title)}</span>
        ${item ? "" : `<span class="item-picker-chip-missing">${escapeHtml(t("itemPicker.chipsHtml.notFound"))}</span>`}
        <button type="button" class="item-picker-chip-remove" data-remove="${escapeHtml(refKey(ref))}" aria-label="${tHtml("itemPicker.chipsHtml.remove", { title: escapeHtml(title) })}">×</button>
      </li>`;
    }).join("");
  }

  function optionHtml(core, item, index) {
    const selected = core.isSelected(item);
    return `<div role="option" id="${core.optionId(index)}" class="item-picker-option${index === core.active ? " is-active" : ""}" aria-selected="${selected}" data-key="${escapeHtml(refKey(item))}">
      <span class="item-picker-option-line">
        ${item.section ? `<span class="section-dot" data-section="${escapeHtml(item.section)}" aria-hidden="true"></span>` : ""}
        <span class="item-picker-option-title">${escapeHtml(item.title)}</span>
        ${item.statusHtml || (item.statusLabel ? `<span class="item-picker-option-status">${escapeHtml(item.statusLabel)}</span>` : "")}
        ${selected ? `<span class="item-picker-option-check" aria-hidden="true">✓</span>` : ""}
      </span>
      ${item.subtitle ? `<span class="item-picker-option-sub">${escapeHtml(item.subtitle)}</span>` : ""}
    </div>`;
  }

  // The listbox: results grouped by kind, then "Show more" when there is.
  function listHtml(core) {
    if (!core.results.items.length) {
      return `<div class="item-picker-empty" role="presentation">${core.query ? t("itemPicker.listHtml.nothingMatches") : t("itemPicker.listHtml.nothingToPickYet")}</div>`;
    }
    const groups = [];
    core.results.items.forEach((item, index) => {
      let group = groups[groups.length - 1];
      if (!group || group.kind !== item.kind) {
        group = { kind: item.kind, rows: [] };
        groups.push(group);
      }
      group.rows.push(optionHtml(core, item, index));
    });
    const more = core.hasMore()
      ? `<div role="option" id="${core.optionId(core.results.items.length)}" class="item-picker-more${core.active === core.results.items.length ? " is-active" : ""}" aria-selected="false" data-more="1">${tHtml("itemPicker.listHtml.showMoreLeft", { value: core.results.total - core.results.items.length })}</div>`
      : "";
    return groups.map((group, index) => {
      const labelId = `${core.id}-group-${index}`;
      return `<div role="group" aria-labelledby="${labelId}" class="item-picker-group">
        <div id="${labelId}" class="item-picker-group-label" role="presentation">${escapeHtml(core.labels[group.kind] || group.kind)}</div>
        ${group.rows.join("")}
      </div>`;
    }).join("") + more;
  }

  // ---- browser ----------------------------------------------------------------

  const RECENT_STORAGE = "startup-tracker-picker-recent";

  function readRecent(name) {
    try {
      const stored = JSON.parse(root.localStorage.getItem(`${RECENT_STORAGE}:${name}`) || "[]");
      return Array.isArray(stored) ? stored.map(String) : [];
    } catch {
      return [];
    }
  }

  function writeRecent(name, list) {
    try {
      root.localStorage.setItem(`${RECENT_STORAGE}:${name}`, JSON.stringify(list));
    } catch {
      // Remembering recent picks is a convenience only.
    }
  }

  function create(holder, options = {}) {
    const {
      multiple = true,
      kinds = [],
      source,
      describe = () => null,
      value = [],
      onChange = () => {},
      label = t("itemPicker.create.pickRecords"),
      placeholder = t("itemPicker.create.typeToSearch"),
      recentName = "default",
      labels = {},
    } = options;
    const core = createCore({ multiple, kinds, source, describe, value, recent: readRecent(recentName), labels });
    const doc = holder.ownerDocument;
    holder.classList.add("item-picker");
    holder.innerHTML = `
      <ul class="item-picker-chips" aria-label="${tHtml("itemPicker.create.picked", { label: escapeHtml(label) })}"></ul>
      <div class="item-picker-controls">
        ${kinds.length > 1 ? `<select class="item-picker-kind" aria-label="${escapeHtml(t("itemPicker.create.show"))}"><option value="all">${escapeHtml(t("itemPicker.create.all"))}</option>${kinds.map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(core.labels[kind] || kind)}</option>`).join("")}</select>` : ""}
        <input type="text" class="item-picker-input" role="combobox" aria-label="${escapeHtml(label)}" aria-autocomplete="list" aria-expanded="false" aria-controls="${core.id}-listbox" autocomplete="off" placeholder="${escapeHtml(placeholder)}">
      </div>
      <div class="item-picker-listbox" id="${core.id}-listbox" role="listbox" aria-label="${escapeHtml(label)}"${multiple ? ` aria-multiselectable="true"` : ""} hidden></div>
    `;
    const chips = holder.querySelector(".item-picker-chips");
    const input = holder.querySelector(".item-picker-input");
    const listbox = holder.querySelector(".item-picker-listbox");
    const kindSelect = holder.querySelector(".item-picker-kind");

    function drawChips() {
      chips.innerHTML = chipsHtml(core, describe);
    }

    function drawList() {
      listbox.hidden = !core.open;
      input.setAttribute("aria-expanded", String(core.open));
      if (core.activeId()) input.setAttribute("aria-activedescendant", core.activeId());
      else input.removeAttribute("aria-activedescendant");
      if (!core.open) return;
      listbox.innerHTML = listHtml(core);
      listbox.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
    }

    function changed() {
      writeRecent(recentName, core.recent);
      drawChips();
      drawList();
      onChange(core.value.slice());
      holder.dispatchEvent(new root.Event("input", { bubbles: true }));
      holder.dispatchEvent(new root.Event("change", { bubbles: true }));
    }

    input.addEventListener("input", (event) => {
      event.stopPropagation();
      core.setQuery(input.value);
      drawList();
    });
    input.addEventListener("focus", () => {
      if (!core.open) {
        core.open = true;
        core.refresh();
        drawList();
      }
    });
    input.addEventListener("keydown", (event) => {
      const result = core.key(event.key);
      if (!result) return;
      event.preventDefault();
      event.stopPropagation();
      if (result === "choose") {
        if (!multiple) input.value = "";
        changed();
      } else if (result === "remove") changed();
      else drawList();
    });
    listbox.addEventListener("mousedown", (event) => event.preventDefault());
    listbox.addEventListener("click", (event) => {
      const option = event.target.closest("[role=option]");
      if (!option) return;
      if (option.dataset.more) {
        core.showMore();
        drawList();
        return;
      }
      core.choose(parseKey(option.dataset.key));
      if (!multiple) input.value = "";
      changed();
      input.focus();
    });
    chips.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      if (core.remove(parseKey(button.dataset.remove))) changed();
      input.focus();
    });
    kindSelect?.addEventListener("change", (event) => {
      event.stopPropagation();
      core.setKindFilter(kindSelect.value);
      core.open = true;
      drawList();
    });
    // Clicking elsewhere closes the dropdown.
    doc.addEventListener("mousedown", (event) => {
      if (!core.open || holder.contains(event.target)) return;
      core.open = false;
      core.active = -1;
      drawList();
    });
    // Inner controls are the picker's own business; the holder reports the change.
    input.addEventListener("change", (event) => event.stopPropagation());

    drawChips();
    return {
      core,
      getValue: () => core.value.slice(),
      setValue(next) {
        core.value = (Array.isArray(next) ? next : next ? [next] : []).map((ref) => ({ kind: ref.kind, id: String(ref.id) }));
        core.query = "";
        input.value = "";
        core.open = false;
        drawChips();
        drawList();
      },
      refresh() {
        core.refresh();
        drawChips();
        drawList();
      },
      focus: () => input.focus(),
    };
  }

  return { PAGE_SIZE, KIND_LABELS, createCore, chipsHtml, listHtml, refKey, parseKey, create };
});
