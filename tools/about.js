#!/usr/bin/env node
"use strict";

// Prints the facts GET /api/about answers, without a server and without
// changing anything: version, where the data lives, the configured port, the
// database's schema version, size and integrity, and how many startups and
// backups there are.
//
// Usage: node tools/about.js [--data-dir <folder>] [--dev] [--port <n>] [--json]
//
// The database is opened read-only. The port is the one the server would use
// with the same flags and environment; this does not check whether a server
// is running on it.

const fs = require("fs");
const path = require("path");
const { resolveDataRoot, dataPaths, readFlag } = require("../lib/data-root");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { listStartups } = require("../lib/startups");
const { createBackupManager } = require("../lib/backups/manager");

const { readConfig, resolvePort } = require("../lib/cli/config");

const PACKAGE_FILE = path.join(__dirname, "..", "package.json");

const SOURCE_NAMES = {
  flag: "from --data-dir",
  dev: "development folder, from --dev",
  env: "from STARTUP_TRACKER_HOME",
  default: "default",
};

function readVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8")).version;
}

// --port, PORT, the port saved in config.json, then the default.
function readPort(argv, env, configFile) {
  const dev = argv.includes("--dev");
  return resolvePort({ flagPort: readFlag(argv, "--port"), env, config: dev ? {} : readConfig(configFile), dev }).port;
}

function integrityProblems(report) {
  const problems = [];
  if (report.integrity.length !== 1 || report.integrity[0] !== "ok") problems.push(`integrity_check reported: ${report.integrity.join(", ")}`);
  if (report.foreignKeyErrors.length > 0) problems.push(`foreign_key_check reported ${report.foreignKeyErrors.length} broken reference(s)`);
  return problems;
}

function describeDatabase(databasePath) {
  if (!fs.existsSync(databasePath)) {
    return {
      databaseFormat: "missing",
      schemaVersion: null,
      databaseBytes: 0,
      integrity: { ok: false, problems: [`No database at ${databasePath} yet. The server creates it on its first start.`] },
      startupCount: 0,
    };
  }
  const databaseBytes = fs.statSync(databasePath).size;
  const unreadable = (error) => ({
    databaseFormat: "unreadable",
    schemaVersion: null,
    databaseBytes,
    integrity: { ok: false, problems: [`Could not read the database: ${error.message}`] },
    startupCount: null,
  });
  let store;
  try {
    store = new TrackerSqliteStore(databasePath, { readOnly: true });
  } catch (error) {
    return unreadable(error);
  }
  try {
    const report = store.checkIntegrity();
    const problems = integrityProblems(report);
    let startupCount = null;
    let schemaVersion = null;
    try {
      schemaVersion = store.getInfo().schemaVersion;
      startupCount = listStartups(store).length;
    } catch (error) {
      problems.push(`Could not read the startup list: ${error.message}`);
    }
    return {
      databaseFormat: "current",
      schemaVersion,
      databaseBytes,
      integrity: { ok: problems.length === 0, problems },
      startupCount,
    };
  } catch (error) {
    return unreadable(error);
  } finally {
    store.close();
  }
}

function countBackups(paths) {
  // Listing needs no store; nothing here takes a backup.
  const manager = createBackupManager({ store: null, backupDir: paths.backupDir, mediaDir: paths.mediaDir });
  return manager.list().length;
}

function collectAbout({ argv = process.argv.slice(2), env = process.env, now = () => new Date() } = {}) {
  const dataRoot = resolveDataRoot({ argv, env });
  const paths = dataPaths(dataRoot.root, env);
  const port = readPort(argv, env, paths.configFile);
  const checkedAt = new Date(now()).toISOString();
  const database = describeDatabase(paths.databaseFile);
  return {
    version: readVersion(),
    dataFolder: paths.root,
    dataFolderSource: dataRoot.source,
    databasePath: paths.databaseFile,
    mediaDir: paths.mediaDir,
    backupDir: paths.backupDir,
    port,
    schemaVersion: database.schemaVersion,
    databaseFormat: database.databaseFormat,
    databaseBytes: database.databaseBytes,
    integrity: { checkedAt, ...database.integrity },
    startupCount: database.startupCount,
    backupCount: countBackups(paths),
  };
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatAbout(about) {
  const database = {
    current: `${formatBytes(about.databaseBytes)}, schema ${about.schemaVersion}`,
    missing: "not created yet",
    unreadable: `${formatBytes(about.databaseBytes)}, could not be read`,
  }[about.databaseFormat];
  const integrity = about.integrity.ok
    ? `ok (checked ${about.integrity.checkedAt})`
    : `PROBLEMS (checked ${about.integrity.checkedAt})\n${about.integrity.problems.map((problem) => `                - ${problem}`).join("\n")}`;
  const lines = [
    `Startup Tracker ${about.version}`,
    `  Data folder   ${about.dataFolder} (${SOURCE_NAMES[about.dataFolderSource] || about.dataFolderSource})`,
    `  Database      ${about.databasePath} (${database})`,
    `  Media         ${about.mediaDir}`,
    `  Backups       ${about.backupDir} (${plural(about.backupCount, "backup")})`,
    `  Port          ${about.port} (configured; whether a server is running is not checked)`,
    `  Startups      ${about.startupCount ?? "unknown"}`,
    `  Integrity     ${integrity}`,
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const about = collectAbout({ argv });
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(about, null, 2)}\n` : formatAbout(about));
  if (!about.integrity.ok && about.databaseFormat !== "missing") process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { collectAbout, formatAbout };
