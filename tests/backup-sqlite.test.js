"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { GLOBAL_STARTUP_ID, TrackerSqliteStore, stableSerialize, verifyDatabaseFile } = require("../lib/tracker-sqlite-store");
const { createStartup, deleteStartup, getStartup } = require("../lib/startups");
const { MANIFEST_FILE, DATABASE_FILE, MEDIA_STORE } = require("../lib/backups/manager");
const { createBackup } = require("../tools/backup-sqlite");
const {
  listBackups,
  parseRecordTarget,
  restoreRecord,
  restoreSnapshot,
  restoreStartup,
  verifySnapshot,
} = require("../tools/restore-sqlite");

const BACKUP_TOOL = path.join(__dirname, "..", "tools", "backup-sqlite.js");
const RESTORE_TOOL = path.join(__dirname, "..", "tools", "restore-sqlite.js");

// A temporary data folder: database, backup folder and media folder.
function makeEnv(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(tempDir, "data", "tracker.sqlite");
  const backupDir = path.join(tempDir, "backups");
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  return {
    tempDir,
    databasePath,
    backupDir,
    mediaDir,
    // Options for createBackup and for the restore functions.
    backup: { databasePath, outputDir: backupDir, mediaDir },
    restore: { databasePath, backupDir, mediaDir },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// A database holding one startup with the given state. Returns its id.
function seedStartup(databasePath, state, name = "Acme") {
  const store = new TrackerSqliteStore(databasePath);
  try {
    const { id } = createStartup(store, { name });
    store.replaceState(id, state);
    return id;
  } finally {
    store.close();
  }
}

function withStore(databasePath, action) {
  const store = new TrackerSqliteStore(databasePath);
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function upsert(databasePath, startupId, section, record, options) {
  return withStore(databasePath, (store) => store.upsertRecord(startupId, section, record, options));
}

function readStartupState(databasePath, startupId) {
  const store = new TrackerSqliteStore(databasePath, { readOnly: true });
  try {
    return store.readState(startupId).state;
  } finally {
    store.close();
  }
}

function writeMedia(mediaDir, relative, content) {
  const target = path.join(mediaDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readMedia(mediaDir, relative) {
  return fs.readFileSync(path.join(mediaDir, ...relative.split("/")), "utf8");
}

function readManifest(folder) {
  return JSON.parse(fs.readFileSync(path.join(folder, MANIFEST_FILE), "utf8"));
}

test("without a label the tool takes a safety backup folder, and unchanged data is not backed up twice", () => {
  const env = makeEnv("tracker-backup-safety-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "First" }] });
    const first = createBackup({ ...env.backup, date: new Date(Date.UTC(2026, 7, 19, 12, 0, 0)) });
    assert.equal(first.kind, "safety");
    assert.equal(first.skipped, false);
    assert.equal(first.startupCount, 1);
    assert.equal(first.folder, path.join(env.backupDir, first.id));
    assert.match(first.id, /^20260819-120000-000-safety$/);
    assert.deepEqual(fs.readdirSync(first.folder).sort(), [DATABASE_FILE, MANIFEST_FILE].sort());
    assert.equal(readManifest(first.folder).reason, "tool");
    assert.equal(verifyDatabaseFile(path.join(first.folder, DATABASE_FILE)).ok, true);
    // Reading a backup must not leave WAL files beside it.
    assert.equal(fs.existsSync(path.join(first.folder, `${DATABASE_FILE}-wal`)), false);

    const again = createBackup({ ...env.backup, date: new Date(Date.UTC(2026, 7, 19, 12, 1, 0)) });
    assert.equal(again.skipped, true);
    assert.equal(again.id, first.id);

    upsert(env.databasePath, startupId, "items", { id: "a", title: "Second" });
    const changed = createBackup({ ...env.backup, date: new Date(Date.UTC(2026, 7, 19, 12, 2, 0)) });
    assert.equal(changed.skipped, false);
    assert.notEqual(changed.id, first.id);
  } finally {
    env.cleanup();
  }
});

test("a labelled backup is pinned: taken even when nothing changed, and never rotated away", () => {
  const env = makeEnv("tracker-backup-pinned-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "Original" }] });
    const unrelated = path.join(env.backupDir, "manual-note.json");
    fs.mkdirSync(env.backupDir, { recursive: true });
    fs.writeFileSync(unrelated, "{}\n");

    const safety = createBackup({ ...env.backup, date: new Date(Date.UTC(2026, 7, 19, 12, 0, 0)) });
    const pinned = createBackup({ ...env.backup, label: "pre bulk edit", date: new Date(Date.UTC(2026, 7, 19, 12, 0, 1)) });
    assert.equal(pinned.kind, "pinned");
    assert.equal(pinned.label, "pre-bulk-edit");
    assert.equal(pinned.skipped, false, "a pinned backup is always taken");
    assert.match(pinned.id, /-pinned-pre-bulk-edit$/);
    assert.equal(pinned.stateHash, safety.stateHash);

    for (let index = 0; index < 4; index += 1) {
      upsert(env.databasePath, startupId, "items", { id: "a", title: `Value ${index}` });
      const result = createBackup({ ...env.backup, limit: 2, date: new Date(Date.UTC(2026, 7, 19, 12, 1, index)) });
      assert.equal(result.keep.safety, 2);
    }

    const kinds = listBackups(env.restore).map((entry) => entry.kind);
    assert.equal(kinds.filter((kind) => kind === "safety").length, 2, "--limit caps safety backups");
    assert.equal(kinds.filter((kind) => kind === "pinned").length, 1);
    assert.equal(fs.existsSync(unrelated), true, "files that are not backups are never pruned");

    const copy = new TrackerSqliteStore(path.join(pinned.folder, DATABASE_FILE), { readOnly: true });
    try {
      assert.equal(copy.readState(startupId).state.items[0].title, "Original");
    } finally {
      copy.close();
    }
  } finally {
    env.cleanup();
  }
});

test("keep counts come from the global settings when they are set", () => {
  const env = makeEnv("tracker-backup-settings-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "One" }] });
    withStore(env.databasePath, (store) => store.replaceSection(GLOBAL_STARTUP_ID, "settings", { backups: { keepAutomatic: 7, keepSafety: 1 } }));
    for (let index = 0; index < 3; index += 1) {
      upsert(env.databasePath, startupId, "items", { id: "a", title: `Value ${index}` });
      const result = createBackup({ ...env.backup, date: new Date(Date.UTC(2026, 7, 19, 12, 0, index)) });
      assert.deepEqual(result.keep, { automatic: 7, safety: 1 });
    }
    assert.equal(listBackups(env.restore).length, 1);
  } finally {
    env.cleanup();
  }
});

test("media files are stored once and shared between backups", () => {
  const env = makeEnv("tracker-backup-media-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "One" }] });
    writeMedia(env.mediaDir, `${startupId}/deck.pdf`, "deck bytes");
    writeMedia(env.mediaDir, `${startupId}/deck-copy.pdf`, "deck bytes");
    writeMedia(env.mediaDir, `${startupId}/logo.png`, "logo bytes");

    const first = createBackup({ ...env.backup, label: "one" });
    assert.equal(first.mediaFiles, 3);
    assert.equal(first.mediaCopied, 2, "identical content is stored once");
    const second = createBackup({ ...env.backup, label: "two" });
    assert.equal(second.mediaFiles, 3);
    assert.equal(second.mediaCopied, 0, "nothing new to copy");
    assert.equal(fs.readdirSync(path.join(env.backupDir, MEDIA_STORE)).length, 2);
    assert.equal(readManifest(second.folder).files.length, 3);
  } finally {
    env.cleanup();
  }
});

test("SQLite backup rejects invalid retention limits before writing", () => {
  assert.throws(
    () => createBackup({ databasePath: "missing.sqlite", limit: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => createBackup({ databasePath: "missing.sqlite", limit: 5000 }),
    /positive integer up to 1000/,
  );
});

test("the backup tool prints the backup as JSON", () => {
  const env = makeEnv("tracker-backup-cli-");
  try {
    seedStartup(env.databasePath, { items: [{ id: "a", title: "One" }] });
    const run = spawnSync(process.execPath, [
      BACKUP_TOOL,
      "--database", env.databasePath,
      "--output-dir", env.backupDir,
      "--media-dir", env.mediaDir,
      "--label", "cli-check",
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, "pinned");
    assert.equal(result.label, "cli-check");
    assert.equal(result.skipped, false);
    assert.equal(fs.existsSync(path.join(result.folder, DATABASE_FILE)), true);
    assert.equal(result.mediaFiles, 0);
  } finally {
    env.cleanup();
  }
});

test("a whole-database restore from a backup folder brings the media back and keeps the replaced file", () => {
  const env = makeEnv("tracker-restore-folder-");
  try {
    const startupId = seedStartup(env.databasePath, {
      items: [{ id: "a", title: "Good" }, { id: "b", title: "Also good" }],
    });
    writeMedia(env.mediaDir, `${startupId}/deck.pdf`, "deck v1");
    writeMedia(env.mediaDir, `${startupId}/logo.png`, "logo v1");
    const backup = createBackup({ ...env.backup, label: "before-wreck" });

    withStore(env.databasePath, (store) => {
      store.replaceState(startupId, { items: [{ id: "a", title: "WIPED" }] });
      createStartup(store, { name: "Created after the backup" });
    });
    fs.rmSync(path.join(env.mediaDir, startupId, "deck.pdf"));
    writeMedia(env.mediaDir, `${startupId}/logo.png`, "logo damaged");
    writeMedia(env.mediaDir, `${startupId}/added-later.txt`, "kept");

    const result = restoreSnapshot(backup.id, env.restore);
    assert.equal(result.kind, "pinned");
    assert.equal(result.startupCount, 1);
    assert.deepEqual({ restored: result.media.restored, listed: result.media.listed }, { restored: 2, listed: 2 });

    assert.deepEqual(readStartupState(env.databasePath, startupId).items.map((item) => item.title), ["Good", "Also good"]);
    assert.deepEqual(readStartupState(env.databasePath, GLOBAL_STARTUP_ID).startups.map((startup) => startup.name), ["Acme"]);
    assert.equal(readMedia(env.mediaDir, `${startupId}/deck.pdf`), "deck v1");
    assert.equal(readMedia(env.mediaDir, `${startupId}/logo.png`), "logo v1");
    assert.equal(readMedia(env.mediaDir, `${startupId}/added-later.txt`), "kept", "files the backup does not list stay");
    assert.equal(fs.existsSync(`${env.databasePath}-wal`), false);

    assert.match(path.basename(result.replacedPath), /^tracker\.sqlite\.replaced-\d{8}T\d{6}/);
    const replaced = new TrackerSqliteStore(result.replacedPath, { readOnly: true });
    try {
      assert.equal(replaced.readState(startupId).state.items[0].title, "WIPED");
    } finally {
      replaced.close();
    }
  } finally {
    env.cleanup();
  }
});

test("the restore tool lists and verifies backup folders", () => {
  const env = makeEnv("tracker-restore-list-");
  try {
    seedStartup(env.databasePath, { items: [{ id: "a", title: "Good" }] });
    const backup = createBackup({ ...env.backup, label: "folder" });
    assert.equal(verifySnapshot(backup.id, env.restore).ok, true);

    const run = spawnSync(process.execPath, [
      RESTORE_TOOL, "--list", "--database", env.databasePath, "--backup-dir", env.backupDir, "--media-dir", env.mediaDir,
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /-pinned-folder\s+pinned\s+label: folder .* 1 startup: Acme\s+0 media files/);
  } finally {
    env.cleanup();
  }
});

test("a single record can be restored from a backup folder without rolling back everything else", () => {
  const env = makeEnv("tracker-restore-record-");
  try {
    const startupId = seedStartup(env.databasePath, {
      items: [{ id: "a", title: "Original A" }, { id: "b", title: "Original B" }],
    });
    const backup = createBackup(env.backup);

    upsert(env.databasePath, startupId, "items", { id: "a", title: "MANGLED", notes: "garbage" });
    upsert(env.databasePath, startupId, "items", { id: "b", title: "Deliberately edited later" });

    const result = restoreRecord(backup.id, `${startupId}/items/a`, env.restore);
    assert.equal(result.existed, true);
    assert.equal(result.restored, `${startupId}/items/a`);
    assert.equal(result.from, backup.id);

    const items = readStartupState(env.databasePath, startupId).items;
    assert.deepEqual(items.find((item) => item.id === "a"), { id: "a", title: "Original A" });
    assert.equal(items.find((item) => item.id === "b").title, "Deliberately edited later");

    // The same restore, naming the startup with --startup instead.
    upsert(env.databasePath, startupId, "items", { id: "a", title: "MANGLED AGAIN" });
    restoreRecord(backup.id, "items/a", { ...env.restore, startupId });
    assert.equal(readStartupState(env.databasePath, startupId).items.find((item) => item.id === "a").title, "Original A");

    assert.throws(
      () => restoreRecord(backup.id, `${startupId}/items/does-not-exist`, env.restore),
      /has no record does-not-exist/,
    );
    assert.throws(
      () => restoreRecord(backup.id, "no-slash", { ...env.restore, startupId }),
      /expects <section>\/<id>/,
    );
    assert.throws(
      () => restoreRecord(backup.id, "other-0000/items/a", env.restore),
      /holds nothing for startup other-0000/,
    );
    assert.throws(
      () => restoreRecord("20990101-000000-000-pinned", `${startupId}/items/a`, env.restore),
      /Backup not found/,
    );
  } finally {
    env.cleanup();
  }
});

test("a corrupt backup is refused before it can overwrite live data", () => {
  const env = makeEnv("tracker-corrupt-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "Live data" }] });
    writeMedia(env.mediaDir, `${startupId}/deck.pdf`, "deck");
    const damagedDatabase = createBackup({ ...env.backup, label: "damaged-database" });
    const damagedMedia = createBackup({ ...env.backup, label: "damaged-media" });

    const databaseFile = path.join(damagedDatabase.folder, DATABASE_FILE);
    const bytes = fs.readFileSync(databaseFile);
    bytes.fill(0, 4_096, 20_000);
    fs.writeFileSync(databaseFile, bytes);
    assert.equal(verifySnapshot(damagedDatabase.id, env.restore).ok, false);
    assert.throws(() => restoreSnapshot(damagedDatabase.id, env.restore), /did not verify/);

    // Both backups share the one stored copy of the media file.
    const [stored] = fs.readdirSync(path.join(env.backupDir, MEDIA_STORE));
    fs.writeFileSync(path.join(env.backupDir, MEDIA_STORE, stored), "tampered");
    const report = verifySnapshot(damagedMedia.id, env.restore);
    assert.equal(report.ok, false);
    assert.match(report.problems.join("; "), /Damaged media file/);
    upsert(env.databasePath, startupId, "items", { id: "a", title: "Live data, edited" });
    assert.throws(() => restoreSnapshot(damagedMedia.id, env.restore), /did not verify.*Nothing was changed/);
    assert.throws(() => restoreStartup(damagedMedia.id, startupId, env.restore), /did not verify/);

    // The live database is untouched, which is the whole point of verifying first.
    assert.equal(verifyDatabaseFile(env.databasePath).ok, true);
    assert.equal(readStartupState(env.databasePath, startupId).items[0].title, "Live data, edited");
    const leftovers = fs.readdirSync(path.dirname(env.databasePath)).filter((name) => /replaced|restoring/.test(name));
    assert.deepEqual(leftovers, [], "nothing was set aside or half-copied");
  } finally {
    env.cleanup();
  }
});

test("a backup carries record history, and restoring one record logs the restore", () => {
  const env = makeEnv("tracker-history-backup-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", status: "todo" }] });
    withStore(env.databasePath, (store) => {
      store.upsertRecord(startupId, "items", { id: "a", status: "done" }, { origin: "ui" });
      assert.ok(store.getInfo().historyEntryCount >= 2);
    });

    const backup = createBackup({ ...env.backup, label: "history-check" });
    const copy = new TrackerSqliteStore(path.join(backup.folder, DATABASE_FILE), { readOnly: true });
    try {
      const history = copy.readRecordHistory(startupId, "items", "a");
      assert.equal(history.available, true);
      assert.ok(history.total >= 2, "the backup holds the timeline the live database had");
    } finally {
      copy.close();
    }

    upsert(env.databasePath, startupId, "items", { id: "a", status: "abandoned" }, { origin: "ui" });
    restoreRecord(backup.id, `${startupId}/items/a`, env.restore);

    withStore(env.databasePath, (store) => {
      assert.equal(store.getRecord(startupId, "items", "a").status, "done");
      const newest = store.readRecordHistory(startupId, "items", "a").entries[0];
      assert.equal(newest.origin, "restore", "a restore is itself an edit worth logging");
      assert.equal(newest.label, `Restored from ${backup.id}`);
    });
  } finally {
    env.cleanup();
  }
});

test("restoring one startup leaves every other startup exactly as it was", () => {
  const env = makeEnv("tracker-restore-startup-");
  try {
    const { first, second } = withStore(env.databasePath, (store) => {
      const ids = { first: createStartup(store, { name: "First" }).id, second: createStartup(store, { name: "Second" }).id };
      store.replaceState(ids.first, { items: [{ id: "shared", title: "First original" }, { id: "x", title: "Extra" }] });
      store.replaceState(ids.second, { items: [{ id: "shared", title: "Second original" }] });
      return ids;
    });
    writeMedia(env.mediaDir, `${first}/deck.pdf`, "first deck");
    writeMedia(env.mediaDir, `${second}/deck.pdf`, "second deck");
    const backup = createBackup({ ...env.backup, label: "two-startups" });

    upsert(env.databasePath, first, "items", { id: "shared", title: "First mangled" });
    upsert(env.databasePath, first, "items", { id: "new", title: "Added after the backup" });
    upsert(env.databasePath, second, "items", { id: "shared", title: "Second edited on purpose" });
    fs.rmSync(path.join(env.mediaDir, first, "deck.pdf"));
    writeMedia(env.mediaDir, `${second}/deck.pdf`, "second deck, edited");

    const before = withStore(env.databasePath, (store) => ({
      state: stableSerialize(store.readState(second)),
      revision: store.getRevision(second),
      global: stableSerialize(store.readState(GLOBAL_STARTUP_ID)),
    }));

    const result = restoreStartup(backup.id, first, env.restore);
    assert.equal(result.restored, first);
    assert.equal(result.from, backup.id);
    assert.equal(result.unchanged, false);
    assert.deepEqual({ restored: result.media.restored, listed: result.media.listed }, { restored: 1, listed: 1 });

    assert.deepEqual(readStartupState(env.databasePath, first).items.map((item) => item.title), ["First original", "Extra"]);
    assert.equal(readMedia(env.mediaDir, `${first}/deck.pdf`), "first deck");
    const after = withStore(env.databasePath, (store) => ({
      state: stableSerialize(store.readState(second)),
      revision: store.getRevision(second),
      global: stableSerialize(store.readState(GLOBAL_STARTUP_ID)),
    }));
    assert.deepEqual(after, before, "the other startup and the global settings did not move");
    assert.equal(readMedia(env.mediaDir, `${second}/deck.pdf`), "second deck, edited");

    // The safety backup taken first holds the state from just before the restore.
    const safety = listBackups(env.restore).find((entry) => entry.id === result.safetyBackup);
    assert.equal(safety.kind, "safety");
    assert.equal(readManifest(path.join(env.backupDir, safety.id)).reason, "restore");
    const saved = new TrackerSqliteStore(path.join(env.backupDir, safety.id, DATABASE_FILE), { readOnly: true });
    try {
      assert.equal(saved.readState(first).state.items[0].title, "First mangled");
    } finally {
      saved.close();
    }

    withStore(env.databasePath, (store) => {
      const newest = store.readRecordHistory(first, "items", "shared").entries[0];
      assert.equal(newest.origin, "restore");
    });

    assert.throws(() => restoreStartup(backup.id, GLOBAL_STARTUP_ID, env.restore), /not a startup/);
    assert.throws(() => restoreStartup(backup.id, "gone-0000", env.restore), /holds nothing for startup gone-0000/);
  } finally {
    env.cleanup();
  }
});

test("restoring a startup deleted since the backup puts it back into the startup list", () => {
  const env = makeEnv("tracker-restore-deleted-startup-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "Kept in the backup" }] }, "Gone");
    const backup = createBackup({ ...env.backup, label: "before-delete" });
    withStore(env.databasePath, (store) => deleteStartup(store, startupId));

    const result = restoreStartup(backup.id, startupId, env.restore);
    assert.equal(result.addedToStartupList, true);
    withStore(env.databasePath, (store) => {
      assert.equal(getStartup(store, startupId).name, "Gone");
      assert.equal(store.readState(startupId).state.items[0].title, "Kept in the backup");
    });
  } finally {
    env.cleanup();
  }
});

test("a startup restore stops when the safety backup fails", () => {
  const env = makeEnv("tracker-restore-startup-safety-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "Original" }] });
    const backup = createBackup({ ...env.backup, label: "no-media" });
    upsert(env.databasePath, startupId, "items", { id: "a", title: "Edited" });
    // A new media file has to go into the media store, and the store's place
    // is taken by a file, so the safety backup cannot be written.
    writeMedia(env.mediaDir, `${startupId}/new.png`, "new");
    fs.writeFileSync(path.join(env.backupDir, MEDIA_STORE), "in the way");

    assert.throws(() => restoreStartup(backup.id, startupId, env.restore), /No safety backup could be taken, so nothing was restored/);
    assert.equal(readStartupState(env.databasePath, startupId).items[0].title, "Edited");
  } finally {
    env.cleanup();
  }
});

test("the safety backup before a startup restore does not rotate out the backup being restored", () => {
  const env = makeEnv("tracker-restore-startup-rotation-");
  try {
    const startupId = seedStartup(env.databasePath, { items: [{ id: "a", title: "Original" }] });
    withStore(env.databasePath, (store) => store.replaceSection(GLOBAL_STARTUP_ID, "settings", { backups: { keepSafety: 1 } }));
    writeMedia(env.mediaDir, `${startupId}/deck.pdf`, "deck v1");
    const source = createBackup(env.backup);
    assert.equal(source.kind, "safety");

    upsert(env.databasePath, startupId, "items", { id: "a", title: "Edited" });
    writeMedia(env.mediaDir, `${startupId}/deck.pdf`, "deck v2");
    const result = restoreStartup(source.id, startupId, env.restore);
    assert.notEqual(result.safetyBackup, source.id);
    assert.equal(readStartupState(env.databasePath, startupId).items[0].title, "Original");
    assert.equal(readMedia(env.mediaDir, `${startupId}/deck.pdf`), "deck v1");
    assert.deepEqual(listBackups(env.restore).map((entry) => entry.id).sort(), [source.id, result.safetyBackup].sort());
  } finally {
    env.cleanup();
  }
});

test("a backup is named by its folder id, and nothing else is taken", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-resolve-backup-"));
  try {
    const backupDir = path.join(tempDir, "backup");
    const options = { backupDir, databasePath: path.join(tempDir, "tracker.sqlite"), mediaDir: path.join(tempDir, "media") };
    fs.mkdirSync(backupDir, { recursive: true });

    for (const value of ["", null, undefined, "invalid-backup.txt", "tracker.js", "../../etc/passwd"]) {
      assert.throws(() => verifySnapshot(value, options), /Not a backup id/, String(value));
    }
    assert.throws(() => restoreSnapshot("bad-name.txt", options), /Not a backup id: bad-name\.txt/);
    assert.throws(() => restoreRecord("bad-name.txt", "acme-0000/items/a", options), /Not a backup id/);
    assert.throws(() => restoreStartup("bad-name.txt", "acme-0000", options), /Not a backup id/);
    assert.throws(() => verifySnapshot("20260101-000000-000-safety", options), /Backup not found/);
    assert.throws(() => restoreSnapshot("../20260101-000000-000-safety", options), /Backup not found/);

    // A folder without its manifest is listed and verified, but never restored.
    fs.mkdirSync(path.join(backupDir, "20260101-000000-000-pinned"));
    assert.equal(listBackups(options).find((entry) => entry.kind === "pinned").complete, false);
    assert.equal(verifySnapshot("20260101-000000-000-pinned", options).ok, false);
    assert.throws(() => restoreSnapshot("20260101-000000-000-pinned", options), /is incomplete/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a record restore writes only into the named startup", () => {
  const env = makeEnv("tracker-restore-scope-");
  try {
    const { first, second } = withStore(env.databasePath, (store) => {
      const ids = { first: createStartup(store, { name: "First" }).id, second: createStartup(store, { name: "Second" }).id };
      store.replaceState(ids.first, { items: [{ id: "shared", title: "First original" }] });
      store.replaceState(ids.second, { items: [{ id: "shared", title: "Second original" }] });
      return ids;
    });

    const backup = createBackup(env.backup);
    const listed = listBackups(env.restore)[0];
    assert.equal(listed.startupCount, 2);
    assert.deepEqual(listed.startups.sort(), ["First", "Second"]);

    upsert(env.databasePath, first, "items", { id: "shared", title: "First mangled" });
    upsert(env.databasePath, second, "items", { id: "shared", title: "Second edited on purpose" });

    restoreRecord(backup.id, `${first}/items/shared`, env.restore);

    assert.equal(readStartupState(env.databasePath, first).items[0].title, "First original");
    assert.equal(readStartupState(env.databasePath, second).items[0].title, "Second edited on purpose");
  } finally {
    env.cleanup();
  }
});

test("--record without a startup fails and says how to name one", () => {
  assert.throws(() => parseRecordTarget("items/a"), /--record needs the startup: --record <startupId>\/<section>\/<id>/);
  assert.throws(() => parseRecordTarget("Not An Id/items/a"), /Not a startup id: Not An Id/);
  assert.deepEqual(parseRecordTarget("acme-0000/items/a/b"), { startupId: "acme-0000", section: "items", recordId: "a/b" });
  assert.deepEqual(parseRecordTarget("items/a", "acme-0000"), { startupId: "acme-0000", section: "items", recordId: "a" });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-restore-cli-"));
  try {
    const run = spawnSync(process.execPath, [
      RESTORE_TOOL,
      "--database", path.join(tempDir, "tracker.sqlite"),
      "--backup-dir", tempDir,
      "--media-dir", path.join(tempDir, "media"),
      "--snapshot", "20260101-000000-000-pinned",
      "--record", "items/a",
    ], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--record needs the startup/);
    assert.match(run.stderr, /--startup <startupId> --record <section>\/<id>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
