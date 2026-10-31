#!/usr/bin/env node
"use strict";

// Restore tracker data from a backup in the backup folder. <backup> is a
// backup folder's id (see --list).
//
//   node tools/restore-sqlite.js --list
//   node tools/restore-sqlite.js --verify <backup>
//   node tools/restore-sqlite.js --snapshot <backup>
//   node tools/restore-sqlite.js --snapshot <backup> --startup <startupId>
//   node tools/restore-sqlite.js --snapshot <backup> --record <startupId>/<section>/<id>
//   node tools/restore-sqlite.js --snapshot <backup> --startup <startupId> --record <section>/<id>
//
// Options: --data-dir <folder>, --database <file>, --backup-dir <folder>,
// --media-dir <folder>.
//
// A record restore puts one record back into one startup, and a startup
// restore replaces one startup's records and puts its media files back. Both
// write through the store and are safe while the server runs; a startup
// restore takes a safety backup first. Stop the server first for a
// whole-database restore: it replaces the database file, and a running server
// keeps writing to the old one.

const fs = require("fs");
const path = require("path");
const { resolveDataRoot, dataPaths } = require("../lib/data-root");

// The same data folder the server uses: --data-dir, STARTUP_TRACKER_HOME, then
// the default. TRACKER_DB_PATH, TRACKER_BACKUP_DIR and TRACKER_MEDIA_DIR still
// override it.
function defaultDataPaths() {
  return dataPaths(resolveDataRoot({ argv: process.argv.slice(2) }).root);
}
const {
  GLOBAL_STARTUP_ID,
  STARTUPS_SECTION,
  TrackerSqliteStore,
  normalizeStartupId,
  verifyDatabaseFile,
} = require("../lib/tracker-sqlite-store");
const { getStartup } = require("../lib/startups");
const { createBackupManager, FOLDER_PATTERN } = require("../lib/backups/manager");
const { openBackupManager } = require("./backup-sqlite");

const LISTED_NAMES = 5;

function readArgument(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  if (!argv[index + 1]) throw new Error(`Missing value for ${flag}.`);
  return argv[index + 1];
}

function resolvePaths(options = {}) {
  return {
    databasePath: path.resolve(
      options.databasePath
        || defaultDataPaths().databaseFile,
    ),
    backupDir: path.resolve(
      options.backupDir
        || defaultDataPaths().backupDir,
    ),
    mediaDir: path.resolve(
      options.mediaDir
        || defaultDataPaths().mediaDir,
    ),
  };
}

// Listing, verifying and reading a backup folder never touch the live
// database, which may be the very thing that is damaged, so this manager has
// no store. It cannot take backups; openBackupManager in backup-sqlite.js does.
function readOnlyManager({ backupDir, mediaDir }) {
  return createBackupManager({ store: null, backupDir, mediaDir });
}

// A backup folder's id, as --list shows it. Anything else is rejected, since
// the name reaches here from the command line. An incomplete folder is still
// found, so --verify can say what is wrong with it.
function findBackup(paths, reference) {
  const name = path.basename(String(reference || ""));
  if (!FOLDER_PATTERN.test(name)) throw new Error(`Not a backup id: ${reference}`);
  const manager = readOnlyManager(paths);
  let backup;
  try {
    backup = manager.find(name);
  } catch {
    throw new Error(`Backup not found: ${path.join(paths.backupDir, name)}`);
  }
  return { id: backup.id, kind: backup.kind, complete: backup.complete, manager };
}

// A backup to restore from. Its manifest brings the revision and hash the
// database was taken with, so the database is checked against them.
function resolveBackup(paths, reference) {
  const backup = findBackup(paths, reference);
  if (!backup.complete) {
    throw new Error(`${backup.id} is incomplete (its manifest or database is missing), so nothing can be restored from it.`);
  }
  const manifest = backup.manager.manifest(backup.id);
  return {
    ...backup,
    filePath: backup.manager.databasePath(backup.id),
    expected: { expectedRevision: manifest.database.revision, expectedStateHash: manifest.database.stateHash },
  };
}

// Every backup in the backup folder, newest first.
function listBackups(options = {}) {
  return readOnlyManager(resolvePaths(options)).list().map((backup) => ({
    id: backup.id,
    kind: backup.kind,
    label: backup.label,
    createdAt: backup.createdAt,
    reason: backup.reason,
    bytes: backup.databaseBytes,
    startupCount: backup.startups.length,
    startups: backup.startups.map((startup) => startup.name || startup.id),
    mediaFiles: backup.mediaFiles,
    complete: backup.complete,
  }));
}

