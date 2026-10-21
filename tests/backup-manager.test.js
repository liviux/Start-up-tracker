"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { createBackupManager } = require("../lib/backups/manager");

const SID = "acme-0001";

function setup(keep) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-manager-"));
  const mediaDir = path.join(root, "media");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(path.join(mediaDir, SID), { recursive: true });
  const store = new TrackerSqliteStore(path.join(root, "data", "tracker.sqlite"));
  store.replaceState(SID, { items: [{ id: "a", platform: "One" }] }, { origin: "tool" });
  let clock = Date.parse("2026-10-17T10:00:00.000Z");
  const manager = createBackupManager({ store, backupDir, mediaDir, keep, now: () => new Date((clock += 1000)), mediaGraceMs: 0 });
  return {
    root, mediaDir, backupDir, store, manager,
    write(index) {
      store.upsertRecord(SID, "items", { id: `r${index}`, platform: `Item ${index}` }, { origin: "tool" });
    },
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a backup holds a verified database and every media file once", () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.mediaDir, SID, "deck.pdf"), "pdf bytes");
    fs.writeFileSync(path.join(env.mediaDir, SID, "copy.pdf"), "pdf bytes");
    const first = env.manager.create({ kind: "pinned", label: "before launch" });
    assert.equal(first.skipped, false);
    assert.equal(first.label, "before-launch");
    assert.equal(first.mediaFiles, 2);
    assert.equal(first.mediaCopied, 1, "identical content is stored once");
    assert.equal(fs.readdirSync(path.join(env.backupDir, "media-store")).length, 1);
    const check = env.manager.verify(first.id);
    assert.ok(check.ok, check.problems.join("; "));
    assert.deepEqual(env.manager.manifest(first.id).startups, []);
  } finally {
    env.cleanup();
  }
});

test("unchanged data is not backed up twice, except on request", () => {
  const env = setup();
  try {
    const first = env.manager.create({ kind: "automatic" });
    const again = env.manager.create({ kind: "automatic" });
    assert.equal(again.skipped, true);
    assert.equal(again.id, first.id);
    assert.equal(env.manager.create({ kind: "safety", reason: "restore" }).skipped, true);
    assert.equal(env.manager.create({ kind: "pinned" }).skipped, false);
    fs.writeFileSync(path.join(env.mediaDir, SID, "new.png"), "png");
    assert.equal(env.manager.create({ kind: "automatic" }).skipped, false, "a new media file is a change");
    env.write(1);
    assert.equal(env.manager.create({ kind: "automatic" }).skipped, false, "a database write is a change");
  } finally {
    env.cleanup();
  }
});

test("each kind rotates on its own and pinned backups never do", () => {
  const env = setup({ automatic: 3, safety: 2 });
  try {
    env.manager.create({ kind: "pinned", label: "keep" });
    for (let index = 0; index < 6; index += 1) {
      env.write(`a${index}`);
      env.manager.create({ kind: "automatic" });
      env.write(`s${index}`);
      env.manager.create({ kind: "safety" });
    }
    const kinds = env.manager.list().map((backup) => backup.kind);
    assert.equal(kinds.filter((kind) => kind === "automatic").length, 3);
    assert.equal(kinds.filter((kind) => kind === "safety").length, 2);
    assert.equal(kinds.filter((kind) => kind === "pinned").length, 1);
  } finally {
    env.cleanup();
  }
});

test("rotation removes media that no remaining backup lists", () => {
  const env = setup({ automatic: 1 });
  try {
    const file = path.join(env.mediaDir, SID, "old.png");
    fs.writeFileSync(file, "old content");
    env.manager.create({ kind: "automatic" });
    fs.writeFileSync(file, "new content");
    env.manager.create({ kind: "automatic" });
    const stored = fs.readdirSync(path.join(env.backupDir, "media-store"));
    assert.equal(stored.length, 1, "the old version left with the backup that listed it");
  } finally {
    env.cleanup();
  }
});

