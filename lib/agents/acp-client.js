"use strict";

// One connection to an agent over the Agent Client Protocol (ACP), version 1:
// the agent runs as a child process and speaks JSON-RPC on stdin and stdout.
//
// The tracker offers no client methods: no file system, no terminal. Any
// request from the agent other than session/request_permission is answered
// with -32601 (method not found). Permission requests go to `onPermission`;
// session/update notifications to `onUpdate`.

const { JsonRpcPeer, RpcError, ERRORS } = require("./jsonrpc");
const { spawnProcess, killTree } = require("./process");

const PROTOCOL_VERSION = 1;
const STDERR_LIMIT = 256 * 1024;

class AcpError extends Error {
  constructor(message, code = "acp") {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}

// Flattens a select option list, grouped or not, to [{ value, name }].
function selectValues(options) {
  const out = [];
  for (const entry of Array.isArray(options) ? options : []) {
    if (entry && Array.isArray(entry.options)) out.push(...selectValues(entry.options));
    else if (entry && typeof entry.value === "string") out.push({ value: entry.value, name: String(entry.name || entry.value) });
  }
  return out;
}

// The effort (thinking) option: the spec's thought_level category, a
// category named for it (Mistral Vibe: "thinking") or, for an agent that
// leaves the category out or uses its own ("_..."), an id or name that says
// so (Cursor: effort, reasoning_effort or reasoning by model).
const EFFORT_NAME = /^(thought[\s_-]?level|effort|reasoning([\s_-]?effort)?|thinking([\s_-]?(level|effort))?)$/i;
function isEffortOption(option) {
  if (EFFORT_NAME.test(String(option.category || ""))) return true;
  if (option.category && !String(option.category).startsWith("_")) return false;
  return EFFORT_NAME.test(String(option.id || "")) || EFFORT_NAME.test(String(option.name || ""));
}

// An on/off thinking option offers these two levels.
const SWITCH_LEVELS = Object.freeze([{ value: "on", name: "On" }, { value: "off", name: "Off" }]);

// Models, thinking levels and modes of a new session, from configOptions or,
// for older agents, the `models` and `modes` fields.
function sessionChoices(result) {
  const choices = { models: [], currentModel: "", modelConfigId: "", modelVia: "", thoughtLevels: [], thoughtConfigId: "", thoughtType: "", modes: [], currentMode: "" };
  for (const option of Array.isArray(result?.configOptions) ? result.configOptions : []) {
    if (!option) continue;
    if (option.type === "boolean" && isEffortOption(option) && !choices.thoughtConfigId) {
      Object.assign(choices, { thoughtLevels: SWITCH_LEVELS.map((level) => ({ ...level })), thoughtConfigId: String(option.id), thoughtType: "boolean" });
      continue;
    }
    if (option.type !== "select") continue;
    const values = selectValues(option.options);
    if (option.category === "model" && !choices.modelConfigId) {
      choices.models = values;
      choices.currentModel = String(option.currentValue || "");
      choices.modelConfigId = String(option.id);
      choices.modelVia = "config";
    } else if (isEffortOption(option) && !choices.thoughtConfigId) {
      choices.thoughtLevels = values;
      choices.thoughtConfigId = String(option.id);
      choices.thoughtType = "select";
    } else if (option.category === "mode" && !choices.modes.length) {
      choices.modes = values;
      choices.currentMode = String(option.currentValue || "");
    }
  }
  const legacy = result?.models;
  if (!choices.modelVia && legacy && Array.isArray(legacy.availableModels)) {
    choices.models = legacy.availableModels.filter((model) => model && model.modelId).map((model) => ({ value: String(model.modelId), name: String(model.name || model.modelId) }));
    choices.currentModel = String(legacy.currentModelId || "");
    choices.modelVia = "legacy";
  }
  if (!choices.modes.length && result?.modes && Array.isArray(result.modes.availableModes)) {
    choices.modes = result.modes.availableModes.filter((mode) => mode && mode.id).map((mode) => ({ value: String(mode.id), name: String(mode.name || mode.id) }));
    choices.currentMode = String(result.modes.currentModeId || "");
  }
  return choices;
}

class AcpConnection {
  // launch: { command, args } from process.resolveLaunch. Hooks: onUpdate(params),
  // onPermission(params) -> Promise<optionId | null>, onMessage(direction, line),
  // onStderr(text), onExit(code, signal).
  constructor({ launch, cwd, env, clientVersion = "", onUpdate = () => {}, onPermission = async () => null, onMessage = () => {}, onStderr = () => {}, onExit = () => {} }) {
    this.launch = launch;
    this.cwd = cwd;
    this.env = env;
    this.clientVersion = clientVersion;
    this.hooks = { onUpdate, onPermission, onMessage, onStderr, onExit };
    this.child = null;
    this.peer = null;
    this.stderr = "";
    this.info = null;
    this.choices = null;
    this.pendingPermissions = new Set();
    this.exited = false;
  }

