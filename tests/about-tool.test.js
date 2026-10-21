"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { SCHEMA_VERSION, TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { createStartup } = require("../lib/startups");
const { dataPaths } = require("../lib/data-root");
const { writeLegacyDatabase } = require("./helpers/legacy-schema");
const { createBackup } = require("../tools/backup-sqlite");
const { collectAbout, formatAbout } = require("../tools/about");

const ABOUT_TOOL = path.join(__dirname, "..", "tools", "about.js");
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

// No TRACKER_* overrides and no PORT, so only --data-dir decides.
const CLEAN_ENV = {};

function makeDataFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "about-tool-"));
  return { root, paths: dataPaths(root, CLEAN_ENV) };
}

function seed(paths) {
  const store = new TrackerSqliteStore(paths.databaseFile);
  try {
    const first = createStartup(store, { name: "First" }).id;
    createStartup(store, { name: "Second" });
    store.replaceState(first, { items: [{ id: "a", title: "One" }] });
  } finally {
    store.close();
  }
}

// Every file under a folder with its bytes, to prove nothing was written.
function snapshotFolder(folder) {
  const files = {};
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else files[path.relative(folder, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  visit(folder);
  return files;
}

// A read-only open of a WAL database creates empty -wal and -shm files when
// no server has them open. They hold no data, so they are left out.
function withoutWalFiles(files) {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !/-(wal|shm)$/.test(name)));
}

test("about reports the data folder, database, integrity, startups and backups without changing anything", () => {
  const { root, paths } = makeDataFolder();
  try {
    seed(paths);
    fs.mkdirSync(path.join(paths.mediaDir, "first"), { recursive: true });
    fs.writeFileSync(path.join(paths.mediaDir, "first", "deck.pdf"), "deck");
    createBackup({ databasePath: paths.databaseFile, outputDir: paths.backupDir, mediaDir: paths.mediaDir, label: "one" });
    const flat = new TrackerSqliteStore(paths.databaseFile);
    try {
      flat.createSnapshot(path.join(paths.backupDir, "tracker-20260101-000000-old.sqlite"));
    } finally {
      flat.close();
    }
    const before = snapshotFolder(root);

    const about = collectAbout({ argv: ["--data-dir", root], env: CLEAN_ENV, now: () => new Date("2026-10-17T12:00:00Z") });
    assert.equal(about.version, VERSION);
    assert.equal(about.dataFolder, root);
    assert.equal(about.dataFolderSource, "flag");
    assert.equal(about.databasePath, paths.databaseFile);
    assert.equal(about.mediaDir, paths.mediaDir);
    assert.equal(about.backupDir, paths.backupDir);
    assert.equal(about.port, 57322);
    assert.equal(about.schemaVersion, SCHEMA_VERSION);
    assert.equal(about.databaseFormat, "current");
    assert.equal(about.databaseBytes, fs.statSync(paths.databaseFile).size);
    assert.deepEqual(about.integrity, { checkedAt: "2026-10-17T12:00:00.000Z", ok: true, problems: [] });
    assert.equal(about.startupCount, 2);
    assert.equal(about.backupCount, 1);
    assert.equal(about.olderBackupFiles, 1);

    assert.deepEqual(withoutWalFiles(snapshotFolder(root)), before, "nothing in the data folder changed");

    const text = formatAbout(about);
    assert.match(text, new RegExp(`^Startup Tracker ${VERSION.replaceAll(".", "\\.")}\\n`));
    assert.match(text, /Startups {6}2/);
    assert.match(text, /Integrity {5}ok \(checked 2026-10-17T12:00:00\.000Z\)/);
    assert.match(text, /1 backup, 1 older backup file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the port follows --port, PORT and --dev like the server", () => {
  const { root } = makeDataFolder();
  try {
    assert.equal(collectAbout({ argv: ["--data-dir", root], env: { PORT: "4100" } }).port, 4100);
    assert.equal(collectAbout({ argv: ["--data-dir", root, "--port", "4200"], env: { PORT: "4100" } }).port, 4200);
    assert.equal(collectAbout({ argv: ["--data-dir", root, "--dev"], env: CLEAN_ENV }).port, 57323);
    assert.throws(() => collectAbout({ argv: ["--data-dir", root], env: { PORT: "nope" } }), /Not a valid port: nope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy database reports its older format and is not upgraded", () => {
  const { root, paths } = makeDataFolder();
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeLegacyDatabase(paths.databaseFile, { items: [{ id: "a", title: "Old" }] });
    const before = fs.readFileSync(paths.databaseFile);

    const about = collectAbout({ argv: ["--data-dir", root], env: CLEAN_ENV });
    assert.equal(about.databaseFormat, "legacy");
    assert.equal(about.schemaVersion, 3);
    assert.match(about.databaseFormatNote, /one startup per file/);
    assert.equal(about.integrity.ok, true);
    assert.equal(about.startupCount, 1);
    assert.ok(fs.readFileSync(paths.databaseFile).equals(before), "the database is byte-identical");
    assert.match(formatAbout(about), /Older format: one startup per file \(schema 3\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a data folder without a database says so and creates nothing", () => {
  const { root } = makeDataFolder();
  try {
    const about = collectAbout({ argv: ["--data-dir", root], env: CLEAN_ENV });
    assert.equal(about.databaseFormat, "missing");
    assert.equal(about.schemaVersion, null);
    assert.equal(about.databaseBytes, 0);
    assert.equal(about.integrity.ok, false);
    assert.match(about.integrity.problems[0], /No database at .* yet/);
    assert.equal(about.backupCount, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the about tool prints text, or JSON with --json", () => {
  const { root, paths } = makeDataFolder();
  try {
    seed(paths);
    const env = { ...process.env, PORT: "", STARTUP_TRACKER_HOME: "" };
    for (const name of ["TRACKER_DB_PATH", "TRACKER_BACKUP_DIR", "TRACKER_MEDIA_DIR"]) delete env[name];

    const json = spawnSync(process.execPath, [ABOUT_TOOL, "--data-dir", root, "--json"], { encoding: "utf8", env });
    assert.equal(json.status, 0, json.stderr);
    const about = JSON.parse(json.stdout);
    assert.equal(about.dataFolder, root);
    assert.equal(about.startupCount, 2);
    assert.equal(about.integrity.ok, true);

    const text = spawnSync(process.execPath, [ABOUT_TOOL, "--data-dir", root], { encoding: "utf8", env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Data folder {3}.* \(from --data-dir\)/);
    assert.match(text.stdout, /Port {10}57322 \(configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
