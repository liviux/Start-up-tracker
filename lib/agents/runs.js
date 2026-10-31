"use strict";

// Agent runs: a prompt sent to one of your agents for one startup, watched
// live from the browser.
//
// Each run has a folder, agent-runs/<startupId>/<runId>/, in the data folder:
//   run.json      what the run is: agent, model, prompt, status, changes,
//                 permission decisions, usage
//   events.jsonl  what the page shows, one event per line with a sequence
//                 number, so a reconnect resumes where it stopped
//   log.jsonl     the raw protocol messages and the agent's stderr, with
//                 configured secrets and tokens replaced by ***
//   AGENTS.md     the run's rules, read by agents that look for one
//   work/         the agent's working folder (not a sandbox: the agent's own
//                 tools can reach whatever your user account can)
//
// The agent gets the tracker tools as an MCP server (bin/tracker-mcp.js) with
// a token that can only create, update and link records of this startup
// while the run lasts. Writes are saved at once; "Undo this run" puts back
// what was there before, unless someone changed it since.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID } = require("../tracker-sqlite-store");
const agentTokens = require("../agent-tokens");
const AiImport = require("../../public/js/ai-import.js");
const { AcpConnection } = require("./acp-client");
const { resolveLaunch, cleanEnv } = require("./process");
const { routingEnv } = require("./openrouter");
const { launchEffort, withLaunchEffort } = require("./launch-effort");
const harnesses = require("./harnesses");
const { needsDownloadConsent } = require("./check");
const { callTool } = require("./tools");
const { NAMES: TOOL_NAMES } = require("./tool-definitions");

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);
const FINISHED = new Set(["done", "failed", "cancelled", "interrupted"]);
const MAX_EVENTS = 20000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200000;
const FOLLOW_UP_MINUTES = 10;
const CANCEL_GRACE_MS = 10000;
const RESEARCH_KINDS = new Set(["read", "search", "fetch", "think"]);
const REFUSED_KINDS = new Set(["edit", "delete", "move", "execute", "switch_mode"]);
const RUN_ID = /^run-[a-z0-9]{6,40}$/;
const BIN_OF = { items: "deletedItems", programs: "deletedPrograms", funding: "deletedFunding" };

