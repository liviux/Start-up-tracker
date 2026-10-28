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

  // Registry agents filtered by a search text, installed ones first.
  function filterAgents(agents, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    return (Array.isArray(agents) ? agents : [])
      .filter((agent) => words.every((word) => `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  }

  const pure = { CHECK_STATES, POLICIES, SETTING_KEYS, parseArgs, formatArgs, parseEnv, formatEnv, checkState, filterAgents };

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
    const ui = { overview: null, tokens: [], query: "", busy: new Set(), messages: new Map(), status: "" };
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
          check?.agentInfo ? el("span", { className: "settings-hint", text: ` · ${check.agentInfo.title || check.agentInfo.name || ""} ${check.agentInfo.version || ""}` }) : null,
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

    function check(harness, { testPrompt = false, consent = false } = {}) {
      return run(`check:${harness.id}`, async () => {
        say(t("settings.agents.checking"));
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

    function harnessCard(harness) {
      const checking = ui.busy.has(`check:${harness.id}`);
      const models = Array.isArray(harness.models) ? harness.models : [];
      const policy = el("select", { on: { change: (event) => save(harness, { policy: event.target.value }) } },
        POLICIES.map((id) => el("option", { value: id, selected: harness.policy === id, text: t(`agents.policies.${id}.name`) })));
      const defaultModel = models.length
        ? el("select", { on: { change: (event) => save(harness, { defaultModel: event.target.value }) } }, [
          el("option", { value: "", text: t("settings.agents.agentDefault"), selected: !harness.defaultModel }),
          ...models.map((model) => el("option", { value: model.value, text: model.name, selected: harness.defaultModel === model.value })),
        ])
        : el("div", { className: "agent-model-empty" }, [
          el("p", { className: "settings-hint", text: t("settings.agents.modelsAfterCheck") }),
          el("input", { type: "text", value: harness.defaultModel || "", placeholder: t("agents.dialog.modelPlaceholder"), on: { change: (event) => save(harness, { defaultModel: event.target.value.trim() }) } }),
        ]);
      const preferred = models.length
        ? el("div", { className: "agent-model-grid" }, models.map((model) => el("label", { className: "agent-model-check" }, [
          el("input", {
            type: "checkbox",
            checked: (harness.preferredModels || []).includes(model.value),
            on: { change: (event) => {
              const set = new Set(harness.preferredModels || []);
              if (event.target.checked) set.add(model.value);
              else set.delete(model.value);
              save(harness, { preferredModels: models.map((entry) => entry.value).filter((value) => set.has(value)) });
            } },
          }),
          el("span", { text: model.name }),
        ])))
        : null;
      const args = el("input", { type: "text", value: formatArgs(harness.args), spellcheck: "false" });
      const command = harness.kind === "custom" ? el("input", { type: "text", value: harness.command, spellcheck: "false" }) : null;
      const env = el("textarea", { rows: 3, spellcheck: "false", placeholder: "API_KEY=...", value: formatEnv(harness.env) });
      env.value = formatEnv(harness.env);
      const message = ui.messages.get(`check:${harness.id}`) || ui.messages.get(`save:${harness.id}`);
      return el("article", { className: "agent-harness", dataset: { state: checkState(harness) } }, [
        el("header", { className: "agent-harness-head" }, [
          el("h5", { text: harness.name }),
          el("span", { className: "settings-hint", text: harness.registryId ? `${harness.kind} · ${harness.registryId}${harness.registryVersion ? ` ${harness.registryVersion}` : ""}` : t("settings.agents.custom") }),
        ]),
        el("p", {}, [el("code", { className: "agent-command", text: harness.commandLine })]),
        ...checkBlock(harness),
        message ? el("p", { className: "settings-error", role: "alert", text: message }) : null,
        el("div", { className: "settings-row-actions" }, [
          el("button", { type: "button", className: "primary-button compact", disabled: checking, text: checking ? t("settings.agents.checking") : t("settings.agents.check"), on: { click: () => check(harness) } }),
          el("button", { type: "button", className: "secondary-button compact", disabled: checking, text: t("settings.agents.testPrompt"), title: t("settings.agents.testPromptHint"), on: { click: () => check(harness, { testPrompt: true }) } }),
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
        el("details", { className: "agent-harness-more" }, [
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
              el("label", { className: "settings-field" }, [el("span", { text: t("settings.agents.defaultModel") }), defaultModel]),
              preferred ? el("fieldset", { className: "settings-fieldset" }, [el("legend", { text: t("settings.agents.preferredModels") }), preferred]) : null,
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

    // Agent icons live on the registry's servers, so they load only while the
    // network switch (Settings > General) allows going online.
    function registryList(agents) {
      const remoteIcons = ui.overview?.registry?.network !== false;
      return el("ul", { className: "agent-registry-list" }, agents.map((agent) => el("li", { className: "agent-registry-item" }, [
        agent.icon && remoteIcons ? el("img", { src: agent.icon, alt: "", width: 20, height: 20, loading: "lazy", referrerpolicy: "no-referrer" }) : el("span", { "aria-hidden": "true" }),
        el("div", {}, [
          el("strong", { text: agent.name }),
          el("span", { className: "settings-hint", text: ` ${agent.kind || t("settings.agents.unavailable")}${agent.version ? ` · ${agent.version}` : ""}` }),
          agent.installed ? el("span", { className: "agent-found", text: t("settings.agents.found") }) : null,
          el("p", { className: "settings-hint", text: agent.description }),
          agent.kind === "binary" && !agent.installed && agent.launch?.archive ? el("p", { className: "settings-hint" }, [t("settings.agents.installFirst", { command: agent.launch.command }), " ", el("a", { href: agent.launch.archive, target: "_blank", rel: "noopener", text: t("settings.agents.download") })]) : null,
          ui.messages.get(`add:${agent.id}`) ? el("p", { className: "settings-error", text: ui.messages.get(`add:${agent.id}`) }) : null,
        ]),
        agent.added
          ? el("span", { className: "settings-hint", text: t("settings.agents.alreadyAdded") })
          : el("button", { type: "button", className: "secondary-button compact", disabled: !agent.available || ui.busy.has(`add:${agent.id}`), text: t("settings.agents.add"), on: { click: () => addFromRegistry(agent) } }),
      ])));
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
    }

    container.replaceChildren(...ctx.heading(section), el("p", { className: "settings-hint", text: t("settings.loading") }));
    await load();
    draw();
  }

  return Object.freeze({ ...pure, render });
});
