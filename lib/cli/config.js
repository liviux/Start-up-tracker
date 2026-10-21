"use strict";

// config.json in the data folder: install-level options the CLI saves once and
// reuses. Today that is only the port.
//
// The port is part of the browser's origin, and the browser keeps unsent
// edits per origin, so the tracker should start on the same port every time.
// The CLI writes the default, 57322, at the first start and every later start
// reads it back. Development (--dev) uses 57323 and never saves it.

const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 57322;
const DEV_PORT = 57323;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// 0 asks the system for a free port; tests use it. A saved port must be a
// real one, so `allowZero` is off for config.json.
function parsePort(raw, { allowZero = true } = {}) {
  const text = String(raw).trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < min || port > 65535) throw new ConfigError(`Not a valid port: ${raw}`);
  return port;
}

// Returns {} when there is no config.json yet.
function readConfig(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${configFile} is not valid JSON (${error.message}). Fix or delete it; the next start writes a new one.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${configFile} must hold a JSON object.`);
  }
  if (parsed.port !== undefined) {
    try {
      parsed.port = parsePort(parsed.port, { allowZero: false });
    } catch {
      throw new ConfigError(`${configFile} has a port that is not valid: ${JSON.stringify(parsed.port)}. Use a number from 1 to 65535.`);
    }
  }
  return parsed;
}

// Merges `patch` into the saved config. Written to a temporary file first, so
// a crash never leaves half a file, and readable only by the user.
function writeConfig(configFile, patch) {
  const next = { ...readConfig(configFile), ...patch };
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configFile);
  return next;
}

// First start: saves the default port so every later start uses it. A
// development run saves nothing.
function ensureConfig(configFile, { dev = false } = {}) {
  const config = readConfig(configFile);
  if (dev || config.port !== undefined) return config;
  return writeConfig(configFile, { port: DEFAULT_PORT });
}

// The port a start uses, in this order: --port, PORT, config.json, then the
// default (57323 with --dev, which ignores config.json).
function resolvePort({ flagPort = null, env = process.env, config = {}, dev = false } = {}) {
  if (flagPort !== null && flagPort !== undefined) return { port: parsePort(flagPort), source: "flag" };
  if (env.PORT !== undefined && env.PORT !== "") return { port: parsePort(env.PORT), source: "env" };
  if (dev) return { port: DEV_PORT, source: "dev" };
  if (config.port !== undefined) return { port: config.port, source: "config" };
  return { port: DEFAULT_PORT, source: "default" };
}

module.exports = {
  DEFAULT_PORT,
  DEV_PORT,
  ConfigError,
  parsePort,
  readConfig,
  writeConfig,
  ensureConfig,
  resolvePort,
};
