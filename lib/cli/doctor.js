"use strict";

// startup-tracker doctor: checks the things that stop the tracker from
// starting or keep data unsafe. It changes nothing.

const fs = require("fs");
const { readConfig, resolvePort } = require("./config");
const { getServerStatus } = require("./run-state");
const { isPortFree, identifyPortOwner } = require("./ports");

const MIN_NODE = [22, 16];

function nodeCheck(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: "Node.js",
    level: ok ? "ok" : "fail",
    message: ok ? `${version} (needs ${MIN_NODE.join(".")} or newer)` : `${version} is too old; Startup Tracker needs ${MIN_NODE.join(".")} or newer for its built-in SQLite.`,
  };
}

async function portCheck({ paths, flags, env, fetchImpl, status }) {
  let port;
  try {
    port = resolvePort({ flagPort: flags.port ?? null, env, config: flags.dev ? {} : readConfig(paths.configFile), dev: Boolean(flags.dev) }).port;
  } catch (error) {
    return { name: "Port", level: "fail", message: error.message };
  }
  if (status.state === "running" && status.run.port === port) return { name: "Port", level: "ok", message: `${port}: this tracker is running on it.` };
  if (status.state === "running") return { name: "Port", level: "warn", message: `The tracker runs on ${status.run.port}, but the next start uses ${port}. Edits the browser has not sent stay with the old address.` };
  if (port === 0 || (await isPortFree(port))) return { name: "Port", level: "ok", message: `${port} is free.` };
  const { owner } = await identifyPortOwner(port, paths, { fetchImpl });
  if (owner === "ours") return { name: "Port", level: "ok", message: `${port}: this tracker answers on it (started without the CLI).` };
  if (owner === "tracker") return { name: "Port", level: "fail", message: `${port} is used by another Startup Tracker with a different data folder.` };
  return { name: "Port", level: "fail", message: `${port} is used by another program. Run "startup-tracker start" in a terminal to pick and save another port.` };
}

function modeOf(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

// Folders 0700 and the API token 0600 on macOS and Linux.
function permissionsCheck(paths, { platform = process.platform } = {}) {
  if (platform === "win32") return { name: "Permissions", level: "info", message: "Not checked on Windows; the data folder sits in your user profile." };
  if (modeOf(paths.root) === null) return { name: "Permissions", level: "info", message: `${paths.root} does not exist yet; the first start creates it.` };
  const problems = [];
  for (const folder of [paths.root, paths.dataDir, paths.secretsDir, paths.backupDir, paths.mediaDir, paths.logsDir, paths.runDir]) {
    const mode = modeOf(folder);
    if (mode !== null && mode & 0o077) problems.push(`${folder} is ${mode.toString(8)}, expected 700 (chmod 700 "${folder}")`);
  }
  const tokenMode = modeOf(paths.tokenFile);
  if (tokenMode !== null && tokenMode & 0o077) problems.push(`${paths.tokenFile} is ${tokenMode.toString(8)}, expected 600 (chmod 600 "${paths.tokenFile}")`);
  return problems.length
    ? { name: "Permissions", level: "warn", message: `Other users on this computer may read your data:\n${problems.map((line) => `    - ${line}`).join("\n")}` }
    : { name: "Permissions", level: "ok", message: "Data folders are 700 and the API token is 600." };
}

function databaseCheck({ paths, flags, env }) {
  const { collectAbout } = require("../../tools/about");
  const argv = ["--data-dir", paths.root, ...(flags.dev ? ["--dev"] : [])];
  let about;
  try {
    about = collectAbout({ argv, env });
  } catch (error) {
    return { name: "Database", level: "fail", message: error.message };
  }
  if (about.databaseFormat === "missing") return { name: "Database", level: "info", message: `${about.databasePath} does not exist yet; the first start creates it.` };
  if (!about.integrity.ok) return { name: "Database", level: "fail", message: `${about.databasePath}:\n${about.integrity.problems.map((line) => `    - ${line}`).join("\n")}\n    Restore a backup: startup-tracker restore --list` };
  return { name: "Database", level: "ok", message: `${about.databasePath}: integrity ok, ${about.startupCount} startup(s), ${about.backupCount} backup(s).` };
}

// The agents of the ACP registry (the cached copy, else the one that ships
// with the app; doctor never goes online) whose program is on this computer,
// and the agents set up in Settings > AI agents.
async function agentsCheck(paths, { env = process.env } = {}) {
  const registry = require("../agents/registry");
  let found = [];
  try {
    const loaded = await registry.loadRegistry({ cacheDir: paths.cacheDir, network: false });
    found = registry.describeAgents(loaded, { env }).filter((agent) => agent.installed).map((agent) => agent.name);
  } catch (error) {
    return { name: "AI agents", level: "info", message: `The agent registry could not be read: ${error.message}` };
  }
  let setUp = null;
  if (fs.existsSync(paths.databaseFile)) {
    try {
      const { TrackerSqliteStore } = require("../tracker-sqlite-store");
      const { listHarnesses } = require("../agents/harnesses");
      const store = new TrackerSqliteStore(paths.databaseFile, { readOnly: true });
      try {
        setUp = listHarnesses(store).length;
      } finally {
        store.close();
      }
    } catch {
      setUp = null;
    }
  }
  const foundText = found.length ? `found on this computer: ${found.join(", ")}` : "none of the registry's agents was found on this computer (they are optional; see docs/agents.md)";
  const setUpText = setUp === null ? "" : `; ${setUp} set up in Settings > AI agents`;
  return { name: "AI agents", level: "info", message: `${foundText}${setUpText}.` };
}

async function runDoctor({ paths, flags = {}, env = process.env, fetchImpl, platform = process.platform, nodeVersion } = {}) {
  const status = await getServerStatus(paths, { fetchImpl });
  return [
    nodeCheck(nodeVersion),
    await portCheck({ paths, flags, env, fetchImpl, status }),
    permissionsCheck(paths, { platform }),
    databaseCheck({ paths, flags, env }),
    await agentsCheck(paths, { env }),
  ];
}

const LABELS = { ok: "ok  ", warn: "WARN", fail: "FAIL", info: "info" };

function formatDoctor(checks) {
  const lines = checks.map((check) => `${LABELS[check.level]} ${check.name}: ${check.message}`);
  const failed = checks.filter((check) => check.level === "fail").length;
  lines.push(failed ? `${failed} problem(s) found.` : "No problems found.");
  return `${lines.join("\n")}\n`;
}

module.exports = { MIN_NODE, nodeCheck, portCheck, permissionsCheck, databaseCheck, agentsCheck, runDoctor, formatDoctor };
