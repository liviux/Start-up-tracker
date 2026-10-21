// A multi-select tree for picking a target's categories, subcategories and
// types (window.StartupTrackerTaxonomyPicker).
//
//   const picker = TaxonomyPicker.create(holder, { section: "mk", value, onChange });
//   // A scope with no primary, where picking nothing means everything:
//   TaxonomyPicker.create(holder, { section, primary: false, emptyText: "All categories" });
//   picker.getValue(); picker.setValue(list);
//
// The picks show as chips, the first one marked as the primary; "Make
// primary" moves another one to the front. Checking a type also records its
// subcategory and category (Taxonomy.normalizeSelection). Only the nodes this
// startup turned on are offered; a pick that is off or unknown stays as a
// chip with a hint, so opening a record never drops it. The holder raises
// "input" and "change" events like a native control.
(function () {
  "use strict";

  const Taxonomy = window.StartupTrackerTaxonomy;
  const I18n = window.StartupTrackerI18n;
  if (!Taxonomy || !I18n) {
    console.error("taxonomy-picker.js needs taxonomy-model.js and i18n.js first.");
    return;
  }
  const t = I18n.t;
  let sequence = 0;

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

  function create(holder, { section, value = [], onChange = () => {}, label = "", primary = true, emptyText = "" } = {}) {
    const id = `taxonomy-picker-${++sequence}`;
    let current = Taxonomy.normalizeSelection(value);
    let query = "";
    const open = new Set();

    holder.classList.add("taxonomy-picker");
    holder.setAttribute("role", "group");
    if (label) holder.setAttribute("aria-label", label);

    const chips = el("ul", { className: "taxonomy-picker-chips", "aria-label": t("taxonomy.picked") });
    const search = el("input", {
      type: "search",
      className: "taxonomy-picker-search",
      placeholder: t("taxonomy.searchPlaceholder"),
      "aria-label": t("taxonomy.searchLabel"),
      autocomplete: "off",
      "aria-controls": `${id}-tree`,
    });
    const tree = el("div", { className: "taxonomy-picker-tree", id: `${id}-tree` });
    holder.replaceChildren(chips, search, tree);

    function emit() {
      onChange(current.slice());
      holder.dispatchEvent(new Event("input", { bubbles: true }));
      holder.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function picks() {
      return Taxonomy.leaves(current);
    }

    function setPicks(list) {
      current = Taxonomy.normalizeSelection(list);
      draw();
      emit();
    }

    function toggle(nodeId, on) {
      const list = picks();
      if (on) {
        // A deeper pick replaces its ancestors; a node already implied by a
        // deeper pick is not added again.
        const ancestors = new Set(Taxonomy.path(nodeId).map((node) => node.id));
        const next = list.filter((entry) => !ancestors.has(entry) || entry === nodeId);
        if (!next.includes(nodeId)) next.push(nodeId);
        setPicks(next);
      } else {
        const removed = Taxonomy.descendants(nodeId);
        setPicks(list.filter((entry) => !removed.has(entry)));
      }
    }

    function chip(nodeId, index) {
      const known = Taxonomy.isKnown(nodeId);
      const off = known && !Taxonomy.isEnabled(nodeId);
      const hint = !known ? t("taxonomy.unknown") : off ? t("taxonomy.disabled") : "";
      const isPrimary = primary && index === 0;
      return el("li", { className: `taxonomy-chip${isPrimary ? " is-primary" : ""}${hint ? " is-flagged" : ""}`, title: known ? Taxonomy.description(nodeId) : t("taxonomy.unknownHelp") }, [
        isPrimary ? el("span", { className: "taxonomy-chip-primary", text: t("taxonomy.primary") }) : null,
        el("span", { className: "taxonomy-chip-name", text: Taxonomy.pathLabel(nodeId) }),
        hint ? el("span", { className: "taxonomy-chip-hint", text: hint }) : null,
        primary && index > 0 ? el("button", {
          type: "button",
          className: "taxonomy-chip-action",
          text: t("taxonomy.makePrimary"),
          "aria-label": t("taxonomy.makePrimaryOf", { name: Taxonomy.name(nodeId) }),
          on: { click: () => setPicks([nodeId, ...picks().filter((entry) => entry !== nodeId)]) },
        }) : null,
        el("button", {
          type: "button",
          className: "taxonomy-chip-remove",
          "aria-label": t("taxonomy.remove", { name: Taxonomy.name(nodeId) }),
          text: "×",
          on: { click: () => setPicks(picks().filter((entry) => entry !== nodeId)) },
        }),
      ]);
    }

    function nodeRow(node, matches) {
      const children = Taxonomy.children(node.id, section, { onlyEnabled: true }).filter((child) => !matches || matches.has(child.id));
      const checked = current.includes(node.id);
      const box = el("input", {
        type: "checkbox",
        checked,
        id: `${id}-${node.id}`,
        on: { change: (event) => toggle(node.id, event.target.checked) },
      });
      const labelNode = el("label", { for: box.id, title: node.description || "" }, [box, el("span", { text: node.level === "category" ? node.name : node.name })]);
      if (!children.length) return el("li", { className: `taxonomy-node level-${node.level}` }, labelNode);
      const expanded = Boolean(matches) || open.has(node.id) || current.some((picked) => picked !== node.id && Taxonomy.path(picked).some((entry) => entry.id === node.id));
      const toggleButton = el("button", {
        type: "button",
        className: "taxonomy-node-toggle",
        "aria-expanded": String(expanded),
        "aria-label": t(expanded ? "taxonomy.collapse" : "taxonomy.expand", { name: node.name }),
        on: { click: () => {
          if (expanded) open.delete(node.id);
          else open.add(node.id);
          draw();
        } },
      }, expanded ? "▾" : "▸");
      return el("li", { className: `taxonomy-node level-${node.level}` }, [
        el("div", { className: "taxonomy-node-row" }, [toggleButton, labelNode]),
        expanded ? el("ul", {}, children.map((child) => nodeRow(child, matches))) : null,
      ]);
    }

    function draw() {
      const list = picks();
      chips.replaceChildren(...(list.length ? list.map(chip) : [el("li", { className: "taxonomy-chip-empty", text: emptyText || t("taxonomy.nonePicked") })]));
      let matches = null;
      if (query.trim()) {
        matches = new Set();
        for (const node of Taxonomy.search(section, query)) for (const entry of Taxonomy.path(node.id)) matches.add(entry.id);
      }
      const roots = Taxonomy.categories(section, { onlyEnabled: true }).filter((node) => !matches || matches.has(node.id));
      tree.replaceChildren(roots.length ? el("ul", {}, roots.map((node) => nodeRow(node, matches))) : el("p", { className: "taxonomy-picker-empty", text: t("taxonomy.noMatches") }));
    }

    search.addEventListener("input", () => {
      query = search.value;
      draw();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });

    draw();
    return {
      getValue: () => current.slice(),
      setValue(list) {
        current = Taxonomy.normalizeSelection(list);
        query = "";
        search.value = "";
        open.clear();
        draw();
      },
      setSection(next) {
        section = next;
        draw();
      },
      refresh: draw,
      focus: () => search.focus(),
    };
  }

  window.StartupTrackerTaxonomyPicker = { create };
})();