// "<startupId>/<section>/<id>", or "<section>/<id>" when the startup comes from
// --startup. The record id is everything after the section, slashes included.
function parseRecordTarget(target, startupId = "") {
  let rest = String(target || "");
  let id = startupId;
  if (!id) {
    const first = rest.indexOf("/");
    if (first < 1 || rest.indexOf("/", first + 1) < 0) {
      throw new Error(
        "--record needs the startup: --record <startupId>/<section>/<id>, "
        + `or --startup <startupId> --record <section>/<id>. Got: ${target}`,
      );
    }
    id = rest.slice(0, first);
    rest = rest.slice(first + 1);
  }
  const separatorIndex = rest.indexOf("/");
  if (separatorIndex < 1) {
    throw new Error(`--record expects <section>/<id>, for example items/abc123. Got: ${rest}`);
  }
  const section = rest.slice(0, separatorIndex);
  const recordId = rest.slice(separatorIndex + 1);
  if (!recordId) throw new Error("--record is missing the record id.");
  try {
    return { startupId: normalizeStartupId(id), section, recordId };
  } catch {
    throw new Error(`Not a startup id: ${id}`);
  }
}

// One startup's state in a backup, proven readable before anything depends on
// it, with its entry in the backup's startup list (null when the list does not
// name it).
function readSnapshotStartup(snapshot, startupId) {
  const verification = verifyDatabaseFile(snapshot.filePath, snapshot.expected);
  if (!verification.ok) {
    throw new Error(`${snapshot.id} did not verify: ${verification.problems.join("; ")}`);
  }
  const store = new TrackerSqliteStore(snapshot.filePath, { readOnly: true });
  try {
    const ids = store.listStartupIds({ includeGlobal: true });
    if (!ids.includes(startupId)) {
      throw new Error(`${snapshot.id} holds nothing for startup ${startupId}. It has: ${ids.join(", ") || "no startups"}.`);
    }
    return { state: store.readState(startupId).state, listEntry: getStartup(store, startupId) };
  } finally {
    store.close();
  }
}

// A record or startup restore writes into the live database through the
// store, and never creates one.
function assertLiveDatabase(databasePath) {
  if (!fs.existsSync(databasePath)) throw new Error(`No database at ${databasePath}.`);
}

// The manager's full check: the database and every media file.
function verifySnapshot(reference, options = {}) {
  const backup = findBackup(resolvePaths(options), reference);
  return { fileName: backup.id, kind: backup.kind, ...backup.manager.verify(backup.id) };
}

// A backup is restored only when its database and every media file it lists
// check out. Restoring half of a backup is worse than none.
function assertBackupVerifies(backup) {
  const report = backup.manager.verify(backup.id);
  if (!report.ok) throw new Error(`${backup.id} did not verify: ${report.problems.join("; ")}. Nothing was changed.`);
}

function replacedPathFor(databasePath) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  let candidate = `${databasePath}.replaced-${stamp}`;
  for (let counter = 2; fs.existsSync(candidate); counter += 1) {
    candidate = `${databasePath}.replaced-${stamp}-${counter}`;
  }
  return candidate;
}

