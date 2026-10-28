"use strict";

// What the server does with backups, exports and imports, apart from HTTP:
// restores in three scopes, the comparison a restore is previewed with, and
// imports held behind a token between their preview and their apply.
//
// Every restore and import takes a safety backup first and stops if it
// cannot. Calls are synchronous, so the server handles no other request
// while one runs: writes are frozen for its whole length.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  GLOBAL_STARTUP_ID,
  STARTUPS_SECTION,
  TrackerSqliteStore,
  normalizeStartupId,
  stableSerialize,
  verifyDatabaseFile,
} = require("../tracker-sqlite-store");
const startups = require("../startups");
const { pairedSection } = require("../recycle-bin");
const { createBackupManager, BackupError } = require("./manager");
const { automaticBackupDue } = require("./schedule");
const transfer = require("./transfer");
const statusStore = require("../statuses");

const IMPORT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_COMPARED_RECORDS = 500;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

function recordTitle(record) {
  for (const field of ["title", "name", "platform", "funder", "label", "applicationName"]) {
    if (typeof record?.[field] === "string" && record[field].trim()) return record[field].trim();
  }
  return "";
}

function removeDatabaseFiles(filePath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${filePath}${suffix}`, { force: true });
}

function withReadOnlyStore(filePath, action) {
  const copy = new TrackerSqliteStore(filePath, { readOnly: true });
  try {
    return action(copy);
  } finally {
    copy.close();
  }
}

function createBackupService({ store, backupDir, mediaDir, readSettings, appVersion = "", onDataReplaced = () => {}, now = () => new Date() }) {
  const manager = createBackupManager({ store, backupDir, mediaDir, now });
  const countCache = new Map();
  const imports = new Map();
  const workDir = path.join(backupDir, ".work");

  function applyKeepSettings() {
    const { backups } = readSettings();
    manager.setKeep("automatic", backups.keepAutomatic);
    manager.setKeep("safety", backups.keepSafety);
  }

  function create(kind, { label = "", reason = "", protect = [] } = {}) {
    applyKeepSettings();
    return manager.create({ kind, label, reason, protect });
  }

  // The backup a restore or an import stands on. Failing to take it is an
  // error for the caller: the change does not run without it.
  function safety(reason, { protect = [] } = {}) {
    try {
      return create("safety", { reason, protect });
    } catch (error) {
      throw new BackupError(`The safety backup could not be taken, so nothing was changed: ${error.message}`, "safetyBackupFailed", 500);
    }
  }

  function maybeAutomatic({ atStart = false, lastWriteAt = 0 } = {}) {
    const backups = readSettings?.()?.backups || {};
    // Settings > Backups (or the setup) can turn automatic backups off.
    if (backups.automatic === false) return null;
    const hours = Number(backups.intervalHours);
    const due = automaticBackupDue({
      newest: manager.newest(),
      revision: store.getInfo().revision,
      now: now().getTime(),
      lastWriteAt,
      atStart,
      hasStartups: startups.listStartups(store).length > 0,
      intervalMs: Number.isFinite(hours) && hours >= 1 ? hours * 60 * 60 * 1000 : undefined,
    });
    return due ? create("automatic", { reason: due }) : null;
  }

  // Records per section of one startup in one backup. Backups never change,
  // so the counts are cached by backup id.
  function countsIn(backupId, startupId) {
    const key = `${backupId}\0${startupId}`;
    if (countCache.has(key)) return countCache.get(key);
    let counts = null;
    let db = null;
    try {
      db = new DatabaseSync(manager.databasePath(backupId), { readOnly: true });
      counts = {};
      const rows = db.prepare(`
        SELECT section_name, count(*) AS count FROM state_records WHERE startup_id = ? GROUP BY section_name
      `).all(startupId);
      for (const row of rows) counts[row.section_name] = Number(row.count);
    } catch {
      counts = null;
    } finally {
      try {
        db?.close();
      } catch {}
    }
    countCache.set(key, counts);
    return counts;
  }

  function list({ startupId = "" } = {}) {
    return manager.list().map(({ sortKey, ...backup }) => ({
      ...backup,
      counts: startupId && backup.complete ? countsIn(backup.id, startupId) : undefined,
    }));
  }

  function readBackupStartup(backupId, startupId) {
    return withReadOnlyStore(manager.databasePath(backupId), (copy) => ({
      state: copy.readState(startupId).state,
      listEntry: (copy.readSection(GLOBAL_STARTUP_ID, STARTUPS_SECTION) || []).find((entry) => entry.id === startupId) || null,
    }));
  }

  // What restoring one startup from a backup would change, section by section
  // and record by record.
  function compare(backupId, startupId) {
    const current = store.readState(startupId).state;
    const { state: backup } = readBackupStartup(backupId, startupId);
    const sections = [];
    const records = [];
    let truncated = false;
    const note = (entry) => {
      if (records.length >= MAX_COMPARED_RECORDS) truncated = true;
      else records.push(entry);
    };
    for (const section of [...new Set([...Object.keys(current), ...Object.keys(backup)])].sort()) {
      const now = current[section];
      const then = backup[section];
      if (!Array.isArray(now) && !Array.isArray(then)) {
        const changed = stableSerialize(now ?? null) !== stableSerialize(then ?? null);
        if (changed) note({ section, id: null, change: "changed", title: "" });
        sections.push({ section, current: null, backup: null, added: 0, removed: 0, changed: changed ? 1 : 0 });
        continue;
      }
      const nowById = new Map((Array.isArray(now) ? now : []).map((record) => [record.id, record]));
      const thenById = new Map((Array.isArray(then) ? then : []).map((record) => [record.id, record]));
      const summary = { section, current: nowById.size, backup: thenById.size, added: 0, removed: 0, changed: 0 };
      for (const [id, record] of thenById) {
        if (!nowById.has(id)) {
          summary.added += 1;
          note({ section, id, change: "added", title: recordTitle(record) });
        } else if (stableSerialize(nowById.get(id)) !== stableSerialize(record)) {
          summary.changed += 1;
          note({ section, id, change: "changed", title: recordTitle(record) });
        }
      }
      for (const [id, record] of nowById) {
        if (!thenById.has(id)) {
          summary.removed += 1;
          note({ section, id, change: "removed", title: recordTitle(record) });
        }
      }
      sections.push(summary);
    }
    return { sections, records, truncated };
  }

  // Every scope a database holds, read from a verified file.
  function readAllScopes(filePath) {
    return withReadOnlyStore(filePath, (copy) => {
      const states = new Map();
      for (const startupId of copy.listStartupIds({ includeGlobal: true })) {
        states.set(startupId, copy.readState(startupId).state);
      }
      return states;
    });
  }

  // Replaces every startup and the global settings with the given scopes.
  // Startups the source does not hold are removed; their media folders stay.
  function replaceWholeDatabase(states, options) {
    for (const startupId of store.listStartupIds()) {
      if (!states.has(startupId)) store.deleteStartupData(startupId);
    }
    // The global scope goes last, so the startup list never names a startup
    // whose records are not there yet.
    const order = [...states.keys()].sort((a, b) => (a === GLOBAL_STARTUP_ID) - (b === GLOBAL_STARTUP_ID));
    for (const startupId of order) store.replaceState(startupId, states.get(startupId), options);
    if (!states.has(GLOBAL_STARTUP_ID)) store.replaceState(GLOBAL_STARTUP_ID, {}, options);
  }

  function restoreStartup(backupId, startupId, options) {
    const { state, listEntry } = readBackupStartup(backupId, startupId);
    const current = startups.getStartup(store, startupId);
    if (!current && !listEntry) throw new BackupError("Neither the tracker nor the backup has this startup.", "unknownStartup", 404);
    const result = store.replaceState(startupId, state, options);
    // A startup deleted since the backup comes back into the list as it was.
    if (!current) store.upsertRecord(GLOBAL_STARTUP_ID, STARTUPS_SECTION, listEntry, options);
    const media = manager.restoreMedia(backupId, { startupId });
    return { revision: result.revision, media };
  }

  function restoreRecords(backupId, startupId, records, options) {
    if (!Array.isArray(records) || records.length === 0) throw new BackupError("Choose the records to restore.", "noRecords");
    if (!startups.getStartup(store, startupId)) throw new BackupError("Unknown startup.", "unknownStartup", 404);
    const { state: backup } = readBackupStartup(backupId, startupId);
    const current = store.readState(startupId).state;
    const operations = [];
    const restored = [];
    for (const { section, id } of records) {
      if (typeof section !== "string" || typeof id !== "string" || !id) throw new BackupError("Each record needs a section and an id.", "badRecord");
      const fromBackup = Array.isArray(backup[section]) ? backup[section].find((record) => record.id === id) : undefined;
      const inCurrent = Array.isArray(current[section]) && current[section].some((record) => record.id === id);
      if (fromBackup) {
        if (!Array.isArray(current[section])) {
          operations.push({ type: "replaceSection", section, value: [fromBackup] });
          current[section] = [fromBackup];
        } else {
          operations.push({ type: "upsert", section, id, value: fromBackup });
        }
        // The same record sitting in the recycle bin now would be a second
        // copy once it is back.
        const partner = pairedSection(section);
        if (partner && Array.isArray(current[partner]) && current[partner].some((record) => record.id === id)) {
          operations.push({ type: "delete", section: partner, id });
        }
        restored.push({ section, id, change: inCurrent ? "changed" : "added" });
      } else if (inCurrent) {
        operations.push({ type: "delete", section, id });
        restored.push({ section, id, change: "removed" });
      }
    }
    if (!operations.length) return { revision: store.getRevision(startupId), records: [] };
    const result = store.applyOperations(startupId, operations, options);
    return { revision: result.revision, records: restored };
  }

  function checkRestoreTarget(backup, scope, startupId, records) {
    try {
      normalizeStartupId(startupId);
    } catch {
      throw new BackupError("This is not a startup id.", "badStartup");
    }
    const current = startups.getStartup(store, startupId);
    if (scope === "startup") {
      if (!current && !backup.startups.some((entry) => entry.id === startupId)) {
        throw new BackupError("Neither the tracker nor the backup has this startup.", "unknownStartup", 404);
      }
      return;
    }
    if (!current) throw new BackupError("Unknown startup.", "unknownStartup", 404);
    if (!Array.isArray(records) || records.length === 0) throw new BackupError("Choose the records to restore.", "noRecords");
    if (records.some((record) => typeof record?.section !== "string" || typeof record?.id !== "string" || !record.id)) {
      throw new BackupError("Each record needs a section and an id.", "badRecord");
    }
  }

  function restore(backupId, { scope, startupId = "", records = [] } = {}) {
    const backup = manager.find(backupId);
    if (!backup.complete) throw new BackupError("This backup is incomplete and cannot be restored.", "brokenBackup");
    if (!["startup", "database", "records"].includes(scope)) throw new BackupError("Choose what to restore: this startup, the whole database or selected records.", "badScope");
    if (scope !== "database" && !startupId) throw new BackupError("Name the startup to restore.", "noStartup");
    // What the request names is checked before the safety backup, so a refused
    // restore leaves no backup behind and an unusable id is a 400, not a 500.
    if (scope !== "database") checkRestoreTarget(backup, scope, startupId, records);
    const check = verifyDatabaseFile(manager.databasePath(backup.id), { expectedStateHash: backup.stateHash });
    if (!check.ok) throw new BackupError(`This backup did not verify: ${check.problems.join("; ")}`, "brokenBackup");

    const safetyBackup = safety(`before restoring ${scope === "database" ? "the whole database" : startupId} from ${backup.id}`, { protect: [backup.id] });
    const options = { origin: "restore", label: `Restored from the backup of ${backup.createdAt || backup.id}`, importedAt: now().toISOString() };
    let detail;
    if (scope === "database") {
      replaceWholeDatabase(readAllScopes(manager.databasePath(backup.id)), options);
      detail = { media: manager.restoreMedia(backup.id) };
    } else if (scope === "startup") {
      detail = restoreStartup(backup.id, startupId, options);
    } else {
      detail = restoreRecords(backup.id, startupId, records, options);
    }
    onDataReplaced(scope === "database" ? null : startupId);
    return { scope, backup: backup.id, startupId: scope === "database" ? "" : startupId, safetyBackup: safetyBackup.id, ...detail };
  }

  function forgetExpiredImports() {
    const time = now().getTime();
    for (const [token, entry] of imports) {
      if (entry.expiresAt <= time) {
        if (entry.file) removeDatabaseFiles(entry.file);
        imports.delete(token);
      }
    }
  }

  // Reads an uploaded export or database without changing anything.
  function prepareImport(buffer) {
    forgetExpiredImports();
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = now().getTime() + IMPORT_TOKEN_TTL_MS;
    if (Buffer.isBuffer(buffer) && buffer.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      fs.mkdirSync(workDir, { recursive: true });
      const file = path.join(workDir, `import-${token}.sqlite`);
      fs.writeFileSync(file, buffer);
      const check = verifyDatabaseFile(file);
      const legacy = check.legacy && check.problems.length === 1;
      if (!check.ok && !legacy) {
        fs.rmSync(file, { force: true });
        throw new BackupError(`This database did not verify: ${check.problems.join("; ")}`, "badDatabase");
      }
      const names = legacy ? [] : withReadOnlyStore(file, (copy) => (copy.readSection(GLOBAL_STARTUP_ID, STARTUPS_SECTION) || []).map((entry) => entry.name));
      imports.set(token, { kind: "database", file, legacy, expiresAt });
      return { token, kind: "database", preview: { legacy, startupCount: legacy ? 1 : check.startupCount, startups: names, recordCount: check.recordCount } };
    }
    const parsed = transfer.readImport(buffer);
    imports.set(token, { kind: "export", parsed, expiresAt });
    const statuses = statusStore.readStatuses(store);
    const preview = parsed.preview.map((entry, index) => ({ ...entry, unmappedStatuses: statusStore.unknownStatuses(parsed.startups[index].state, statuses) }));
    return { token, kind: "export", preview: { startups: preview, exportedAt: parsed.manifest.exportedAt || "", appVersion: parsed.manifest.app?.version || "" } };
  }

  function applyPreparedImport(token, { mode, startupId = "" } = {}) {
    forgetExpiredImports();
    const entry = imports.get(String(token || ""));
    if (!entry) throw new BackupError("This import has expired or was already used. Choose the file again.", "importExpired", 404);
    if (entry.kind === "export" && mode !== "new" && mode !== "replace") throw new BackupError("Add the import as a new startup or replace a startup with it.", "badMode");
    if (entry.kind === "database" && mode !== "database") throw new BackupError("A database file restores the whole database.", "badMode");
    if (mode === "replace" && !startups.getStartup(store, startupId)) throw new BackupError("Unknown startup.", "unknownStartup", 404);

    const safetyBackup = safety(mode === "database" ? "before importing a database" : `before an import (${mode})`);
    imports.delete(token);
    try {
      if (entry.kind === "export") {
        const result = transfer.applyImport(store, entry.parsed, { mode, targetStartupId: startupId, mediaDir });
        onDataReplaced(mode === "replace" ? startupId : "");
        return { ...result, safetyBackup: safetyBackup.id };
      }
      let source = entry.file;
      if (entry.legacy) {
        // An older database is upgraded on a copy, never in place.
        source = `${entry.file}.upgraded.sqlite`;
        fs.copyFileSync(entry.file, source);
        new TrackerSqliteStore(source).close();
      }
      replaceWholeDatabase(readAllScopes(source), { origin: "import", label: "Imported a database file", importedAt: now().toISOString() });
      onDataReplaced(null);
      return { mode, safetyBackup: safetyBackup.id, startups: startups.listStartups(store).map(({ id, name }) => ({ id, name })) };
    } finally {
      // Opening the upgraded copy leaves -wal and -shm files beside it.
      if (entry.file) {
        removeDatabaseFiles(entry.file);
        removeDatabaseFiles(`${entry.file}.upgraded.sqlite`);
      }
    }
  }

  // Sensitive company values (companySecrets: national ids, bank accounts)
  // stay out of an export unless asked for.
  function exportStartups(startupIds, format, { includeSensitive = false } = {}) {
    const omit = includeSensitive ? null : (startupId, section, value) => (section === "companySecrets" ? undefined : value);
    return transfer.exportData(store, { startupIds, mediaDir, format, appVersion, omit, now: now() });
  }

  // A verified copy of the whole database, as bytes.
  function exportDatabase() {
    fs.mkdirSync(workDir, { recursive: true });
    const file = path.join(workDir, `export-${crypto.randomBytes(8).toString("hex")}.sqlite`);
    try {
      store.createSnapshot(file);
      return fs.readFileSync(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // Verified backups, newest first, for the advice printed when the live
  // database is damaged.
  function restorable() {
    return manager.list()
      .filter((backup) => backup.complete)
      .filter((backup) => verifyDatabaseFile(manager.databasePath(backup.id)).ok);
  }

  return {
    manager,
    create,
    safety,
    maybeAutomatic,
    list,
    compare,
    restore,
    prepareImport,
    applyPreparedImport,
    exportStartups,
    exportDatabase,
    restorable,
    verify: (id) => manager.verify(id),
    remove: (id) => manager.remove(id),
    databasePath: (id) => manager.databasePath(id),
  };
}

module.exports = { createBackupService, IMPORT_TOKEN_TTL_MS, SQLITE_MAGIC };
