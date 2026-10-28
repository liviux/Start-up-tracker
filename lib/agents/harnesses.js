"use strict";

// The agents you set up in Settings > AI agents ("harnesses"), shared by every
// startup, and the settings for runs.
//
//   agentHarnesses  global records: name, where it came from, how it starts,
//                   permission policy, models, the last check
//   agentSettings   global value: concurrent runs, run timeout, runs kept
//
// Environment variables you give an agent may hold API keys, so their values
// live in secrets/agent-env.json in the data folder (readable by you only);
// the records keep only their names. A run never takes a command from the
// browser: it starts a harness stored here.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID } = require("../tracker-sqlite-store");

const HARNESSES_SECTION = "agentHarnesses";
const SETTINGS_SECTION = "agentSettings";
const ENV_FILE = "agent-env.json";
const POLICIES = Object.freeze(["allow", "research", "ask"]);
const KINDS = Object.freeze(["npx", "uvx", "binary", "custom"]);
const DEFAULT_SETTINGS = Object.freeze({ concurrency: 2, timeoutMinutes: 60, keepRuns: 100, idleMinutes: 10 });
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

class HarnessError extends Error {
  constructor(message, code = "harness", statusCode = 400) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readSettings(store) {
  const value = store.readSection(GLOBAL_STARTUP_ID, SETTINGS_SECTION);
  const merged = { ...DEFAULT_SETTINGS, ...(value && typeof value === "object" ? value : {}) };
  return {
    concurrency: Math.min(Math.max(Math.round(Number(merged.concurrency)) || 2, 1), 8),
    timeoutMinutes: Math.min(Math.max(Math.round(Number(merged.timeoutMinutes)) || 60, 1), 24 * 60),
    keepRuns: Math.min(Math.max(Math.round(Number(merged.keepRuns)) || 100, 5), 2000),
    idleMinutes: Math.min(Math.max(Math.round(Number(merged.idleMinutes)) || 10, 1), 240),
  };
}

function writeSettings(store, patch, { origin = "ui" } = {}) {
  const next = readSettings(store);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && patch[key] !== undefined) {
      const value = Number(patch[key]);
      if (!Number.isFinite(value)) throw new HarnessError(`${key} must be a number.`);
      next[key] = value;
    }
  }
  store.replaceSection(GLOBAL_STARTUP_ID, SETTINGS_SECTION, next, { origin, label: "AI agent settings" });
  return readSettings(store);
}

function listHarnesses(store) {
  const list = store.readSection(GLOBAL_STARTUP_ID, HARNESSES_SECTION);
  return Array.isArray(list) ? list : [];
}

function getHarness(store, id) {
  const harness = listHarnesses(store).find((entry) => entry.id === id);
  if (!harness) throw new HarnessError("No such agent.", "notFound", 404);
  return harness;
}

function envFile(secretsDir) {
  return path.join(secretsDir, ENV_FILE);
}

