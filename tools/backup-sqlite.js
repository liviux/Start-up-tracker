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
//
// A database from before startups is never upgraded by a backup. It is copied
// as it is to a flat tracker-<stamp>[-label].sqlite file, as before, without
// media.

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
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

// Flat files from before backup folders. Only timestamp-named ones rotate; a
// labelled file was named deliberately and is never deleted to make room.
const ROTATING_SNAPSHOT_PATTERN = /^tracker-\d{8}-\d{6}(?:-\d{9})?\.sqlite$/;
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

function makeSnapshotFileName(date = new Date(), label = "") {
  const iso = date.toISOString();
  const compactDate = iso.slice(0, 10).replaceAll("-", "");
  const compactTime = iso.slice(11, 19).replaceAll(":", "");
  const safeLabel = String(label).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safeLabel) return `tracker-${compactDate}-${compactTime}-${safeLabel}.sqlite`;
  const nanoseconds = String(process.hrtime.bigint() % 1_000_000_000n).padStart(9, "0");
  return `tracker-${compactDate}-${compactTime}-${nanoseconds}.sqlite`;
}

function listRotatingSnapshots(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((fileName) => ROTATING_SNAPSHOT_PATTERN.test(fileName))
    .map((fileName) => {
      const filePath = path.join(outputDir, fileName);
      const stats = fs.statSync(filePath);
      return { fileName, filePath, stats };
    })
    .filter(({ stats }) => stats.isFile())
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || b.fileName.localeCompare(a.fileName));
}

function pruneRotatingSnapshots(outputDir, limit) {
  const snapshots = listRotatingSnapshots(outputDir);
  const removed = snapshots.slice(limit);
  for (const { filePath } of removed) fs.unlinkSync(filePath);
  return removed.map(({ fileName }) => fileName);
}

// The two problems a sound database may have: none, or only that it predates
// startups. Anything else means it is damaged.
function isSoundLegacy(verification) {
  return verification.legacy === true && verification.problems.length === 1;
}

// A database from before startups existed is copied as it is. Opening it with
// the store would upgrade it in place, and a backup must never change its
// source. VACUUM INTO on a read-only connection leaves the file untouched.
function copyLegacyDatabase(databasePath, outputPath, source) {
  if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite existing snapshot: ${outputPath}`);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.snapshotting-${process.pid}-${Date.now()}`,
  );
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.prepare("VACUUM INTO ?").run(temporaryPath);
    } finally {
      db.close();
    }
    const copy = verifyDatabaseFile(temporaryPath);
    if (!isSoundLegacy(copy) || copy.recordCount !== source.recordCount || copy.sectionCount !== source.sectionCount) {
      const reason = copy.problems.length ? copy.problems.join("; ") : "its record count differs from the source";
      throw new Error(`The snapshot of ${databasePath} did not verify: ${reason}`);
    }
    fs.renameSync(temporaryPath, outputPath);
    return copy;
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${temporaryPath}${suffix}`, { force: true });
  }
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

function backupLegacyDatabase({ databasePath, backupDir, source, label, limit, date }) {
  const outputPath = path.join(backupDir, makeSnapshotFileName(date, label));
  const copy = copyLegacyDatabase(databasePath, outputPath, source);
  const fileLimit = limit ?? readPositiveInteger(process.env.MAX_BACKUPS ?? 5, "Backup limit");
  return {
    id: path.basename(outputPath),
    kind: "file",
    label: label ? path.basename(outputPath).replace(/^tracker-\d{8}-\d{6}-|\.sqlite$/g, "") : "",
    folder: backupDir,
    databasePath,
    outputPath,
    bytes: copy.bytes,
    legacy: true,
    note: "This database uses the older one-startup format. It was copied as it is to a single file and was not upgraded. Media files are not part of this copy. Start the server once to upgrade it; later backups include media.",
    startupCount: 1,
    recordCount: copy.recordCount,
    sectionCount: copy.sectionCount,
    verified: true,
    skipped: false,
    rotates: ROTATING_SNAPSHOT_PATTERN.test(path.basename(outputPath)),
    limit: fileLimit,
    removed: pruneRotatingSnapshots(backupDir, fileLimit),
    mediaFiles: 0,
    mediaCopied: 0,
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

  // Checked before the store opens: a read-write open upgrades a legacy file
  // and writes the schema into a damaged one.
  const source = verifyDatabaseFile(databasePath);
  if (isSoundLegacy(source)) {
    return backupLegacyDatabase({ databasePath, backupDir, source, label, limit, date: options.date });
  }
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
      legacy: false,
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
  ROTATING_SNAPSHOT_PATTERN,
  createBackup,
  isSoundLegacy,
  listRotatingSnapshots,
  makeSnapshotFileName,
  openBackupManager,
  pruneRotatingSnapshots,
  readKeepSettings,
};
