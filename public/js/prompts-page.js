// Extra > Prompts (window.StartupTrackerPromptsPage).
//
// The shipped prompts, presets and example library are in content/prompts/.
// What you change or add is shared by every startup and kept in the global
// scope: "prompts" (your prompts, and your edits of a built-in one under its
// id), "promptPresets" and "promptExamples". Each startup brings its own
// profile values, {{CONSTRAINTS}} among them.
//
// A preset sets the prompt, the section, the categories and the examples.
// The page fills every {{VARIABLE}} with js/prompt-render.js and copies the
// result; {{TRACKER_ACCESS}} tells the agent how to save its work, with a
// limited token made at the moment you copy (lib/agent-tokens.js).
//
// UMD: the pure parts run under Node for tests (module.exports); the browser
// gets window.StartupTrackerPromptsPage with create(root, hooks) as well.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerPromptsPage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const SECTIONS = Object.freeze(["mk", "po", "fu"]);
  const TABS = Object.freeze({ mk: "MK", po: "PO", fu: "FU" });
  const PRESET_GROUPS = Object.freeze(["mk", "po", "fu", "general"]);
  const EXAMPLE_VARIABLES = Object.freeze(["SEARCH_FOCUS", "VERIFIED_ACTIVITY", "AVOID", "SPECIAL_SCHEDULE"]);
  // An example asking for text before each run, such as the topic of
  // "Research a topic".
  const PLACEHOLDER = /\[write it here before running\]/gi;
  const HAS_PLACEHOLDER = /\[write it here before running\]/i;
  const PACK_FORMAT = "startup-tracker-prompts";

  // ---- the library -------------------------------------------------------------

  const byId = (list) => new Map((Array.isArray(list) ? list : []).filter((entry) => entry && entry.id).map((entry) => [String(entry.id), entry]));

  // Shipped and stored, merged: a stored entry with a shipped id is your edit
  // of it and wins; the rest are your own.
  function library({ shipped = {}, stored = {} } = {}) {
    const merge = (base, mine, mark) => {
      const own = byId(mine);
      const merged = (Array.isArray(base) ? base : []).map((entry) => {
        const edit = own.get(String(entry.id));
        return edit ? { ...entry, ...edit, [mark]: true, edited: true, shipped: entry } : { ...entry, [mark]: true, edited: false, shipped: entry };
      });
      const shippedIds = new Set(merged.map((entry) => String(entry.id)));
      for (const entry of own.values()) if (!shippedIds.has(String(entry.id))) merged.push({ ...entry, [mark]: false, edited: false });
      return merged;
    };
    return {
      prompts: merge(shipped.prompts, stored.prompts, "builtIn"),
      presets: merge(shipped.presets, stored.presets, "builtIn"),
      examples: merge(shipped.examples, stored.examples, "builtIn"),
    };
  }

  // A preset is hidden when every category it names is turned off here.
  function presetVisible(preset, isEnabled) {
    const nodes = preset?.scope?.coverage === "nodes" ? preset.scope.taxonomy || [] : [];
    return !nodes.length || nodes.some((id) => isEnabled(id));
  }

  // The examples a preset picks, with the section-specific ones of a general
  // preset in place of the shared ones for that variable.
  function presetExamples(preset, section) {
    const out = {};
    for (const name of EXAMPLE_VARIABLES) {
      const specific = preset?.examplesBySection?.[section]?.[name];
      out[name] = [...(Array.isArray(specific) ? specific : preset?.examples?.[name] || [])];
    }
    return out;
  }

  // ---- scope ---------------------------------------------------------------------

  // The tree's picks as three lists, ["all"] where nothing narrows a level.
  function scopeFromPicks(section, picks, Taxonomy) {
    const level = (id) => Taxonomy.get(id)?.level;
    const categories = picks.filter((id) => level(id) === "category");
    if (!categories.length) return { categories: ["all"], subcategories: ["all"], types: ["all"] };
    const pickedSubs = picks.filter((id) => level(id) === "subcategory");
    const pickedTypes = picks.filter((id) => level(id) === "type");
    const within = (list, parentId, childLevel) => {
      const mine = list.filter((id) => Taxonomy.inBranch([id], parentId));
      return mine.length ? mine : Taxonomy.children(parentId, section, { onlyEnabled: true }).filter((node) => node.level === childLevel).map((node) => node.id);
    };
    const subcategories = categories.flatMap((id) => within(pickedSubs, id, "subcategory"));
    const types = subcategories.flatMap((id) => within(pickedTypes, id, "type"));
    return {
      categories,
      subcategories: pickedSubs.length ? subcategories : ["all"],
      types: pickedTypes.length ? types : ["all"],
    };
  }

  // The other way: the fewest picks that mean the same scope.
  function picksFromScope(section, scope, Taxonomy) {
    const list = (value) => (Array.isArray(value) ? value : [value || "all"]).filter((id) => id && id !== "all");
    const categories = list(scope.categories);
    if (!categories.length) return [];
    const collapse = (picked, parentId) => {
      const children = Taxonomy.children(parentId, section, { onlyEnabled: true }).map((node) => node.id);
      const mine = picked.filter((id) => children.includes(id));
      return mine.length && mine.length < children.length ? mine : [];
    };
    const picks = [];
    for (const categoryId of categories) {
      const subs = collapse(list(scope.subcategories), categoryId);
      if (!subs.length) {
        picks.push(categoryId);
        continue;
      }
      for (const subId of subs) {
        const types = collapse(list(scope.types), subId);
        picks.push(...(types.length ? types : [subId]));
      }
    }
    return picks;
  }

  function formatItemNames(names) {
    if (!names || !names.length) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  // "Alpha and Beta" for a few, "all except Gamma" for most, the plural label
  // for all or none.
  function formatSmartSelectionList(selectedIds, allItems, pluralLabel) {
    const items = (Array.isArray(allItems) ? allItems : [])
      .filter((item) => item && (item.id != null || item.name != null))
      .map((item) => ({ id: String(item.id != null ? item.id : item.name), name: String(item.name != null ? item.name : item.id) }));
    const ids = Array.isArray(selectedIds) ? selectedIds : (selectedIds ? [selectedIds] : []);
    if (!items.length || !ids.length || ids.includes("all")) return pluralLabel;
    const chosen = new Set(ids.map(String));
    const selected = items.filter((item) => chosen.has(item.id));
    const unselected = items.filter((item) => !chosen.has(item.id));
    if (!selected.length) return pluralLabel;
    if (selected.length === items.length) return items.length === 1 ? selected[0].name : pluralLabel;
    if (selected.length <= items.length / 2) return formatItemNames(selected.map((item) => item.name));
    return `all except ${formatItemNames(unselected.map((item) => item.name))}`;
  }

  // TAB, CATEGORY, SUBCATEGORY, TYPE and SCOPE_DETAILS for a section and its
  // picks. A level the section does not use is left empty, so its line goes.
  function scopeValues(section, picks, Taxonomy) {
    // The rules read the picks with their parents, as the tree implies them.
    const scope = scopeFromPicks(section, Taxonomy.normalizeSelection ? Taxonomy.normalizeSelection(picks) : picks, Taxonomy);
    const nodesOf = (parents, levelName) => parents.flatMap((id) => Taxonomy.children(id, section, { onlyEnabled: true }).filter((node) => node.level === levelName));
    const categories = Taxonomy.categories(section, { onlyEnabled: true });
    const chosenCategories = scope.categories.includes("all") ? categories.map((node) => node.id) : scope.categories;
    const subcategories = nodesOf(chosenCategories, "subcategory");
    const chosenSubs = scope.subcategories.includes("all") ? subcategories.map((node) => node.id) : scope.subcategories;
    const types = nodesOf(chosenSubs, "type");
    const named = (list) => list.map((node) => ({ id: node.id, name: Taxonomy.name(node.id) }));
    const details = (Taxonomy.leaves ? Taxonomy.leaves(picks) : picks)
      .map((id) => {
        const text = Taxonomy.description(id);
        return text ? `- ${Taxonomy.pathLabel(id)}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return {
      TAB: TABS[section] || "",
      CATEGORY: formatSmartSelectionList(scope.categories, named(categories), "all categories"),
      SUBCATEGORY: subcategories.length ? formatSmartSelectionList(scope.subcategories, named(subcategories), "all subcategories") : "",
      TYPE: types.length ? formatSmartSelectionList(scope.types, named(types), "all types") : "",
      SCOPE_DETAILS: details,
    };
  }

  // ---- values ----------------------------------------------------------------------

  // One bullet per selected example, with the run's own text last. A
  // "[write it here before running]" in an example takes the text typed for it.
  function exampleValue(examples, ids, { extra = "", fills = {} } = {}) {
    const known = byId(examples);
    const parts = (Array.isArray(ids) ? ids : []).map((id) => {
      const example = known.get(String(id));
      if (!example) return "";
      const fill = String(fills[example.id] || "").trim();
      return fill ? example.text.replace(PLACEHOLDER, fill) : example.text;
    });
    if (String(extra || "").trim()) parts.push(String(extra).trim());
    return parts.filter(Boolean).map((text) => `- ${text}`).join("\n  ");
  }

  // Values from the startup profile and the settings.
  function profileValues(profile = {}, { startupName = "", timeZone = "", today = "", linkLabel = (type) => type } = {}) {
    const links = (Array.isArray(profile.links) ? profile.links : []).filter((link) => link && link.url).map((link) => `- ${link.label || linkLabel(link.type)}: ${link.url}`);
    const cap = Number(profile.maxNewTargetsPerDay);
    return {
      STARTUP_NAME: String(profile.name || startupName || "").trim(),
      STARTUP_ONE_LINER: String(profile.oneLiner || "").trim(),
      STARTUP_DESCRIPTION: String(profile.description || "").trim(),
      STARTUP_WEBSITE: String(profile.website || "").trim(),
      STARTUP_LINKS: links.join("\n  "),
      SECTOR: String(profile.industry || "").trim(),
      CONSTRAINTS: String(profile.aiContext || "").trim().split("\n").join("\n  "),
      COUNTRY: String(profile.country || "").trim(),
      ENTITY_TYPE: String(profile.entityType || "").trim(),
      HOME_REGION: String(profile.homeRegion || "").trim(),
      MAX_TARGETS_PER_DAY: Number.isInteger(cap) && cap > 0 ? String(cap) : "10",
      TODAY: today,
      TIMEZONE: timeZone,
    };
  }

  // {{TRACKER_ACCESS}}: "agent" for an agent that runs commands, "chat" for a
  // chat without tools, "run" for a run started from the tracker (Part 13),
  // whose agent gets the tracker tools. The token is made when the prompt is
  // copied; the preview shows where it will go.
  function trackerAccess(mode, { baseUrl = "", startupId = "", startupName = "", token = "", expiresAt = "", formatExample = null } = {}) {
    if (mode === "run") {
      return [
        "Save your work with the tracker tools of the \"tracker\" MCP server this run gives you. Do not edit files to change the tracker.",
        `- Startup: ${startupName} (id \`${startupId}\`). The tools work on this startup only.`,
        "- Start with get_startup_context, get_taxonomy and get_calendar_load.",
        "- Before create_target, look for the same target with search_targets, by name and by web address. If it exists, read it with get_target and change it with update_target (pass its revision), or add to its notes with append_note.",
        "- create_target and update_target take category ids from get_taxonomy; give several when a target fits more than one. link_records links two records.",
        "- Nothing can be deleted. Each change is saved at once and marked with this run.",
      ].join("\n");
    }
    if (mode === "chat") {
      return [
        "You cannot change the tracker yourself. End your reply with the targets as one JSON block in this format, so they can be checked and imported with \"Import AI results\":",
        "",
        "```json",
        formatExample ? formatExample() : "{ \"targets\": [] }",
        "```",
        "",
        "Use \"section\" mk (Marketing), po (Programs) or fu (Funding). Besides the keys shown you may use any field of that section from the field list; leave out what you could not verify.",
      ].join("\n");
    }
    const shownToken = token || "<a new token is made when you copy this prompt>";
    const until = expiresAt ? ` It stops working at ${expiresAt}.` : " It stops working 24 hours after it is made.";
    return [
      `Save your work through the tracker's HTTP API at ${baseUrl} (it runs on this computer).`,
      `- Startup: ${startupName} (id \`${startupId}\`). Change only this startup.`,
      `- Token: \`${shownToken}\`. It can add and update targets of this startup and link records there, and nothing else.${until}`,
      `- Read the data: \`curl -s ${baseUrl}/api/s/${startupId}/state\` returns \`state\` (\`items\` is Marketing, \`programs\` Programs, \`funding\` Funding, \`links\` the links) and \`revisionMap\`.`,
      `- Read the fields, categories and statuses: \`${baseUrl}/api/fields\`, \`${baseUrl}/api/taxonomy\`, \`${baseUrl}/api/statuses\`.`,
      "- Add or update records:",
      `  \`curl -s -X PATCH ${baseUrl}/api/s/${startupId}/state/operations -H "Authorization: Bearer ${shownToken}" -H "Content-Type: application/json" -d '{"protocolVersion":3,"operations":[{"type":"upsert","section":"items","id":"<new unique id>","value":{...},"baseRevision":0}]}'\``,
      "  A new record needs a new unique id and \"baseRevision\": 0. To update one, send the whole record with its current revision from revisionMap.records.<section>.<id>. An answer of 409 means it changed meanwhile: read it again and retry.",
      "- Record keys: the basics under their names (name, organization, link, status, priority, nextActionDate, nextActionTime, nextAction, deadline, owner, campaignId, tags), the section's fields under \"details\", categories in \"taxonomy\" as a list of category ids, the notes in \"notes\" as Markdown, and anything no field covers in \"customFields\" as a list of {\"label\": \"...\", \"value\": \"...\"}.",
      "- Dated entries go in \"timeline\", a list of {\"id\", \"date\", \"type\", \"title\", \"outcome\", \"notes\"}: type \"key-date\" for a date ahead, which shows on the calendar, or what happened (\"sent\", \"reply\", \"meeting\", \"decision\", \"other\").",
      "- A link between two records is a record in \"links\": {\"id\": \"<new id>\", \"a\": {\"kind\": \"mk\", \"id\": \"...\"}, \"b\": {\"kind\": \"po\", \"id\": \"...\"}, \"relation\": \"related\"}.",
    ].join("\n");
  }

  // ---- prompt packs ----------------------------------------------------------------

  function exportPack(stored) {
    return {
      format: PACK_FORMAT,
      version: 1,
      prompts: Array.isArray(stored.prompts) ? stored.prompts : [],
      presets: Array.isArray(stored.presets) ? stored.presets : [],
      examples: Array.isArray(stored.examples) ? stored.examples : [],
    };
  }

  // Checks a pack and merges it into what is stored: entries with a new id
  // are added, entries with a known id replace it. Returns the merged lists
  // and how many of each were added or replaced.
  function importPack(pack, stored) {
    if (!pack || typeof pack !== "object" || pack.format !== PACK_FORMAT) throw new Error("This is not a prompt pack exported from Startup Tracker.");
    const check = (list, name, valid) => {
      if (list === undefined) return [];
      if (!Array.isArray(list)) throw new Error(`"${name}" must be a list.`);
      list.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || !String(entry.id || "").trim()) throw new Error(`${name}[${index}] needs an id.`);
        const problem = valid(entry);
        if (problem) throw new Error(`${name}[${index}]: ${problem}`);
      });
      return list;
    };
    const incoming = {
      prompts: check(pack.prompts, "prompts", (entry) => (typeof entry.body !== "string" || !String(entry.name || "").trim() ? "a prompt needs a name and a body" : "")),
      presets: check(pack.presets, "presets", (entry) => (!String(entry.name || "").trim() ? "a preset needs a name" : "")),
      examples: check(pack.examples, "examples", (entry) => (!EXAMPLE_VARIABLES.includes(entry.variable) || typeof entry.text !== "string" ? `an example needs a variable (${EXAMPLE_VARIABLES.join(", ")}) and a text` : "")),
    };
    const counts = { added: 0, replaced: 0 };
    const merged = {};
    for (const key of ["prompts", "presets", "examples"]) {
      const current = Array.isArray(stored[key]) ? stored[key] : [];
      const map = new Map(current.map((entry) => [String(entry.id), entry]));
      for (const entry of incoming[key]) {
        counts[map.has(String(entry.id)) ? "replaced" : "added"] += 1;
        map.set(String(entry.id), { ...entry, id: String(entry.id) });
      }
      merged[key] = [...map.values()];
    }
    return { merged, counts };
  }

  // ---- the page (browser) ----------------------------------------------------------

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  async function loadShipped(fetchImpl) {
    const read = (name) => fetchImpl(`/content/prompts/${name}.json`, { cache: "no-cache" }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    const [builtIn, presets, examples, variables, tips] = await Promise.all(["built-in", "presets", "examples", "variables", "constraints-tips"].map(read));
    return { prompts: builtIn.prompts, presets: presets.presets, examples: examples.examples, variables: variables.variables, tips };
  }

  // hooks: t, shared() -> { prompts, presets, examples }, saveShared(changes,
  // message), deletePrompt(id), profile(), startupName(), startupId,
  // timeZone(), today(), Taxonomy, TaxonomyPicker, Fields, PromptRender,
  // AiImport, renderMarkdown(text), plainText(markdown), copyText(text),
  // createToken() -> { token, expiresAt }, checkImport(entries) -> rows,
  // importRows(rows) -> count, linkLabel(type), openProfile(), loadUi(),
  // saveUi(ui), formatTimestamp(iso).
  function create(container, hooks) {
    const t = hooks.t;
    let shipped = null;
    let loadError = "";
    const saved = hooks.loadUi?.() || {};
    const ui = {
      presetId: saved.presetId || "",
      promptId: saved.promptId || "target-research",
      section: SECTIONS.includes(saved.section) ? saved.section : "mk",
      picks: Array.isArray(saved.picks) ? saved.picks : [],
      selections: saved.selections && typeof saved.selections === "object" ? saved.selections : {},
      extra: saved.extra && typeof saved.extra === "object" ? saved.extra : {},
      fills: saved.fills && typeof saved.fills === "object" ? saved.fills : {},
      mode: saved.mode === "chat" ? "chat" : "agent",
      view: "preview",
      runsScope: saved.runsScope === "all" ? "all" : "preset",
      presetQuery: "",
      openGroups: saved.openGroups && typeof saved.openGroups === "object" ? saved.openGroups : {},
      openRunId: "",
      showAll: false,
      presetDirty: Boolean(saved.presetDirty),
      draft: null,
      message: "",
      importRows: null,
      importText: "",
    };

    const remember = () => hooks.saveUi?.({ presetId: ui.presetId, promptId: ui.promptId, section: ui.section, picks: ui.picks, selections: ui.selections, extra: ui.extra, fills: ui.fills, mode: ui.mode, runsScope: ui.runsScope, openGroups: ui.openGroups, presetDirty: ui.presetDirty });

    function lib() {
      return library({ shipped: shipped || {}, stored: hooks.shared() });
    }

    function currentPrompt(all = lib()) {
      return all.prompts.find((prompt) => prompt.id === ui.promptId) || all.prompts[0] || null;
    }

    function values(all, { token = "", expiresAt = "", mode = ui.mode } = {}) {
      const out = {
        ...profileValues(hooks.profile() || {}, { startupName: hooks.startupName(), timeZone: hooks.timeZone(), today: hooks.today(), linkLabel: hooks.linkLabel }),
        ...scopeValues(ui.section, ui.picks, hooks.Taxonomy),
        TRACKER_ACCESS: trackerAccess(mode, { baseUrl: root.location?.origin || "", startupId: hooks.startupId, startupName: hooks.startupName(), token, expiresAt, formatExample: hooks.AiImport?.formatExample }),
      };
      for (const name of EXAMPLE_VARIABLES) out[name] = exampleValue(all.examples, ui.selections[name], { extra: ui.extra[name], fills: ui.fills });
      return out;
    }

    function rendered(all, options) {
      const prompt = currentPrompt(all);
      if (!prompt) return { text: "", unresolved: [], used: [] };
      return hooks.PromptRender.render(ui.draft !== null ? ui.draft.body : prompt.body, values(all, options));
    }

    function applyPreset(preset) {
      ui.presetId = preset.id;
      ui.promptId = preset.promptId || "target-research";
      if (preset.section !== "general" && SECTIONS.includes(preset.section)) ui.section = preset.section;
      const coverage = preset.scope?.coverage;
      if (coverage === "nodes") ui.picks = (preset.scope.taxonomy || []).filter((id) => hooks.Taxonomy.get(id) && hooks.Taxonomy.isEnabled(id));
      else if (coverage === "allEnabled") ui.picks = [];
      ui.selections = presetExamples(preset, ui.section);
      ui.extra = {};
      ui.draft = null;
      ui.view = "preview";
      ui.presetQuery = "";
      ui.presetDirty = false;
      ui.message = "";
      remember();
      draw();
    }

    // ---- drawing ----

    function presetMatches(preset, query) {
      if (!query) return true;
      return [preset.name, preset.code, preset.description, preset.whenToUse]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    }

    function visiblePresets(all) {
      const query = ui.presetQuery.trim().toLowerCase();
      return all.presets.filter((preset) => (ui.showAll || presetVisible(preset, (id) => hooks.Taxonomy.isEnabled(id))) && presetMatches(preset, query));
    }

    function hiddenPresetCount(all) {
      return all.presets.filter((preset) => !presetVisible(preset, (id) => hooks.Taxonomy.isEnabled(id))).length;
    }

    function libraryGroups(all) {
      const visible = new Set(visiblePresets(all).map((preset) => preset.id));
      const groups = PRESET_GROUPS.map((group) => {
        const list = all.presets.filter((preset) => (preset.section || "general") === group && visible.has(preset.id));
        if (!list.length) return "";
        return `
          <div class="prompt-library-group" data-section="${group}">
            <h4><span class="prompt-library-dot" aria-hidden="true"></span>${escapeHtml(t(`prompts.groups.${group}`))}<span class="prompt-library-group-count">${list.length}</span></h4>
            <div class="prompt-library-list">
              ${list.map((preset) => `
                <button type="button" class="prompt-library-item${preset.id === ui.presetId ? " is-active" : ""}" data-preset="${escapeHtml(preset.id)}" aria-pressed="${preset.id === ui.presetId}" title="${escapeHtml([preset.name, preset.description, preset.whenToUse ? `${t("prompts.whenToUse")}: ${preset.whenToUse}` : ""].filter(Boolean).join("\n"))}">
                  ${preset.code ? `<span class="prompt-code">${escapeHtml(preset.code)}</span>` : ""}
                  <span class="prompt-library-name">${escapeHtml(preset.name)}</span>
                  ${preset.builtIn ? "" : `<span class="prompt-library-own">${escapeHtml(t("prompts.yours"))}</span>`}
                </button>`).join("")}
            </div>
          </div>`;
      }).join("");
      const query = ui.presetQuery.trim();
      return groups || `<p class="prompt-library-empty">${escapeHtml(query ? t("prompts.noSearchResults", { query }) : t("prompts.noPresets"))}</p>`;
    }

    function libraryRail(all) {
      const count = visiblePresets(all).length;
      const hidden = hiddenPresetCount(all);
      return `
        <aside class="prompt-library" aria-label="${escapeHtml(t("prompts.presets"))}">
          <div class="prompt-library-head">
            <div class="prompt-library-title"><h4>${escapeHtml(t("prompts.presets"))}</h4><span class="prompt-library-count">${count}</span></div>
            <label class="prompt-library-search">
              <svg aria-hidden="true"><use href="#icon-search"></use></svg>
              <input type="search" data-preset-search value="${escapeHtml(ui.presetQuery)}" placeholder="${escapeHtml(t("prompts.searchPresets"))}" aria-label="${escapeHtml(t("prompts.searchPresets"))}">
            </label>
          </div>
          <div class="prompt-library-body">${libraryGroups(all)}</div>
          <div class="prompt-library-foot">
            ${hidden > 0 || ui.showAll ? `<button type="button" class="text-button" data-prompt-action="toggle-all">${escapeHtml(ui.showAll ? t("prompts.hideOff") : t("prompts.showAll", { count: hidden }))}</button>` : ""}
          </div>
        </aside>`;
    }

    function selectedExampleTotal() {
      return EXAMPLE_VARIABLES.reduce((total, name) => total + (Array.isArray(ui.selections[name]) ? ui.selections[name].length : 0), 0);
    }

    function metaChips(all) {
      const prompt = currentPrompt(all);
      const scope = scopeValues(ui.section, ui.picks, hooks.Taxonomy);
      const items = [
        `<span class="prompt-meta-chip prompt-meta-section" data-section="${ui.section}"><span class="prompt-library-dot" aria-hidden="true"></span>${escapeHtml(t(`prompts.groups.${ui.section}`))}</span>`,
        `<span class="prompt-meta-chip" title="${escapeHtml(scope.CATEGORY)}">${escapeHtml(scope.CATEGORY)}</span>`,
      ];
      const examples = selectedExampleTotal();
      if (examples) items.push(`<span class="prompt-meta-chip">${escapeHtml(t("prompts.metaExamples", { count: examples }))}</span>`);
      if (ui.presetId && ui.presetDirty) items.push(`<span class="prompt-meta-chip prompt-meta-edited">${escapeHtml(t("prompts.editedPreset"))}</span>`);
      if (prompt?.edited) items.push(`<span class="prompt-meta-chip prompt-meta-yours">${escapeHtml(t("prompts.yours"))}</span>`);
      return items.join("");
    }

    function workbenchHeader(all) {
      const preset = all.presets.find((entry) => entry.id === ui.presetId);
      const prompt = currentPrompt(all);
      const title = preset?.name || prompt?.name || t("prompts.untitled");
      const sentence = (text) => {
        const value = String(text || "").trim();
        return value && !/[.!?]$/.test(value) ? `${value}.` : value;
      };
      const about = preset
        ? [sentence(preset.description), preset.whenToUse ? `${t("prompts.whenToUse")}: ${sentence(preset.whenToUse)}` : "", sentence(preset.note)].filter(Boolean).join(" ")
        : t("prompts.customSetupHint");
      const eyebrow = preset
        ? `<p class="prompt-eyebrow" data-section="${preset.section || "general"}"><span class="prompt-library-dot" aria-hidden="true"></span>${escapeHtml(t("prompts.presetEyebrow", { section: t(`prompts.groups.${preset.section || "general"}`) }))}</p>`
        : `<p class="prompt-eyebrow">${escapeHtml(t("prompts.customSetup"))}</p>`;
      return `
        <header class="prompt-workbench-head">
          <div class="prompt-workbench-title">
            ${eyebrow}
            <h3>${escapeHtml(title)}</h3>
            <p class="prompt-workbench-about">${escapeHtml(about)}</p>
          </div>
          <div class="prompt-workbench-actions">
            <button type="button" class="secondary-button compact" data-prompt-action="save-preset">${escapeHtml(t("prompts.savePreset"))}</button>
            ${preset && !preset.builtIn ? `<button type="button" class="text-button danger-text" data-prompt-action="delete-preset">${escapeHtml(t("prompts.deletePreset"))}</button>` : ""}
          </div>
        </header>`;
    }

    function promptTabs() {
      const entries = [["preview", "prompts.preview"], ["edit", "prompts.edit"], ["setup", "prompts.setup"], ["runs", "prompts.runs"]];
      return `
        <div class="prompt-tabs" role="tablist" aria-label="${escapeHtml(t("prompts.pageTabs"))}">
          ${entries.map(([id, key]) => `
            <button type="button" role="tab" id="promptTab-${id}" aria-controls="promptPanel" aria-selected="${ui.view === id}" class="${ui.view === id ? "active" : ""}" data-prompt-view="${id}">
              ${escapeHtml(t(key))}${id === "runs" ? `<span class="prompt-tab-badge" data-agent-run-count hidden></span>` : ""}
            </button>`).join("")}
        </div>`;
    }

    function previewPanel(all) {
      const result = rendered(all);
      const placeholderLeft = HAS_PLACEHOLDER.test(result.text);
      const warnings = [
        ...(result.unresolved.length ? [t("prompts.unresolved", { names: result.unresolved.map((name) => `{{${name}}}`).join(", ") })] : []),
        ...(placeholderLeft ? [t("prompts.placeholderLeft")] : []),
      ];
      return `
        <div class="prompt-panel-inner prompt-preview-panel">
          <div class="prompt-preview-bar">
            <label class="prompt-mode-inline"><span>${escapeHtml(t("prompts.mode"))}</span>
              <select data-prompt-mode aria-label="${escapeHtml(t("prompts.mode"))}">
                <option value="agent" ${ui.mode === "agent" ? "selected" : ""}>${escapeHtml(t("prompts.modeAgent"))}</option>
                <option value="chat" ${ui.mode === "chat" ? "selected" : ""}>${escapeHtml(t("prompts.modeChat"))}</option>
              </select>
            </label>
            <div class="prompt-actions">
              <button type="button" class="text-button" data-prompt-action="import-results">${escapeHtml(t("prompts.importResults"))}</button>
              <button type="button" class="secondary-button compact" data-prompt-action="copy-markdown">${escapeHtml(t("prompts.copyMarkdown"))}</button>
              <button type="button" class="secondary-button compact" data-prompt-action="copy">${escapeHtml(t("prompts.copy"))}</button>
              ${hooks.runWith ? `<button type="button" class="primary-button compact" data-prompt-action="run-with">${escapeHtml(t("prompts.runWith"))}</button>` : ""}
            </div>
          </div>
          <div class="prompt-warnings" data-prompt-warnings ${warnings.length ? "" : "hidden"}>${warnings.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}</div>
          <div class="prompt-preview markdown-rendered" data-preview-content>${hooks.renderMarkdown(result.text) || `<p class="settings-hint">${escapeHtml(t("prompts.nothing"))}</p>`}</div>
          <p class="prompt-preview-foot">${escapeHtml(t("prompts.characterCount", { count: result.text.length.toLocaleString() }))}</p>
          ${importDialog()}
        </div>`;
    }

    function editorPanel(all) {
      const prompt = currentPrompt(all);
      if (!prompt) return `<p class="settings-hint">${escapeHtml(t("prompts.nothing"))}</p>`;
      return `
        <div class="prompt-panel-inner prompt-edit-panel">
          <div class="prompt-editor">
            <label>${escapeHtml(t("prompts.name"))}<input type="text" data-draft-name maxlength="120" value="${escapeHtml(ui.draft?.name ?? prompt.name ?? "")}"></label>
            <label>${escapeHtml(t("prompts.body"))}<textarea data-draft-body rows="22" spellcheck="false">${escapeHtml(ui.draft?.body ?? prompt.body ?? "")}</textarea></label>
            <p class="settings-hint">${escapeHtml(t("prompts.editHint"))}</p>
            <div class="settings-row-actions">
              <button type="button" class="primary-button compact" data-prompt-action="save-prompt">${escapeHtml(prompt.builtIn ? t("prompts.saveEdit") : t("prompts.save"))}</button>
              <button type="button" class="secondary-button compact" data-prompt-action="cancel-edit">${escapeHtml(t("prompts.cancel"))}</button>
            </div>
          </div>
        </div>`;
    }

    function exampleRow(name, example, selected) {
      const checked = selected.has(example.id);
      return `
        <div class="prompt-example">
          <label class="prompt-example-option" title="${escapeHtml(example.text)}">
            <input type="checkbox" data-example="${escapeHtml(example.id)}" data-variable="${name}" ${checked ? "checked" : ""}>
            <span class="prompt-example-label">${example.code ? `<span class="prompt-code">${escapeHtml(example.code)}</span>` : ""}<span>${escapeHtml(example.label || example.text.slice(0, 60))}</span></span>
          </label>
          ${example.builtIn ? "" : `<button type="button" class="icon-button" data-prompt-action="delete-example" data-id="${escapeHtml(example.id)}" aria-label="${escapeHtml(t("prompts.deleteExample", { name: example.label || "" }))}">×</button>`}
          ${checked && HAS_PLACEHOLDER.test(example.text) ? `<label class="prompt-example-fill"><span>${escapeHtml(t("prompts.fillIn"))}</span><input type="text" data-fill="${escapeHtml(example.id)}" value="${escapeHtml(ui.fills[example.id] || "")}"></label>` : ""}
        </div>`;
    }

    function exampleCard(name, all) {
      const selected = new Set(ui.selections[name] || []);
      const options = all.examples.filter((example) => example.variable === name);
      const description = (shipped?.variables || []).find((entry) => entry.name === name)?.description || "";
      const open = Boolean(ui.openGroups[`example:${name}`]);
      return `
        <details class="prompt-card prompt-example-card" data-example-group="${name}" ${open ? "open" : ""}>
          <summary>
            <span class="prompt-example-heading"><code>{{${name}}}</code><span class="prompt-example-description">${escapeHtml(description)}</span></span>
            <span class="prompt-example-count">${escapeHtml(t("prompts.selected", { count: selected.size }))}</span>
          </summary>
          <div class="prompt-example-body">
            <div class="prompt-example-list">
              ${options.map((example) => exampleRow(name, example, selected)).join("") || `<p class="settings-hint">${escapeHtml(t("prompts.noExamples"))}</p>`}
            </div>
            <label class="prompt-extra"><span>${escapeHtml(t("prompts.extraForRun"))}</span><textarea rows="2" data-extra="${name}">${escapeHtml(ui.extra[name] || "")}</textarea></label>
            <button type="button" class="text-button" data-prompt-action="save-example" data-variable="${name}">${escapeHtml(t("prompts.saveExample"))}</button>
          </div>
        </details>`;
    }

    function profileCard(all, used) {
      const profile = profileValues(hooks.profile() || {}, { startupName: hooks.startupName(), timeZone: hooks.timeZone(), today: hooks.today(), linkLabel: hooks.linkLabel });
      const rows = Object.entries(profile).filter(([name]) => used.has(name));
      if (!rows.length) return "";
      const missing = rows.filter(([, value]) => !value).length;
      return `
        <details class="prompt-card prompt-profile-card" data-profile-details ${missing ? "open" : ""}>
          <summary>
            <span>${escapeHtml(t("prompts.fromProfile"))}</span>
            <span class="prompt-example-count">${escapeHtml(t("prompts.valuesUsed", { count: rows.length }))}</span>
          </summary>
          <ul class="prompt-profile-list">
            ${rows.map(([name, value]) => `
              <li class="${value ? "" : "is-missing"}"><code>{{${name}}}</code> ${value ? `<span>${escapeHtml(value.length > 80 ? `${value.slice(0, 80)}…` : value)}</span>` : `<span class="prompt-var-missing">${escapeHtml(t("prompts.notSet"))}</span>`}</li>`).join("")}
          </ul>
          <div><button type="button" class="text-button" data-prompt-action="open-profile">${escapeHtml(t("prompts.editProfile"))}</button></div>
        </details>`;
    }

    function setupPanel(all) {
      const prompt = currentPrompt(all);
      const used = new Set(prompt ? hooks.PromptRender.variablesIn(ui.draft !== null ? ui.draft.body : prompt.body) : []);
      const scope = scopeValues(ui.section, ui.picks, hooks.Taxonomy);
      const exampleCards = EXAMPLE_VARIABLES.filter((name) => used.has(name)).map((name) => exampleCard(name, all)).join("");
      return `
        <div class="prompt-panel-inner prompt-setup">
          <section class="prompt-card">
            <header class="prompt-card-head">
              <h4>${escapeHtml(t("prompts.promptCard"))}</h4>
              <p class="settings-hint">${escapeHtml(t("prompts.promptCardHint"))}</p>
            </header>
            <div class="prompt-setup-grid">
              <label class="prompt-field">${escapeHtml(t("prompts.prompt"))}
                <select data-prompt-select>${all.prompts.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === prompt?.id ? "selected" : ""}>${escapeHtml(entry.name)}${entry.builtIn ? "" : ` (${escapeHtml(t("prompts.yours"))})`}</option>`).join("")}</select>
              </label>
              <fieldset class="prompt-section-pick">
                <legend>${escapeHtml(t("prompts.section"))}</legend>
                ${SECTIONS.map((section) => `<label data-section="${section}"><input type="radio" name="promptSection" value="${section}" ${section === ui.section ? "checked" : ""}> ${escapeHtml(t(`prompts.groups.${section}`))}</label>`).join("")}
              </fieldset>
            </div>
            ${prompt?.description ? `<p class="settings-hint">${escapeHtml(prompt.description)}</p>` : ""}
          </section>
          <section class="prompt-card">
            <header class="prompt-card-head">
              <h4>${escapeHtml(t("prompts.categories"))}</h4>
              <p class="settings-hint" data-prompt-scope-summary>${escapeHtml(scope.CATEGORY)}</p>
            </header>
            <div id="promptScopePicker" aria-label="${escapeHtml(t("prompts.categories"))}"></div>
          </section>
          ${exampleCards}
          ${profileCard(all, used)}
          <section class="prompt-card prompt-manage">
            <header class="prompt-card-head">
              <h4>${escapeHtml(t("prompts.managePrompts"))}</h4>
              <p class="settings-hint">${escapeHtml(t("prompts.managePromptsHint"))}</p>
            </header>
            <div class="prompt-manage-actions">
              <button type="button" class="secondary-button compact" data-prompt-action="new-prompt">${escapeHtml(t("prompts.newPrompt"))}</button>
              ${prompt?.builtIn && prompt.edited ? `<button type="button" class="secondary-button compact" data-prompt-action="reset-prompt">${escapeHtml(t("prompts.reset"))}</button>` : ""}
              ${prompt && !prompt.builtIn ? `<button type="button" class="secondary-button compact danger-text" data-prompt-action="delete-prompt">${escapeHtml(t("prompts.deletePrompt"))}</button>` : ""}
              <button type="button" class="text-button" data-prompt-action="export-pack">${escapeHtml(t("prompts.exportPack"))}</button>
              <label class="text-button prompt-import-pack">${escapeHtml(t("prompts.importPack"))}<input type="file" accept="application/json,.json" data-prompt-pack hidden></label>
            </div>
          </section>
        </div>`;
    }

    function runsPanel(all) {
      const preset = all.presets.find((entry) => entry.id === ui.presetId);
      const scoped = Boolean(preset) && ui.runsScope !== "all";
      return `
        <div class="prompt-panel-inner prompt-runs">
          <div class="prompt-runs-bar">
            <div class="prompt-segmented" role="group" aria-label="${escapeHtml(t("prompts.runsScope"))}">
              <button type="button" data-runs-scope="preset" aria-pressed="${scoped}" ${preset ? "" : "disabled"}>${escapeHtml(t("prompts.thisPreset"))}</button>
              <button type="button" data-runs-scope="all" aria-pressed="${!scoped}">${escapeHtml(t("prompts.allRuns"))}</button>
            </div>
            <p class="settings-hint">${escapeHtml(scoped ? t("prompts.runsPresetHint", { name: preset.name }) : t("prompts.runsAllHint"))}</p>
          </div>
          <div id="promptRunsMount" class="prompt-runs-mount"></div>
        </div>`;
    }

    function activePanel(all) {
      if (ui.view === "edit") return editorPanel(all);
      if (ui.view === "setup") return setupPanel(all);
      if (ui.view === "runs") return runsPanel(all);
      return previewPanel(all);
    }

    function importDialog() {
      if (ui.importRows === null) return "";
      const rows = ui.importRows;
      const body = rows.length ? `
        <table class="prompt-import-table">
          <thead><tr><th scope="col">${escapeHtml(t("prompts.import.add"))}</th><th scope="col">${escapeHtml(t("prompts.import.target"))}</th><th scope="col">${escapeHtml(t("prompts.import.check"))}</th></tr></thead>
          <tbody>${rows.map((row) => `
            <tr class="${row.ok ? "" : "is-invalid"}">
              <td><input type="checkbox" data-import-row="${row.index}" ${row.ok ? "" : "disabled"} ${row.picked ? "checked" : ""} aria-label="${escapeHtml(t("prompts.import.pick", { name: row.values.name || `#${row.index + 1}` }))}"></td>
              <td><strong>${escapeHtml(row.values.name || `#${row.index + 1}`)}</strong> ${row.section ? `<span class="settings-hint">${escapeHtml(t(`prompts.groups.${row.section}`))}</span>` : ""}${row.values.link ? `<br><span class="settings-hint">${escapeHtml(row.values.link)}</span>` : ""}</td>
              <td>${row.duplicateOf ? `<p class="prompt-import-duplicate">${escapeHtml(t(row.duplicateOf.where === "tracker" ? "prompts.import.duplicate" : "prompts.import.duplicateInImport", { name: row.duplicateOf.name, reason: t(`prompts.import.by.${row.duplicateOf.reason}`) }))}</p>` : ""}${[...row.problems, ...row.warnings].map((text) => `<p class="${row.problems.includes(text) ? "prompt-import-problem" : "settings-hint"}">${escapeHtml(text)}</p>`).join("") || (row.duplicateOf ? "" : `<p class="settings-hint">${escapeHtml(t("prompts.import.new"))}</p>`)}</td>
            </tr>`).join("")}</tbody>
        </table>` : "";
      return `
        <div class="prompt-import" role="dialog" aria-modal="false" aria-labelledby="promptImportTitle">
          <h3 id="promptImportTitle">${escapeHtml(t("prompts.importResults"))}</h3>
          <p class="settings-hint">${escapeHtml(t("prompts.import.intro"))}</p>
          <textarea rows="8" data-import-text spellcheck="false" aria-label="${escapeHtml(t("prompts.import.paste"))}">${escapeHtml(ui.importText)}</textarea>
          <div class="settings-row-actions">
            <button type="button" class="secondary-button compact" data-prompt-action="import-check">${escapeHtml(t("prompts.import.checkButton"))}</button>
            ${rows.some((row) => row.picked) ? `<button type="button" class="primary-button compact" data-prompt-action="import-apply">${escapeHtml(t("prompts.import.apply", { count: rows.filter((row) => row.picked).length }))}</button>` : ""}
            <button type="button" class="secondary-button compact" data-prompt-action="import-close">${escapeHtml(t("prompts.cancel"))}</button>
          </div>
          ${ui.importError ? `<p class="prompt-import-problem" role="alert">${escapeHtml(ui.importError)}</p>` : ""}
          ${body}
        </div>`;
    }

    function mountPicker() {
      const holder = container.querySelector("#promptScopePicker");
      if (!holder || !hooks.TaxonomyPicker) return;
      hooks.TaxonomyPicker.create(holder, {
        section: ui.section,
        value: ui.picks,
        primary: false,
        emptyText: t("prompts.allCategories"),
        label: t("prompts.categories"),
        onChange: (list) => {
          ui.picks = hooks.Taxonomy.leaves(list);
          ui.presetDirty = Boolean(ui.presetId);
          remember();
          const summary = container.querySelector("[data-prompt-scope-summary]");
          if (summary) summary.textContent = scopeValues(ui.section, ui.picks, hooks.Taxonomy).CATEGORY;
          updateMeta();
        },
      });
    }

    function mountRuns() {
      const holder = container.querySelector("#promptRunsMount");
      if (!holder || !hooks.mountRuns) return;
      const presetId = ui.runsScope !== "all" && ui.presetId ? ui.presetId : "";
      const openRunId = ui.openRunId || "";
      ui.openRunId = "";
      hooks.mountRuns(holder, {
        presetId,
        openRunId,
        emptyTitle: presetId ? t("prompts.runsEmptyTitle") : t("agents.emptyTitle"),
        emptyHint: presetId ? t("prompts.runsEmptyHint") : t("agents.emptyHint"),
      });
    }

    function mountActivePanel() {
      if (ui.view === "setup") mountPicker();
      if (ui.view === "runs") mountRuns();
    }

    function updateMeta(all = lib()) {
      const node = container.querySelector("[data-prompt-meta]");
      if (node) node.innerHTML = metaChips(all);
      const message = container.querySelector("[data-prompt-message]");
      if (message) message.textContent = ui.message || "";
    }

    function draw() {
      if (!container) return;
      if (!shipped) {
        container.innerHTML = `<p class="settings-hint">${escapeHtml(loadError ? t("prompts.loadFailed", { message: loadError }) : t("prompts.loading"))}</p>`;
        return;
      }
      const all = lib();
      const focus = document.activeElement && container.contains(document.activeElement) ? document.activeElement.dataset : null;
      container.innerHTML = `
        <div class="prompts-layout">
          ${libraryRail(all)}
          <section class="prompt-workbench">
            ${workbenchHeader(all)}
            <div class="prompt-workbench-meta" data-prompt-meta>${metaChips(all)}</div>
            <p class="prompt-message prompt-workbench-message" data-prompt-message role="status">${ui.message ? escapeHtml(ui.message) : ""}</p>
            ${promptTabs()}
            <div class="prompt-panel" id="promptPanel" role="tabpanel" aria-labelledby="promptTab-${ui.view}" tabindex="0">${activePanel(all)}</div>
          </section>
        </div>`;
      mountActivePanel();
      hooks.counted?.(all.presets.length);
      if (focus?.extra) container.querySelector(`[data-extra="${focus.extra}"]`)?.focus();
      if (focus?.fill) container.querySelector(`[data-fill="${focus.fill}"]`)?.focus();
    }

    function drawOutput() {
      const panel = container.querySelector("[data-prompt-panel]");
      if (!panel) return draw();
      panel.innerHTML = activePanel(lib());
      mountActivePanel();
      updateMeta();
    }

    // A sync from the server redraws the rail and the open preview, but leaves
    // the setup form and a live run alone.
    function refreshPreview() {
      if (ui.view !== "preview" || ui.importRows !== null) return;
      const panel = container.querySelector("[data-prompt-panel]");
      if (!panel) return draw();
      if (panel.contains(document.activeElement)) return;
      const pane = panel.querySelector("[data-preview-content]");
      const top = pane?.scrollTop || 0;
      panel.innerHTML = previewPanel(lib());
      const next = panel.querySelector("[data-preview-content]");
      if (next) next.scrollTop = top;
    }

    function setView(view) {
      if (!["preview", "edit", "setup", "runs"].includes(view)) return;
      ui.view = view;
      if (view === "preview") ui.draft = null;
      ui.message = "";
      remember();
      draw();
    }

    // ---- actions ----

    function sharedLists() {
      const shared = hooks.shared();
      return { prompts: [...(shared.prompts || [])], presets: [...(shared.presets || [])], examples: [...(shared.examples || [])] };
    }

    async function copy(markdown) {
      const all = lib();
      let access = {};
      if (ui.mode === "agent") {
        try {
          access = await hooks.createToken();
        } catch (error) {
          ui.message = t("prompts.tokenFailed", { message: error.message });
          drawOutput();
          return;
        }
      }
      const result = rendered(all, access);
      const text = markdown ? result.text : hooks.plainText(result.text);
      try {
        await hooks.copyText(text);
        ui.message = ui.mode === "agent" ? t("prompts.copiedWithToken", { date: hooks.formatTimestamp(access.expiresAt) }) : t("prompts.copied");
      } catch {
        ui.message = t("prompts.copyFailed");
      }
      drawOutput();
    }

    function savePrompt() {
      const all = lib();
      const prompt = currentPrompt(all);
      const name = String(container.querySelector("[data-draft-name]")?.value || "").trim() || prompt?.name || t("prompts.untitled");
      const body = String(container.querySelector("[data-draft-body]")?.value || "");
      const lists = sharedLists();
      const now = new Date().toISOString();
      const record = { id: prompt.id, name, body, description: prompt.description || "", whenToUse: prompt.whenToUse || "", sections: prompt.sections || SECTIONS, updatedAt: now, ...(prompt.builtIn ? { editOf: prompt.id, editedFromVersion: 1 } : { createdAt: prompt.createdAt || now }) };
      lists.prompts = [...lists.prompts.filter((entry) => entry.id !== prompt.id), record];
      ui.draft = null;
      ui.view = "preview";
      ui.message = t("prompts.saved");
      hooks.saveShared({ prompts: lists.prompts }, t("prompts.saved"));
      draw();
    }

    async function handleAction(action, button) {
      const lists = sharedLists();
      const all = lib();
      if (action === "toggle-all") {
        ui.showAll = !ui.showAll;
        draw();
      } else if (action === "copy") {
        copy(false);
      } else if (action === "copy-markdown") {
        copy(true);
      } else if (action === "run-with") {
        // The server renders the prompt again from the same template and
        // values, with the run's own {{TRACKER_ACCESS}}.
        const prompt = currentPrompt(all);
        if (!prompt) return;
        const template = ui.draft !== null ? ui.draft.body : prompt.body;
        const runValues = values(all, { mode: "run" });
        const result = hooks.PromptRender.render(template, runValues);
        const preset = all.presets.find((entry) => entry.id === ui.presetId);
        hooks.runWith({ template, values: runValues, text: result.text, unresolved: result.unresolved, placeholderLeft: HAS_PLACEHOLDER.test(result.text), constraints: runValues.CONSTRAINTS || "", title: preset?.name || prompt.name || "", presetId: ui.presetId || "" });
      } else if (action === "new-prompt") {
        const id = root.crypto?.randomUUID ? root.crypto.randomUUID() : `prompt-${Date.now()}`;
        const now = new Date().toISOString();
        const base = currentPrompt(all);
        hooks.saveShared({ prompts: [...lists.prompts, { id, name: t("prompts.untitled"), body: base?.body || "", description: "", sections: SECTIONS, createdAt: now, updatedAt: now }] }, t("prompts.created"));
        ui.promptId = id;
        ui.draft = null;
        ui.view = "edit";
        remember();
        draw();
      } else if (action === "save-prompt") {
        savePrompt();
      } else if (action === "cancel-edit") {
        ui.draft = null;
        ui.view = "preview";
        draw();
      } else if (action === "reset-prompt") {
        const prompt = currentPrompt(all);
        if (!prompt?.builtIn || !(await root.StartupTrackerDialog.confirm(t("prompts.resetConfirm", { name: prompt.shipped?.name || prompt.name })))) return;
        hooks.saveShared({ prompts: lists.prompts.filter((entry) => entry.id !== prompt.id) }, t("prompts.resetDone"));
        ui.message = t("prompts.resetDone");
        draw();
      } else if (action === "delete-prompt") {
        const prompt = currentPrompt(all);
        if (!prompt || prompt.builtIn) return;
        if (!(await hooks.deletePrompt(prompt))) return;
        ui.promptId = "target-research";
        remember();
        draw();
      } else if (action === "save-preset") {
        const name = String(root.prompt?.(t("prompts.presetName")) || "").trim();
        if (!name) return;
        const id = root.crypto?.randomUUID ? root.crypto.randomUUID() : `preset-${Date.now()}`;
        const preset = { id, name, section: ui.section, description: "", whenToUse: "", promptId: currentPrompt(all)?.id || "target-research", scope: ui.picks.length ? { coverage: "nodes", taxonomy: [...ui.picks] } : { coverage: "allEnabled", taxonomy: [] }, examples: JSON.parse(JSON.stringify(ui.selections)) };
        hooks.saveShared({ presets: [...lists.presets, preset] }, t("prompts.presetSaved"));
        ui.presetId = id;
        ui.presetDirty = false;
        ui.message = t("prompts.presetSaved");
        remember();
        draw();
      } else if (action === "delete-preset") {
        const preset = all.presets.find((entry) => entry.id === ui.presetId);
        if (!preset || preset.builtIn || !(await root.StartupTrackerDialog.confirm(t("prompts.deletePresetConfirm", { name: preset.name }), { danger: true }))) return;
        hooks.saveShared({ presets: lists.presets.filter((entry) => entry.id !== preset.id) }, t("prompts.presetDeleted"));
        ui.presetId = "";
        ui.presetDirty = false;
        remember();
        draw();
      } else if (action === "save-example") {
        const variable = button.dataset.variable;
        const text = String(ui.extra[variable] || "").trim();
        if (!text) {
          ui.message = t("prompts.exampleEmpty");
          drawOutput();
          return;
        }
        const id = root.crypto?.randomUUID ? root.crypto.randomUUID() : `example-${Date.now()}`;
        const label = text.length > 48 ? `${text.slice(0, 48)}…` : text;
        hooks.saveShared({ examples: [...lists.examples, { id, variable, label, text }] }, t("prompts.exampleSaved"));
        ui.extra[variable] = "";
        ui.selections[variable] = [...(ui.selections[variable] || []), id];
        ui.presetDirty = Boolean(ui.presetId);
        remember();
        draw();
      } else if (action === "delete-example") {
        const id = button.dataset.id;
        const example = lists.examples.find((entry) => entry.id === id);
        if (!example || !(await root.StartupTrackerDialog.confirm(t("prompts.deleteExampleConfirm", { name: example.label || "" }), { danger: true }))) return;
        hooks.saveShared({ examples: lists.examples.filter((entry) => entry.id !== id) }, t("prompts.exampleDeleted"));
        for (const name of EXAMPLE_VARIABLES) ui.selections[name] = (ui.selections[name] || []).filter((entry) => entry !== id);
        ui.presetDirty = Boolean(ui.presetId);
        remember();
        draw();
      } else if (action === "export-pack") {
        const blob = new Blob([JSON.stringify(exportPack(lists), null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "startup-tracker-prompts.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } else if (action === "open-profile") {
        hooks.openProfile?.();
      } else if (action === "import-results") {
        ui.importRows = [];
        ui.importError = "";
        drawOutput();
        container.querySelector("[data-import-text]")?.focus();
      } else if (action === "import-close") {
        ui.importRows = null;
        ui.importText = "";
        drawOutput();
      } else if (action === "import-check") {
        ui.importText = String(container.querySelector("[data-import-text]")?.value || "");
        const parsed = hooks.AiImport.parse(ui.importText);
        ui.importError = parsed.error;
        ui.importRows = parsed.error ? [] : hooks.checkImport(parsed.entries).map((row) => ({ ...row, picked: row.ok && !row.duplicateOf }));
        drawOutput();
      } else if (action === "import-apply") {
        const picked = ui.importRows.filter((row) => row.picked && row.ok);
        const count = hooks.importRows(picked);
        ui.importRows = null;
        ui.importText = "";
        ui.message = t("prompts.import.done", { count });
        drawOutput();
      }
    }

    container.addEventListener("click", (event) => {
      const preset = event.target.closest("[data-preset]");
      if (preset) {
        const found = lib().presets.find((entry) => entry.id === preset.dataset.preset);
        if (found) applyPreset(found);
        return;
      }
      const view = event.target.closest("[data-prompt-view]");
      if (view) {
        setView(view.dataset.promptView);
        return;
      }
      const scope = event.target.closest("[data-runs-scope]");
      if (scope) {
        ui.runsScope = scope.dataset.runsScope === "all" ? "all" : "preset";
        remember();
        draw();
        return;
      }
      const action = event.target.closest("[data-prompt-action]");
      if (action) handleAction(action.dataset.promptAction, action);
    });

    container.addEventListener("toggle", (event) => {
      const group = event.target.closest?.("[data-example-group]");
      if (group) ui.openGroups[`example:${group.dataset.exampleGroup}`] = group.open;
      const profile = event.target.closest?.("[data-profile-details]");
      if (profile) ui.openGroups.profile = profile.open;
    }, true);

    container.addEventListener("change", async (event) => {
      const target = event.target;
      if (target.matches("[data-example]")) {
        const name = target.dataset.variable;
        const list = new Set(ui.selections[name] || []);
        if (target.checked) list.add(target.dataset.example);
        else list.delete(target.dataset.example);
        // Keep the library's order.
        ui.selections[name] = lib().examples.filter((example) => list.has(example.id)).map((example) => example.id);
        ui.presetDirty = Boolean(ui.presetId);
        remember();
        draw();
      } else if (target.matches("[data-prompt-select]")) {
        ui.promptId = target.value;
        ui.draft = null;
        ui.presetDirty = Boolean(ui.presetId);
        remember();
        draw();
      } else if (target.matches("input[name=promptSection]")) {
        ui.section = target.value;
        ui.picks = [];
        const preset = lib().presets.find((entry) => entry.id === ui.presetId);
        if (preset && preset.section === "general") ui.selections = presetExamples(preset, ui.section);
        ui.presetDirty = Boolean(ui.presetId);
        remember();
        draw();
      } else if (target.matches("[data-prompt-mode]")) {
        ui.mode = target.value === "chat" ? "chat" : "agent";
        remember();
        drawOutput();
      } else if (target.matches("[data-import-row]")) {
        const row = ui.importRows?.find((entry) => entry.index === Number(target.dataset.importRow));
        if (row) row.picked = target.checked;
        drawOutput();
      } else if (target.matches("[data-prompt-pack]")) {
        const file = target.files?.[0];
        if (!file) return;
        try {
          const { merged, counts } = importPack(JSON.parse(await file.text()), sharedLists());
          if (counts.replaced && !(await root.StartupTrackerDialog.confirm(t("prompts.packReplace", { count: counts.replaced })))) return;
          hooks.saveShared(merged, t("prompts.packImported"));
          ui.message = t("prompts.packDone", { added: counts.added, replaced: counts.replaced });
        } catch (error) {
          ui.message = t("prompts.packFailed", { message: error.message });
        }
        draw();
      }
    });

    container.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches("[data-preset-search]")) {
        ui.presetQuery = target.value;
        const body = container.querySelector(".prompt-library-body");
        if (body) body.innerHTML = libraryGroups(lib());
        const count = container.querySelector(".prompt-library-count");
        if (count) count.textContent = String(visiblePresets(lib()).length);
      } else if (target.matches("[data-extra]")) {
        ui.extra[target.dataset.extra] = target.value;
        remember();
      } else if (target.matches("[data-fill]")) {
        ui.fills[target.dataset.fill] = target.value;
        remember();
      } else if (target.matches("[data-draft-body], [data-draft-name]")) {
        const prompt = currentPrompt();
        ui.draft = {
          name: String(container.querySelector("[data-draft-name]")?.value ?? prompt?.name ?? ""),
          body: String(container.querySelector("[data-draft-body]")?.value ?? prompt?.body ?? ""),
        };
      }
    });

    async function load() {
      try {
        shipped = await loadShipped(root.fetch.bind(root));
        loadError = "";
      } catch (error) {
        loadError = error.message;
      }
      draw();
    }

    return {
      load,
      render() {
        if (!shipped && !loadError) {
          load();
          return;
        }
        const all = lib();
        const rail = container.querySelector(".prompt-library");
        if (!rail) return draw();
        const search = container.querySelector("[data-preset-search]");
        if (document.activeElement === search) {
          const body = rail.querySelector(".prompt-library-body");
          if (body) body.innerHTML = libraryGroups(all);
          const count = rail.querySelector(".prompt-library-count");
          if (count) count.textContent = String(visiblePresets(all).length);
        } else {
          rail.outerHTML = libraryRail(all);
        }
        updateMeta(all);
        if (ui.view === "preview") refreshPreview();
        hooks.counted?.(all.presets.length);
      },
      tips: () => shipped?.tips || null,
      // "Import AI results" with a text already in it (a run's final JSON).
      openImport(text) {
        ui.importText = String(text || "");
        const parsed = hooks.AiImport.parse(ui.importText);
        ui.importError = parsed.error;
        ui.importRows = parsed.error ? [] : hooks.checkImport(parsed.entries).map((row) => ({ ...row, picked: row.ok && !row.duplicateOf }));
        if (shipped) {
          ui.view = "preview";
          draw();
        }
        container.querySelector(".prompt-import")?.scrollIntoView?.({ block: "nearest" });
      },
      // A run opens in the Runs tab, next to the prompt it belongs to. With
      // "all" (a link from another window) every run is listed instead of the
      // current preset's.
      openRun(runId, { all = false } = {}) {
        if (!runId) return;
        ui.view = "runs";
        ui.message = "";
        if (all || !ui.presetId) ui.runsScope = "all";
        ui.openRunId = String(runId);
        remember();
        draw();
      },
      ui,
    };
  }

  return Object.freeze({
    SECTIONS,
    TABS,
    EXAMPLE_VARIABLES,
    PACK_FORMAT,
    library,
    presetVisible,
    presetExamples,
    scopeFromPicks,
    picksFromScope,
    formatItemNames,
    formatSmartSelectionList,
    scopeValues,
    exampleValue,
    profileValues,
    trackerAccess,
    exportPack,
    importPack,
    loadShipped,
    create,
  });
});
