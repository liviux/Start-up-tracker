"use strict";

// Where Startup Tracker keeps its data. The code folder never holds data.
//
// Resolution order: the --data-dir flag, then STARTUP_TRACKER_HOME, then the
// default folder in the user's home directory, ~/.startup-tracker
// (%USERPROFILE%\.startup-tracker on Windows). --dev picks
// ~/.startup-tracker-dev instead, so development never touches real data.
//
// Tests never reach the real folder: under `node --test`, or with
// STARTUP_TRACKER_TEST_RUN=1, the default folder is refused and the data
// folder has to be named (tools/run-tests.js gives every run a temporary one).
//
// TRACKER_DB_PATH, TRACKER_BACKUP_DIR and TRACKER_MEDIA_DIR still override the
// individual locations (tests use them).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEV_FOLDER_NAME = ".startup-tracker-dev";
const DEFAULT_FOLDER_NAME = ".startup-tracker";
const TOKEN_FILE_NAME = "api-token";

function readFlag(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1] || "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

function expandHome(value, homedir) {
  if (value === "~") return homedir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir, value.slice(2));
  return value;
}

// Returns { root, source } where source says which rule picked the folder.
function resolveDataRoot({ argv = process.argv.slice(2), env = process.env, homedir = os.homedir() } = {}) {
  const flag = readFlag(argv, "--data-dir");
  if (flag !== null) {
    if (!flag.trim()) throw new Error("--data-dir needs a folder path.");
    return { root: path.resolve(expandHome(flag.trim(), homedir)), source: "flag" };
  }
  if (argv.includes("--dev")) {
    return { root: path.join(homedir, DEV_FOLDER_NAME), source: "dev" };
  }
  const fromEnv = String(env.STARTUP_TRACKER_HOME || "").trim();
  if (fromEnv) return { root: path.resolve(expandHome(fromEnv, homedir)), source: "env" };
  if (isTestRun(env)) {
    throw new Error("A test run never uses the real data folder. Pass --data-dir or STARTUP_TRACKER_HOME.");
  }
  return { root: path.join(homedir, DEFAULT_FOLDER_NAME), source: "default" };
}

function isTestRun(env) {
  return Boolean(env.NODE_TEST_CONTEXT) || env.STARTUP_TRACKER_TEST_RUN === "1";
}

// Every location inside the data folder (layout in the release plan, section 4.3).
function dataPaths(root, env = process.env) {
  const dataDir = path.join(root, "data");
  return {
    root,
    configFile: path.join(root, "config.json"),
    dataDir,
    databaseFile: path.resolve(env.TRACKER_DB_PATH || path.join(dataDir, "tracker.sqlite")),
    mediaDir: path.resolve(env.TRACKER_MEDIA_DIR || path.join(root, "media")),
    backupDir: path.resolve(env.TRACKER_BACKUP_DIR || path.join(root, "backups")),
    secretsDir: path.join(root, "secrets"),
    tokenFile: path.join(root, "secrets", TOKEN_FILE_NAME),
    logsDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    agentRunsDir: path.join(root, "agent-runs"),
    exportsDir: path.join(root, "exports"),
    cacheDir: path.join(root, "cache"),
  };
}

// Creates the folders the server needs, readable only by the current user.
function ensureDataFolders(paths) {
  const folders = [paths.root, paths.dataDir, path.dirname(paths.databaseFile), paths.mediaDir, paths.backupDir, paths.secretsDir, paths.logsDir, paths.runDir];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  // The secrets folder is tightened even when it already existed.
  try {
    fs.chmodSync(paths.secretsDir, 0o700);
  } catch {
    // Windows has no POSIX permissions; the folder sits in the user's profile.
  }
}

// The API token lets the CLI, tools and agent runs call state-changing routes.
// It is created on first start with permissions 0600 and never leaves the data folder.
function readOrCreateApiToken(paths) {
  try {
    const existing = fs.readFileSync(paths.tokenFile, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(paths.tokenFile, 0o600);
  } catch {
    // See ensureDataFolders.
  }
  return token;
}

module.exports = {
  DEV_FOLDER_NAME,
  DEFAULT_FOLDER_NAME,
  resolveDataRoot,
  dataPaths,
  ensureDataFolders,
  readOrCreateApiToken,
  readFlag,
};
