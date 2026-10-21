"use strict";

// Uploaded media files (lib/media-files.js, tools/media-orphans.js): a file
// stays while its record is in the bin, a copy goes to another startup
// without its links, and orphan files are listed, never deleted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { createStartup } = require("../lib/startups");
const mediaFiles = require("../lib/media-files");
const { purgeExpired } = require("../lib/recycle-bin");
const { findOrphans } = require("../tools/media-orphans");

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "media-files-"));
  const mediaDir = path.join(home, "media");
  const databaseFile = path.join(home, "data", "tracker.sqlite");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const store = new TrackerSqliteStore(databaseFile);
  const one = createStartup(store, { name: "One" }, { origin: "tool" }).id;
  const two = createStartup(store, { name: "Two" }, { origin: "tool" }).id;
  fs.mkdirSync(path.join(mediaDir, one), { recursive: true });
  const write = (name, text = "file") => fs.writeFileSync(path.join(mediaDir, one, name), text);
  write("live.png", "live");
  write("binned.png");
  write("old.png");
  write("stray.png", "nobody");
  write("company.pdf");
  const upload = (id, name, extra = {}) => ({ id, title: id, type: "screenshot", sourceType: "upload", storedName: name, filePath: `/media/${one}/${name}`, tags: ["launch"], ...extra });
  store.replaceState(one, {
    mediaItems: [upload("m-live", "live.png"), { id: "m-url", title: "Video", sourceType: "url", externalPath: "https://example.com/v.mp4" }],
    deletedMediaItems: [upload("m-binned", "binned.png", { deletedAt: new Date().toISOString() }), upload("m-old", "old.png", { deletedAt: "2026-01-01T00:00:00Z" })],
    companyProfile: { fields: { statute: "company.pdf" } },
    links: [{ id: "l1", a: { kind: "mk", id: "t1" }, b: { kind: "media", id: "m-live" }, relation: "uses" }],
  }, { origin: "tool" });
  return { home, mediaDir, databaseFile, store, one, two, cleanup: () => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

test("a copy takes the file and the details to the other startup, not the links", () => {
  const env = setup();
  try {
    const copy = mediaFiles.copyMediaItem({ store: env.store, mediaDir: env.mediaDir, fromStartupId: env.one, toStartupId: env.two, mediaId: "m-live" });
    assert.notEqual(copy.id, "m-live");
    assert.deepEqual(copy.copiedFrom, { startupId: env.one, id: "m-live" });
    assert.equal(copy.title, "m-live");
    assert.deepEqual(copy.tags, ["launch"]);
    assert.equal(fs.readFileSync(path.join(env.mediaDir, env.two, copy.storedName), "utf8"), "live");
    assert.equal(copy.filePath, `/media/${env.two}/${copy.storedName}`);
    const state = env.store.readState(env.two).state;
    assert.deepEqual(state.mediaItems.map((media) => media.id), [copy.id]);
    assert.equal(state.links, undefined, "links stay behind");
    // A second copy does not overwrite the first file.
    const again = mediaFiles.copyMediaItem({ store: env.store, mediaDir: env.mediaDir, fromStartupId: env.one, toStartupId: env.two, mediaId: "m-live" });
    assert.notEqual(again.storedName, copy.storedName);
    // A link-only item copies without a file.
    assert.equal(mediaFiles.copyMediaItem({ store: env.store, mediaDir: env.mediaDir, fromStartupId: env.one, toStartupId: env.two, mediaId: "m-url" }).storedName, undefined);
    assert.throws(() => mediaFiles.copyMediaItem({ store: env.store, mediaDir: env.mediaDir, fromStartupId: env.one, toStartupId: env.one, mediaId: "m-live" }), /another startup/);
    assert.throws(() => mediaFiles.copyMediaItem({ store: env.store, mediaDir: env.mediaDir, fromStartupId: env.one, toStartupId: env.two, mediaId: "nope" }), /not found/);
  } finally {
    env.cleanup();
  }
});

test("a file stays while anything names it, and goes once its record is deleted for good", () => {
  const env = setup();
  try {
    const exists = (name) => fs.existsSync(path.join(env.mediaDir, env.one, name));
    // Still in the bin, used by a live record, or named by a company document.
    assert.deepEqual(mediaFiles.removeUnusedFiles(env.store, env.mediaDir, env.one, ["binned.png", "live.png", "company.pdf", "../../etc/passwd"]), { removed: [], kept: ["binned.png", "live.png", "company.pdf"] });
    assert.ok(exists("binned.png") && exists("live.png") && exists("company.pdf"));
    // The retention clean-up purges the old record and reports its file.
    const purged = purgeExpired(env.store, { now: new Date("2026-10-17T12:00:00Z") });
    assert.deepEqual(purged.mediaFiles, [{ startupId: env.one, storedName: "old.png" }]);
    assert.deepEqual(mediaFiles.removeUnusedFiles(env.store, env.mediaDir, env.one, ["old.png"]).removed, ["old.png"]);
    assert.ok(!exists("old.png"));
  } finally {
    env.cleanup();
  }
});

test("the orphan list names unused files and folders of deleted startups, and deletes nothing", () => {
  const env = setup();
  try {
    fs.mkdirSync(path.join(env.mediaDir, "gone-0001"));
    env.store.close();
    const result = findOrphans({ argv: ["--data-dir", env.home], env: {} });
    assert.deepEqual(result.files.map((file) => file.name), ["stray.png"]);
    assert.equal(result.files[0].size, 6);
    assert.deepEqual(result.folders.map((folder) => folder.startupId), ["gone-0001"]);
    assert.ok(fs.existsSync(path.join(env.mediaDir, env.one, "stray.png")));
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});