  start() {
    this.child = spawnProcess({ command: this.launch.command, args: this.launch.args, cwd: this.cwd, env: this.env });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = true;
        this.peer?.close(new AcpError(`The agent stopped${code !== null ? ` with exit code ${code}` : signal ? ` (${signal})` : ""}.${this.stderrTail() ? ` ${this.stderrTail()}` : ""}`, "exited"));
        this.hooks.onExit(code, signal);
        resolve({ code, signal });
      });
    });
    this.spawnError = new Promise((resolve) => this.child.on("error", (error) => resolve(error)));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text) => {
      if (this.stderr.length < STDERR_LIMIT) this.stderr += text.slice(0, STDERR_LIMIT - this.stderr.length);
      this.hooks.onStderr(text);
    });
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      onRequest: (method, params) => this.#onRequest(method, params),
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        // A model change can come back as a notification with every option
        // (pi does this); the effort levels follow it.
        if (params?.update?.sessionUpdate === "config_option_update") this.#applyOptions(params.update.configOptions);
        this.hooks.onUpdate(params);
      },
    });
    this.peer.on("message", (direction, line) => this.hooks.onMessage(direction, line));
    this.child.stdin.on("error", () => {});
    return this;
  }

  // Takes the effort option from a full configOptions list, after a model
  // change. An empty list (some agents send one) changes nothing.
  #applyOptions(configOptions) {
    if (!this.choices || !Array.isArray(configOptions) || !configOptions.length) return;
    const after = sessionChoices({ configOptions });
    Object.assign(this.choices, { thoughtLevels: after.thoughtLevels, thoughtConfigId: after.thoughtConfigId, thoughtType: after.thoughtType });
  }

  stderrTail() {
    const lines = this.stderr.trim().split("\n").filter(Boolean);
    return lines.slice(-3).join(" ").slice(0, 400);
  }

  async #onRequest(method, params) {
    if (method !== "session/request_permission") throw new RpcError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    const options = Array.isArray(params?.options) ? params.options : [];
    let settle;
    const cancelled = new Promise((resolve) => {
      settle = resolve;
    });
    this.pendingPermissions.add(settle);
    try {
      const choice = await Promise.race([this.hooks.onPermission(params), cancelled]);
      if (choice && choice.cancelled) return { outcome: { outcome: "cancelled" } };
      const optionId = typeof choice === "string" ? choice : choice?.optionId;
      if (optionId && options.some((option) => option.optionId === optionId)) return { outcome: { outcome: "selected", optionId } };
      // No usable answer: refuse with the agent's own reject option.
      const reject = options.find((option) => option.kind === "reject_once") || options.find((option) => option.kind === "reject_always");
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    } finally {
      this.pendingPermissions.delete(settle);
    }
  }

  // Races a request against the process failing to start or exiting. When
  // the connection closes, the error says how the process ended.
  async #call(method, params, timeoutMs) {
    const failed = this.spawnError.then((error) => {
      throw new AcpError(`The agent could not be started: ${error.message}`, error.code === "ENOENT" ? "notInstalled" : "spawn");
    });
    try {
      return await Promise.race([this.peer.request(method, params, { timeoutMs }), failed]);
    } catch (error) {
      if (error instanceof RpcError || error instanceof AcpError || error.code === "timeout") throw error;
      const exit = await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(() => resolve(null), 1000))]);
      if (!exit) throw error;
      throw new AcpError(`The agent stopped${exit.code !== null ? ` with exit code ${exit.code}` : exit.signal ? ` (${exit.signal})` : ""}.${this.stderrTail() ? ` ${this.stderrTail()}` : ""}`, "exited");
    }
  }

  async initialize({ timeoutMs = 180000 } = {}) {
    const result = await this.#call("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // _meta.parameterizedModelPicker: Cursor then offers effort as its own
      // config option instead of folding it into the model id. Agents that do
      // not know it ignore _meta, as the protocol asks.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
      clientInfo: { name: "startup-tracker", title: "Startup Tracker", version: this.clientVersion },
    }, timeoutMs);
    if (!result || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpError(`The agent speaks ACP protocol version ${result?.protocolVersion ?? "unknown"}; the tracker speaks version ${PROTOCOL_VERSION}.`, "incompatible");
    }
    this.info = {
      protocolVersion: result.protocolVersion,
      agentInfo: result.agentInfo || null,
      authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
      capabilities: result.agentCapabilities || {},
    };
    return this.info;
  }

  authenticate(methodId, { timeoutMs = 300000 } = {}) {
    return this.#call("authenticate", { methodId }, timeoutMs);
  }

  async newSession({ cwd, mcpServers = [], timeoutMs = 120000 }) {
    const result = await this.#call("session/new", { cwd, mcpServers }, timeoutMs);
    if (!result || typeof result.sessionId !== "string") throw new AcpError("The agent did not create a session.", "incompatible");
    this.choices = sessionChoices(result);
    return { sessionId: result.sessionId, choices: this.choices };
  }

  // Picks a model: session/set_config_option for agents that list models as
  // a config option, session/set_model for those with the older field.
  async setModel(sessionId, modelId, { timeoutMs = 60000 } = {}) {
    if (!modelId || !this.choices) return false;
    if (this.choices.modelVia === "config") {
      const result = await this.#call("session/set_config_option", { sessionId, configId: this.choices.modelConfigId, value: modelId }, timeoutMs);
      // The reply carries every option again; a model can change the thinking levels it offers.
      this.#applyOptions(result?.configOptions);
      return true;
    }
    if (this.choices.modelVia === "legacy") {
      await this.#call("session/set_model", { sessionId, modelId }, timeoutMs);
      return true;
    }
    return false;
  }

  // Picks a thinking (effort) level through session/set_config_option. A
  // level the session does not offer is skipped and returns false.
  async setThoughtLevel(sessionId, level, { timeoutMs = 60000 } = {}) {
    const choices = this.choices;
    if (!level || !choices?.thoughtConfigId || !choices.thoughtLevels.some((entry) => entry.value === level)) return false;
    const params = choices.thoughtType === "boolean"
      ? { sessionId, configId: choices.thoughtConfigId, type: "boolean", value: level === "on" }
      : { sessionId, configId: choices.thoughtConfigId, value: level };
    const result = await this.#call("session/set_config_option", params, timeoutMs);
    this.#applyOptions(result?.configOptions);
    return true;
  }

  async prompt(sessionId, text) {
    const result = await this.#call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0);
    return { stopReason: String(result?.stopReason || ""), usage: result?.usage || null };
  }

  // Cancels the turn: pending permission requests get the `cancelled`
  // outcome, as the protocol requires.
  cancel(sessionId) {
    for (const settle of this.pendingPermissions) settle({ cancelled: true });
    this.peer?.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId) {
    if (!this.info?.capabilities?.sessionCapabilities?.close) return false;
    try {
      await this.#call("session/close", { sessionId }, 10000);
      return true;
    } catch {
      return false;
    }
  }

  async stop({ graceMs = 3000 } = {}) {
    try {
      this.child?.stdin?.end();
    } catch {
      // Already closed.
    }
    await killTree(this.child, { graceMs });
    this.peer?.close(new AcpError("The agent was stopped.", "stopped"));
  }
}

module.exports = { PROTOCOL_VERSION, AcpError, AcpConnection, sessionChoices, selectValues };
