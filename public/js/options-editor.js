// Editors for the shared option lists (js/options.js): Media > Options,
// Feedback > Options, Research links > Groups and the Programs documents
// checklist in Extra > Fields (window.StartupTrackerOptionsEditor).
//
// Each list is edited as a table of rows and saved whole with PUT
// /api/options; "Use the shipped list" removes the edited copy. Removing an
// option never changes a record: records keep the value and show it as
// stored until the option comes back.
(function () {
  "use strict";

  const Options = window.StartupTrackerOptions;
  const Api = window.StartupTrackerApi;
  const I18n = window.StartupTrackerI18n;
  const LinkTypes = window.StartupTrackerLinkTypes;
  if (!Options || !I18n) {
    console.error("options-editor.js needs options.js and i18n.js first.");
    return;
  }
  const t = I18n.t;

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

  // The choices of a list's extra property.
  function extraChoices(spec) {
    if (spec.extra?.key === "block") {
      return Options.FEEDBACK_BLOCKS.map((value) => ({ value, label: t(`options.blocks.${value || "none"}`) }));
    }
    if (spec.extra?.key === "linkType" && LinkTypes) {
      return LinkTypes.TYPES.map((type) => ({ value: type.id, label: I18n.has?.(`linkTypes.types.${type.id}`) ? t(`linkTypes.types.${type.id}`) : type.id }));
    }
    return [];
  }

  async function saveLists(lists) {
    const response = await fetch(Api?.urls?.options || "/api/options", {
      method: "PUT",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists, origin: "ui" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    Options.setDefaults(payload.defaults);
    Options.setStored(payload.stored);
    return payload;
  }

  // One list: rows of label, description and the extra property, with move,
  // remove and add, then Save.
  function listEditor(name, { onSaved }) {
    const spec = Options.specOf(name);
    const choices = extraChoices(spec);
    let rows = Options.list(name).map((option) => ({ ...option }));
    let status = { text: "", kind: "" };
    const wrap = el("section", { className: "options-editor-list", dataset: { optionsList: name } });

    const draw = () => {
      const table = el("ol", { className: "options-editor-rows" }, rows.map((row, index) => {
        const label = el("input", { type: "text", value: row.label || "", maxLength: 80, required: true, "aria-label": t("options.label"), placeholder: t("options.labelPlaceholder") });
        label.addEventListener("input", () => {
          row.label = label.value;
        });
        const description = el("input", { type: "text", value: row.description || "", maxLength: 400, "aria-label": t("options.description"), placeholder: t("options.descriptionPlaceholder") });
        description.addEventListener("input", () => {
          row.description = description.value;
        });
        let extra = null;
        if (choices.length) {
          extra = el("select", { "aria-label": t(`options.extra.${spec.extra.key}`) }, choices.map((choice) => el("option", { value: choice.value, text: choice.label, selected: (row[spec.extra.key] || "") === choice.value })));
          extra.addEventListener("change", () => {
            row[spec.extra.key] = extra.value;
          });
        }
        const move = (offset) => () => {
          const target = index + offset;
          if (target < 0 || target >= rows.length) return;
          [rows[index], rows[target]] = [rows[target], rows[index]];
          draw();
        };
        return el("li", { className: "options-editor-row" }, [
          el("span", { className: "options-editor-id", title: t("options.idHint"), text: row.id || t("options.newId") }),
          label,
          description,
          extra,
          el("div", { className: "options-editor-actions" }, [
            el("button", { type: "button", className: "icon-button", "aria-label": t("options.moveUp", { name: row.label || "" }), disabled: index === 0, text: "↑", on: { click: move(-1) } }),
            el("button", { type: "button", className: "icon-button", "aria-label": t("options.moveDown", { name: row.label || "" }), disabled: index === rows.length - 1, text: "↓", on: { click: move(1) } }),
            el("button", { type: "button", className: "icon-button danger-hover", "aria-label": t("options.remove", { name: row.label || "" }), text: "×", on: { click: () => {
              rows.splice(index, 1);
              draw();
            } } }),
          ]),
        ]);
      }));
      const save = async () => {
        const taken = rows.map((row) => row.id).filter(Boolean);
        const list = rows.map((row) => {
          const clean = { ...row, label: String(row.label || "").trim() };
          if (!clean.id && clean.label) {
            clean.id = Options.idFromLabel(clean.label, taken);
            taken.push(clean.id);
          }
          return clean;
        });
        try {
          Options.validateList(name, list);
          await saveLists({ [name]: list });
          rows = Options.list(name).map((option) => ({ ...option }));
          status = { text: t("options.saved"), kind: "ok" };
          onSaved?.(name);
        } catch (error) {
          status = { text: error.message, kind: "error" };
        }
        draw();
      };
      const reset = async () => {
        if (!(await window.StartupTrackerDialog.confirm(t("options.resetConfirm"), { danger: true }))) return;
        try {
          await saveLists({ [name]: null });
          rows = Options.list(name).map((option) => ({ ...option }));
          status = { text: t("options.resetDone"), kind: "ok" };
          onSaved?.(name);
        } catch (error) {
          status = { text: error.message, kind: "error" };
        }
        draw();
      };
      wrap.replaceChildren(
        el("h4", { text: t(`options.lists.${name}.title`) }),
        el("p", { className: "settings-hint", text: t(`options.lists.${name}.hint`) }),
        table,
        el("div", { className: "settings-row-actions" }, [
          el("button", { type: "button", className: "secondary-button compact", text: t("options.add"), on: { click: () => {
            rows.push({ id: "", label: "", description: "", ...(spec.extra ? { [spec.extra.key]: choices[0]?.value || "" } : {}) });
            draw();
            wrap.querySelector(".options-editor-row:last-child input")?.focus();
          } } }),
          el("button", { type: "button", className: "primary-button compact", text: t("options.save"), on: { click: save } }),
          Options.isEdited(name) ? el("button", { type: "button", className: "secondary-button compact", text: t("options.reset"), on: { click: reset } }) : null,
        ]),
        el("p", { className: `fields-editor-status${status.kind ? ` is-${status.kind}` : ""}`, role: "status", text: status.text }),
      );
    };
    draw();
    return wrap;
  }

  // Draws the editors of `lists` into `container`, replacing what was there.
  function render(container, lists, { onSaved } = {}) {
    if (!container) return;
    container.replaceChildren(...lists.map((name) => listEditor(name, { onSaved })));
  }

  window.StartupTrackerOptionsEditor = Object.freeze({ render });
})();