// Replace the whole database file with the backup's and put its media files
// back, as the manifest lists them. Media files the backup does not list are
// left where they are. The live file is set aside rather than deleted, so a
// restore from the wrong backup is still recoverable. A file copy rather than
// a write through the store, because this is the way back when the live
// database is too damaged to open.
function restoreSnapshot(reference, options = {}) {
  const paths = resolvePaths(options);
  const { databasePath } = paths;
  const snapshot = resolveBackup(paths, reference);
  assertBackupVerifies(snapshot);
  const source = verifyDatabaseFile(snapshot.filePath, snapshot.expected);
  if (!source.ok) {
    throw new Error(`${snapshot.id} did not verify: ${source.problems.join("; ")}`);
  }
  const expected = { expectedRevision: source.revision, expectedStateHash: source.stateHash };

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const incomingPath = path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.restoring-${process.pid}-${Date.now()}`);
  let replacedPath = "";
  try {
    fs.copyFileSync(snapshot.filePath, incomingPath);
    const incoming = verifyDatabaseFile(incomingPath, expected);
    if (!incoming.ok) {
      throw new Error(`The copy of ${snapshot.id} did not verify: ${incoming.problems.join("; ")}. Nothing was changed.`);
    }
    if (fs.existsSync(databasePath)) {
      replacedPath = replacedPathFor(databasePath);
      fs.copyFileSync(databasePath, replacedPath);
      // Commits not yet checkpointed live in the -wal file and belong to the
      // database being set aside.
      if (fs.existsSync(`${databasePath}-wal`)) fs.copyFileSync(`${databasePath}-wal`, `${replacedPath}-wal`);
    }
    // A -wal left beside the restored file would be replayed onto it.
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    fs.renameSync(incomingPath, databasePath);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${incomingPath}${suffix}`, { force: true });
  }

  // Prove the live database now holds what the backup held, before reporting
  // success. A restore that silently half-applied is the worst outcome here.
  const verification = verifyDatabaseFile(databasePath, expected);
  if (!verification.ok) {
    throw new Error(
      `The restored database did not verify: ${verification.problems.join("; ")}. `
      + `The database as it was before this restore is at ${replacedPath}.`,
    );
  }

  let media;
  try {
    media = snapshot.manager.restoreMedia(snapshot.id);
  } catch (error) {
    throw new Error(
      `The database was restored, but putting the media files back failed: ${error.message} `
      + `The database as it was before this restore is at ${replacedPath}.`,
    );
  }

  return {
    restored: snapshot.id,
    kind: snapshot.kind,
    databasePath,
    replacedPath,
    revision: verification.revision,
    startupCount: verification.startupCount,
    recordCount: verification.recordCount,
    media: { restored: media.restored, listed: media.listed, mediaDir: paths.mediaDir },
  };
}

// Put one record back into one startup without touching anything else. This is
// the failure that actually happens: the database is healthy, one entry was
// overwritten with something wrong, and a full rollback would throw away every
// good edit made since. Safe to run while the server is up -- it writes through
// the store's transactional path, which the server notices.
function restoreRecord(reference, target, options = {}) {
  const paths = resolvePaths(options);
  const { databasePath } = paths;
  const { startupId, section, recordId } = parseRecordTarget(target, options.startupId);

  const snapshot = resolveBackup(paths, reference);
  const { state } = readSnapshotStartup(snapshot, startupId);
  const collection = state[section];
  if (!Array.isArray(collection)) {
    throw new Error(`${snapshot.id} has no collection named "${section}" in startup ${startupId}.`);
  }
  const record = collection.find((entry) => entry && String(entry.id) === recordId);
  if (!record) {
    throw new Error(`${snapshot.id} has no record ${recordId} in "${section}" of startup ${startupId}.`);
  }

  assertLiveDatabase(databasePath);
  const store = new TrackerSqliteStore(databasePath);
  try {
    if (startupId !== GLOBAL_STARTUP_ID && !getStartup(store, startupId)) {
      throw new Error(`The live database has no startup ${startupId}.`);
    }
    const existing = store.getRecord(startupId, section, recordId);
    const result = store.upsertRecord(startupId, section, record, {
      origin: "restore",
      label: `Restored from ${snapshot.id}`,
    });
    return {
      restored: `${startupId}/${section}/${recordId}`,
      startupId,
      from: snapshot.id,
      existed: Boolean(existing),
      revision: result.revision,
    };
  } finally {
    store.close();
  }
}

// A new safety backup could rotate out the very safety backup being restored
// from. Its cap is raised just enough for this run that the source stays;
// the next prune by anyone else trims it back.
function safetyCapKeeping(backup, manager) {
  if (backup.kind !== "safety") return undefined;
  const position = manager.list().filter((entry) => entry.kind === "safety" && entry.complete).findIndex((entry) => entry.id === backup.id);
  return position + 2 > manager.limits.safety ? Math.min(position + 2, 1000) : undefined;
}

