"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const startups = require("../lib/startups");
const { exportData, readImport, applyImport } = require("../lib/backups/transfer");
const { createZip } = require("../lib/backups/zip");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-"));
  const mediaDir = path.join(root, "media");
  const store = new TrackerSqliteStore(path.join(root, "tracker.sqlite"));
  const source = startups.createStartup(store, { name: "Northwind" });
  store.replaceState(source.id, {
    items: [{ id: "a", platform: "Forum", attachment: `/media/${source.id}/deck.pdf` }, { id: "b", platform: "Blog" }],
    programs: [{ id: "p", name: "Accelerator" }],
    profile: { oneLiner: "Robots for warehouses" },
  }, { origin: "tool" });
  store.replaceSection(GLOBAL_STARTUP_ID, "tags", [{ id: "t1", label: "launch" }], { origin: "tool" });
  fs.mkdirSync(path.join(mediaDir, source.id, "docs"), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, source.id, "deck.pdf"), "pdf");
  fs.writeFileSync(path.join(mediaDir, source.id, "docs", "notes.md"), "# notes");
  return {
    root, mediaDir, store, source,
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a zip export imports as a new startup with the same records and media", () => {
  const env = setup();
  try {
    const exported = exportData(env.store, { startupIds: [env.source.id], mediaDir: env.mediaDir, appVersion: "0.1.0" });
    assert.equal(exported.extension, "zip");
    const imported = readImport(exported.data);
    assert.deepEqual(imported.preview, [{ id: env.source.id, name: "Northwind", sections: { items: 2, programs: 1, profile: null }, mediaFiles: 2 }]);
    assert.deepEqual(imported.global.tags, [{ id: "t1", label: "launch" }]);

    const result = applyImport(env.store, imported, { mode: "new", mediaDir: env.mediaDir });
    const copyId = result.startups[0].id;
    assert.notEqual(copyId, env.source.id);
    const copy = env.store.readState(copyId).state;
    const original = env.store.readState(env.source.id).state;
    assert.equal(copy.items.length, original.items.length);
    assert.equal(copy.items[0].attachment, `/media/${copyId}/deck.pdf`, "media links follow the new startup");
    assert.deepEqual(copy.programs, original.programs);
    assert.equal(fs.readFileSync(path.join(env.mediaDir, copyId, "docs", "notes.md"), "utf8"), "# notes");
    assert.deepEqual(env.store.readSection(GLOBAL_STARTUP_ID, "tags"), [{ id: "t1", label: "launch" }], "global settings are never overwritten");
  } finally {
    env.cleanup();
  }
});

test("a JSON export round-trips without media and can replace a startup", () => {
  const env = setup();
  try {
    const exported = exportData(env.store, { startupIds: [env.source.id], format: "json" });
    const imported = readImport(exported.data);
    assert.equal(imported.startups[0].media.length, 0);
    const target = startups.createStartup(env.store, { name: "Target" });
    env.store.replaceState(target.id, { items: [{ id: "x", platform: "Old" }] }, { origin: "tool" });
    const other = startups.createStartup(env.store, { name: "Bystander" });
    env.store.replaceState(other.id, { items: [{ id: "a", platform: "Untouched" }] }, { origin: "tool" });
    const before = JSON.stringify(env.store.readState(other.id).state);

    applyImport(env.store, imported, { mode: "replace", targetStartupId: target.id });
    assert.deepEqual(env.store.readSection(target.id, "items").map((item) => item.id), ["a", "b"]);
    assert.equal(JSON.stringify(env.store.readState(other.id).state), before);
  } finally {
    env.cleanup();
  }
});

test("exports of several startups list each one, and replace needs exactly one", () => {
  const env = setup();
  try {
    const second = startups.createStartup(env.store, { name: "Second" });
    const exported = exportData(env.store, { startupIds: [env.source.id, second.id], mediaDir: env.mediaDir });
    const imported = readImport(exported.data);
    assert.equal(imported.preview.length, 2);
    assert.throws(() => applyImport(env.store, imported, { mode: "replace", targetStartupId: second.id }), { code: "needsOneStartup" });
  } finally {
    env.cleanup();
  }
});

test("exports leave out what omit removes and never contain the secrets folder", () => {
  const env = setup();
  try {
    fs.mkdirSync(path.join(env.root, "secrets"));
    fs.writeFileSync(path.join(env.root, "secrets", "api-token"), "secret");
    const exported = exportData(env.store, {
      startupIds: [env.source.id],
      mediaDir: env.mediaDir,
      omit: (startupId, section, value) => (section === "profile" ? {} : value),
    });
    assert.equal(exported.data.includes(Buffer.from("secret")), false);
    assert.equal(exported.data.includes(Buffer.from("Robots for warehouses")), false);
  } finally {
    env.cleanup();
  }
});

test("bad imports are refused before anything changes", () => {
  const manifest = { format: "startup-tracker-export", formatVersion: 1, startups: [{ id: "x-0001", name: "X" }] };
  const zipOf = (entries) => createZip(entries.map(([name, data]) => ({ name, data: typeof data === "string" ? data : JSON.stringify(data) })));
  assert.throws(() => readImport(Buffer.from("{}")), { code: "notExport" });
  assert.throws(() => readImport(Buffer.from("not json")), { code: "badJson" });
  assert.throws(() => readImport(zipOf([["manifest.json", { ...manifest, formatVersion: 9 }]])), { code: "formatVersion" });
  assert.throws(() => readImport(zipOf([["manifest.json", manifest]])), { code: "incomplete" });
  assert.throws(() => readImport(zipOf([
    ["manifest.json", manifest],
    ["startups/x-0001/startup.json", { id: "x-0001", name: "X" }],
    ["startups/x-0001/sections/items.json", [{ platform: "no id" }]],
  ])), { code: "badRecord" });
  assert.throws(() => readImport(zipOf([
    ["manifest.json", { ...manifest, startups: [{ id: "../../x", name: "X" }] }],
  ])), { code: "badStartupId" });
});
