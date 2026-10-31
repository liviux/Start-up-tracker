// Extra > Categories: the category library shared by every startup, and this
// startup's choice of which nodes are on (window.StartupTrackerCategoriesEditor).
//
// Names, descriptions, order, new nodes, merges and deletes change the library
// for every startup and go straight to /api/taxonomy. The on/off checkboxes
// are this startup's own and are saved through the page's outbox
// (StartupTrackerPage.setEnabledTaxonomy). Deleting a node that targets use
// asks where they move first; the server repoints them in every startup.
(function () {
  "use strict";

  const Taxonomy = window.StartupTrackerTaxonomy;
  const I18n = window.StartupTrackerI18n;
  const Sections = window.StartupTrackerSections;
  if (!Taxonomy || !I18n) {
    console.error("categories-editor.js needs taxonomy-model.js and i18n.js first.");
    return;
  }
  const t = I18n.t;
  const DESCRIPTION_LIMIT = 400;
  const SECTION_IDS = ["mk", "po", "fu"];

  const ui = { root: null };
  const view = {
    section: "mk",
    query: "",
    open: new Set(),
    // Nodes whose list of targets is open.
    openTargets: new Set(),
    // The node whose edit, add, merge or delete form is open: "edit:<id>" and so on.
    form: "",
    usage: {},
    updates: [],
    status: "",
    statusKind: "",
  };

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

  function page() {
    return window.StartupTrackerPage || null;
  }

  async function request(url, method = "GET", body = null) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify({ ...body, origin: "ui" }) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }

  // Reads the library again and tells the page, which re-renders its tabs
  // and pickers (and reads its records again when targets moved).
  async function reload({ recordsMoved = false } = {}) {
    const payload = await Taxonomy.load();
    view.usage = payload.usage || {};
    view.updates = Array.isArray(payload.updates) ? payload.updates : [];
    await page()?.taxonomyChanged?.({ recordsMoved });
  }

  function say(message, kind = "ok") {
    view.status = message;
    view.statusKind = kind;
  }

  async function run(action, success) {
    try {
      const result = await action();
      say(typeof success === "function" ? success(result) : success);
    } catch (error) {
      say(t("categories.failed", { error: error.message }), "error");
    }
    draw();
  }

  // ---- forms ------------------------------------------------------------------

  function counter(textarea) {
    const out = el("span", { className: "categories-counter", "aria-live": "polite" });
    const update = () => { out.textContent = t("categories.charactersLeft", { count: DESCRIPTION_LIMIT - textarea.value.length }); };
    textarea.addEventListener("input", update);
    update();
    return out;
  }

  function nodeForm({ node = null, parent = null, level }) {
    const name = el("input", { type: "text", maxLength: 80, value: node?.name || "", required: true });
    const shortName = level === "category" ? el("input", { type: "text", maxLength: 24, value: node?.shortName || "" }) : null;
    const description = el("textarea", { maxLength: DESCRIPTION_LIMIT, rows: 3, required: true }, node?.description || "");
    const field = (label, control, extra) => el("label", { className: "categories-field" }, [el("span", { text: label }), control, extra || null]);
    const save = async () => {
      const values = {
        name: name.value.replace(/\s+/g, " ").trim(),
        description: description.value.replace(/\s+/g, " ").trim(),
      };
      if (shortName) values.shortName = shortName.value.trim() || values.name;
      if (!values.name || !values.description) {
        say(t("categories.needsNameAndDescription"), "error");
        draw();
        return;
      }
      view.form = "";
      if (node) {
        await run(async () => {
          await request(`/api/taxonomy/nodes/${encodeURIComponent(node.id)}`, "PATCH", values);
          await reload();
        }, t("categories.saved", { name: values.name }));
      } else {
        await run(async () => {
          const created = await request("/api/taxonomy/nodes", "POST", { ...values, section: view.section, parentId: parent?.id || null });
          // A new node is on in this startup.
          if (Taxonomy.enabledSelection()) await page()?.setEnabledTaxonomy?.({ enabled: [...Taxonomy.enabledSelection().enabled, created.node.id] });
          if (parent) view.open.add(parent.id);
          await reload();
        }, t("categories.added", { name: values.name }));
      }
    };
    return el("form", {
      className: "categories-form",
      on: { submit: (event) => { event.preventDefault(); save(); } },
    }, [
      field(t("categories.name"), name),
      shortName ? field(t("categories.shortName"), shortName, el("span", { className: "categories-hint", text: t("categories.shortNameHint") })) : null,
      field(t("categories.description"), description, counter(description)),
      el("div", { className: "categories-actions" }, [
        el("button", { type: "submit", className: "primary-button", text: node ? t("categories.save") : t("categories.add") }),
        el("button", { type: "button", className: "secondary-button", text: t("categories.cancel"), on: { click: () => { view.form = ""; draw(); } } }),
        node && !node.custom ? el("button", {
          type: "button",
          className: "secondary-button",
          text: t("categories.reset"),
          on: { click: () => {
            view.form = "";
            run(async () => {
              await request(`/api/taxonomy/nodes/${encodeURIComponent(node.id)}/reset`, "POST", {});
              await reload();
            }, t("categories.resetDone", { name: node.name }));
          } },
        }) : null,
      ]),
    ]);
  }

  // Same section and level, outside the node's own branch.
  function otherNodes(node) {
    const own = Taxonomy.descendants(node.id);
    return Taxonomy.all().filter((other) => other.section === node.section && other.level === node.level && !own.has(other.id));
  }

  function nodesOutside(node) {
    const own = Taxonomy.descendants(node.id);
    return Taxonomy.all().filter((other) => other.section === node.section && !own.has(other.id));
  }

  function usedBy(node) {
    let total = 0;
    for (const id of Taxonomy.descendants(node.id)) total += view.usage[id] || 0;
    return total;
  }

  function mergeForm(node) {
    const select = el("select", {}, otherNodes(node).map((other) => el("option", { value: other.id, text: Taxonomy.pathLabel(other.id) })));
    return el("div", { className: "categories-form" }, [
      el("label", { className: "categories-field" }, [el("span", { text: t("categories.mergeInto", { name: node.name }) }), select]),
      el("p", { className: "categories-hint", text: t("categories.mergeHint", { count: view.usage[node.id] || 0 }) }),
      el("div", { className: "categories-actions" }, [
        el("button", {
          type: "button",
          className: "primary-button",
          text: t("categories.merge"),
          disabled: !select.options.length,
          on: { click: () => {
            const into = select.value;
            view.form = "";
            run(async () => {
              const result = await request(`/api/taxonomy/nodes/${encodeURIComponent(node.id)}/merge`, "POST", { into });
              await reload({ recordsMoved: result.moved > 0 });
              return result;
            }, (result) => t("categories.merged", { name: node.name, into: Taxonomy.name(into), count: result.moved }));
          } },
        }),
        el("button", { type: "button", className: "secondary-button", text: t("categories.cancel"), on: { click: () => { view.form = ""; draw(); } } }),
      ]),
    ]);
  }

  function deleteForm(node) {
    const used = usedBy(node);
    const select = used ? el("select", {}, nodesOutside(node).map((other) => el("option", { value: other.id, text: Taxonomy.pathLabel(other.id) }))) : null;
    return el("div", { className: "categories-form categories-danger" }, [
      el("p", { text: used ? t("categories.deleteUsed", { name: node.name, count: used }) : t("categories.deleteUnused", { name: node.name }) }),
      select ? el("label", { className: "categories-field" }, [el("span", { text: t("categories.moveTo") }), select]) : null,
      el("div", { className: "categories-actions" }, [
        el("button", {
          type: "button",
          className: "danger-button",
          text: used ? t("categories.moveAndDelete") : t("categories.delete"),
          on: { click: () => {
            const moveTo = select?.value || "";
            view.form = "";
            run(async () => {
              const result = await request(`/api/taxonomy/nodes/${encodeURIComponent(node.id)}/delete`, "POST", { moveTo });
              await reload({ recordsMoved: result.moved > 0 });
              return result;
            }, (result) => t("categories.deleted", { name: node.name, count: result.moved }));
          } },
        }),
        el("button", { type: "button", className: "secondary-button", text: t("categories.cancel"), on: { click: () => { view.form = ""; draw(); } } }),
      ]),
    ]);
  }

  // ---- tree -------------------------------------------------------------------

  function move(node, delta) {
    const siblings = Taxonomy.children(node.parentId, node.section);
    const index = siblings.findIndex((entry) => entry.id === node.id);
    const other = index + delta;
    if (other < 0 || other >= siblings.length) return;
    const ids = siblings.map((entry) => entry.id);
    [ids[index], ids[other]] = [ids[other], ids[index]];
    run(async () => {
      await request("/api/taxonomy/reorder", "POST", { ids });
      await reload();
    }, t("categories.reordered"));
  }

  function toggleEnabled(node, on) {
    const selection = Taxonomy.toggle(node.id, on);
    page()?.setEnabledTaxonomy?.(selection);
    say(t(on ? "categories.turnedOn" : "categories.turnedOff", { name: node.name }));
    draw();
  }

  function iconButton(label, text, onClick, disabled = false) {
    return el("button", { type: "button", className: "categories-icon-button", "aria-label": label, title: label, disabled, on: { click: onClick } }, text);
  }

  // Which targets of this startup use the node directly. The page owns the
  // records and the record window; the editor only lists and opens them.
  function targetsOf(node) {
    const list = page()?.targetsForNode?.(node.section, node.id);
    return Array.isArray(list) ? list : [];
  }

  function targetsBlock(node) {
    const entries = targetsOf(node);
    const total = view.usage[node.id] || 0;
    return el("div", { className: "categories-targets" }, [
      el("div", { className: "categories-targets-head" }, [
        el("strong", { text: t("categories.targetsTitle", { count: entries.length }) }),
        entries.length < total ? el("span", { className: "categories-hint", text: t("categories.targetsOtherStartups") }) : null,
      ]),
      entries.length
        ? el("ul", {}, entries.map((target) => el("li", {}, el("button", {
          type: "button",
          className: "categories-target",
          title: t("categories.openTarget", { name: target.name }),
          on: { click: () => page()?.openTarget?.(node.section, target.id) },
        }, [
          el("span", { className: "categories-target-name", text: target.name }),
          target.statusLabel ? el("span", { className: "categories-target-status", text: target.statusLabel }) : null,
        ]))))
        : el("p", { className: "categories-hint", text: t("categories.noTargets") }),
    ]);
  }

  function nodeRow(node, matches) {
    const children = Taxonomy.children(node.id, node.section).filter((child) => !matches || matches.has(child.id));
    const expanded = Boolean(matches) || view.open.has(node.id);
    const siblings = Taxonomy.children(node.parentId, node.section);
    const index = siblings.findIndex((entry) => entry.id === node.id);
    const enabled = Taxonomy.isEnabled(node.id);
    const parentOff = node.parentId && !Taxonomy.isEnabled(node.parentId);
    const box = el("input", {
      type: "checkbox",
      checked: enabled,
      disabled: parentOff,
      "aria-label": t("categories.onFor", { name: node.name }),
      title: t("categories.onHint"),
      on: { change: (event) => toggleEnabled(node, event.target.checked) },
    });
    const open = (form) => { view.form = view.form === form ? "" : form; draw(); };
    const targetsOpen = view.openTargets.has(node.id);
    const toggleTargets = () => {
      if (targetsOpen) view.openTargets.delete(node.id);
      else view.openTargets.add(node.id);
      draw();
    };
    const childLevel = node.level === "category" ? "subcategory" : node.level === "subcategory" ? "type" : null;
    const header = el("div", { className: `categories-row${enabled ? "" : " is-off"}` }, [
      children.length || Taxonomy.children(node.id, node.section).length
        ? iconButton(t(expanded ? "taxonomy.collapse" : "taxonomy.expand", { name: node.name }), expanded ? "▾" : "▸", () => {
          if (expanded) view.open.delete(node.id);
          else view.open.add(node.id);
          draw();
        })
        : el("span", { className: "categories-spacer", "aria-hidden": "true" }),
      box,
      el("div", { className: "categories-name" }, [
        el("strong", { text: node.level === "category" && node.shortName && node.shortName !== node.name ? `${node.name} (${node.shortName})` : node.name }),
        node.custom ? el("span", { className: "categories-badge", text: t("categories.custom") }) : null,
        el("button", {
          type: "button",
          className: `categories-usage${targetsOpen ? " is-open" : ""}`,
          title: t("categories.usageHint"),
          "aria-expanded": String(targetsOpen),
          "aria-label": t(targetsOpen ? "categories.hideTargets" : "categories.showTargets", { name: node.name, count: view.usage[node.id] || 0 }),
          text: t("categories.usage", { count: view.usage[node.id] || 0 }),
          on: { click: toggleTargets },
        }),
        el("span", { className: "categories-description", text: node.description }),
      ]),
      el("div", { className: "categories-buttons" }, [
        iconButton(t("categories.moveUp", { name: node.name }), "↑", () => move(node, -1), index <= 0),
        iconButton(t("categories.moveDown", { name: node.name }), "↓", () => move(node, 1), index >= siblings.length - 1),
        el("button", { type: "button", className: "secondary-button", text: t("categories.edit"), on: { click: () => open(`edit:${node.id}`) } }),
        childLevel ? el("button", { type: "button", className: "secondary-button", text: t(childLevel === "subcategory" ? "categories.addSubcategory" : "categories.addType"), on: { click: () => open(`add:${node.id}`) } }) : null,
        el("button", { type: "button", className: "secondary-button", text: t("categories.mergeButton"), on: { click: () => open(`merge:${node.id}`) } }),
        el("button", { type: "button", className: "secondary-button", text: t("categories.delete"), on: { click: () => open(`delete:${node.id}`) } }),
      ]),
    ]);
    let form = null;
    if (view.form === `edit:${node.id}`) form = nodeForm({ node, level: node.level });
    else if (view.form === `add:${node.id}`) form = nodeForm({ parent: node, level: childLevel });
    else if (view.form === `merge:${node.id}`) form = mergeForm(node);
    else if (view.form === `delete:${node.id}`) form = deleteForm(node);
    return el("li", { className: `categories-node level-${node.level}`, dataset: { nodeId: node.id } }, [
      header,
      targetsOpen ? targetsBlock(node) : null,
      form,
      expanded && children.length ? el("ul", {}, children.map((child) => nodeRow(child, matches))) : null,
    ]);
  }

  // ---- library updates, export, import ----------------------------------------

  function updatesBlock() {
    const pending = view.updates.filter((node) => node.section === view.section);
    if (!pending.length) return null;
    const boxes = pending.map((node) => el("input", { type: "checkbox", checked: true, value: node.id }));
    return el("section", { className: "categories-updates" }, [
      el("h4", { text: t("categories.updatesTitle", { count: pending.length }) }),
      el("p", { className: "categories-hint", text: t("categories.updatesHint") }),
      el("ul", {}, pending.map((node, index) => el("li", {}, el("label", { title: node.description }, [boxes[index], ` ${node.parentId ? `${Taxonomy.pathLabel(node.parentId)} > ` : ""}${node.name}`])))),
      el("div", { className: "categories-actions" }, [
        el("button", {
          type: "button",
          className: "primary-button",
          text: t("categories.addSelected"),
          on: { click: () => {
            const ids = boxes.filter((box) => box.checked).map((box) => box.value);
            run(async () => {
              const result = await request("/api/taxonomy/library/accept", "POST", { ids });
              await reload();
              return result;
            }, (result) => t("categories.updatesAdded", { count: result.added.length }));
          } },
        }),
      ]),
    ]);
  }

  function toolsBlock() {
    const file = el("input", { type: "file", accept: "application/json,.json", className: "visually-hidden" });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      run(async () => {
        const library = JSON.parse(await chosen.text());
        const result = await request("/api/taxonomy/import", "POST", { library });
        await reload();
        return result;
      }, (result) => t("categories.imported", { count: result.added.length, skipped: result.skipped }));
      file.value = "";
    });
    return el("div", { className: "categories-tools" }, [
      el("a", { className: "secondary-button", href: "/api/taxonomy/export", download: "startup-tracker-categories.json", text: t("categories.export") }),
      el("label", { className: "secondary-button" }, [file, t("categories.import")]),
      el("span", { className: "categories-hint", text: t("categories.copyHint") }),
    ]);
  }

  // ---- whole view ---------------------------------------------------------------

  function draw() {
    if (!ui.root) return;
    const tabs = el("div", { className: "categories-tabs", role: "tablist", "aria-label": t("categories.sectionsLabel") }, SECTION_IDS.map((id) => el("button", {
      type: "button",
      role: "tab",
      className: "categories-tab section-chip",
      dataset: { section: id },
      "aria-selected": String(view.section === id),
      text: `${Sections?.byId(id)?.short || id.toUpperCase()} · ${t(`sections.${id}.name`)}`,
      on: { click: () => { view.section = id; view.form = ""; draw(); } },
    })));
    const search = el("input", {
      type: "search",
      className: "categories-search",
      placeholder: t("taxonomy.searchPlaceholder"),
      "aria-label": t("taxonomy.searchLabel"),
      value: view.query,
    });
    search.addEventListener("input", () => {
      view.query = search.value;
      drawTree();
      search.focus();
    });
    const tree = el("div", { className: "categories-tree" });
    const status = el("p", { className: "categories-status", role: "status", "aria-live": "polite", dataset: { kind: view.statusKind }, text: view.status });
    const addTop = view.form === "add:" ? nodeForm({ level: "category" }) : el("button", {
      type: "button",
      className: "secondary-button",
      text: t("categories.addCategory"),
      on: { click: () => { view.form = "add:"; draw(); } },
    });

    function drawTree() {
      let matches = null;
      if (view.query.trim()) {
        matches = new Set();
        for (const node of Taxonomy.search(view.section, view.query, { onlyEnabled: false })) for (const entry of Taxonomy.path(node.id)) matches.add(entry.id);
      }
      const roots = Taxonomy.categories(view.section).filter((node) => !matches || matches.has(node.id));
      tree.replaceChildren(roots.length ? el("ul", {}, roots.map((node) => nodeRow(node, matches))) : el("p", { className: "categories-hint", text: t("taxonomy.noMatches") }));
    }

    drawTree();
    // updatesBlock() is null when the library has nothing new.
    ui.root.replaceChildren(...[
      el("p", { className: "categories-intro", text: t("categories.intro") }),
      tabs,
      updatesBlock(),
      el("div", { className: "categories-toolbar" }, [search, addTop]),
      status,
      tree,
      toolsBlock(),
    ].filter(Boolean));
  }

  let loaded = false;

  async function render(root) {
    ui.root = root;
    if (!loaded) {
      loaded = true;
      try {
        const payload = await Taxonomy.load();
        view.usage = payload.usage || {};
        view.updates = Array.isArray(payload.updates) ? payload.updates : [];
      } catch (error) {
        say(t("categories.failed", { error: error.message }), "error");
      }
    }
    draw();
  }

  window.StartupTrackerCategoriesEditor = { render };
})();