test("media comes back from a backup, for one startup or all", () => {
  const env = setup();
  try {
    fs.mkdirSync(path.join(env.mediaDir, "other-0002"));
    fs.writeFileSync(path.join(env.mediaDir, SID, "a.txt"), "A");
    fs.writeFileSync(path.join(env.mediaDir, "other-0002", "b.txt"), "B");
    const backup = env.manager.create({ kind: "pinned" });
    fs.rmSync(path.join(env.mediaDir, SID, "a.txt"));
    fs.writeFileSync(path.join(env.mediaDir, "other-0002", "b.txt"), "changed");
    fs.writeFileSync(path.join(env.mediaDir, SID, "later.txt"), "kept");

    assert.deepEqual(env.manager.restoreMedia(backup.id, { startupId: SID }), { restored: 1, listed: 1 });
    assert.equal(fs.readFileSync(path.join(env.mediaDir, SID, "a.txt"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(env.mediaDir, "other-0002", "b.txt"), "utf8"), "changed", "another startup is untouched");
    assert.equal(fs.readFileSync(path.join(env.mediaDir, SID, "later.txt"), "utf8"), "kept", "files the backup does not list stay");

    env.manager.restoreMedia(backup.id);
    assert.equal(fs.readFileSync(path.join(env.mediaDir, "other-0002", "b.txt"), "utf8"), "B");
  } finally {
    env.cleanup();
  }
});

test("a damaged media file fails verification and deleting a backup collects its media", () => {
  const env = setup();
  try {
    fs.writeFileSync(path.join(env.mediaDir, SID, "a.txt"), "A");
    const backup = env.manager.create({ kind: "pinned" });
    const [stored] = fs.readdirSync(path.join(env.backupDir, "media-store"));
    fs.writeFileSync(path.join(env.backupDir, "media-store", stored), "tampered");
    assert.equal(env.manager.verify(backup.id).ok, false);
    env.manager.remove(backup.id);
    assert.deepEqual(fs.readdirSync(path.join(env.backupDir, "media-store")), []);
    assert.throws(() => env.manager.find(backup.id), { code: "unknownBackup" });
    assert.throws(() => env.manager.find("../etc"), { code: "unknownBackup" });
  } finally {
    env.cleanup();
  }
});

test("a snapshot taken while the WAL holds commits has them", () => {
  const env = setup();
  try {
    for (let index = 0; index < 50; index += 1) env.write(index);
    const backup = env.manager.create({ kind: "pinned" });
    const copy = new TrackerSqliteStore(env.manager.databasePath(backup.id), { readOnly: true });
    try {
      assert.equal(copy.readSection(SID, "items").length, 51);
    } finally {
      copy.close();
    }
  } finally {
    env.cleanup();
  }
});

test("a missing or invalid keep count falls back to the default instead of deleting everything", () => {
  const env = setup({ automatic: undefined, safety: "nonsense" });
  try {
    assert.deepEqual({ ...env.manager.limits }, { automatic: 20, safety: 20 });
    env.manager.create({ kind: "automatic" });
    env.write(1);
    env.manager.create({ kind: "safety" });
    assert.equal(env.manager.list().length, 2, "both backups survive their own prune");
  } finally {
    env.cleanup();
  }
});

test("a backup named in protect survives the rotation its own safety backup triggers", () => {
  const env = setup({ safety: 1 });
  try {
    const restoring = env.manager.create({ kind: "safety", reason: "first" });
    env.write("p");
    const safety = env.manager.create({ kind: "safety", reason: "before restore", protect: [restoring.id] });
    const ids = env.manager.list().map((backup) => backup.id);
    assert.ok(ids.includes(restoring.id), "the backup being restored is kept");
    assert.ok(ids.includes(safety.id));
  } finally {
    env.cleanup();
  }
});

test("fresh media-store files and backups in progress are never collected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-grace-"));
  try {
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(path.join(backupDir, "media-store"), { recursive: true });
    const orphan = path.join(backupDir, "media-store", "a".repeat(64));
    fs.writeFileSync(orphan, "copied by another process");
    const careful = createBackupManager({ store: null, backupDir, mediaDir: path.join(root, "media") });
    careful.collectMedia();
    assert.ok(fs.existsSync(orphan), "inside the grace period");
    const eager = createBackupManager({ store: null, backupDir, mediaDir: path.join(root, "media"), mediaGraceMs: 0 });
    fs.mkdirSync(path.join(backupDir, ".creating-x"));
    eager.collectMedia();
    assert.ok(fs.existsSync(orphan), "while a backup is being written");
    fs.rmdirSync(path.join(backupDir, ".creating-x"));
    eager.collectMedia();
    assert.equal(fs.existsSync(orphan), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