// Replace one startup's records with what a backup holds, through the store,
// and put that startup's media files back. Other startups and the global
// settings are not touched (a startup deleted since the backup is put back
// into the startup list), so this is safe while the server runs. A safety
// backup of everything is taken first; if it fails, nothing is restored.
function restoreStartup(reference, startupId, options = {}) {
  const paths = resolvePaths(options);
  const { databasePath } = paths;
  let id;
  try {
    id = normalizeStartupId(startupId);
  } catch {
    throw new Error(`Not a startup id: ${startupId}`);
  }
  if (id === GLOBAL_STARTUP_ID) {
    throw new Error(
      `${GLOBAL_STARTUP_ID} holds the shared settings and the startup list, not a startup. `
      + `Restore one of its records with --record ${GLOBAL_STARTUP_ID}/<section>/<id>, or the whole database with --snapshot alone.`,
    );
  }

  const backup = resolveBackup(paths, reference);
  assertBackupVerifies(backup);
  const { state, listEntry } = readSnapshotStartup(backup, id);

  assertLiveDatabase(databasePath);
  const store = new TrackerSqliteStore(databasePath);
  try {
    const current = getStartup(store, id);
    if (!current && !listEntry) {
      throw new Error(`Neither the live database nor ${backup.id} lists startup ${id}, so there is nowhere to put it back.`);
    }
    let safety;
    try {
      const probe = openBackupManager(store, paths);
      const manager = openBackupManager(store, { ...paths, safetyLimit: safetyCapKeeping(backup, probe) });
      safety = manager.create({ kind: "safety", reason: "restore" });
    } catch (error) {
      throw new Error(`No safety backup could be taken, so nothing was restored: ${error.message}`);
    }
    const options = { origin: "restore", label: `Restored from ${backup.id}` };
    const result = store.replaceState(id, state, options);
    // A startup deleted since the backup comes back into the list as it was,
    // the same as a startup restore through the API.
    if (!current) store.upsertRecord(GLOBAL_STARTUP_ID, STARTUPS_SECTION, listEntry, options);
    const media = backup.manager.restoreMedia(backup.id, { startupId: id });
    return {
      restored: id,
      from: backup.id,
      addedToStartupList: !current,
      kind: backup.kind,
      safetyBackup: safety.id,
      safetySkipped: safety.skipped,
      revision: result.revision,
      unchanged: result.unchanged,
      media: { restored: media.restored, listed: media.listed, mediaDir: paths.mediaDir },
    };
  } finally {
    store.close();
  }
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatStartups({ startupCount, startups }) {
  const label = `${startupCount} startup${startupCount === 1 ? "" : "s"}`;
  if (startupCount === 0) return label;
  const shown = startups.slice(0, LISTED_NAMES).join(", ");
  const more = startupCount > LISTED_NAMES ? ` and ${startupCount - LISTED_NAMES} more` : "";
  return `${label}: ${shown}${more}`;
}

function formatListLine(entry) {
  const created = entry.createdAt || "unknown time";
  const broken = entry.complete ? "" : "  INCOMPLETE";
  return `  ${entry.id}  ${entry.kind.padEnd(9)}  label: ${entry.label || "-"}  ${created}  `
    + `${formatBytes(entry.bytes).padStart(8)}  ${formatStartups(entry)}  `
    + `${entry.mediaFiles} media file${entry.mediaFiles === 1 ? "" : "s"}${broken}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const options = {
    databasePath: readArgument(argv, "--database", undefined),
    backupDir: readArgument(argv, "--backup-dir", undefined),
    mediaDir: readArgument(argv, "--media-dir", undefined),
    startupId: readArgument(argv, "--startup", undefined),
  };

  if (argv.includes("--list") || argv.length === 0) {
    const { backupDir } = resolvePaths(options);
    const backups = listBackups(options);
    if (backups.length === 0) {
      process.stdout.write(`No backups in ${backupDir}\n`);
      return;
    }
    process.stdout.write(`Backups in ${backupDir}:\n`);
    for (const entry of backups) process.stdout.write(formatListLine(entry));
    process.stdout.write(
      "\nRestore everything (server stopped): node tools/restore-sqlite.js --snapshot <backup>\n"
      + "Restore one startup: node tools/restore-sqlite.js --snapshot <backup> --startup <startupId>\n"
      + "Restore one record: node tools/restore-sqlite.js --snapshot <backup> --record <startupId>/<section>/<id>\n",
    );
    return;
  }

  const verifyTarget = readArgument(argv, "--verify", undefined);
  if (verifyTarget) {
    const report = verifySnapshot(verifyTarget, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const snapshotName = readArgument(argv, "--snapshot", undefined);
  if (!snapshotName) {
    throw new Error("Nothing to do. Pass --list, --verify <backup>, or --snapshot <backup>.");
  }

  const recordTarget = readArgument(argv, "--record", undefined);
  let result;
  if (recordTarget) result = restoreRecord(snapshotName, recordTarget, options);
  else if (options.startupId) result = restoreStartup(snapshotName, options.startupId, options);
  else result = restoreSnapshot(snapshotName, options);
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
  listBackups,
  parseRecordTarget,
  resolveBackup,
  restoreRecord,
  restoreSnapshot,
  restoreStartup,
  verifySnapshot,
};