class RunError extends Error {
  constructor(message, code = "run", statusCode = 400) {
    super(message);
    this.name = "RunError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const AGENTS_MD = `# Rules for this run

You are working for one startup in Startup Tracker, a local tracker of
marketing targets, programs and funding.

- Use the tracker tools (the "tracker" MCP server) to read and save. Do not
  edit files to change the tracker.
- Never delete anything. There is no delete tool.
- Before creating a target, check for duplicates with search_targets, by
  name and by web address; update the existing target instead.
- Cite your sources: put the official page you used, and the date you checked
  it, in the notes. Leave out what you could not verify; never invent dates,
  amounts or results.
- Respect the daily limit for new targets (get_startup_context,
  get_calendar_load).
`;

// The decision a policy takes for a permission request: an option id, or
// null to ask you. "allow" approves everything; "research" allows reading,
// searching, fetching, thinking and the tracker tools, and refuses edit,
// delete, move and execute.
function decidePermission(policy, request) {
  const options = Array.isArray(request?.options) ? request.options : [];
  const pick = (...kinds) => {
    for (const kind of kinds) {
      const option = options.find((entry) => entry.kind === kind);
      if (option) return option.optionId;
    }
    return null;
  };
  const allow = () => pick("allow_once", "allow_always");
  const reject = () => pick("reject_once", "reject_always");
  if (policy === "ask") return { ask: true };
  if (policy === "research") {
    const call = request?.toolCall || {};
    const kind = String(call.kind || "other");
    if (RESEARCH_KINDS.has(kind)) return { optionId: allow(), reason: `${kind} is allowed in research mode` };
    if (REFUSED_KINDS.has(kind)) return { optionId: reject(), reason: `${kind} is refused in research mode` };
    const text = `${call.title || ""} ${call.name || ""} ${JSON.stringify(call.rawInput || "")}`;
    if (TOOL_NAMES.some((name) => text.includes(name)) || /\btracker\b/i.test(text)) return { optionId: allow(), reason: "a tracker tool" };
    return { optionId: reject(), reason: "not a research action" };
  }
  return { optionId: allow(), reason: "allow everything" };
}

// Replaces each secret (at least 4 characters) with ***.
function redactor(secrets) {
  const list = [...new Set(secrets.filter((value) => typeof value === "string" && value.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const secret of list) out = out.split(secret).join("***");
    return out;
  };
}

// The last ```json block of a reply that holds targets, for "Import AI
// results", or "".
function jsonFallback(text) {
  const blocks = [...String(text || "").matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (const block of blocks.reverse()) {
    const parsed = AiImport.parse(`\`\`\`json\n${block[1]}\`\`\``);
    if (!parsed.error && parsed.entries.length) return block[1].trim();
  }
  return "";
}

class RunManager {
  // store, paths: { agentRunsDir, secretsDir }, baseUrl() -> the tracker's
  // address, extraSecrets() -> values to redact (the master token),
  // clientVersion, mcpScript (bin/tracker-mcp.js), timeZone(). Tests shorten
  // minuteMs (how long a "minute" of the timeout and idle settings lasts) and
  // idleCheckMs.
  constructor({ store, paths, baseUrl, extraSecrets = () => [], clientVersion = "", mcpScript, timeZone = () => "", spawnHook = null, minuteMs = 60000, idleCheckMs = 15000 }) {
    this.store = store;
    this.dir = paths.agentRunsDir;
    this.secretsDir = paths.secretsDir;
    this.baseUrl = baseUrl;
    this.extraSecrets = extraSecrets;
    this.clientVersion = clientVersion;
    this.mcpScript = mcpScript;
    this.timeZone = timeZone;
    this.spawnHook = spawnHook;
    this.minuteMs = minuteMs;
    this.idleCheckMs = idleCheckMs;
    this.live = new Map();
    this.queue = [];
    // Agents of released runs that are still being stopped; shutdown() waits
    // for them, so none outlives the tracker or keeps its folder busy.
    this.stopping = new Set();
  }

  // ---- storage ----

  runDir(startupId, runId) {
    return path.join(this.dir, startupId, runId);
  }

  #write(run) {
    const dir = this.runDir(run.startupId, run.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "run.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  #read(startupId, runId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.runDir(startupId, runId), "run.json"), "utf8"));
    } catch {
      return null;
    }
  }

  #allRuns() {
    const runs = [];
    if (!fs.existsSync(this.dir)) return runs;
    for (const startupId of fs.readdirSync(this.dir)) {
      const startupDir = path.join(this.dir, startupId);
      if (!fs.statSync(startupDir).isDirectory()) continue;
      for (const runId of fs.readdirSync(startupDir)) {
        if (!RUN_ID.test(runId)) continue;
        const live = this.live.get(runId);
        const run = live ? live.run : this.#read(startupId, runId);
        if (run) runs.push(run);
      }
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // Runs left "running" by a server that stopped are "interrupted".
  init() {
    for (const run of this.#allRuns()) {
      if (ACTIVE.has(run.status)) {
        run.status = "interrupted";
        run.endedAt = run.endedAt || new Date().toISOString();
        run.error = run.error || "The tracker stopped while this run was going.";
        this.#write(run);
        this.#appendEventFile(run, { type: "status", data: { status: "interrupted" } });
      }
    }
    for (const token of agentTokens.listTokens(this.store)) {
      if (token.scope === "run" && token.active) {
        try {
          agentTokens.revokeToken(this.store, token.id, { origin: "tool" });
        } catch {
          // Already gone.
        }
      }
    }
  }

  summary(run) {
    const { prompt, changes, permissions, ...rest } = run;
    return { ...rest, promptChars: String(prompt || "").length, changeCount: (changes || []).length, waitingFor: (permissions || []).filter((entry) => !entry.decision).length };
  }

  list({ startupId = "" } = {}) {
    return this.#allRuns().filter((run) => !startupId || run.startupId === startupId).map((run) => this.summary(run));
  }

  get(runId) {
    if (!RUN_ID.test(String(runId || ""))) throw new RunError("No such run.", "notFound", 404);
    const live = this.live.get(runId);
    if (live) return live.run;
    const found = this.#allRuns().find((run) => run.id === runId);
    if (!found) throw new RunError("No such run.", "notFound", 404);
    return found;
  }

  counts() {
    const runs = this.#allRuns();
    return { running: runs.filter((run) => ACTIVE.has(run.status)).length, waiting: runs.filter((run) => run.status === "waiting").length };
  }

  // ---- events ----

  #appendEventFile(run, event) {
    const dir = this.runDir(run.startupId, run.id);
    fs.mkdirSync(dir, { recursive: true });
    const seq = (run.eventCount || 0) + 1;
    run.eventCount = seq;
    const entry = { seq, at: new Date().toISOString(), ...event };
    fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  #emit(state, type, data) {
    const { run } = state;
    if ((run.eventCount || 0) >= MAX_EVENTS) {
      if (!state.capped) {
        state.capped = true;
        const entry = this.#appendEventFile(run, { type: "notice", data: { text: "This run reached its output limit; later updates are not stored." } });
        for (const listener of state.listeners) listener(entry);
      }
      if (type !== "status") return null;
    }
    const entry = this.#appendEventFile(run, { type, data });
    run.lastEventAt = entry.at;
    if (run.idle && type !== "idle") run.idle = false;
    for (const listener of state.listeners) listener(entry);
    return entry;
  }

  // Events after `after`, for a page that (re)connects.
  events(runId, after = 0) {
    const run = this.get(runId);
    const file = path.join(this.runDir(run.startupId, run.id), "events.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.seq > after);
  }

  // Listens to new events; returns a function that stops listening.
  subscribe(runId, listener) {
    const state = this.live.get(runId);
    if (!state) return () => {};
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  isLive(runId) {
    return this.live.has(runId);
  }

  // Whether a follow-up message can go to the run's agent now.
  canMessage(runId) {
    const state = this.live.get(runId);
    return Boolean(state && state.connection && !state.connection.exited && state.sessionId && !state.turnActive);
  }

  #log(state, entry) {
    if (state.logBytes >= MAX_LOG_BYTES) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry, text: state.redact(entry.text) })}\n`;
    state.logBytes += Buffer.byteLength(line);
    try {
      fs.appendFileSync(path.join(this.runDir(state.run.startupId, state.run.id), "log.jsonl"), line);
    } catch {
      // The run's folder is gone (pruned, or the tracker is stopping); the
      // agent's last words are not worth an error.
    }
  }

  logText(runId) {
    const run = this.get(runId);
    const file = path.join(this.runDir(run.startupId, run.id), "log.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  // ---- runs ----

  // Starts a run of a stored harness. The prompt is the text the page
  // rendered and the server checked (no unresolved variables).
  create({ startupId, harnessId, model = "", effort, prompt, title = "", presetId = "", origin = "ui" }) {
    if (!startupId || startupId === GLOBAL_STARTUP_ID) throw new RunError("A run belongs to one startup.");
    const harness = harnesses.getHarness(this.store, harnessId);
    if (harness.lastCheck?.state === "failed" && !harness.overrideBlock) throw new RunError(`${harness.name} failed its last check. Check it again, or allow it anyway in Settings > AI agents.`, "blocked", 409);
    if (needsDownloadConsent(harness)) throw new RunError(`Allow the download of ${harness.package} in Settings > AI agents first.`, "consentNeeded", 409);
    const text = String(prompt || "");
    if (!text.trim()) throw new RunError("The prompt is empty.");
    if (text.length > MAX_PROMPT_CHARS) throw new RunError("The prompt is too long.");
    if (/\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/.test(text)) throw new RunError("The prompt still has unfilled variables.", "unresolved");
    const settings = harnesses.readSettings(this.store);
    const now = new Date().toISOString();
    const run = {
      id: `run-${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`,
      startupId,
      harnessId,
      harness: { name: harness.name, kind: harness.kind, commandLine: harness.commandLine || harnesses.commandLine(harness), policy: harness.policy, registryId: harness.registryId || "" },
      model: String(model || harness.defaultModel || ""),
      // No effort sent: the one you picked for this model in Settings.
      effort: String(effort ?? harnesses.effortFor(harness, model || harness.defaultModel) ?? "").slice(0, 200),
      title: String(title || "").slice(0, 160),
      presetId: String(presetId || ""),
      prompt: text,
      status: "queued",
      stopReason: "",
      error: "",
      createdAt: now,
      startedAt: "",
      endedAt: "",
      lastEventAt: now,
      idle: false,
      usage: null,
      changes: [],
      permissions: [],
      turns: 0,
      jsonFallback: "",
      undoneAt: "",
      undo: null,
      eventCount: 0,
      timeoutMinutes: settings.timeoutMinutes,
      origin,
    };
    this.#write(run);
    const state = this.#state(run, harness);
    this.#emit(state, "status", { status: "queued" });
    this.#emit(state, "message", { role: "user", text });
    this.queue.push(run.id);
    this.#pump();
    this.#prune(settings.keepRuns);
    return run;
  }

  #state(run, harness) {
    const env = harnesses.readEnv(this.secretsDir, harness.id);
    const state = {
      run,
      harness,
      env,
      connection: null,
      sessionId: "",
      listeners: new Set(),
      pending: new Map(),
      results: new Map(),
      token: null,
      redact: redactor([...Object.values(env), ...this.extraSecrets()]),
      logBytes: 0,
      capped: false,
      turnActive: false,
      timers: [],
      reply: "",
      cancelRequested: false,
    };
    this.live.set(run.id, state);
    return state;
  }

  #activeTurns() {
    let count = 0;
    for (const state of this.live.values()) if (["starting", "running", "waiting"].includes(state.run.status)) count += 1;
    return count;
  }

  #pump() {
    const { concurrency } = harnesses.readSettings(this.store);
    while (this.queue.length && this.#activeTurns() < concurrency) {
      const runId = this.queue.shift();
      const state = this.live.get(runId);
      if (!state || state.run.status !== "queued") continue;
      this.#start(state).catch((error) => this.#finish(state, "failed", error.message));
    }
  }

  #setStatus(state, status, extra = {}) {
    // A run stopped while it was starting is released already: a late step
    // of its start must not mark it running again.
    if (this.live.get(state.run.id) !== state) return;
    Object.assign(state.run, { status }, extra);
    this.#write(state.run);
    this.#emit(state, "status", { status, ...extra });
  }

  async #start(state) {
    const { run, harness } = state;
    this.#setStatus(state, "starting", { startedAt: new Date().toISOString() });
    const dir = this.runDir(run.startupId, run.id);
    const work = path.join(dir, "work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), AGENTS_MD);
    fs.writeFileSync(path.join(work, "AGENTS.md"), AGENTS_MD);
    const hours = Math.max(1, Math.ceil((run.timeoutMinutes + FOLLOW_UP_MINUTES) / 60));
    const made = agentTokens.createToken(this.store, { startupId: run.startupId, label: `Run of ${harness.name}`.slice(0, 80), hours, runId: run.id, origin: "tool" });
    state.token = made;
    state.redact = redactor([...Object.values(state.env), made.token, ...this.extraSecrets()]);
    const env = routingEnv(harness, [run.model, harness.defaultModel, ...(harness.preferredModels || [])], cleanEnv(state.env));
    // Cline takes the effort as a launch flag; the others over ACP below.
    const launch = resolveLaunch(withLaunchEffort(harness, run.effort), { env });
    if (launch.error) throw new Error(launch.error);
    run.launch = { display: state.redact(launch.display || "") };
    const connection = new AcpConnection({
      launch,
      cwd: work,
      env,
      clientVersion: this.clientVersion,
      onUpdate: (params) => this.#onUpdate(state, params),
      onPermission: (params) => this.#onPermission(state, params),
      onMessage: (direction, line) => this.#log(state, { kind: "rpc", direction, text: line }),
      onStderr: (text) => this.#log(state, { kind: "stderr", text }),
      onExit: (code, signal) => this.#onExit(state, code, signal),
    });
    this.spawnHook?.(connection);
    state.connection = connection.start();
    const info = await connection.initialize();
    this.#emit(state, "agent", { agentInfo: info.agentInfo });
    const mcpServers = [{
      name: "tracker",
      command: process.execPath,
      args: [this.mcpScript],
      env: [
        { name: "TRACKER_URL", value: this.baseUrl() },
        { name: "TRACKER_RUN_TOKEN", value: made.token },
        { name: "TRACKER_STARTUP_ID", value: run.startupId },
        { name: "TRACKER_RUN_ID", value: run.id },
      ],
    }];
    const session = await connection.newSession({ cwd: work, mcpServers });
    state.sessionId = session.sessionId;
    this.#emit(state, "session", { models: session.choices.models, currentModel: session.choices.currentModel });
    if (run.model) {
      try {
        await connection.setModel(session.sessionId, run.model);
      } catch (error) {
        this.#emit(state, "notice", { text: `The model ${run.model} could not be set: ${error.message}` });
      }
    } else if (session.choices.currentModel) {
      run.model = session.choices.currentModel;
    }
    if (run.effort && !launchEffort(harness)) {
      try {
        if (!await connection.setThoughtLevel(session.sessionId, run.effort)) this.#emit(state, "notice", { text: `${run.harness.name} offers no effort level ${run.effort} here; it uses its own.` });
      } catch (error) {
        this.#emit(state, "notice", { text: `The effort level ${run.effort} could not be set: ${error.message}` });
      }
    }
    // Stopped while starting: cancel() finishes the run (at once, or on its
    // next tick), so the prompt is never sent.
    if (state.cancelRequested || this.live.get(run.id) !== state) return;
    const timeout = setTimeout(() => this.cancel(run.id, { reason: "timeout" }), run.timeoutMinutes * this.minuteMs);
    timeout.unref?.();
    state.timers.push(timeout);
    this.#watchIdle(state);
    await this.#turn(state, run.prompt);
  }

  #watchIdle(state) {
    const { idleMinutes } = harnesses.readSettings(this.store);
    const timer = setInterval(() => {
      if (!state.turnActive || state.run.idle || state.run.status === "waiting") return;
      if (Date.now() - Date.parse(state.run.lastEventAt) >= idleMinutes * this.minuteMs) {
        this.#emit(state, "idle", { minutes: idleMinutes });
        state.run.idle = true;
        this.#write(state.run);
      }
    }, this.idleCheckMs);
    timer.unref?.();
    state.timers.push(timer);
  }

  async #turn(state, text) {
    const { run } = state;
    state.turnActive = true;
    state.reply = "";
    run.turns += 1;
    this.#setStatus(state, "running");
    let result;
    try {
      result = await state.connection.prompt(state.sessionId, text);
    } catch (error) {
      state.turnActive = false;
      if (state.cancelRequested) return this.#finish(state, "cancelled", "");
      return this.#finish(state, "failed", error.message);
    }
    state.turnActive = false;
    run.stopReason = result.stopReason;
    if (state.cancelRequested || result.stopReason === "cancelled") return this.#finish(state, "cancelled", "");
    if (!run.changes.length) run.jsonFallback = jsonFallback(state.reply);
    this.#finish(state, "done", "", { keepAlive: true });
  }

  #onUpdate(state, params) {
    const update = params?.update || {};
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      const text = update.content?.type === "text" ? String(update.content.text || "") : `[${update.content?.type || "content"}]`;
      if (kind === "agent_message_chunk") state.reply += text;
      this.#emit(state, "chunk", { role: kind === "agent_thought_chunk" ? "thought" : kind === "user_message_chunk" ? "user" : "agent", text: state.redact(text) });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.#emit(state, kind, {
        toolCallId: update.toolCallId,
        title: state.redact(update.title || ""),
        kind: update.kind || "",
        status: update.status || "",
        locations: Array.isArray(update.locations) ? update.locations.map((location) => location.path).filter(Boolean).slice(0, 20) : [],
        content: state.redact(JSON.stringify(update.content || []).slice(0, 4000)),
      });
    } else if (kind === "plan") {
      this.#emit(state, "plan", { entries: (update.entries || []).map((entry) => ({ content: state.redact(entry.content || ""), status: entry.status || "", priority: entry.priority || "" })) });
    } else if (kind === "usage_update") {
      state.run.usage = { used: Number(update.used) || 0, size: Number(update.size) || 0, cost: update.cost || null };
      this.#write(state.run);
      this.#emit(state, "usage", state.run.usage);
    } else if (kind) {
      this.#emit(state, "update", { kind });
    }
  }

  async #onPermission(state, params) {
    const { run, harness } = state;
    // After a cancel the protocol's answer is "cancelled", for every request.
    const decision = state.cancelRequested ? { cancelled: true } : decidePermission(harness.policy, params);
    const entry = {
      id: crypto.randomUUID(),
      title: state.redact(params?.toolCall?.title || ""),
      kind: params?.toolCall?.kind || "",
      options: (params?.options || []).map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
      decision: "",
      decidedBy: "",
      at: new Date().toISOString(),
    };
    run.permissions.push(entry);
    if (decision.cancelled) {
      Object.assign(entry, { decision: "cancelled", decidedBy: "cancelled" });
      this.#write(run);
      this.#emit(state, "permission", entry);
      return { cancelled: true };
    }
    if (!decision.ask) {
      entry.decision = decision.optionId || "cancelled";
      entry.decidedBy = `policy: ${decision.reason}`;
      this.#write(run);
      this.#emit(state, "permission", entry);
      return decision.optionId;
    }
    this.#setStatus(state, "waiting");
    this.#emit(state, "permission", entry);
    const answer = await new Promise((resolve) => state.pending.set(entry.id, resolve));
    state.pending.delete(entry.id);
    entry.decision = answer?.cancelled ? "cancelled" : answer || "";
    entry.decidedBy = answer?.cancelled ? "cancelled" : "you";
    if (run.status === "waiting" && !state.pending.size) this.#setStatus(state, "running");
    else this.#write(run);
    this.#emit(state, "permission", entry);
    return answer;
  }

  // Your answer to a waiting permission request.
  answerPermission(runId, requestId, optionId) {
    const state = this.live.get(runId);
    const resolve = state?.pending.get(requestId);
    if (!resolve) throw new RunError("This request is no longer waiting.", "notWaiting", 409);
    const entry = state.run.permissions.find((item) => item.id === requestId);
    if (!entry?.options.some((option) => option.optionId === optionId)) throw new RunError("Pick one of the offered options.");
    resolve(optionId);
    return entry;
  }

  // Another prompt in the same session, after a turn ended.
  async sendMessage(runId, text) {
    const state = this.live.get(runId);
    if (!state || !state.connection || state.connection.exited || !state.sessionId) throw new RunError("This run's agent has stopped. Use Run again.", "notLive", 409);
    if (state.turnActive) throw new RunError("Wait for the agent to finish, or cancel it.", "busy", 409);
    const message = String(text || "").trim();
    if (!message) throw new RunError("The message is empty.");
    this.#clearFollowUp(state);
    state.cancelRequested = false;
    Object.assign(state.run, { endedAt: "", stopReason: "" });
    this.#emit(state, "message", { role: "user", text: state.redact(message) });
    this.#turn(state, message);
    return state.run;
  }

  // Stops a run: session/cancel, then the whole process tree after 10 s.
  async cancel(runId, { reason = "you" } = {}) {
    const state = this.live.get(runId);
    if (!state) {
      const run = this.get(runId);
      return run;
    }
    const { run } = state;
    if (run.status === "queued") {
      this.queue = this.queue.filter((id) => id !== runId);
      this.#finish(state, "cancelled", reason === "timeout" ? "The run timed out." : "");
      return run;
    }
    // A finished turn whose agent waits for a follow-up: just stop the agent.
    if (!ACTIVE.has(run.status)) {
      this.#release(state);
      return run;
    }
    state.cancelRequested = true;
    if (reason === "timeout") run.error = `The run took longer than ${run.timeoutMinutes} minutes and was stopped.`;
    if (state.connection && state.sessionId && state.turnActive) state.connection.cancel(state.sessionId);
    for (const resolve of state.pending.values()) resolve({ cancelled: true });
    const kill = setTimeout(() => {
      if (this.live.has(runId)) this.#finish(state, "cancelled", run.error || "");
    }, state.turnActive ? CANCEL_GRACE_MS : 0);
    kill.unref?.();
    return run;
  }

  // The tracker is stopping: every agent is stopped at once and its run
  // marked "interrupted".
  async shutdown() {
    const states = [...this.live.values()];
    this.queue = [];
    await Promise.all(states.map(async (state) => {
      const { run } = state;
      if (ACTIVE.has(run.status)) {
        Object.assign(run, { status: "interrupted", endedAt: new Date().toISOString(), error: run.error || "The tracker stopped while this run was going." });
        this.#write(run);
        this.#appendEventFile(run, { type: "status", data: { status: "interrupted", error: run.error } });
        this.#write(run);
      }
      this.#clearFollowUp(state);
      for (const timer of state.timers) clearTimeout(timer), clearInterval(timer);
      this.live.delete(run.id);
      if (state.token) {
        try {
          agentTokens.revokeToken(this.store, state.token.record.id, { origin: "tool" });
        } catch {
          // Already revoked.
        }
      }
      if (state.connection && !state.connection.exited) await state.connection.stop({ graceMs: 1000 }).catch(() => {});
    }));
    await Promise.all(this.stopping);
  }

  async stopAll() {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.cancel(id)));
    return ids.length;
  }

  #clearFollowUp(state) {
    if (state.followUp) clearTimeout(state.followUp);
    state.followUp = null;
  }

  #onExit(state, code, signal) {
    if (!this.live.has(state.run.id)) return;
    if (state.turnActive || ["starting", "running", "waiting"].includes(state.run.status)) {
      this.#finish(state, state.cancelRequested ? "cancelled" : "failed", state.cancelRequested ? "" : `The agent stopped${code !== null ? ` with exit code ${code}` : signal ? ` (${signal})` : ""}. ${state.connection?.stderrTail() || ""}`.trim());
    } else {
      this.#release(state);
    }
  }

  // Ends a turn or a run. A finished turn keeps the agent for follow-up
  // messages for a while (keepAlive); everything else stops it.
  #finish(state, status, error, { keepAlive = false } = {}) {
    const { run } = state;
    // Released already (the tracker is stopping, or the run ended): the
    // agent's last failing call changes nothing.
    if (this.live.get(run.id) !== state) return;
    state.turnActive = false;
    Object.assign(run, { status, endedAt: new Date().toISOString() });
    if (error) run.error = state.redact(error);
    this.#write(run);
    this.#emit(state, "status", { status, stopReason: run.stopReason, error: run.error, jsonFallback: Boolean(run.jsonFallback), changes: run.changes.length });
    if (keepAlive && state.connection && !state.connection.exited) {
      this.#clearFollowUp(state);
      state.followUp = setTimeout(() => this.#release(state), FOLLOW_UP_MINUTES * this.minuteMs);
      state.followUp.unref?.();
    } else {
      this.#release(state);
    }
    this.#pump();
  }

  // Stops the agent, revokes the run token and forgets the live state.
  #release(state) {
    if (!this.live.has(state.run.id)) return;
    this.#clearFollowUp(state);
    for (const timer of state.timers) clearTimeout(timer), clearInterval(timer);
    this.live.delete(state.run.id);
    const connection = state.connection;
    if (connection && !connection.exited) {
      const stopped = (async () => {
        if (state.sessionId) await connection.closeSession(state.sessionId).catch(() => {});
        await connection.stop().catch(() => {});
      })();
      this.stopping.add(stopped);
      stopped.finally(() => this.stopping.delete(stopped));
    }
    if (state.token) {
      try {
        agentTokens.revokeToken(this.store, state.token.record.id, { origin: "tool" });
      } catch {
        // Already revoked.
      }
    }
    for (const listener of state.listeners) listener({ seq: 0, type: "closed", data: {} });
    state.listeners.clear();
    this.#pump();
  }

  // A tracker tool called by the run's MCP server with the run token.
  toolCall(tokenRecord, name, args, mutationId) {
    const state = this.live.get(tokenRecord.runId);
    if (!state) throw new RunError("This run has ended.", "runEnded", 403);
    const { run } = state;
    const result = callTool(name, args, {
      store: this.store,
      startupId: run.startupId,
      run: { id: run.id, harness: run.harness.name, model: run.model },
      mutationId: mutationId ? String(mutationId).slice(0, 200) : "",
      timeZone: this.timeZone(),
      results: state.results,
      onChange: (change) => {
        run.changes.push({ ...change, at: new Date().toISOString() });
        this.#write(run);
        const described = change.after?.name || change.id;
        this.#emit(state, "change", { section: change.section, kind: change.kind, id: change.id, event: change.event, name: described });
      },
    });
    run.lastEventAt = new Date().toISOString();
    return result;
  }

  // Puts back what the run changed: records it created go to the recycle bin
  // (links are removed), records it updated get their earlier value. A
  // record someone changed after the run is left alone and reported.
  undo(runId, { origin = "ui" } = {}) {
    const run = this.get(runId);
    if (this.live.get(runId)?.turnActive) throw new RunError("Cancel the run before undoing it.", "busy", 409);
    if (run.undoneAt) throw new RunError("This run was undone already.", "undone", 409);
    const byRecord = new Map();
    for (const change of run.changes || []) {
      const key = `${change.section}\0${change.id}`;
      const entry = byRecord.get(key) || { section: change.section, kind: change.kind, id: change.id, created: change.event === "created", before: change.before, revision: change.revision };
      entry.revision = change.revision;
      byRecord.set(key, entry);
    }
    const map = this.store.readRevisionMap(run.startupId);
    const operations = [];
    const report = { undone: [], skipped: [] };
    const now = new Date().toISOString();
    for (const entry of byRecord.values()) {
      const current = Number(map.records?.[entry.section]?.[entry.id] || 0);
      if (!current) {
        report.skipped.push({ ...entry, reason: "gone" });
        continue;
      }
      if (current !== entry.revision) {
        report.skipped.push({ ...entry, reason: "changed since" });
        continue;
      }
      if (entry.created) {
        const live = this.store.readSection(run.startupId, entry.section) || [];
        const record = live.find((item) => String(item.id) === String(entry.id));
        operations.push({ type: "delete", section: entry.section, id: entry.id, baseRevision: current });
        if (BIN_OF[entry.section] && record) operations.push({ type: "upsert", section: BIN_OF[entry.section], id: entry.id, value: { ...record, deletedAt: now, updatedAt: now } });
      } else {
        operations.push({ type: "upsert", section: entry.section, id: entry.id, value: entry.before, baseRevision: current });
      }
      report.undone.push({ section: entry.section, kind: entry.kind, id: entry.id, created: entry.created });
    }
    if (operations.length) this.store.applyOperations(run.startupId, operations, { origin, label: `Undo run ${run.id}` });
    run.undoneAt = now;
    run.undo = { undone: report.undone.length, skipped: report.skipped.map((entry) => ({ section: entry.section, id: entry.id, reason: entry.reason })) };
    const state = this.live.get(runId);
    if (state) {
      this.#write(run);
      this.#emit(state, "undo", run.undo);
    } else {
      this.#write(run);
      this.#appendEventFile(run, { type: "undo", data: run.undo });
      this.#write(run);
    }
    return { run: this.summary(run), ...report };
  }

  // Keeps the newest `keep` finished runs.
  #prune(keep) {
    const finished = this.#allRuns().filter((run) => FINISHED.has(run.status) && !this.live.has(run.id));
    for (const run of finished.slice(Math.max(0, keep - (this.#allRuns().length - finished.length)))) {
      // Windows keeps a stopped agent's folder busy for a moment after it exits.
      fs.rmSync(this.runDir(run.startupId, run.id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

module.exports = { RunManager, RunError, ACTIVE, FINISHED, decidePermission, redactor, jsonFallback, AGENTS_MD };
