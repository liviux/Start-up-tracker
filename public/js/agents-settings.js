// Settings > AI agents (window.StartupTrackerAgentsSettings), drawn inside
// the Settings panel (js/settings.js).
//
// - Your agents: the command each runs, the last check and its state, models,
//   the permission policy, environment variables, the block override.
// - Add an agent: from the ACP registry (or its shipped snapshot, or the
//   built-in catalog), or a custom command. The server shows the exact
//   command first and stores the agent only after you confirm it.
// - Run settings: concurrent runs, run timeout, runs kept, idle flag.
// - Agent tokens: the tokens of copied prompts and of runs, with Revoke.
//
// UMD: browsers get window.StartupTrackerAgentsSettings, Node gets
// module.exports (the pure helpers).
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerAgentsSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const CHECK_STATES = Object.freeze(["not-installed", "needs-login", "incompatible", "ready", "failed"]);
  const POLICIES = Object.freeze(["allow", "research", "ask"]);
  const SETTING_KEYS = Object.freeze(["concurrency", "timeoutMinutes", "keepRuns", "idleMinutes"]);

  // ---- what can be tested -----------------------------------------------------

  // "--flag value 'two words'" -> ["--flag", "value", "two words"].
  function parseArgs(text) {
    const out = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (const match of String(text || "").matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3]);
    return out;
  }

  function formatArgs(args) {
    return (Array.isArray(args) ? args : []).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  }

  // "NAME=value" lines -> { NAME: "value" }; a value of *** keeps the stored one.
  function parseEnv(text) {
    const env = {};
    const problems = [];
    String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const index = line.indexOf("=");
      const name = index > 0 ? line.slice(0, index).trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) problems.push(line);
      else env[name] = line.slice(index + 1);
    });
    return { env, problems };
  }

  function formatEnv(env) {
    return Object.entries(env || {}).map(([name, value]) => `${name}=${value}`).join("\n");
  }

  // The dot next to an agent: its last check, "unchecked" before the first.
  function checkState(harness) {
    const state = harness?.lastCheck?.state;
    return CHECK_STATES.includes(state) ? state : "unchecked";
  }

  // The version next to an agent: what its last check reported, which is the
  // installed program. Before a check, an npx or uvx package's version is
  // known from the registry; a binary's registry version is only the catalog
  // snapshot and may not match what is installed.
  function harnessVersion(harness) {
    const reported = harness?.lastCheck?.agentInfo?.version;
    if (reported) return String(reported);
    return harness?.kind === "binary" ? "" : String(harness?.registryVersion || "");
  }

  // The version to show in the add list. An agent you already added uses its
  // card's version. Otherwise, an agent whose installed program would run has
  // no known version until it is checked; the registry's version is only what
  // it offers, so it is shown only when that program is not installed.
  function registryAgentVersion(agent, harness) {
    if (harness) return harnessVersion(harness);
    const installedProgram = agent?.installed && (agent.kind === "binary" || agent.installedBin);
    return installedProgram ? "" : String(agent?.version || "");
  }

  // Registry agents filtered by a search text: installed ones first, the
  // ones you already added last.
  function filterAgents(agents, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    return (Array.isArray(agents) ? agents : [])
      .filter((agent) => words.every((word) => `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(Boolean(a.added)) - Number(Boolean(b.added)) || Number(Boolean(b.installed)) - Number(Boolean(a.installed)) || a.name.localeCompare(b.name));
  }

  // An OpenRouter model id and its routing suffix (":nitro"), when the
  // agent takes one (harness.routingVariants, OpenCode only).
  function splitRouting(value, variants = []) {
    const text = String(value || "");
    const routing = text.startsWith("openrouter/") ? (variants || []).find((suffix) => text.endsWith(suffix) && text.length > suffix.length) : "";
    return routing ? { base: text.slice(0, -routing.length), routing } : { base: text, routing: "" };
  }

  // The models a picker shows for a search text: every word in the name or
  // id, in any case, at most `limit` of them; `more` counts the rest.
  const MODEL_LIST_LIMIT = 50;
  function matchModels(models, query, limit = MODEL_LIST_LIMIT) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const found = (Array.isArray(models) ? models : []).filter((model) => {
      const text = `${model.name || ""} ${model.value || ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    return { shown: found.slice(0, limit), more: Math.max(0, found.length - limit) };
  }

  // The effort levels to offer for a model: the ones the last check read
  // for it or, when it has not read them yet, the common ones (the run then
  // tells you when the agent does not take the level). [] when the check
  // found the model offers none. A saved level stays on the list.
  const COMMON_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  function effortChoices(harness, model) {
    const read = harness?.modelEfforts?.[model || ""];
    const levels = Array.isArray(read) ? read : COMMON_EFFORTS.map((value) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) }));
    const picked = harness?.effortByModel?.[model || ""];
    return picked && !levels.some((level) => level.value === picked) ? [...levels, { value: picked, name: picked }] : levels;
  }

  // The models with OpenRouter routing variants added (OpenCode): each
  // openrouter/ model is followed by one entry per variant ("…:nitro"), so a
  // search finds them. A model that already carries a suffix (":free") gets
  // none. label(suffix) names a variant.
  function withRoutingVariants(models, variants = [], label = (suffix) => suffix) {
    const list = Array.isArray(models) ? models : [];
    if (!variants?.length) return list;
    return list.flatMap((model) => {
      const value = String(model.value || "");
      if (!value.startsWith("openrouter/") || value.slice(value.lastIndexOf("/") + 1).includes(":")) return [model];
      return [model, ...variants.map((suffix) => ({ value: `${value}${suffix}`, name: `${model.name || value} · ${label(suffix)}` }))];
    });
  }

  // True when a model's name only spells out its id ("Claude Sonnet 5.5" and
  // "claude-sonnet-5-5"), so the list shows it once.
  function sameModelText(name, id) {
    const plain = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return plain(name) === plain(id);
  }

  // What was typed in a model picker -> the model's id: its id or its name,
  // in any case, with a routing suffix the agent takes. "" for an empty box,
  // null for a model the agent does not list.
  function findModel(models, text, variants = []) {
    const typed = String(text || "").trim();
    if (!typed) return "";
    const list = Array.isArray(models) ? models : [];
    const find = (wanted) => {
      const lower = wanted.toLowerCase();
      return list.find((model) => model.value === wanted)
        || list.find((model) => model.value.toLowerCase() === lower || String(model.name || "").toLowerCase() === lower);
    };
    const match = find(typed);
    if (match) return match.value;
    const { base, routing } = splitRouting(typed, variants);
    const baseMatch = routing ? find(base) : null;
    return baseMatch ? `${baseMatch.value}${routing}` : null;
  }

  const pure = { CHECK_STATES, POLICIES, SETTING_KEYS, parseArgs, formatArgs, parseEnv, formatEnv, checkState, harnessVersion, registryAgentVersion, filterAgents, COMMON_EFFORTS, effortChoices, withRoutingVariants, matchModels, sameModelText, splitRouting, findModel };

  if (!root.document) return Object.freeze(pure);

  // ---- browser ----------------------------------------------------------------

  async function request(url, { method = "GET", body } = {}) {
    const response = await root.fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok || parsed.ok === false) throw Object.assign(new Error(parsed.error || parsed.message || `HTTP ${response.status}`), { code: parsed.code || "", preview: parsed.preview || "" });
    return parsed;
  }

  // Asks the server for the command, shows it, and sends again with
  // "confirmed" when you agree. Returns the answer, or null when declined.
  // send(false) either previews ({ preview }) or saves what needs no
  // confirmation. confirmCommand draws the themed dialog; without it (a test,
  // or a browser that cannot show one) the built-in confirm is used.
  async function withConfirmation(t, send, {
    first = false,
    confirmCommand = null,
    title = t("settings.agents.confirmTitle"),
    intro = t("settings.agents.confirmIntro"),
    confirmText = t("settings.agents.add"),
  } = {}) {
    let answer;
    try {
      answer = await send(false);
    } catch (error) {
      if (error.code !== "confirmNeeded") throw error;
      answer = { preview: error.preview };
    }
    if (!answer.preview) return answer;
    const accepted = confirmCommand
      ? await confirmCommand({
        title,
        intro,
        command: answer.preview,
        warning: first ? t("settings.agents.warning") : "",
        confirmText,
      })
      : root.confirm([t("settings.agents.confirmCommand", { command: answer.preview }), first ? `\n\n${t("settings.agents.warning")}` : ""].join(""));
    if (!accepted) return null;
    return send(true);
  }

  // ctx: { el, t, Api, heading(section, intro) -> nodes, isCurrent(),
  // formatInstant(iso), errorText(error) }.
  async function render(container, section, ctx) {
    const { el, t, Api } = ctx;
    // open: the agents whose options are unfolded; focus: a [data-focus] to
    // focus again after the next draw.
    const ui = { overview: null, tokens: [], query: "", busy: new Set(), messages: new Map(), status: "", open: new Set(), focus: "" };
    const status = el("p", { className: "settings-status", role: "status" });

    // A themed replacement for window.confirm: the command sits in a code
    // block, the warning keeps its amber note, and the buttons use the same
    // style as the rest of the page.
    function ask({ title, intro, command = "", warning = "", confirmText = t("settings.agents.add") }) {
      return new Promise((resolve) => {
        const dialog = el("dialog", { className: "agent-dialog agent-command-dialog", "aria-labelledby": "agentCommandTitle" });
        let settled = false;
        const finish = (answer) => {
          if (settled) return;
          settled = true;
          dialog.close();
          dialog.remove();
          resolve(answer);
        };
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          finish(false);
        });
        const confirm = el("button", {
          type: "button",
          className: "primary-button",
          text: confirmText,
          on: { click: () => finish(true) },
        });
        dialog.append(
          el("div", { className: "agent-dialog-body" }, [
            el("h3", { id: "agentCommandTitle", text: title }),
            intro ? el("p", { className: "agent-dialog-intro", text: intro }) : null,
            command ? el("pre", { className: "agent-dialog-command", text: command }) : null,
            warning ? el("p", { className: "agent-warning", text: warning }) : null,
          ]),
          el("footer", { className: "agent-dialog-actions" }, [
            el("button", { type: "button", className: "text-button", text: t("settings.agents.cancel"), on: { click: () => finish(false) } }),
            confirm,
          ]),
        );
        root.document.body.append(dialog);
        dialog.showModal();
        confirm.focus();
      });
    }

    async function load({ rescan = false } = {}) {
      const [overview, tokens] = await Promise.all([
        request(rescan ? Api.urls.agentsRescan : Api.urls.agents, rescan ? { method: "POST", body: {} } : {}),
        request(Api.urls.agentTokens("")).catch(() => ({ tokens: [] })),
      ]);
      ui.overview = overview;
      ui.tokens = tokens.tokens || [];
    }

    function say(text) {
      status.textContent = text;
    }

    async function run(key, task) {
      if (ui.busy.has(key)) return;
      ui.busy.add(key);
      ui.messages.delete(key);
      draw();
      try {
        await task();
      } catch (error) {
        ui.messages.set(key, ctx.errorText(error));
      } finally {
        ui.busy.delete(key);
        if (ctx.isCurrent()) draw();
        ui.focus = "";
      }
    }

    function replaceHarness(harness) {
      const list = ui.overview.harnesses;
      const index = list.findIndex((entry) => entry.id === harness.id);
      if (index === -1) list.push(harness);
      else list[index] = harness;
    }

    function checkBlock(harness) {
      const check = harness.lastCheck;
      const state = checkState(harness);
      const nodes = [
        el("p", { className: "agent-check-line" }, [
          el("span", { className: "agent-check-dot", dataset: { state }, "aria-hidden": "true" }),
          el("strong", { text: t(`settings.agents.states.${state}`) }),
          check?.at ? el("span", { className: "settings-hint", text: ` · ${ctx.formatInstant(check.at)}` }) : null,
        ]),
      ];
      if (check?.message) nodes.push(el("p", { className: state === "ready" ? "settings-hint" : "settings-error", text: check.message }));
      if (check?.testReply) nodes.push(el("p", { className: "settings-hint", text: t("settings.agents.testReply", { reply: check.testReply }) }));
      if (state === "needs-login" && check.authMethods?.length) {
        nodes.push(el("div", { className: "agent-login" }, check.authMethods.map((method) => (method.type === "terminal"
          ? el("p", {}, [t("settings.agents.loginTerminal", { name: method.name }), " ", el("code", { text: method.command })])
          : el("button", {
            type: "button",
            className: "secondary-button compact",
            text: t("settings.agents.authenticate", { name: method.name }),
            on: { click: () => run(`check:${harness.id}`, async () => {
              const body = await request(Api.urls.harnessAuthenticate(harness.id), { method: "POST", body: { methodId: method.id } });
              replaceHarness(body.harness);
              say(t(`settings.agents.states.${body.check.state}`));
            }) },
          })))));
      }
      if (harness.blocked) {
        nodes.push(el("p", { className: "settings-error" }, [
          t("settings.agents.blocked"),
          " ",
          el("button", { type: "button", className: "text-button", text: t("settings.agents.override"), on: { click: () => save(harness, { overrideBlock: true }) } }),
        ]));
      }
      return nodes;
    }

    function save(harness, patch, { confirmFirst = false } = {}) {
      return run(`save:${harness.id}`, async () => {
        const body = await withConfirmation(t, (confirmed) => request(Api.urls.harness(harness.id), { method: "PATCH", body: { ...patch, confirmed } }), {
          first: confirmFirst,
          confirmCommand: ask,
          title: t("settings.agents.confirmChangeTitle"),
          intro: t("settings.agents.confirmChangeIntro"),
          confirmText: t("settings.agents.saveLaunch"),
        });
        if (!body) return;
        replaceHarness(body.harness);
        say(t("settings.saved"));
      });
    }

    // A check and a test prompt are separate buttons with their own busy
    // state; the server runs one at a time per agent.
    function check(harness, { testPrompt = false, consent = false } = {}) {
      const key = `${testPrompt ? "test" : "check"}:${harness.id}`;
      if (testPrompt && !harness.defaultModel) {
        ui.messages.set(key, t("settings.agents.testNeedsModel"));
        ui.open.add(harness.id);
        ui.focus = `default-model:${harness.id}`;
        draw();
        ui.focus = "";
        return Promise.resolve();
      }
      return run(key, async () => {
        say(t(testPrompt ? "settings.agents.testing" : "settings.agents.checking"));
        const body = await request(Api.urls.harnessCheck(harness.id), { method: "POST", body: { testPrompt, consent } });
        replaceHarness(body.harness);
        if (body.check.state === "consent-needed") {
          if (root.confirm(t("settings.agents.consent", { package: body.check.package }))) {
            const again = await request(Api.urls.harnessCheck(harness.id), { method: "POST", body: { testPrompt, consent: true } });
            replaceHarness(again.harness);
            say(t(`settings.agents.states.${again.check.state}`));
          }
          return;
        }
        say(t(`settings.agents.states.${body.check.state}`));
      });
    }

    // A search box with the tracker's own list of the agent's models (a
    // combobox): type any part of a name or id, then click a model or use the
    // arrow keys and Enter. onPick gets the model id, or "" for the agent's
    // default (offered first when defaultLabel is given). The list is drawn
    // here rather than with <datalist>, whose picks reach the page
    // differently in each browser.
    let pickerSequence = 0;
    function modelPicker(harness, models, { value = "", placeholder, label, focusKey, defaultLabel = "", onPick }) {
      pickerSequence += 1;
      const listId = `agent-model-list-${pickerSequence}`;
      const shown = value ? modelName(models, value, harness.routingVariants) : placeholder;
      const input = el("input", {
        type: "text",
        value,
        placeholder,
        role: "combobox",
        "aria-label": label,
        "aria-autocomplete": "list",
        "aria-expanded": "false",
        "aria-controls": listId,
        autocomplete: "off",
        spellcheck: "false",
        dataset: { focus: focusKey },
      });
      const list = el("ul", { className: "agent-model-list", id: listId, role: "listbox", "aria-label": label, hidden: true });
      const listed = withRoutingVariants(models, harness.routingVariants, (suffix) => t(`settings.agents.routing.${suffix.slice(1)}`));
      const entries = defaultLabel ? [{ value: "", name: defaultLabel }, ...listed] : listed;
      let matches = [];
      let active = -1;
      let done = false;

      const take = (picked) => {
        if (done) return;
        done = true;
        close();
        if (picked !== value) onPick(picked);
        else {
          // The same model again: nothing to save, the box shows it again.
          done = false;
          input.blur();
        }
      };
      const setActive = (index) => {
        active = index;
        [...list.querySelectorAll("[role=option]")].forEach((item, position) => item.setAttribute("aria-selected", String(position === index)));
        const item = list.querySelector(`#${listId}-${index}`);
        if (item) {
          input.setAttribute("aria-activedescendant", item.id);
          item.scrollIntoView({ block: "nearest" });
        } else input.removeAttribute("aria-activedescendant");
      };
      // The list follows what you type; an empty box shows none.
      const open = () => {
        if (!input.value.trim()) return close();
        const found = matchModels(entries, input.value, MODEL_LIST_LIMIT);
        matches = found.shown;
        list.replaceChildren(...[
          ...matches.map((model, index) => el("li", {
            id: `${listId}-${index}`,
            role: "option",
            "aria-selected": "false",
            className: model.value === value ? "is-current" : "",
            // mousedown keeps the focus in the box, so blur does not close the list first.
            on: { mousedown: (event) => event.preventDefault(), click: () => take(model.value) },
          }, [
            el("span", { text: model.name }),
            model.value && !sameModelText(model.name, model.value) ? el("span", { className: "agent-model-id", text: ` · ${model.value}` }) : null,
          ])),
          matches.length ? null : el("li", { className: "agent-model-more", text: t("settings.agents.noModelMatch") }),
          found.more ? el("li", { className: "agent-model-more", text: t("settings.agents.moreModels", { count: found.more }) }) : null,
        ].filter(Boolean));
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
        setActive(matches.length ? 0 : -1);
      };
      function close() {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }

      input.addEventListener("focus", () => {
        done = false;
        // Empty while picking, so what you type searches from scratch; the
        // current model stays as the placeholder and comes back if nothing
        // is picked.
        input.placeholder = shown;
        input.value = "";
      });
      input.addEventListener("blur", () => {
        close();
        input.placeholder = placeholder;
        if (!done) input.value = value;
      });
      input.addEventListener("input", open);
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!list.hidden && matches.length) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (!list.hidden && matches[active]) return take(matches[active].value);
          // A typed id the list does not show, such as an OpenRouter routing variant.
          const text = input.value.trim();
          if (!text) return;
          const picked = findModel(models, text, harness.routingVariants);
          if (picked !== null) return take(picked);
          ui.messages.set(`save:${harness.id}`, t("settings.agents.unknownModel", { model: text }));
          done = true;
          draw();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          input.blur();
        }
      });
      return el("span", { className: "agent-model-picker" }, [input, list]);
    }

    // A routing variant ("openrouter/x:nitro") is named after its model; the
    // routing box next to it shows the variant.
    function modelName(models, value, variants = []) {
      const named = (id) => models.find((model) => model.value === id)?.name;
      return named(value) || named(splitRouting(value, variants).base) || value;
    }

    function harnessCard(harness) {
      const checking = ui.busy.has(`check:${harness.id}`);
      const testing = ui.busy.has(`test:${harness.id}`);
      const models = Array.isArray(harness.models) ? harness.models : [];
      // The effort levels a model offers, read by the last check: undefined
      // for a model picked since, [] for one that offers none.
      const effortSelect = (model, className = "") => {
        const levels = effortChoices(harness, model);
        if (!levels.length) return null;
        const picked = harness.effortByModel?.[model || ""] || "";
        const name = model ? modelName(models, model, harness.routingVariants) : t("settings.agents.agentDefault");
        return el("select", {
          className,
          "aria-label": t("settings.agents.effortFor", { model: name }),
          "data-tooltip": t("settings.agents.effortFor", { model: name }),
          on: { change: (event) => {
            const next = { ...(harness.effortByModel || {}), [model || ""]: event.target.value };
            if (!event.target.value) delete next[model || ""];
            save(harness, { effortByModel: next });
          } },
        }, [
          el("option", { value: "", text: t("settings.agents.effortDefault"), selected: !picked }),
          ...levels.map((level) => el("option", { value: level.value, text: level.name, selected: picked === level.value })),
        ]);
      };
      // OpenRouter routing for an openrouter/ model (OpenCode): the suffix
      // becomes part of the model id; onChange gets the new id.
      const variants = harness.routingVariants || [];
      const routingSelect = (value, onChange, className = "") => {
        const { base, routing } = splitRouting(value, variants);
        if (!variants.length || !base.startsWith("openrouter/")) return null;
        const name = modelName(models, base, variants);
        return el("select", {
          className,
          "aria-label": t("settings.agents.routingFor", { model: name }),
          "data-tooltip": t("settings.agents.routingFor", { model: name }),
          on: { change: (event) => onChange(`${base}${event.target.value}`) },
        }, [
          el("option", { value: "", text: t("settings.agents.routing.default"), selected: !routing }),
          ...variants.map((suffix) => el("option", { value: suffix, text: t(`settings.agents.routing.${suffix.slice(1)}`), selected: routing === suffix })),
        ]);
      };
      const policy = el("select", { on: { change: (event) => save(harness, { policy: event.target.value }) } },
        POLICIES.map((id) => el("option", { value: id, selected: harness.policy === id, text: t(`agents.policies.${id}.name`) })));
      const defaultFocus = `default-model:${harness.id}`;
      const defaultModel = models.length
        ? modelPicker(harness, models, {
          value: splitRouting(harness.defaultModel, variants).base,
          placeholder: t("settings.agents.agentDefault"),
          label: t("settings.agents.defaultModel"),
          defaultLabel: t("settings.agents.agentDefault"),
          focusKey: defaultFocus,
          onPick: (model) => save(harness, { defaultModel: model }),
        })
        : el("div", { className: "agent-model-empty" }, [
          el("p", { className: "settings-hint", text: t("settings.agents.modelsAfterCheck") }),
          el("input", { type: "text", value: harness.defaultModel || "", placeholder: t("agents.dialog.modelPlaceholder"), "aria-label": t("settings.agents.defaultModel"), dataset: { focus: defaultFocus }, on: { change: (event) => save(harness, { defaultModel: event.target.value.trim() }) } }),
        ]);
      // Preferred models: chips in the order you picked them, and a picker
      // over the models not picked yet.
      const preferredValues = harness.preferredModels || [];
      const preferredFocus = `preferred-model:${harness.id}`;
      const keepFocus = (patch) => {
        ui.focus = preferredFocus;
        return save(harness, patch);
      };
      const preferred = models.length
        ? el("div", { className: "agent-model-preferred" }, [
          preferredValues.length
            ? el("ul", { className: "agent-model-chips" }, preferredValues.map((value) => el("li", { className: "agent-model-chip" }, [
              el("span", { text: modelName(models, value, variants) }),
              routingSelect(value, (model) => keepFocus({ preferredModels: [...new Set(preferredValues.map((entry) => (entry === value ? model : entry)))] }), "agent-model-effort"),
              effortSelect(value, "agent-model-effort"),
              el("button", {
                type: "button",
                className: "agent-model-chip-remove",
                "aria-label": t("settings.agents.removePreferred", { model: modelName(models, value, variants) }),
                "data-tooltip": t("settings.agents.removePreferred", { model: modelName(models, value, variants) }),
                text: "×",
                on: { click: () => keepFocus({ preferredModels: preferredValues.filter((entry) => entry !== value) }) },
              }),
            ])))
            : el("p", { className: "settings-hint", text: t("settings.agents.noPreferred") }),
          preferredValues.length < 20 ? modelPicker(harness, models.filter((model) => !preferredValues.includes(model.value)), {
            placeholder: t("settings.agents.addPreferred"),
            label: t("settings.agents.addPreferred"),
            focusKey: preferredFocus,
            onPick: (model) => { if (model) keepFocus({ preferredModels: [...preferredValues, model] }); },
          }) : null,
        ])
        : null;
      const unread = models.length && ["", harness.defaultModel, ...preferredValues].some((model) => !Array.isArray(harness.modelEfforts?.[model || ""]));
      const args = el("input", { type: "text", value: formatArgs(harness.args), spellcheck: "false" });
      const command = harness.kind === "custom" ? el("input", { type: "text", value: harness.command, spellcheck: "false" }) : null;
      const env = el("textarea", { rows: 3, spellcheck: "false", placeholder: "API_KEY=...", value: formatEnv(harness.env) });
      env.value = formatEnv(harness.env);
      const message = ui.messages.get(`check:${harness.id}`) || ui.messages.get(`test:${harness.id}`) || ui.messages.get(`save:${harness.id}`);
      const version = harnessVersion(harness);
      const adapter = Boolean(harness.registryId) && ui.overview?.registry?.agents?.some((agent) => agent.id === harness.registryId && agent.adapter);
      return el("article", { className: "agent-harness", dataset: { state: checkState(harness) } }, [
        el("header", { className: "agent-harness-head" }, [
          el("h5", { text: harness.name }),
          adapter ? adapterBadge() : null,
          el("span", { className: "settings-hint", text: harness.registryId ? `${harness.kind} · ${harness.registryId}${version ? ` ${version}` : ""}` : t("settings.agents.custom") }),
        ]),
        el("p", {}, [el("code", { className: "agent-command", text: harness.commandLine })]),
        ...checkBlock(harness),
        message ? el("p", { className: "settings-error", role: "alert", text: message }) : null,
        el("div", { className: "settings-row-actions" }, [
          el("button", { type: "button", className: "primary-button compact", disabled: checking || testing, text: checking ? t("settings.agents.checking") : t("settings.agents.check"), on: { click: () => check(harness) } }),
          el("button", { type: "button", className: "secondary-button compact", disabled: checking || testing, text: testing ? t("settings.agents.testing") : t("settings.agents.testPrompt"), "data-tooltip": t("settings.agents.testPromptHint"), on: { click: () => check(harness, { testPrompt: true }) } }),
          el("button", {
            type: "button",
            className: "text-button danger-text",
            text: t("settings.agents.remove"),
            on: { click: () => {
              if (!root.confirm(t("settings.agents.removeConfirm", { name: harness.name }))) return;
              run(`save:${harness.id}`, async () => {
                await request(Api.urls.harness(harness.id), { method: "DELETE" });
                ui.overview.harnesses = ui.overview.harnesses.filter((entry) => entry.id !== harness.id);
                say(t("settings.agents.removed", { name: harness.name }));
              });
            } },
          }),
        ]),
        el("details", {
          className: "agent-harness-more",
          open: ui.open.has(harness.id),
          on: { toggle: (event) => { if (event.target.open) ui.open.add(harness.id); else ui.open.delete(harness.id); } },
        }, [
          el("summary", {}, [
            el("span", { text: t("settings.agents.options") }),
            el("span", { className: "agent-options-mark", "aria-hidden": "true", text: "⌄" }),
          ]),
          el("div", { className: "agent-options" }, [
            el("section", { className: "agent-options-group" }, [
              el("h6", { text: t("settings.agents.permissions") }),
              el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.policy") }), policy]),
              el("p", { className: "settings-hint", text: t(`agents.policies.${harness.policy}.hint`) }),
              el("p", { className: "agent-warning", text: t("settings.agents.warning") }),
            ]),
            el("section", { className: "agent-options-group" }, [
              el("h6", { text: t("settings.agents.model") }),
              el("div", { className: "settings-field" }, [
                el("span", { text: t("settings.agents.defaultModel") }),
                el("div", { className: "agent-model-row" }, [
                  defaultModel,
                  routingSelect(harness.defaultModel, (model) => save(harness, { defaultModel: model })),
                  effortSelect(harness.defaultModel),
                ]),
              ]),
              preferred ? el("fieldset", { className: "settings-fieldset" }, [el("legend", { text: t("settings.agents.preferredModels") }), preferred]) : null,
              unread ? el("p", { className: "settings-hint", text: t("settings.agents.effortAfterCheck") }) : null,
            ]),
            el("section", { className: "agent-options-group" }, [
              el("h6", { text: t("settings.agents.launch") }),
              command ? el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.command") }), command]) : null,
              el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.args") }), args]),
              el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.env") }), env]),
              el("p", { className: "settings-hint", text: t("settings.agents.envHint") }),
              el("button", {
                type: "button",
                className: "secondary-button compact",
                text: t("settings.agents.saveLaunch"),
                on: { click: () => {
                  const parsed = parseEnv(env.value);
                  if (parsed.problems.length) {
                    ui.messages.set(`save:${harness.id}`, t("settings.agents.envProblem", { lines: parsed.problems.join(", ") }));
                    draw();
                    return;
                  }
                  save(harness, { args: parseArgs(args.value), env: parsed.env, ...(command ? { command: command.value } : {}) });
                } },
              }),
            ]),
          ]),
        ]),
      ]);
    }

    function addFromRegistry(agent) {
      return run(`add:${agent.id}`, async () => {
        const first = !ui.overview.harnesses.length;
        const body = await withConfirmation(t, (confirmed) => request(Api.urls.harnesses, { method: "POST", body: { registryId: agent.id, confirmed, preview: !confirmed } }), { first, confirmCommand: ask });
        if (!body) return;
        replaceHarness(body.harness);
        agent.added = true;
        say(t("settings.agents.added", { name: body.harness.name }));
      });
    }

    function registryBlock() {
      const registry = ui.overview.registry;
      const agents = filterAgents(registry.agents, ui.query);
      const source = t(`settings.agents.sources.${registry.source}`, { date: registry.fetchedAt ? ctx.formatInstant(registry.fetchedAt) : "" });
      const search = el("input", { type: "search", value: ui.query, placeholder: t("settings.agents.search"), "aria-label": t("settings.agents.search") });
      search.addEventListener("input", () => {
        ui.query = search.value;
        const list = container.querySelector(".agent-registry-list");
        if (list) list.replaceWith(registryList(filterAgents(registry.agents, ui.query)));
      });
      return el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.agents.addTitle") }),
        el("p", { className: "settings-hint", text: source }),
        registry.problem ? el("p", { className: "settings-hint", text: registry.problem }) : null,
        !registry.network ? el("p", { className: "settings-hint", text: t("settings.agents.networkOff") }) : null,
        el("div", { className: "settings-row-actions" }, [
          search,
          el("button", {
            type: "button",
            className: "secondary-button compact",
            disabled: ui.busy.has("rescan"),
            text: ui.busy.has("rescan") ? t("settings.agents.rescanning") : t("settings.agents.rescan"),
            on: { click: () => run("rescan", async () => {
              await load({ rescan: true });
              say(t("settings.agents.rescanned"));
            }) },
          }),
        ]),
        ui.messages.get("rescan") ? el("p", { className: "settings-error", text: ui.messages.get("rescan") }) : null,
        registryList(agents),
      ]);
    }

    // An ACP adapter is a separate program that speaks ACP for an agent that
    // has no ACP mode of its own; the server sets `adapter` (lib/agents/registry.js).
    function adapterBadge() {
      return el("span", { className: "agent-adapter", title: t("settings.agents.adapterHint"), text: t("settings.agents.adapter") });
    }

    // Agent icons live on the registry's servers, so they load only while the
    // network switch (Settings > General) allows going online.
    function registryList(agents) {
      const remoteIcons = ui.overview?.registry?.network !== false;
      const harnessById = new Map((ui.overview?.harnesses || []).filter((harness) => harness.registryId).map((harness) => [harness.registryId, harness]));
      return el("ul", { className: "agent-registry-list" }, agents.map((agent) => {
        const version = registryAgentVersion(agent, harnessById.get(agent.id));
        return el("li", { className: `agent-registry-item${agent.installed && !agent.added ? " is-found" : ""}${agent.added ? " is-added" : ""}` }, [
          agent.icon && remoteIcons ? el("img", { src: agent.icon, alt: "", width: 20, height: 20, loading: "lazy", referrerpolicy: "no-referrer" }) : el("span", { "aria-hidden": "true" }),
          el("div", {}, [
            el("strong", { text: agent.name }),
            el("span", { className: "agent-registry-meta" }, [
              agent.adapter ? adapterBadge() : null,
              el("span", { className: "settings-hint", text: `${agent.kind || t("settings.agents.unavailable")}${version ? ` · ${version}` : ""}` }),
              agent.installed ? el("span", { className: "agent-found", text: t("settings.agents.found") }) : null,
            ]),
            el("p", { className: "settings-hint", text: agent.description }),
            agent.kind === "binary" && !agent.installed && agent.launch?.archive ? el("p", { className: "settings-hint" }, [t("settings.agents.installFirst", { command: agent.launch.command }), " ", el("a", { href: agent.launch.archive, target: "_blank", rel: "noopener", text: t("settings.agents.download") })]) : null,
            ui.messages.get(`add:${agent.id}`) ? el("p", { className: "settings-error", text: ui.messages.get(`add:${agent.id}`) }) : null,
          ]),
          agent.added
            ? el("span", { className: "settings-hint", text: t("settings.agents.alreadyAdded") })
            : el("button", {
              type: "button",
              // An agent found on this computer can be added and run at once.
              className: `${agent.installed ? "primary-button" : "secondary-button"} compact`,
              disabled: !agent.available || ui.busy.has(`add:${agent.id}`),
              text: t("settings.agents.add"),
              on: { click: () => addFromRegistry(agent) },
            }),
        ]);
      }));
    }

    function customBlock() {
      const name = el("input", { type: "text", maxlength: 80 });
      const command = el("input", { type: "text", spellcheck: "false", placeholder: "my-agent" });
      const args = el("input", { type: "text", spellcheck: "false", placeholder: "--acp" });
      return el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.agents.customTitle") }),
        el("p", { className: "settings-hint", text: t("settings.agents.customHint") }),
        el("div", { className: "settings-inline-form" }, [
          el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.name") }), name]),
          el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.command") }), command]),
          el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.args") }), args]),
          el("button", {
            type: "button",
            className: "secondary-button compact",
            text: t("settings.agents.add"),
            on: { click: () => run("custom", async () => {
              const first = !ui.overview.harnesses.length;
              const custom = { command: command.value.trim(), args: parseArgs(args.value) };
              const body = await withConfirmation(t, (confirmed) => request(Api.urls.harnesses, { method: "POST", body: { custom, name: name.value.trim(), confirmed, preview: !confirmed } }), { first, confirmCommand: ask });
              if (!body) return;
              replaceHarness(body.harness);
              say(t("settings.agents.added", { name: body.harness.name }));
            }) },
          }),
        ]),
        ui.messages.get("custom") ? el("p", { className: "settings-error", role: "alert", text: ui.messages.get("custom") }) : null,
      ]);
    }

    function settingsBlock() {
      const values = ui.overview.settings;
      const inputs = Object.fromEntries(SETTING_KEYS.map((key) => [key, el("input", { type: "number", min: 1, value: values[key], step: 1 })]));
      return el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.agents.runsTitle") }),
        el("div", { className: "settings-inline-form" }, [
          ...SETTING_KEYS.map((key) => el("label", { className: "settings-field" }, [el("span", { text: t(`settings.agents.runSettings.${key}`) }), inputs[key]])),
          el("button", {
            type: "button",
            className: "secondary-button compact",
            text: t("settings.agents.saveRuns"),
            on: { click: () => run("settings", async () => {
              const body = await request(Api.urls.agentsSettings, { method: "PUT", body: { settings: Object.fromEntries(SETTING_KEYS.map((key) => [key, Number(inputs[key].value)])) } });
              ui.overview.settings = body.settings;
              say(t("settings.saved"));
            }) },
          }),
        ]),
        ui.messages.get("settings") ? el("p", { className: "settings-error", role: "alert", text: ui.messages.get("settings") }) : null,
      ]);
    }

    function tokensBlock() {
      const active = ui.tokens.filter((token) => token.active);
      return el("div", { className: "settings-block" }, [
        el("h4", { text: t("settings.agents.tokensTitle") }),
        el("p", { className: "settings-hint", text: t("settings.agents.tokensHint") }),
        active.length
          ? el("ul", { className: "agent-token-list" }, active.map((token) => el("li", {}, [
            el("span", { text: `${token.label} · ${token.startupId} · ${t(token.scope === "run" ? "settings.agents.tokenRun" : "settings.agents.tokenPrompt")} · ${t("settings.agents.tokenUntil", { date: ctx.formatInstant(token.expiresAt) })}` }),
            el("button", {
              type: "button",
              className: "text-button danger-text",
              text: t("settings.agents.revoke"),
              on: { click: () => run(`token:${token.id}`, async () => {
                await request(Api.urls.agentTokenRevoke(token.id), { method: "POST", body: {} });
                token.active = false;
                say(t("settings.agents.revoked"));
              }) },
            }),
          ])))
          : el("p", { className: "settings-hint", text: t("settings.agents.noTokens") }),
      ]);
    }

    function draw() {
      if (!ctx.isCurrent()) return;
      const harnesses = ui.overview.harnesses;
      container.replaceChildren(
        ...ctx.heading(section, t("settings.agents.intro")),
        el("p", { className: "agent-warning", role: "note", text: t("settings.agents.warning") }),
        el("div", { className: "settings-block" }, [
          el("h4", { text: t("settings.agents.yours") }),
          harnesses.length ? el("div", { className: "agent-harness-list" }, harnesses.map(harnessCard)) : el("p", { className: "settings-hint", text: t("settings.agents.none") }),
        ]),
        registryBlock(),
        customBlock(),
        settingsBlock(),
        tokensBlock(),
        status,
      );
      if (ui.focus) container.querySelector(`[data-focus="${ui.focus}"]`)?.focus();
    }

    container.replaceChildren(...ctx.heading(section), el("p", { className: "settings-hint", text: t("settings.loading") }));
    await load();
    draw();
  }

  return Object.freeze({ ...pure, render });
});
