#!/usr/bin/env node
"use strict";

// Takes a backup of the whole tracker: the database (every startup and the
// global settings) and the media files, as a folder in the backup directory
// managed by lib/backups/manager.js.
//
//   node tools/backup-sqlite.js --label <what>   a pinned backup, never rotated away
//   node tools/backup-sqlite.js                  a safety backup (reason "tool")
//
// Options: --data-dir <folder>, --database <file>, --output-dir <backup folder>,
// --media-dir <folder>, --limit <n> (how many safety backups to keep).

const fs = require("fs");
const path = require("path");
const { resolveDataRoot, dataPaths } = require("../lib/data-root");
const { createBackupManager } = require("../lib/backups/manager");

// The same data folder the server uses: --data-dir, STARTUP_TRACKER_HOME, then
// the default. TRACKER_DB_PATH, TRACKER_BACKUP_DIR and TRACKER_MEDIA_DIR still
// override it.
function defaultDataPaths() {
  return dataPaths(resolveDataRoot({ argv: process.argv.slice(2) }).root);
}
const { TrackerSqliteStore, verifyDatabaseFile } = require("../lib/tracker-sqlite-store");
const { readSettings } = require("../lib/settings");

const MAX_KEEP = 1000;

function readArgument(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  if (!argv[index + 1]) throw new Error(`Missing value for ${flag}.`);
  return argv[index + 1];
}

function readPositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_KEEP) {
    throw new Error(`${label} must be a positive integer up to ${MAX_KEEP}.`);
  }
  return parsed;
}

// Keep counts from the global settings (backups.keepAutomatic / keepSafety).
// readSettings falls back to the defaults for values that are unset or invalid.
function readKeepSettings(store) {
  const { backups } = readSettings(store);
  return { automatic: backups.keepAutomatic, safety: backups.keepSafety };
}

// The manager for a store, with keep counts from the settings and, when
// given, `safetyLimit` as the cap on safety backups. Shared with the restore
// tool, which takes a safety backup before restoring a startup.
function openBackupManager(store, { backupDir, mediaDir, safetyLimit, date } = {}) {
  const keep = readKeepSettings(store);
  if (safetyLimit !== undefined) keep.safety = safetyLimit;
  return createBackupManager({
    store,
    backupDir,
    mediaDir,
    keep,
    ...(date ? { now: () => new Date(date) } : {}),
  });
}

function resolveOptions(options) {
  const defaults = options.databasePath && options.outputDir && options.mediaDir ? null : defaultDataPaths();
  return {
    databasePath: path.resolve(options.databasePath || defaults.databaseFile),
    backupDir: path.resolve(options.outputDir || defaults.backupDir),
    mediaDir: path.resolve(options.mediaDir || defaults.mediaDir),
  };
}

// options: databasePath, outputDir (the backup folder), mediaDir, label,
// limit (safety backups to keep), date (for tests).
function createBackup(options = {}) {
  const limit = options.limit === undefined ? undefined : readPositiveInteger(options.limit, "Backup limit");
  const { databasePath, backupDir, mediaDir } = resolveOptions(options);
  const label = String(options.label || "").trim();

  if (!fs.existsSync(databasePath)) throw new Error(`SQLite database not found: ${databasePath}`);
  fs.mkdirSync(backupDir, { recursive: true });

  // Checked before the store opens: a read-write open writes the schema into
  // a damaged file.
  const source = verifyDatabaseFile(databasePath);
  if (!source.ok) {
    throw new Error(`${databasePath} did not verify, so no backup was taken: ${source.problems.join("; ")}`);
  }

  const store = new TrackerSqliteStore(databasePath);
  try {
    const manager = openBackupManager(store, { backupDir, mediaDir, safetyLimit: limit, date: options.date });
    // A labelled backup was asked for by name before something risky, so it
    // is pinned and always taken. Without a label it is a safety backup, which
    // the manager skips when nothing changed since the newest backup.
    const kind = label ? "pinned" : "safety";
    const backup = manager.create({ kind, label, reason: "tool" });
    return {
      id: backup.id,
      kind: backup.kind,
      label: backup.label,
      folder: path.join(backupDir, backup.id),
      databasePath,
      backupDir,
      createdAt: backup.createdAt,
      skipped: backup.skipped,
      revision: backup.databaseRevision,
      stateHash: backup.stateHash,
      startupCount: backup.startups.length,
      databaseBytes: backup.databaseBytes,
      mediaFiles: backup.mediaFiles,
      mediaBytes: backup.mediaBytes,
      mediaCopied: backup.mediaCopied ?? 0,
      keep: { ...manager.limits },
      removed: backup.removed || [],
    };
  } finally {
    store.close();
  }
}

function main() {
  const argv = process.argv.slice(2);
  const result = createBackup({
    databasePath: readArgument(argv, "--database", undefined),
    outputDir: readArgument(argv, "--output-dir", undefined),
    mediaDir: readArgument(argv, "--media-dir", undefined),
    limit: readArgument(argv, "--limit", undefined),
    label: readArgument(argv, "--label", undefined),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createBackup,
  openBackupManager,
  readKeepSettings,
};
