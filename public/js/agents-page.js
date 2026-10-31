// Agent runs (window.StartupTrackerAgentsPage): the "Agents" page in the
// sidebar, the run view, the "Run with..." dialog of the Prompts page and the
// overlay a new run opens in.
//
// A run's updates arrive as Server-Sent Events from
// /api/agent-runs/<runId>/events, each with a sequence number. The view keeps
// the last number it drew and reconnects from there (the browser sends it as
// Last-Event-ID), so a dropped connection or a reload never shows an update
// twice. The server does the work (lib/agents/runs.js); this file only shows
// it and sends your answers.
//
// What can be tested without a browser is exported on its own.
//
// UMD: browsers get window.StartupTrackerAgentsPage, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerAgentsPage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const ACTIVE = Object.freeze(["queued", "starting", "running", "waiting"]);
  const STATUSES = Object.freeze(["queued", "starting", "running", "waiting", "done", "failed", "cancelled", "interrupted"]);
  const TABS = Object.freeze(["conversation", "prompt", "changes", "permissions", "log"]);
  const EVENT_TYPES = Object.freeze(["status", "message", "agent", "session", "chunk", "tool_call", "tool_call_update", "plan", "usage", "update", "permission", "change", "notice", "idle", "undo", "closed"]);
  const LOG_LINES = 400;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  // ---- what can be tested -----------------------------------------------------

  function isActive(status) {
    return ACTIVE.includes(status);
  }

  function emptyConversation() {
    return { entries: [], lastSeq: 0, status: "", idle: false, usage: null, agentInfo: null, models: [], jsonFallback: false };
  }

  // Adds one event to the conversation. Events at or below the last sequence
  // number are dropped, so replaying a stream after a reconnect is harmless.
  // Message chunks of one speaker join into one message; a tool call and its
  // updates are one entry; the plan is one entry, replaced as it changes.
  function applyEvent(model, event) {
    if (!event || typeof event !== "object") return model;
    if (event.seq) {
      if (event.seq <= model.lastSeq) return model;
      model.lastSeq = event.seq;
    }
    const data = event.data || {};
    const last = model.entries[model.entries.length - 1];
    if (event.type !== "idle" && event.type !== "closed") model.idle = false;
    switch (event.type) {
      case "message":
        model.entries.push({ type: "message", role: data.role === "user" ? "user" : "agent", text: String(data.text || "") });
        break;
      case "chunk": {
        const role = data.role === "thought" ? "thought" : data.role === "user" ? "user" : "agent";
        const type = role === "thought" ? "thought" : "message";
        if (last && last.type === type && (type === "thought" || last.role === role) && !last.closed) last.text += String(data.text || "");
        else model.entries.push(type === "thought" ? { type, text: String(data.text || "") } : { type, role, text: String(data.text || "") });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = String(data.toolCallId || "");
        const found = id ? model.entries.find((entry) => entry.type === "tool" && entry.id === id) : null;
        const patch = Object.fromEntries(Object.entries({ title: data.title, kind: data.kind, status: data.status, content: data.content }).filter(([, value]) => value));
        if (Array.isArray(data.locations) && data.locations.length) patch.locations = data.locations;
        if (found) Object.assign(found, patch);
        else model.entries.push({ type: "tool", id, title: "", kind: "", status: "", content: "", locations: [], ...patch });
        if (last && last.type === "message") last.closed = true;
        break;
      }
      case "plan": {
        const found = model.entries.find((entry) => entry.type === "plan");
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (found) found.entries = entries;
        else model.entries.push({ type: "plan", entries });
        break;
      }
      case "permission": {
        const found = model.entries.find((entry) => entry.type === "permission" && entry.id === data.id);
        if (found) Object.assign(found, data);
        else model.entries.push({ type: "permission", ...data });
        break;
      }
      case "change":
        model.entries.push({ type: "change", ...data });
        break;
      case "notice":
        model.entries.push({ type: "notice", text: String(data.text || "") });
        break;
      case "status":
        model.status = String(data.status || model.status);
        if (data.jsonFallback) model.jsonFallback = true;
        if (["done", "failed", "cancelled", "interrupted"].includes(model.status)) {
          model.entries.push({ type: "status", status: model.status, stopReason: String(data.stopReason || ""), error: String(data.error || "") });
        }
        break;
      case "idle":
        model.idle = true;
        break;
      case "usage":
        model.usage = data;
        break;
      case "agent":
        model.agentInfo = data.agentInfo || null;
        break;
      case "session":
        model.models = Array.isArray(data.models) ? data.models : [];
        break;
      case "undo":
        model.entries.push({ type: "undo", undone: Number(data.undone) || 0, skipped: Array.isArray(data.skipped) ? data.skipped : [] });
        break;
      default:
        break;
    }
    return model;
  }

  function conversation(events) {
    return (Array.isArray(events) ? events : []).reduce(applyEvent, emptyConversation());
  }

  // "12 s", "3 min 5 s", "1 h 4 min".
  function duration(startedAt, endedAt, now = Date.now()) {
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start)) return "";
    const end = Date.parse(endedAt || "");
    const seconds = Math.max(0, Math.round(((Number.isFinite(end) ? end : now) - start) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
    return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  }

  // An OpenRouter model id and its routing suffix (":nitro"), when the
  // agent takes one (harness.routingVariants, OpenCode only).
  function routingParts(value, variants = []) {
    const text = String(value || "");
    const routing = text.startsWith("openrouter/") ? (variants || []).find((suffix) => text.endsWith(suffix) && text.length > suffix.length) : "";
    return routing ? { base: text.slice(0, -routing.length), routing } : { base: text, routing: "" };
  }

  // The effort levels to offer for a model, as in Settings > AI agents
  // (js/agents-settings.js effortChoices): the ones the last check read, or
  // the common ones until it has. tests/agents-page.test.js keeps the two
  // the same.
  const COMMON_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  function effortChoices(harness, model) {
    const read = harness?.modelEfforts?.[model || ""];
    const levels = Array.isArray(read) ? read : COMMON_EFFORTS.map((value) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) }));
    const picked = harness?.effortByModel?.[model || ""];
    return picked && !levels.some((level) => level.value === picked) ? [...levels, { value: picked, name: picked }] : levels;
  }

  // The models to offer for a harness: your preferred ones first, then the
  // rest the last check found, and `current` when it is neither (a routing
  // variant just picked). Empty when the agent lists none (the dialog then
  // takes a typed model id).
  function modelChoices(harness, current = "") {
    const found = Array.isArray(harness?.models) ? harness.models : [];
    const names = new Map(found.map((model) => [model.value, model.name || model.value]));
    const preferred = (harness?.preferredModels || []).filter(Boolean);
    const ordered = [...new Set([...preferred, ...found.map((model) => model.value)])];
    if (current && found.length && !ordered.includes(current)) ordered.push(current);
    const name = (value) => {
      if (names.has(value)) return names.get(value);
      const { base, routing } = routingParts(value, harness?.routingVariants);
      return routing && names.has(base) ? `${names.get(base)} ${routing}` : value;
    };
    return ordered.map((value) => ({ value, name: name(value), preferred: preferred.includes(value) }));
  }

  // What the run dialog says before Start: unfilled variables block the run,
  // an empty CONSTRAINTS text only warns.
  function dialogChecks({ unresolved = [], placeholderLeft = false, constraints = "", harness = null } = {}) {
    const blocking = [];
    const warnings = [];
    if (unresolved.length) blocking.push({ key: "agents.dialog.unresolved", params: { names: unresolved.map((name) => `{{${name}}}`).join(", ") } });
    if (placeholderLeft) blocking.push({ key: "prompts.placeholderLeft", params: {} });
    if (!harness) blocking.push({ key: "agents.dialog.noHarness", params: {} });
    else if (harness.blocked) blocking.push({ key: "agents.dialog.blocked", params: { name: harness.name } });
    if (!String(constraints || "").trim()) warnings.push({ key: "agents.dialog.noConstraints", params: {} });
    return { blocking, warnings, canStart: blocking.length === 0 };
  }

  // One line of the redacted log, for the Log tab.
  function logLine(line) {
    try {
      const entry = JSON.parse(line);
      const time = String(entry.at || "").slice(11, 19);
      const tag = entry.kind === "stderr" ? "stderr" : entry.direction === "out" ? "→" : "←";
      return `${time} ${tag} ${entry.text || ""}`;
    } catch {
      return String(line || "");
    }
  }

  const pure = { ACTIVE, STATUSES, TABS, EVENT_TYPES, escapeHtml, isActive, emptyConversation, applyEvent, conversation, duration, routingParts, effortChoices, modelChoices, dialogChecks, logLine };

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
    if (!response.ok || parsed.ok === false) throw Object.assign(new Error(parsed.error || parsed.message || `HTTP ${response.status}`), { code: parsed.code || "", status: response.status });
    return parsed;
  }

  // One run, live. hooks: t, Api, renderMarkdown(text), formatTimestamp(iso),
  // openImport(text), openRecord(kind, id), onClose(), onChange(), runAgain(run),
  // standalone.
  function createRunView(holder, hooks) {
    const t = hooks.t;
    const view = { runId: "", run: null, live: false, canMessage: false, model: emptyConversation(), tab: "conversation", source: null, log: "", message: "", busy: false, frame: 0 };

    function statusLabel(status) {
      return t(`agents.status.${STATUSES.includes(status) ? status : "queued"}`);
    }

    function usageText(usage) {
      if (!usage) return "";
      const parts = [];
      if (usage.used) parts.push(t("agents.run.tokens", { used: Number(usage.used).toLocaleString(), size: usage.size ? Number(usage.size).toLocaleString() : "?" }));
      if (usage.cost && usage.cost.amount !== undefined) parts.push(`${Number(usage.cost.amount).toFixed(4)} ${escapeHtml(usage.cost.currency || "")}`);
      return parts.join(" · ");
    }

    function entryHtml(entry) {
      if (entry.type === "message" && entry.role === "user" && entry.text.length > 600) {
        return `<details class="agent-msg agent-msg-user"><summary class="agent-msg-who">${escapeHtml(t("agents.run.youLong", { count: entry.text.length.toLocaleString() }))}</summary><div class="markdown-rendered">${hooks.renderMarkdown(entry.text)}</div></details>`;
      }
      if (entry.type === "message") {
        return `<div class="agent-msg agent-msg-${entry.role}"><div class="agent-msg-who">${escapeHtml(t(entry.role === "user" ? "agents.run.you" : "agents.run.agent"))}</div><div class="markdown-rendered">${hooks.renderMarkdown(entry.text)}</div></div>`;
      }
      if (entry.type === "thought") {
        return `<details class="agent-thought"><summary>${escapeHtml(t("agents.run.thought"))}</summary><div class="markdown-rendered">${hooks.renderMarkdown(entry.text)}</div></details>`;
      }
      if (entry.type === "tool") {
        return `<div class="agent-tool" data-status="${escapeHtml(entry.status)}"><span class="agent-tool-kind">${escapeHtml(entry.kind || "tool")}</span> <strong>${escapeHtml(entry.title || entry.id)}</strong> <span class="agent-tool-status">${escapeHtml(entry.status)}</span>${entry.locations?.length ? `<div class="agent-tool-files">${entry.locations.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}</div>`;
      }
      if (entry.type === "plan") {
        return `<div class="agent-plan"><div class="agent-msg-who">${escapeHtml(t("agents.run.plan"))}</div><ol>${entry.entries.map((step) => `<li data-status="${escapeHtml(step.status)}">${escapeHtml(step.content)}</li>`).join("")}</ol></div>`;
      }
      if (entry.type === "permission") {
        const waiting = !entry.decision;
        const chosen = entry.options?.find((option) => option.optionId === entry.decision);
        const buttons = waiting && view.live
          ? `<div class="agent-permission-actions">${(entry.options || []).map((option) => `<button type="button" class="${/^allow/.test(option.kind) ? "primary-button" : "secondary-button"} compact" data-run-action="answer" data-request="${escapeHtml(entry.id)}" data-option="${escapeHtml(option.optionId)}">${escapeHtml(option.name)}</button>`).join("")}</div>`
          : `<span class="settings-hint">${escapeHtml(entry.decision === "cancelled" ? t("agents.run.cancelledAnswer") : chosen ? chosen.name : entry.decision)} · ${escapeHtml(entry.decidedBy || "")}</span>`;
        return `<div class="agent-permission${waiting ? " is-waiting" : ""}"><strong>${escapeHtml(t("agents.run.permission"))}</strong> <span class="agent-tool-kind">${escapeHtml(entry.kind || "other")}</span> ${escapeHtml(entry.title)} ${buttons}</div>`;
      }
      if (entry.type === "change") {
        return `<div class="agent-change">${escapeHtml(t(entry.event === "created" ? "agents.run.created" : "agents.run.updated", { name: entry.name || entry.id }))}</div>`;
      }
      if (entry.type === "notice") return `<p class="agent-notice">${escapeHtml(entry.text)}</p>`;
      if (entry.type === "undo") return `<p class="agent-notice">${escapeHtml(t("agents.run.undoneSummary", { undone: entry.undone, skipped: entry.skipped.length }))}</p>`;
      if (entry.type === "status") {
        return `<p class="agent-status-line" data-status="${escapeHtml(entry.status)}">${escapeHtml(statusLabel(entry.status))}${entry.stopReason ? ` (${escapeHtml(entry.stopReason)})` : ""}${entry.error ? `: ${escapeHtml(entry.error)}` : ""}</p>`;
      }
      return "";
    }

    function tabBody() {
      const run = view.run;
      if (view.tab === "prompt") {
        return `
          <dl class="agent-run-facts">
            <dt>${escapeHtml(t("agents.run.harness"))}</dt><dd>${escapeHtml(run.harness?.name || "")}</dd>
            <dt>${escapeHtml(t("agents.run.command"))}</dt><dd><code>${escapeHtml(run.harness?.commandLine || "")}</code></dd>
            <dt>${escapeHtml(t("agents.run.model"))}</dt><dd>${escapeHtml(run.model || t("agents.run.defaultModel"))}</dd>
            <dt>${escapeHtml(t("agents.run.effort"))}</dt><dd>${escapeHtml(run.effort || t("agents.run.defaultEffort"))}</dd>
            <dt>${escapeHtml(t("agents.run.policy"))}</dt><dd>${escapeHtml(t(`agents.policies.${run.harness?.policy || "allow"}.name`))}</dd>
          </dl>
          <pre class="agent-prompt-text">${escapeHtml(run.prompt)}</pre>`;
      }
      if (view.tab === "changes") {
        const changes = run.changes || [];
        const list = changes.length
          ? `<ul class="agent-changes">${changes.map((change) => `<li><span class="agent-tool-kind">${escapeHtml(change.kind)}</span> ${escapeHtml(t(change.event === "created" ? "agents.run.created" : "agents.run.updated", { name: change.after?.name || change.after?.platform || change.after?.funder || change.id }))} ${["mk", "po", "fu"].includes(change.kind) ? `<button type="button" class="text-button" data-run-action="open-record" data-kind="${escapeHtml(change.kind)}" data-id="${escapeHtml(change.id)}">${escapeHtml(t("agents.run.open"))}</button>` : ""}</li>`).join("")}</ul>`
          : `<p class="settings-hint">${escapeHtml(t("agents.run.noChanges"))}</p>`;
        const undo = run.undoneAt
          ? `<p class="agent-notice">${escapeHtml(t("agents.run.undoneSummary", { undone: run.undo?.undone || 0, skipped: run.undo?.skipped?.length || 0 }))}</p>${(run.undo?.skipped || []).map((entry) => `<p class="settings-hint">${escapeHtml(t("agents.run.skipped", { id: entry.id, reason: entry.reason }))}</p>`).join("")}`
          : changes.length ? `<button type="button" class="secondary-button compact" data-run-action="undo" ${view.live && isActive(run.status) ? "disabled" : ""}>${escapeHtml(t("agents.run.undo"))}</button><p class="settings-hint">${escapeHtml(t("agents.run.undoHint"))}</p>` : "";
        return `${list}${undo}`;
      }
      if (view.tab === "permissions") {
        const list = run.permissions || [];
        if (!list.length) return `<p class="settings-hint">${escapeHtml(t("agents.run.noPermissions"))}</p>`;
        return `<ul class="agent-permissions">${list.map((entry) => `<li>${entryHtml({ type: "permission", ...entry })}<span class="settings-hint">${escapeHtml(hooks.formatTimestamp(entry.at))}</span></li>`).join("")}</ul>`;
      }
      if (view.tab === "log") {
        const lines = view.log.split("\n").filter(Boolean);
        const shown = lines.slice(-LOG_LINES).map(logLine).join("\n");
        return `
          <p class="settings-hint">${escapeHtml(t("agents.run.logHint", { count: lines.length }))} <a href="${escapeHtml(hooks.Api.urls.agentRunLog(run.id, { download: true }))}" download>${escapeHtml(t("agents.run.download"))}</a></p>
          <pre class="agent-log">${escapeHtml(shown || t("agents.run.logEmpty"))}</pre>`;
      }
      const entries = view.model.entries.map(entryHtml).join("");
      const follow = view.canMessage
        ? `<form class="agent-follow-up" data-run-form="message"><label>${escapeHtml(t("agents.run.followUp"))}<textarea rows="2" name="text" required></textarea></label><button type="submit" class="primary-button compact">${escapeHtml(t("agents.run.send"))}</button></form>`
        : "";
      return `<div class="agent-conversation">${entries || `<p class="settings-hint">${escapeHtml(t("agents.run.nothingYet"))}</p>`}</div>${follow}`;
    }

    function draw() {
      view.frame = 0;
      const run = view.run;
      if (!run) {
        holder.innerHTML = view.message ? `<p class="settings-error" role="alert">${escapeHtml(view.message)}</p>` : "";
        return;
      }
      const status = view.live ? (view.model.status || run.status) : run.status;
      const waiting = (run.permissions || []).filter((entry) => !entry.decision).length;
      const notices = [
        status === "waiting" ? `<p class="agent-banner is-waiting" role="status">${escapeHtml(t("agents.run.waitingForYou"))}</p>` : "",
        status === "queued" ? `<p class="agent-banner" role="status">${escapeHtml(t("agents.run.queued"))}</p>` : "",
        view.model.idle || run.idle ? `<p class="agent-banner is-idle" role="status">${escapeHtml(t("agents.run.idle"))} <button type="button" class="secondary-button compact" data-run-action="cancel">${escapeHtml(t("agents.run.cancel"))}</button></p>` : "",
        run.jsonFallback && !isActive(status) ? `<p class="agent-banner" role="status">${escapeHtml(t("agents.run.jsonFound"))} <button type="button" class="primary-button compact" data-run-action="import">${escapeHtml(t("agents.run.importResults"))}</button></p>` : "",
        view.message ? `<p class="settings-error" role="alert">${escapeHtml(view.message)}</p>` : "",
      ].join("");
      const tabs = TABS.map((tab) => {
        const count = tab === "changes" ? (run.changes || []).length : tab === "permissions" ? (run.permissions || []).length : 0;
        return `<button type="button" role="tab" aria-selected="${view.tab === tab}" class="${view.tab === tab ? "active" : ""}" data-run-tab="${tab}">${escapeHtml(t(`agents.tabs.${tab}`))}${count ? ` <span class="agent-tab-count">${count}</span>` : ""}</button>`;
      }).join("");
      const focus = holder.querySelector("textarea[name=text]");
      const draft = focus ? focus.value : "";
      const hadFocus = focus && root.document.activeElement === focus;
      holder.innerHTML = `
        <article class="agent-run" data-status="${escapeHtml(status)}">
          <header class="agent-run-head">
            <div class="agent-run-title">
              <h3>${escapeHtml(run.title || t("agents.run.untitled"))}</h3>
              <p class="settings-hint">${escapeHtml(run.harness?.name || "")}${run.model ? ` · ${escapeHtml(run.model)}` : ""} · ${escapeHtml(hooks.formatTimestamp(run.createdAt))}${run.startedAt ? ` · ${escapeHtml(duration(run.startedAt, isActive(status) ? "" : run.endedAt))}` : ""}${view.model.usage || run.usage ? ` · ${usageText(view.model.usage || run.usage)}` : ""}</p>
            </div>
            <span class="agent-status-chip" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}${waiting ? ` (${waiting})` : ""}</span>
            <div class="agent-run-actions">
              ${view.live && isActive(status) ? `<button type="button" class="danger-button compact" data-run-action="cancel">${escapeHtml(t("agents.run.cancel"))}</button>` : ""}
              ${!isActive(status) ? `<button type="button" class="secondary-button compact" data-run-action="again">${escapeHtml(t("agents.run.again"))}</button>` : ""}
              ${hooks.standalone ? "" : `<a class="secondary-button compact" href="${escapeHtml(hooks.Api.runPageUrl(run.startupId, run.id))}" target="_blank" rel="noopener">${escapeHtml(t("agents.run.ownWindow"))}</a>`}
              ${hooks.onClose ? `<button type="button" class="text-button" data-run-action="close">${escapeHtml(t("agents.run.close"))}</button>` : ""}
            </div>
          </header>
          ${notices}
          <div class="agent-run-tabs" role="tablist">${tabs}</div>
          <div class="agent-run-body" role="tabpanel">${tabBody()}</div>
        </article>`;
      const textarea = holder.querySelector("textarea[name=text]");
      if (textarea && draft) textarea.value = draft;
      if (textarea && hadFocus) textarea.focus();
      const pane = holder.querySelector(".agent-conversation");
      if (pane && view.tab === "conversation") pane.scrollTop = pane.scrollHeight;
    }

    function schedule() {
      if (view.frame) return;
      view.frame = (root.requestAnimationFrame || ((fn) => root.setTimeout(fn, 16)))(draw);
    }

    function stopStream() {
      if (view.source) view.source.close();
      view.source = null;
    }

    async function refresh() {
      if (!view.runId) return;
      const body = await request(hooks.Api.urls.agentRun(view.runId));
      view.run = body.run;
      view.live = body.live;
      view.canMessage = body.canMessage;
      hooks.onChange?.();
    }

    function stream() {
      stopStream();
      const runId = view.runId;
      const source = new root.EventSource(hooks.Api.urls.agentRunEvents(runId, view.model.lastSeq));
      view.source = source;
      const onEvent = (message) => {
        if (view.runId !== runId) return;
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (event.type === "closed") {
          stopStream();
          refresh().then(schedule, () => {});
          return;
        }
        applyEvent(view.model, event);
        // The run itself (changes, permissions, follow-up) is read again
        // when something in it changed.
        if (["status", "permission", "change", "undo", "idle"].includes(event.type)) refresh().then(schedule, () => {});
        schedule();
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, onEvent);
    }

    async function open(runId) {
      stopStream();
      Object.assign(view, { runId, run: null, live: false, canMessage: false, model: emptyConversation(), tab: "conversation", log: "", message: "" });
      draw();
      try {
        await refresh();
        draw();
        stream();
      } catch (error) {
        view.message = error.message;
        draw();
      }
    }

    async function act(action, button) {
      const run = view.run;
      if (!run || view.busy) return;
      try {
        view.busy = true;
        view.message = "";
        if (action === "cancel") await request(hooks.Api.urls.agentRunAction(run.id, "cancel"), { method: "POST", body: {} });
        else if (action === "undo") {
          if (!(await root.StartupTrackerDialog.confirm(t("agents.run.undoConfirm", { count: (run.changes || []).length }), { danger: true }))) return;
          await request(hooks.Api.urls.agentRunAction(run.id, "undo"), { method: "POST", body: {} });
        } else if (action === "answer") {
          await request(hooks.Api.urls.agentRunPermission(run.id, button.dataset.request), { method: "POST", body: { optionId: button.dataset.option } });
        } else if (action === "again") {
          hooks.runAgain?.(run);
          return;
        } else if (action === "import") {
          hooks.openImport?.(run.jsonFallback);
          return;
        } else if (action === "open-record") {
          hooks.openRecord?.(button.dataset.kind, button.dataset.id);
          return;
        } else if (action === "close") {
          close();
          hooks.onClose?.();
          return;
        }
        await refresh();
      } catch (error) {
        view.message = error.message;
      } finally {
        view.busy = false;
        draw();
      }
    }

    holder.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-run-tab]");
      if (tab) {
        view.tab = tab.dataset.runTab;
        if (view.tab === "log") {
          root.fetch(hooks.Api.urls.agentRunLog(view.runId), { cache: "no-store" }).then((response) => response.text()).then((text) => {
            view.log = text;
            draw();
          }, () => {});
        }
        draw();
        return;
      }
      const button = event.target.closest("[data-run-action]");
      if (button) act(button.dataset.runAction, button);
    });

    holder.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-run-form=message]");
      if (!form) return;
      event.preventDefault();
      const text = String(new root.FormData(form).get("text") || "").trim();
      if (!text) return;
      try {
        await request(hooks.Api.urls.agentRunAction(view.runId, "message"), { method: "POST", body: { text } });
        form.reset();
        await refresh();
        stream();
      } catch (error) {
        view.message = error.message;
      }
      draw();
    });

    function close() {
      stopStream();
      view.runId = "";
      view.run = null;
      holder.innerHTML = "";
    }

    return { open, close, refresh: () => refresh().then(draw), get runId() { return view.runId; } };
  }

  // The Agents page: runs of this startup (or of all startups), one open.
  // hooks: as createRunView, plus startupId, onCounts(counts).
  function create(container, hooks) {
    const t = hooks.t;
    const page = { runs: [], counts: { running: 0, waiting: 0 }, all: false, message: "", loaded: false, timer: 0 };
    let runView = null;

    function listHtml() {
      if (!page.loaded) return `<p class="settings-hint">${escapeHtml(t("agents.loading"))}</p>`;
      if (!page.runs.length) return `<div class="empty-state compact"><h3>${escapeHtml(t("agents.emptyTitle"))}</h3><p>${escapeHtml(t("agents.emptyHint"))}</p></div>`;
      return `
        <table class="agent-runs-table">
          <thead><tr><th scope="col">${escapeHtml(t("agents.columns.run"))}</th><th scope="col">${escapeHtml(t("agents.columns.agent"))}</th><th scope="col">${escapeHtml(t("agents.columns.status"))}</th><th scope="col">${escapeHtml(t("agents.columns.started"))}</th><th scope="col">${escapeHtml(t("agents.columns.duration"))}</th></tr></thead>
          <tbody>${page.runs.map((run) => `
            <tr class="${runView?.runId === run.id ? "is-open" : ""}">
              <td><button type="button" class="text-button" data-open-run="${escapeHtml(run.id)}">${escapeHtml(run.title || t("agents.run.untitled"))}</button>${page.all ? ` <span class="settings-hint">${escapeHtml(run.startupId)}</span>` : ""}</td>
              <td>${escapeHtml(run.harness?.name || "")}${run.model ? `<br><span class="settings-hint">${escapeHtml(run.model)}</span>` : ""}</td>
              <td><span class="agent-status-chip" data-status="${escapeHtml(run.status)}">${escapeHtml(t(`agents.status.${STATUSES.includes(run.status) ? run.status : "queued"}`))}</span>${run.changeCount ? ` <span class="settings-hint">${escapeHtml(t("agents.changeCount", { count: run.changeCount }))}</span>` : ""}</td>
              <td>${escapeHtml(hooks.formatTimestamp(run.startedAt || run.createdAt))}</td>
              <td>${escapeHtml(duration(run.startedAt, isActive(run.status) ? "" : run.endedAt))}</td>
            </tr>`).join("")}</tbody>
        </table>`;
    }

    function drawList() {
      const list = container.querySelector(".agents-list");
      if (list) list.innerHTML = listHtml();
      const stop = container.querySelector("[data-agents-action=stop-all]");
      if (stop) stop.disabled = !page.counts.running;
    }

    function draw() {
      container.innerHTML = `
        <div class="agents-page">
          <div class="agents-toolbar">
            <label class="settings-check"><input type="checkbox" data-agents-all ${page.all ? "checked" : ""}><span>${escapeHtml(t("agents.allStartups"))}</span></label>
            <button type="button" class="secondary-button compact" data-agents-action="settings">${escapeHtml(t("agents.settings"))}</button>
            <button type="button" class="danger-button compact" data-agents-action="stop-all">${escapeHtml(t("agents.stopAll"))}</button>
          </div>
          ${page.message ? `<p class="settings-error" role="alert">${escapeHtml(page.message)}</p>` : ""}
          <div class="agents-layout">
            <section class="agents-list" aria-label="${escapeHtml(t("agents.listLabel"))}"></section>
            <section class="agents-run-holder" aria-live="polite"></section>
          </div>
        </div>`;
      drawList();
      const holder = container.querySelector(".agents-run-holder");
      const openId = runView?.runId;
      runView = createRunView(holder, { ...hooks, onClose: () => drawList(), onChange: () => load({ quiet: true }) });
      if (openId) runView.open(openId);
    }

    async function load({ quiet = false } = {}) {
      try {
        const body = await request(hooks.Api.urls.agentRuns(page.all ? "" : hooks.startupId));
        page.runs = body.runs;
        page.counts = body.counts;
        page.loaded = true;
        page.message = "";
        hooks.onCounts?.(body.counts);
      } catch (error) {
        if (!quiet) page.message = error.message;
      }
      if (container.querySelector(".agents-page")) drawList();
    }

    container.addEventListener("click", async (event) => {
      const open = event.target.closest("[data-open-run]");
      if (open) {
        runView?.open(open.dataset.openRun);
        drawList();
        return;
      }
      const action = event.target.closest("[data-agents-action]")?.dataset.agentsAction;
      if (action === "stop-all") {
        if (!(await root.StartupTrackerDialog.confirm(t("agents.stopAllConfirm", { count: page.counts.running }), { danger: true }))) return;
        try {
          await request(hooks.Api.urls.agentRunsStopAll, { method: "POST", body: {} });
        } catch (error) {
          page.message = error.message;
        }
        await load();
      } else if (action === "settings") {
        hooks.openSettings?.();
      }
    });

    container.addEventListener("change", (event) => {
      if (event.target.matches("[data-agents-all]")) {
        page.all = event.target.checked;
        load();
      }
    });

    return {
      render() {
        if (!container.querySelector(".agents-page")) draw();
        load();
      },
      openRun(runId) {
        if (!container.querySelector(".agents-page")) draw();
        runView.open(runId);
        load({ quiet: true });
      },
      load,
    };
  }

  // The overlay a run opens in from the Prompts page.
  function openOverlay(runId, hooks) {
    let dialog = root.document.querySelector("#agentRunOverlay");
    if (!dialog) {
      dialog = root.document.createElement("dialog");
      dialog.id = "agentRunOverlay";
      dialog.className = "agent-run-overlay";
      dialog.setAttribute("aria-label", hooks.t("agents.overlayLabel"));
      dialog.innerHTML = "<div class=\"agent-run-overlay-body\"></div>";
      root.document.body.appendChild(dialog);
    }
    const holder = dialog.querySelector(".agent-run-overlay-body");
    if (dialog.runView) dialog.runView.close();
    const fresh = holder.cloneNode(false);
    holder.replaceWith(fresh);
    dialog.runView = createRunView(fresh, { ...hooks, onClose: () => dialog.close() });
    dialog.addEventListener("close", () => dialog.runView?.close(), { once: true });
    if (!dialog.open) dialog.showModal();
    dialog.runView.open(runId);
    return dialog.runView;
  }

  // "Run with...": startup, agent, model and the prompt as it will be sent.
  // spec: { text, template, values, unresolved, constraints, title, presetId,
  // startupName }. Resolves with the new run, or null when closed.
  async function openRunDialog(spec, hooks) {
    const t = hooks.t;
    let overview;
    try {
      overview = await request(hooks.Api.urls.agents);
    } catch (error) {
      root.StartupTrackerDialog.alert(error.message);
      return null;
    }
    const usable = overview.harnesses;
    return new Promise((resolve) => {
      const dialog = root.document.createElement("dialog");
      dialog.className = "agent-run-dialog";
      dialog.setAttribute("aria-labelledby", "agentRunDialogTitle");
      const state = { harnessId: (usable.find((harness) => !harness.blocked) || usable[0] || {}).id || "", model: "", effort: null, error: "", busy: false };

      function harness() {
        return usable.find((entry) => entry.id === state.harnessId) || null;
      }

      function draw() {
        const current = harness();
        if (current && !state.model) state.model = current.defaultModel || modelChoices(current)[0]?.value || "";
        const models = modelChoices(current, state.model);
        // OpenRouter routing (OpenCode): a suffix on the model id.
        const variants = current?.routingVariants || [];
        const route = routingParts(state.model, variants);
        const routable = variants.length > 0 && route.base.startsWith("openrouter/");
        // The effort levels the last check read for this model, and the one
        // picked for it in Settings; null until that default is filled in.
        const efforts = current ? effortChoices(current, state.model) : [];
        if (current && state.effort === null) state.effort = current.effortByModel?.[state.model || ""] || "";
        const checks = dialogChecks({ unresolved: spec.unresolved, placeholderLeft: spec.placeholderLeft, constraints: spec.constraints, harness: current });
        dialog.innerHTML = `
          <form class="agent-run-form" method="dialog">
            <h2 id="agentRunDialogTitle">${escapeHtml(t("agents.dialog.title"))}</h2>
            <p class="settings-hint">${escapeHtml(t("agents.dialog.startup", { name: spec.startupName }))}</p>
            ${usable.length ? `
              <label class="settings-field">${escapeHtml(t("agents.dialog.agent"))}
                <select name="harness">${usable.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === state.harnessId ? "selected" : ""}>${escapeHtml(entry.name)}${entry.blocked ? ` (${escapeHtml(t("agents.dialog.blockedShort"))})` : ""}</option>`).join("")}</select>
              </label>
              <label class="settings-field">${escapeHtml(t("agents.dialog.model"))}
                ${models.length
    ? `<select name="model">${models.map((model) => `<option value="${escapeHtml(model.value)}" ${model.value === state.model ? "selected" : ""}>${escapeHtml(model.name)}${model.preferred ? " ★" : ""}</option>`).join("")}</select>`
    : `<input type="text" name="model" value="${escapeHtml(state.model)}" placeholder="${escapeHtml(t("agents.dialog.modelPlaceholder"))}">`}
              </label>
              ${routable ? `
              <label class="settings-field">${escapeHtml(t("agents.dialog.routing"))}
                <select name="routing">
                  <option value="" ${route.routing ? "" : "selected"}>${escapeHtml(t("settings.agents.routing.default"))}</option>
                  ${variants.map((suffix) => `<option value="${escapeHtml(suffix)}" ${suffix === route.routing ? "selected" : ""}>${escapeHtml(t(`settings.agents.routing.${suffix.slice(1)}`))}</option>`).join("")}
                </select>
              </label>` : ""}
              ${efforts.length ? `
              <label class="settings-field">${escapeHtml(t("agents.dialog.effort"))}
                <select name="effort">
                  <option value="" ${state.effort ? "" : "selected"}>${escapeHtml(t("agents.dialog.effortDefault"))}</option>
                  ${efforts.map((level) => `<option value="${escapeHtml(level.value)}" ${level.value === state.effort ? "selected" : ""}>${escapeHtml(level.name)}</option>`).join("")}
                </select>
              </label>` : ""}
              ${current ? `<p class="settings-hint">${escapeHtml(t(`agents.policies.${current.policy}.name`))}: ${escapeHtml(t(`agents.policies.${current.policy}.hint`))}</p>` : ""}` : `<p class="settings-hint">${escapeHtml(t("agents.dialog.noAgents"))}</p>`}
            ${spec.constraints ? `<div class="agent-constraints"><strong>${escapeHtml(t("agents.dialog.constraints"))}</strong><p>${escapeHtml(spec.constraints)}</p></div>` : ""}
            ${[...checks.blocking, ...checks.warnings].map((entry) => `<p class="${checks.blocking.includes(entry) ? "settings-error" : "agent-warning"}">${escapeHtml(t(entry.key, entry.params))}</p>`).join("")}
            <details class="agent-dialog-prompt" open><summary>${escapeHtml(t("agents.dialog.prompt"))}</summary><pre>${escapeHtml(spec.text)}</pre></details>
            <p class="settings-hint">${escapeHtml(t("agents.dialog.privacy"))}</p>
            ${state.error ? `<p class="settings-error" role="alert">${escapeHtml(state.error)}</p>` : ""}
            <div class="startup-form-actions">
              ${usable.length ? "" : `<button type="button" class="secondary-button" data-dialog-action="settings">${escapeHtml(t("agents.settings"))}</button>`}
              <button type="button" class="secondary-button" data-dialog-action="cancel">${escapeHtml(t("agents.dialog.cancel"))}</button>
              <button type="submit" class="primary-button" ${checks.canStart && !state.busy ? "" : "disabled"}>${escapeHtml(t("agents.dialog.start"))}</button>
            </div>
          </form>`;
      }

      dialog.addEventListener("change", (event) => {
        if (event.target.name === "harness") {
          state.harnessId = event.target.value;
          state.model = "";
          state.effort = null;
          draw();
        } else if (event.target.name === "model") {
          state.model = event.target.value;
          state.effort = null;
          draw();
        } else if (event.target.name === "routing") {
          state.model = `${routingParts(state.model, harness()?.routingVariants).base}${event.target.value}`;
          state.effort = null;
          draw();
        } else if (event.target.name === "effort") state.effort = event.target.value;
      });
      dialog.addEventListener("input", (event) => {
        if (event.target.name === "model") state.model = event.target.value;
      });
      dialog.addEventListener("click", (event) => {
        const action = event.target.closest("[data-dialog-action]")?.dataset.dialogAction;
        if (action === "cancel") dialog.close();
        if (action === "settings") {
          dialog.close();
          hooks.openSettings?.();
        }
      });
      dialog.addEventListener("submit", async (event) => {
        event.preventDefault();
        state.busy = true;
        state.error = "";
        draw();
        try {
          const body = await request(hooks.Api.startupApiUrl(hooks.startupId, "agent-runs"), {
            method: "POST",
            body: { harnessId: state.harnessId, model: state.model, effort: state.effort || "", template: spec.template, values: spec.values, title: spec.title, presetId: spec.presetId },
          });
          dialog.result = body.run;
          dialog.close();
        } catch (error) {
          state.error = error.message;
          state.busy = false;
          draw();
        }
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.result || null);
      });
      draw();
      root.document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  // Counts for the sidebar badge: runs going and runs waiting for you,
  // checked every few seconds while any runs, every minute otherwise.
  function watchCounts(hooks, onCounts) {
    let timer = 0;
    async function tick() {
      let counts = { running: 0, waiting: 0 };
      try {
        counts = (await request(hooks.Api.urls.agentRuns(""))).counts;
        onCounts(counts);
      } catch {
        // The next tick tries again.
      }
      timer = root.setTimeout(tick, counts.running ? 5000 : 60000);
    }
    tick();
    return {
      now() {
        root.clearTimeout(timer);
        tick();
      },
    };
  }

  return Object.freeze({ ...pure, createRunView, create, openOverlay, openRunDialog, watchCounts });
});