function readAllEnv(secretsDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(envFile(secretsDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readEnv(secretsDir, harnessId) {
  const all = readAllEnv(secretsDir);
  return all[harnessId] && typeof all[harnessId] === "object" ? { ...all[harnessId] } : {};
}

function writeEnv(secretsDir, harnessId, env) {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const all = readAllEnv(secretsDir);
  if (env && Object.keys(env).length) all[harnessId] = env;
  else delete all[harnessId];
  const file = envFile(secretsDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function cleanArgs(args) {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new HarnessError("Arguments must be a list of strings.");
  return args.slice(0, 40).map((arg) => arg.slice(0, 500));
}

// What the harness runs, as the confirmation dialog shows it.
function commandLine(harness) {
  const parts = harness.kind === "npx" ? ["npx", "--yes", harness.package] : harness.kind === "uvx" ? ["uvx", harness.package] : [harness.command];
  return [...parts, ...(harness.args || [])].filter(Boolean).join(" ");
}

// Adds a harness from a registry entry (its launch spec for this computer) or
// a custom command. `confirmed` must be true: without it nothing is stored
// and the error carries the exact command (`preview`) for the page to show.
function addHarness(store, { agent = null, custom = null, confirmed = false, name = "" }, { origin = "ui", now = new Date() } = {}) {
  let record;
  const base = { id: crypto.randomUUID(), policy: "allow", models: [], preferredModels: [], defaultModel: "", envNames: [], lastCheck: null, overrideBlock: false, downloadConsent: "", createdAt: now.toISOString(), updatedAt: now.toISOString() };
  if (agent) {
    const launch = agent.launch;
    if (!launch || !KINDS.includes(launch.kind)) throw new HarnessError("This agent cannot be started on this computer.", "noLaunch");
    record = {
      ...base,
      name: String(name || agent.name || agent.id).slice(0, 80),
      registryId: String(agent.id),
      registryVersion: String(agent.version || ""),
      icon: agent.icon || "",
      kind: launch.kind,
      package: launch.package || "",
      command: launch.command || "",
      args: cleanArgs(launch.args),
      archive: launch.archive || "",
    };
    // Installed already: run the program on PATH instead of downloading. A
    // native CLI that an adapter needs (codex, claude) does not count here.
    if (agent.installed && agent.installedPath && launch.kind === "npx" && agent.installedBin) {
      Object.assign(record, { kind: "binary", command: agent.installedBin, package: "" });
    }
  } else if (custom) {
    const command = String(custom.command || "").trim();
    if (!command) throw new HarnessError("A custom agent needs a command.");
    record = { ...base, name: String(name || custom.name || command).slice(0, 80), registryId: "", registryVersion: "", icon: "", kind: "custom", package: "", command, args: cleanArgs(custom.args), archive: "" };
  } else {
    throw new HarnessError("Pick an agent from the list or give a command.");
  }
  record.commandLine = commandLine(record);
  if (!confirmed) throw Object.assign(new HarnessError("Confirm the command this agent will run first.", "confirmNeeded"), { preview: record.commandLine });
  store.applyOperations(GLOBAL_STARTUP_ID, [{ type: "upsert", section: HARNESSES_SECTION, id: record.id, value: record, baseRevision: 0 }], { origin, label: `AI agent added: ${record.name}` });
  return record;
}

function saveHarness(store, record, { origin = "ui", label = "AI agent changed" } = {}) {
  const next = { ...record, commandLine: commandLine(record), updatedAt: new Date().toISOString() };
  store.applyOperations(GLOBAL_STARTUP_ID, [{ type: "upsert", section: HARNESSES_SECTION, id: next.id, value: next }], { origin, label });
  return next;
}

// Changes what you may edit: name, arguments, policy, preferred and default
// model, environment (values go to the secrets file), the block override.
// A changed command line clears the last check.
function updateHarness(store, secretsDir, id, patch, { origin = "ui" } = {}) {
  const current = getHarness(store, id);
  const next = { ...current };
  if (patch.name !== undefined) next.name = String(patch.name || current.name).trim().slice(0, 80) || current.name;
  if (patch.args !== undefined) next.args = cleanArgs(patch.args);
  if (patch.command !== undefined && current.kind === "custom") next.command = String(patch.command || "").trim() || current.command;
  // A custom agent's new command or arguments run only once you confirm them.
  if (current.kind === "custom" && commandLine(next) !== commandLine(current) && !patch.confirmed) {
    throw Object.assign(new HarnessError("Confirm the new command first.", "confirmNeeded"), { preview: commandLine(next) });
  }
  if (patch.policy !== undefined) {
    if (!POLICIES.includes(patch.policy)) throw new HarnessError("The policy is allow, research or ask.");
    next.policy = patch.policy;
  }
  if (patch.preferredModels !== undefined) next.preferredModels = (Array.isArray(patch.preferredModels) ? patch.preferredModels : []).map(String).slice(0, 20);
  if (patch.defaultModel !== undefined) next.defaultModel = String(patch.defaultModel || "").slice(0, 200);
  if (patch.overrideBlock !== undefined) next.overrideBlock = Boolean(patch.overrideBlock);
  if (patch.downloadConsent !== undefined) next.downloadConsent = patch.downloadConsent ? String(current.package || "") : "";
  if (patch.env !== undefined) {
    if (!patch.env || typeof patch.env !== "object" || Array.isArray(patch.env)) throw new HarnessError("env must be an object of names and values.");
    const stored = readEnv(secretsDir, id);
    const env = {};
    for (const [name, value] of Object.entries(patch.env)) {
      if (!ENV_NAME.test(name)) throw new HarnessError(`"${name}" is not a valid variable name.`);
      // "***" keeps the stored value: the page never sees it.
      if (value === "***" && stored[name] !== undefined) env[name] = stored[name];
      else if (value !== null && value !== undefined) env[name] = String(value).slice(0, 4000);
    }
    writeEnv(secretsDir, id, env);
    next.envNames = Object.keys(env);
  }
  if (commandLine(next) !== commandLine(current)) next.lastCheck = null;
  return saveHarness(store, next, { origin });
}

function removeHarness(store, secretsDir, id, { origin = "ui" } = {}) {
  const current = getHarness(store, id);
  store.applyOperations(GLOBAL_STARTUP_ID, [{ type: "delete", section: HARNESSES_SECTION, id }], { origin, label: `AI agent removed: ${current.name}` });
  writeEnv(secretsDir, id, {});
  return current;
}

// The harness as the page sees it: environment names, no values.
function publicHarness(harness) {
  const blocked = harness.lastCheck?.state === "failed" && !harness.overrideBlock;
  return { ...harness, env: Object.fromEntries((harness.envNames || []).map((name) => [name, "***"])), blocked };
}

module.exports = {
  HARNESSES_SECTION,
  SETTINGS_SECTION,
  POLICIES,
  DEFAULT_SETTINGS,
  HarnessError,
  readSettings,
  writeSettings,
  listHarnesses,
  getHarness,
  readEnv,
  writeEnv,
  commandLine,
  addHarness,
  saveHarness,
  updateHarness,
  removeHarness,
  publicHarness,
};
