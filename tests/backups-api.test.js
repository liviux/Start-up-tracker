"use strict";

// The HTTP side of settings, backups, restores, export and import, the
// recycle-bin clean-up and the About facts. Every test runs its own server on
// a throwaway data folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { GLOBAL_STARTUP_ID, SCHEMA_VERSION, TrackerSqliteStore, verifyDatabaseFile } = require("../lib/tracker-sqlite-store");
const startupsLib = require("../lib/startups");
const { startServer, makeTempHome } = require("./helpers/server");
const { handMadeZip } = require("./helpers/zip");
const { browserFetch, sendJson, createStartup, saveOperations, uploadFile, seedStartup } = require("./helpers/api");

const DAY_MS = 24 * 60 * 60 * 1000;
const SQLITE_MAGIC = "SQLite format 3\0";

async function save(serverUrl, startupId, operations, extra) {
  const response = await saveOperations(serverUrl, startupId, operations, extra);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

// A new startup holds no sections, so its first write creates them.
function fillSections(serverUrl, startupId, sections) {
  return save(serverUrl, startupId, Object.entries(sections).map(([section, value]) => ({ type: "replaceSection", section, value, baseRevision: 0 })));
}

async function readState(serverUrl, startupId, headers = {}) {
  const response = await browserFetch(`${serverUrl}api/s/${startupId}/state`, { headers });
  assert.equal(response.status, 200);
  return { response, payload: await response.json() };
}

// The state answer without what a restore is allowed to move.
function withoutRevisions(payload) {
  const { revision: _revision, revisionMap: _revisionMap, fileHash: _fileHash, ...rest } = payload;
  return rest;
}

async function listStartups(serverUrl) {
  return (await (await browserFetch(`${serverUrl}api/startups`)).json()).startups;
}

async function listBackups(serverUrl, startupId = "") {
  const response = await browserFetch(`${serverUrl}api/backups${startupId ? `?startupId=${startupId}` : ""}`);
  assert.equal(response.status, 200);
  return (await response.json()).backups;
}

async function takeBackup(serverUrl, label) {
  const response = await sendJson(`${serverUrl}api/backups`, "POST", label === undefined ? {} : { label });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload.backup;
}

async function restore(serverUrl, backupId, body) {
  const response = await sendJson(`${serverUrl}api/backups/${backupId}/restore`, "POST", body);
  return { status: response.status, payload: await response.json() };
}

async function prepareImport(serverUrl, data, contentType) {
  const response = await browserFetch(`${serverUrl}api/import`, { method: "POST", headers: { "Content-Type": contentType }, body: data });
  return { status: response.status, payload: await response.json() };
}

async function applyImport(serverUrl, token, body) {
  const response = await sendJson(`${serverUrl}api/import/${token}/apply`, "POST", body);
  return { status: response.status, payload: await response.json() };
}

async function download(serverUrl, route) {
  const response = await browserFetch(`${serverUrl}${route}`);
  assert.equal(response.status, 200, route);
  return { response, data: Buffer.from(await response.arrayBuffer()) };
}

test("settings come back complete, merge one level deep and name the field they refuse", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const first = await (await browserFetch(`${url}api/settings`)).json();
    assert.deepEqual(first.settings, first.defaults, "nothing stored yet: the defaults");
    assert.equal(first.defaults.appName, "Startup Tracker");
    assert.equal(first.defaults.pageSize, 25);
    assert.deepEqual(first.defaults.appearance, { mode: "system", theme: "studio" });
    assert.deepEqual(first.defaults.backups, { automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 20 });
    assert.deepEqual(first.defaults.recycleBin, { retentionDays: 30 });
    assert.equal(typeof first.revision, "number");

    const patch = async (settings) => {
      const response = await sendJson(`${url}api/settings`, "PATCH", { settings });
      return { status: response.status, payload: await response.json() };
    };

    // Only the keys sent change, and objects merge one level deep.
    const backups = await patch({ backups: { keepSafety: 5 } });
    assert.equal(backups.status, 200);
    assert.deepEqual(backups.payload.settings, { ...first.defaults, backups: { automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 5 } });
    assert.ok(backups.payload.revision > first.revision);
    const appearance = await patch({ appearance: { mode: "dark" }, yourName: "  Sam   Doe " });
    assert.deepEqual(appearance.payload.settings.appearance, { mode: "dark", theme: "studio" });
    assert.equal(appearance.payload.settings.yourName, "Sam Doe");
    assert.deepEqual(appearance.payload.settings.backups, { automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 5 }, "an earlier change stays");
    assert.equal((await patch({ recycleBin: { retentionDays: null } })).payload.settings.recycleBin.retentionDays, null);
    const good = (await (await browserFetch(`${url}api/settings`)).json()).settings;
    assert.deepEqual(good, { ...first.defaults, appearance: { mode: "dark", theme: "studio" }, yourName: "Sam Doe", backups: { automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 5 }, recycleBin: { retentionDays: null } });

    for (const [settings, field] of [
      [{ pageSize: 5 }, "pageSize"],
      [{ appName: "" }, "appName"],
      [{ timeZone: "Mars/Olympus_Mons" }, "timeZone"],
      [{ network: "yes" }, "network"],
      [{ nope: 1 }, "nope"],
      [{ backups: { keepSafety: 0 } }, "backups.keepSafety"],
      [{ backups: { keepForever: 3 } }, "backups.keepForever"],
      [{ appearance: { theme: "neon" } }, "appearance.theme"],
      [{ recycleBin: { retentionDays: 3 } }, "recycleBin.retentionDays"],
      // A bad key refuses the whole change, the good keys beside it included.
      [{ appName: "Fine", pageSize: 1000 }, "pageSize"],
    ]) {
      const refused = await patch(settings);
      assert.equal(refused.status, 400, JSON.stringify(settings));
      assert.equal(refused.payload.code, "badSetting");
      assert.ok(refused.payload.error.startsWith(`${field}:`), `${refused.payload.error} names ${field}`);
    }
    const missing = await sendJson(`${url}api/settings`, "PATCH", {});
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /^settings:/);
    assert.deepEqual((await (await browserFetch(`${url}api/settings`)).json()).settings, good, "refused changes wrote nothing");
  } finally {
    await server.stop();
  }
});

test("a pinned backup is listed with counts per startup, and unchanged data is not backed up again", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    await fillSections(url, alpha.id, { items: [{ id: "a1" }, { id: "a2" }], programs: [{ id: "p1" }], profile: { pitch: "Not counted" } });
    await fillSections(url, beta.id, { items: [{ id: "b1" }] });

    const pinned = await takeBackup(url, "Before launch!");
    assert.equal(pinned.kind, "pinned");
    assert.equal(pinned.label, "Before-launch");
    assert.equal(pinned.reason, "requested");
    assert.equal(pinned.skipped, false);
    assert.equal(pinned.complete, true);
    assert.ok(pinned.databaseBytes > 0);
    assert.deepEqual(pinned.startups.map((entry) => entry.name).sort(), ["Alpha", "Beta"]);

    const [listedForAlpha] = await listBackups(url, alpha.id);
    assert.equal(listedForAlpha.id, pinned.id);
    assert.deepEqual(listedForAlpha.counts, { items: 2, programs: 1 });
    assert.deepEqual((await listBackups(url, beta.id))[0].counts, { items: 1 });
    assert.equal((await listBackups(url))[0].counts, undefined, "counts only for a named startup");
    assert.equal((await browserFetch(`${url}api/backups?startupId=nope-0000`)).status, 404);

    // A pinned backup is taken whenever asked for, changed data or not.
    const second = await takeBackup(url);
    assert.notEqual(second.id, pinned.id);
    assert.equal(second.skipped, false);
    assert.match(second.id, /^\d{8}-\d{6}-\d{3}-pinned$/);

    // A safety backup of data that has not changed is not taken: the newest
    // backup already holds it and stands in.
    const restored = await restore(url, pinned.id, { scope: "startup", startupId: alpha.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.payload));
    assert.equal(restored.payload.restored.safetyBackup, second.id);
    assert.deepEqual((await listBackups(url)).map((backup) => backup.kind), ["pinned", "pinned"]);
  } finally {
    await server.stop();
  }
});

test("a backup verifies, downloads as a database that verifies, and can be deleted", async () => {
  const server = await startServer();
  const url = server.url;
  const backupDir = path.join(server.home, "backups");
  try {
    const startup = await createStartup(url, "Keeper");
    await fillSections(url, startup.id, { items: [{ id: "k1", title: "Kept" }] });
    assert.equal((await uploadFile(url, startup.id, "only-here.txt", "only in this backup")).status, 200);
    const backup = await takeBackup(url, "to-delete");
    assert.equal(backup.mediaFiles, 1);
    assert.equal(backup.mediaBytes, "only in this backup".length);

    const verified = await (await sendJson(`${url}api/backups/${backup.id}/verify`, "POST")).json();
    assert.equal(verified.verified, true);
    assert.deepEqual(verified.problems, []);

    // A damaged media copy is found by the full check.
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, backup.id, "media-manifest.json"), "utf8"));
    const stored = path.join(backupDir, "media-store", manifest.files[0].sha256);
    const original = fs.readFileSync(stored);
    fs.writeFileSync(stored, "tampered");
    const damaged = await (await sendJson(`${url}api/backups/${backup.id}/verify`, "POST")).json();
    assert.equal(damaged.verified, false);
    assert.match(damaged.problems.join("\n"), /Damaged media file: .*only-here\.txt/);
    fs.writeFileSync(stored, original);

    const { response, data } = await download(url, `api/backups/${backup.id}/download`);
    assert.equal(response.headers.get("content-type"), "application/vnd.sqlite3");
    assert.match(response.headers.get("content-disposition"), /^attachment; filename="startup-tracker-.+\.sqlite"$/);
    assert.equal(data.subarray(0, SQLITE_MAGIC.length).toString("binary"), SQLITE_MAGIC);
    const downloaded = path.join(server.home, "downloaded.sqlite");
    fs.writeFileSync(downloaded, data);
    assert.equal(verifyDatabaseFile(downloaded).ok, true);
    const copy = new TrackerSqliteStore(downloaded, { readOnly: true });
    try {
      assert.deepEqual(copy.readState(startup.id).state.items, [{ id: "k1", title: "Kept" }]);
    } finally {
      copy.close();
    }

    const removed = await browserFetch(`${url}api/backups/${backup.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).id, backup.id);
    assert.deepEqual(await listBackups(url), []);
    assert.equal(fs.existsSync(path.join(backupDir, backup.id)), false);
    // The media store keeps unlisted files for a grace period (another process
    // may be mid-backup), so its clean-up is tested in backup-manager.test.js.
    // The live media file is not touched.
    assert.ok(fs.readdirSync(path.join(server.home, "media", startup.id)).some((name) => name.endsWith("only-here.txt")));

    for (const [method, route] of [["DELETE", ""], ["POST", "/verify"], ["GET", "/download"]]) {
      assert.equal((await browserFetch(`${url}api/backups/${backup.id}${route}`, { method })).status, 404, `${method} ${route}`);
    }
  } finally {
    await server.stop();
  }
});

test("compare lists the records a restore would add, remove and change", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Compared");
    const other = await createStartup(url, "Other");
    await fillSections(url, startup.id, {
      items: [{ id: "a", title: "Only in the backup" }, { id: "b", title: "Before" }, { id: "c", title: "Same" }],
      profile: { pitch: "Old pitch" },
    });
    const backup = await takeBackup(url);
    const { payload } = await readState(url, startup.id);
    const base = (id) => payload.revisionMap.records.items[id];
    await save(url, startup.id, [
      { type: "delete", section: "items", id: "a", baseRevision: base("a") },
      { type: "upsert", section: "items", id: "b", value: { id: "b", title: "After" }, baseRevision: base("b") },
      { type: "upsert", section: "items", id: "d", value: { id: "d", title: "Only now" }, baseRevision: 0 },
      { type: "replaceSection", section: "profile", value: { pitch: "New pitch" }, baseRevision: payload.revisionMap.sections.profile },
    ]);

    const response = await browserFetch(`${url}api/backups/${backup.id}/compare?startupId=${startup.id}`);
    assert.equal(response.status, 200);
    const compared = await response.json();
    assert.equal(compared.truncated, false);
    const items = compared.sections.find((entry) => entry.section === "items");
    assert.deepEqual(items, { section: "items", current: 3, backup: 3, added: 1, removed: 1, changed: 1 });
    assert.equal(compared.sections.find((entry) => entry.section === "profile").changed, 1);
    assert.deepEqual(
      compared.records.map(({ section, id, change }) => `${change} ${section}/${id}`).sort(),
      ["added items/a", "changed items/b", "changed profile/null", "removed items/d"],
    );
    assert.equal(compared.records.find((entry) => entry.id === "a").title, "Only in the backup");

    // Comparing changes nothing, and another startup compares as unchanged.
    assert.deepEqual((await readState(url, startup.id)).payload.state.items.map((item) => item.id), ["b", "c", "d"]);
    const untouched = await (await browserFetch(`${url}api/backups/${backup.id}/compare?startupId=${other.id}`)).json();
    assert.deepEqual(untouched.records, []);
    assert.equal((await browserFetch(`${url}api/backups/${backup.id}/compare?startupId=nope-0000`)).status, 404);
    assert.equal((await browserFetch(`${url}api/backups/${backup.id}/compare`)).status, 404);
  } finally {
    await server.stop();
  }
});

test("restoring one startup leaves every other startup as it was and brings its media back", async () => {
  const server = await startServer();
  const url = server.url;
  const mediaDir = path.join(server.home, "media");
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    await fillSections(url, alpha.id, { items: [{ id: "a1", title: "Alpha as backed up" }], profile: { pitch: "Backed up" } });
    await fillSections(url, beta.id, { items: [{ id: "b1", title: "Beta" }] });
    const alphaUpload = await (await uploadFile(url, alpha.id, "deck.pdf", "alpha deck")).json();
    assert.equal((await uploadFile(url, beta.id, "beta.txt", "beta file")).status, 200);
    const backup = await takeBackup(url);
    const backedUp = withoutRevisions((await readState(url, alpha.id)).payload);

    // Alpha changes after the backup: a record, a lost upload and a new one.
    const { payload: alphaNow } = await readState(url, alpha.id);
    await save(url, alpha.id, [
      { type: "upsert", section: "items", id: "a1", value: { id: "a1", title: "Edited" }, baseRevision: alphaNow.revisionMap.records.items.a1 },
      { type: "upsert", section: "items", id: "a2", value: { id: "a2" }, baseRevision: 0 },
    ]);
    fs.rmSync(alphaUpload.absolutePath);
    const later = await (await uploadFile(url, alpha.id, "later.txt", "made after the backup")).json();

    const { response: betaResponse, payload: betaBefore } = await readState(url, beta.id);
    const betaEtag = betaResponse.headers.get("etag");

    const restored = await restore(url, backup.id, { scope: "startup", startupId: alpha.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.payload));
    assert.equal(restored.payload.restored.scope, "startup");
    assert.equal(restored.payload.restored.startupId, alpha.id);
    assert.equal(restored.payload.restored.media.restored, 1);

    // Alpha is as the backup holds it, its upload included.
    const alphaAfter = (await readState(url, alpha.id)).payload;
    assert.deepEqual(withoutRevisions(alphaAfter), backedUp);
    assert.ok(alphaAfter.revision > alphaNow.revision, "the revision moves on, so open pages reload");
    assert.equal(fs.readFileSync(alphaUpload.absolutePath, "utf8"), "alpha deck");
    assert.equal(fs.readFileSync(later.absolutePath, "utf8"), "made after the backup", "files the backup does not list are kept");

    // Beta did not move at all.
    assert.equal((await browserFetch(`${url}api/s/${beta.id}/state`, { headers: { "If-None-Match": betaEtag } })).status, 304);
    assert.equal(JSON.stringify((await readState(url, beta.id)).payload), JSON.stringify(betaBefore));
    assert.equal(fs.readFileSync(path.join(mediaDir, beta.id, fs.readdirSync(path.join(mediaDir, beta.id))[0]), "utf8"), "beta file");

    // What the restore replaced is in a safety backup.
    const safety = (await listBackups(url)).find((entry) => entry.id === restored.payload.restored.safetyBackup);
    assert.equal(safety.kind, "safety");
    assert.match(safety.reason, new RegExp(`before restoring ${alpha.id} from ${backup.id}`));
    const safetyStore = new TrackerSqliteStore(path.join(server.home, "backups", safety.id, "tracker.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(safetyStore.readState(alpha.id).state.items.map((item) => item.title), ["Edited", undefined]);
    } finally {
      safetyStore.close();
    }

    // A startup neither side has, or an unusable id, is refused.
    assert.equal((await restore(url, backup.id, { scope: "startup", startupId: "nope-0000" })).status, 404);
    assert.equal((await restore(url, backup.id, { scope: "startup", startupId: "../etc" })).status, 400);
    assert.equal((await restore(url, backup.id, { scope: "startup" })).status, 400);
  } finally {
    await server.stop();
  }
});

test("restoring the whole database brings back a deleted startup and removes a newer one", async () => {
  const server = await startServer();
  const url = server.url;
  const backupDir = path.join(server.home, "backups");
  try {
    const old = await createStartup(url, "Old");
    await fillSections(url, old.id, { items: [{ id: "o1", title: "Old record" }] });
    const upload = await (await uploadFile(url, old.id, "old.txt", "old media")).json();
    await sendJson(`${url}api/global/operations`, "PATCH", { operations: [{ type: "replaceSection", section: "appearance", value: { theme: "light" } }] });
    const backup = await takeBackup(url, "before-cleanup");

    assert.equal((await browserFetch(`${url}api/startups/${old.id}`, { method: "DELETE" })).status, 200);
    assert.equal(fs.existsSync(upload.absolutePath), false);
    const newer = await createStartup(url, "Newer");
    await fillSections(url, newer.id, { items: [{ id: "n1", title: "Newer record" }] });
    await sendJson(`${url}api/global/operations`, "PATCH", { operations: [{ type: "replaceSection", section: "appearance", value: { theme: "dark" } }] });

    const listed = (await listBackups(url)).find((entry) => entry.id === backup.id);
    assert.equal(listed.complete, true);
    assert.deepEqual(listed.startups, [{ id: old.id, name: "Old" }]);

    const restored = await restore(url, backup.id, { scope: "database" });
    assert.equal(restored.status, 200, JSON.stringify(restored.payload));
    assert.equal(restored.payload.restored.scope, "database");
    const safety = (await listBackups(url)).find((entry) => entry.id === restored.payload.restored.safetyBackup);
    assert.equal(safety.kind, "safety");

    // The safety backup holds what the restore replaced.
    const undo = new TrackerSqliteStore(path.join(backupDir, safety.id, "tracker.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(undo.readState(newer.id).state.items, [{ id: "n1", title: "Newer record" }]);
    } finally {
      undo.close();
    }

    assert.deepEqual((await listStartups(url)).map((startup) => startup.id), [old.id]);
    assert.deepEqual((await readState(url, old.id)).payload.state.items, [{ id: "o1", title: "Old record" }]);
    assert.equal(fs.readFileSync(upload.absolutePath, "utf8"), "old media", "the deleted startup's media comes back");
    assert.equal((await browserFetch(`${url}api/s/${newer.id}/state`)).status, 404);
    assert.deepEqual((await (await browserFetch(`${url}api/global`)).json()).state.appearance, { theme: "light" });
    const home = await browserFetch(url, { redirect: "manual" });
    assert.equal(home.headers.get("location"), `/s/${old.id}/`);
  } finally {
    await server.stop();
  }
});

test("restoring records puts them back as the backup has them and takes them out of the recycle bin", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Records");
    await fillSections(url, startup.id, {
      items: [{ id: "r1", title: "Binned later" }, { id: "r2", title: "Edited later" }, { id: "r3", title: "Untouched" }],
      deletedItems: [],
    });
    const backup = await takeBackup(url);

    // r1 goes to the recycle bin, r2 is edited and r4 is new.
    const { payload } = await readState(url, startup.id);
    const base = (id) => payload.revisionMap.records.items[id];
    await save(url, startup.id, [
      { type: "delete", section: "items", id: "r1", baseRevision: base("r1") },
      { type: "upsert", section: "deletedItems", id: "r1", value: { id: "r1", title: "Binned later", deletedAt: new Date().toISOString() }, baseRevision: 0 },
      { type: "upsert", section: "items", id: "r2", value: { id: "r2", title: "Edited after the backup" }, baseRevision: base("r2") },
      { type: "upsert", section: "items", id: "r4", value: { id: "r4", title: "New" }, baseRevision: 0 },
    ]);

    const restored = await restore(url, backup.id, { scope: "records", startupId: startup.id, records: [{ section: "items", id: "r1" }] });
    assert.equal(restored.status, 200, JSON.stringify(restored.payload));
    assert.deepEqual(restored.payload.restored.records, [{ section: "items", id: "r1", change: "added" }]);
    const state = (await readState(url, startup.id)).payload.state;
    assert.deepEqual(state.items.find((item) => item.id === "r1"), { id: "r1", title: "Binned later" });
    assert.deepEqual(state.deletedItems, [], "no second copy is left in the bin");
    assert.equal(state.items.find((item) => item.id === "r2").title, "Edited after the backup", "records not listed stay as they are");
    assert.ok(state.items.some((item) => item.id === "r4"));
    const safety = (await listBackups(url)).find((entry) => entry.id === restored.payload.restored.safetyBackup);
    assert.equal(safety.kind, "safety");

    // A record the backup does not have is removed when listed.
    const removed = await restore(url, backup.id, { scope: "records", startupId: startup.id, records: [{ section: "items", id: "r4" }] });
    assert.deepEqual(removed.payload.restored.records, [{ section: "items", id: "r4", change: "removed" }]);
    assert.equal((await readState(url, startup.id)).payload.state.items.some((item) => item.id === "r4"), false);

    assert.equal((await restore(url, backup.id, { scope: "records", startupId: startup.id, records: [] })).status, 400);
    assert.equal((await restore(url, backup.id, { scope: "records", startupId: startup.id, records: [{ section: "items" }] })).status, 400);
    assert.equal((await restore(url, backup.id, { scope: "records", startupId: "nope-0000", records: [{ section: "items", id: "r1" }] })).status, 404);
  } finally {
    await server.stop();
  }
});

test("the safety backup taken before a restore never rotates away the backup being restored", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Rotated");
    await fillSections(url, startup.id, { items: [{ id: "r", title: "Version 1" }] });
    const settings = await sendJson(`${url}api/settings`, "PATCH", { settings: { backups: { keepSafety: 1 } } });
    assert.equal(settings.status, 200);

    // Deleting another startup leaves the only safety backup there is.
    const doomed = await createStartup(url, "Doomed");
    const deleted = await (await browserFetch(`${url}api/startups/${doomed.id}`, { method: "DELETE" })).json();
    const safety = (await listBackups(url)).find((entry) => entry.id === deleted.safetyBackup);
    assert.equal(safety.kind, "safety");

    const { payload } = await readState(url, startup.id);
    await save(url, startup.id, [{ type: "upsert", section: "items", id: "r", value: { id: "r", title: "Version 2" }, baseRevision: payload.revisionMap.records.items.r }]);

    // Restoring from it takes a new safety backup. With room for one, that
    // would push out the backup being restored, unless it is protected.
    const restored = await restore(url, safety.id, { scope: "startup", startupId: startup.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.payload));
    assert.notEqual(restored.payload.restored.safetyBackup, safety.id);
    const listed = await listBackups(url);
    assert.ok(listed.some((entry) => entry.id === safety.id), "the restored backup is still listed");
    assert.ok(listed.some((entry) => entry.id === restored.payload.restored.safetyBackup), "and so is the new safety backup");
    assert.equal((await readState(url, startup.id)).payload.state.items[0].title, "Version 1");
    assert.equal((await sendJson(`${url}api/backups/${safety.id}/verify`, "POST")).status, 200);

    // Rotation still applies afterwards: the next safety backup leaves one.
    const again = await createStartup(url, "Again");
    assert.equal((await browserFetch(`${url}api/startups/${again.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await listBackups(url)).filter((entry) => entry.kind === "safety").length, 1);
  } finally {
    await server.stop();
  }
});

// Changes nothing when the safety backup fails: the restore and the import
// both stop before they touch the data.
async function assertNothingChangesWithoutSafety(url, startup, backup, pendingImport) {
  const before = await readState(url, startup.id);
  const backupsBefore = (await listBackups(url)).map((entry) => entry.id);
  for (const body of [{ scope: "startup", startupId: startup.id }, { scope: "database" }, { scope: "records", startupId: startup.id, records: [{ section: "items", id: "s1" }] }]) {
    const refused = await restore(url, backup.id, body);
    assert.equal(refused.status, 500, JSON.stringify(refused.payload));
    assert.equal(refused.payload.code, "safetyBackupFailed");
  }
  const refusedImport = await applyImport(url, pendingImport, { mode: "new" });
  assert.equal(refusedImport.status, 500);
  assert.equal(refusedImport.payload.code, "safetyBackupFailed");
  const refusedDelete = await browserFetch(`${url}api/startups/${startup.id}`, { method: "DELETE" });
  assert.equal(refusedDelete.status, 500);

  const after = await browserFetch(`${url}api/s/${startup.id}/state`, { headers: { "If-None-Match": before.response.headers.get("etag") } });
  assert.equal(after.status, 304, "the startup did not change");
  assert.deepEqual((await listStartups(url)).map((entry) => entry.id), [startup.id], "no startup was added or removed");
  assert.deepEqual((await listBackups(url)).map((entry) => entry.id), backupsBefore);
}

async function setUpUnsafeRestore(url) {
  const startup = await createStartup(url, "Unsafe");
  await fillSections(url, startup.id, { items: [{ id: "s1", title: "Backed up" }] });
  const backup = await takeBackup(url);
  const { payload } = await readState(url, startup.id);
  await save(url, startup.id, [{ type: "upsert", section: "items", id: "s1", value: { id: "s1", title: "Changed since" }, baseRevision: payload.revisionMap.records.items.s1 }]);
  // A new upload, so the safety backup has a media file to store.
  assert.equal((await uploadFile(url, startup.id, "new.txt", "new since the backup")).status, 200);
  const exported = await download(url, `api/s/${startup.id}/export?format=json`);
  const prepared = await prepareImport(url, exported.data, "application/json");
  assert.equal(prepared.status, 200);
  return { startup, backup, token: prepared.payload.token };
}

// Folder permissions are the lever here; the next test reaches the same
// failure through a file in the way, which works for root and on Windows.
test("a restore or import whose safety backup cannot be written changes nothing", { skip: process.getuid?.() === 0 ? "root ignores folder permissions" : process.platform === "win32" ? "Windows ignores POSIX folder modes" : false }, async () => {
  const server = await startServer();
  const backupDir = path.join(server.home, "backups");
  try {
    const { startup, backup, token } = await setUpUnsafeRestore(server.url);
    fs.chmodSync(backupDir, 0o500);
    try {
      await assertNothingChangesWithoutSafety(server.url, startup, backup, token);
    } finally {
      fs.chmodSync(backupDir, 0o700);
    }
  } finally {
    await server.stop();
  }
});

test("a restore or import whose safety backup cannot store its media changes nothing", async () => {
  // Works for root too: the media store is a file, so no media can be copied.
  const server = await startServer();
  const mediaStore = path.join(server.home, "backups", "media-store");
  const moved = `${mediaStore}.away`;
  try {
    const { startup, backup, token } = await setUpUnsafeRestore(server.url);
    // The backup held no media, so the store may not exist yet.
    const hadStore = fs.existsSync(mediaStore);
    if (hadStore) fs.renameSync(mediaStore, moved);
    fs.writeFileSync(mediaStore, "not a folder");
    try {
      await assertNothingChangesWithoutSafety(server.url, startup, backup, token);
    } finally {
      fs.rmSync(mediaStore, { force: true });
      if (hadStore) fs.renameSync(moved, mediaStore);
    }
  } finally {
    await server.stop();
  }
});

test("a zip export imports as a new startup with the same records and media", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const source = await createStartup(url, "Northwind");
    const upload = await (await uploadFile(url, source.id, "deck.pdf", "%PDF-1.4 northwind")).json();
    await fillSections(url, source.id, {
      items: [{ id: "a", platform: "Forum", attachment: upload.path }, { id: "b", platform: "Blog" }],
      programs: [{ id: "p", name: "Accelerator" }],
      profile: { pitch: "Robots for warehouses" },
    });

    const { response, data } = await download(url, `api/s/${source.id}/export?format=zip`);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("content-disposition"), new RegExp(`^attachment; filename="startup-tracker-${source.id}-\\d{8}-\\d{6}\\.zip"$`));
    assert.equal(data.subarray(0, 4).toString("binary"), "PK\x03\x04");
    assert.equal((await browserFetch(`${url}api/s/${source.id}/export?format=pdf`)).status, 400);

    const prepared = await prepareImport(url, data, "application/zip");
    assert.equal(prepared.status, 200, JSON.stringify(prepared.payload));
    assert.equal(prepared.payload.kind, "export");
    assert.match(prepared.payload.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(prepared.payload.preview.startups, [{ id: source.id, name: "Northwind", sections: { items: 2, programs: 1, profile: null }, mediaFiles: 1, unmappedStatuses: [] }]);
    assert.equal((await listStartups(url)).length, 1, "a preview changes nothing");

    const applied = await applyImport(url, prepared.payload.token, { mode: "new" });
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));
    const [copy] = applied.payload.imported.startups;
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.name, "Northwind");
    assert.equal(copy.mediaWritten, 1);
    assert.equal((await listBackups(url)).find((entry) => entry.id === applied.payload.imported.safetyBackup).kind, "safety");

    const counted = new Map((await (await browserFetch(`${url}api/startups?counts=1`)).json()).startups.map((entry) => [entry.id, entry]));
    assert.equal(counted.get(copy.id).recordCount, counted.get(source.id).recordCount);
    assert.equal(counted.get(copy.id).recordCount, 3);
    assert.equal(counted.get(copy.id).mediaBytes, counted.get(source.id).mediaBytes);

    // Links to uploads follow the startup, and lead to the copied file.
    const copied = (await readState(url, copy.id)).payload.state;
    assert.equal(copied.items[0].attachment, `/media/${copy.id}/${encodeURIComponent(upload.storedName)}`);
    assert.equal(await (await browserFetch(`${url}${copied.items[0].attachment.slice(1)}`)).text(), "%PDF-1.4 northwind");
    assert.deepEqual(copied.profile, { pitch: "Robots for warehouses" });

    // A token is used once.
    const again = await applyImport(url, prepared.payload.token, { mode: "new" });
    assert.equal(again.status, 404);
    assert.equal(again.payload.code, "importExpired");
    assert.equal((await listStartups(url)).length, 2);
  } finally {
    await server.stop();
  }
});

test("a json export replaces a startup with what it held", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Replaced");
    const other = await createStartup(url, "Other");
    await fillSections(url, startup.id, { items: [{ id: "x1", title: "Exported" }], profile: { pitch: "Exported pitch" } });
    await fillSections(url, other.id, { items: [{ id: "o1" }] });
    const exportedState = (await readState(url, startup.id)).payload.state;

    const { response, data } = await download(url, `api/s/${startup.id}/export?format=json`);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = JSON.parse(data.toString("utf8"));
    assert.equal(body.manifest.format, "startup-tracker-export");
    assert.equal(body.manifest.includesMedia, false);

    // Several startups at once, in either format.
    const both = await download(url, `api/export?format=json&startups=${startup.id},${other.id}`);
    assert.deepEqual(JSON.parse(both.data.toString("utf8")).startups.map((entry) => entry.startup.id), [startup.id, other.id]);
    assert.equal((await browserFetch(`${url}api/export?format=json&startups=nope-0000`)).status, 404);

    const { payload } = await readState(url, startup.id);
    await save(url, startup.id, [
      { type: "delete", section: "items", id: "x1", baseRevision: payload.revisionMap.records.items.x1 },
      { type: "upsert", section: "items", id: "x2", value: { id: "x2", title: "Added later" }, baseRevision: 0 },
    ]);
    const otherBefore = await readState(url, other.id);

    const prepared = await prepareImport(url, data, "application/json");
    assert.equal(prepared.status, 200, JSON.stringify(prepared.payload));
    const { token } = prepared.payload;
    // Choices that do not fit are refused and leave the token usable.
    assert.equal((await applyImport(url, token, { mode: "database" })).status, 400);
    assert.equal((await applyImport(url, token, { mode: "replace", startupId: "nope-0000" })).status, 404);
    assert.equal((await applyImport(url, token, { mode: "merge" })).status, 400);

    const applied = await applyImport(url, token, { mode: "replace", startupId: startup.id });
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));
    assert.deepEqual(applied.payload.imported.startups.map((entry) => entry.id), [startup.id]);
    assert.deepEqual((await readState(url, startup.id)).payload.state, exportedState);
    assert.equal((await browserFetch(`${url}api/s/${other.id}/state`, { headers: { "If-None-Match": otherBefore.response.headers.get("etag") } })).status, 304);
    assert.equal((await listStartups(url)).length, 2, "replacing adds no startup");
  } finally {
    await server.stop();
  }
});

test("a database export imports over the whole database", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const kept = await createStartup(url, "Kept");
    await fillSections(url, kept.id, { items: [{ id: "k1", title: "As exported" }] });
    const { response, data } = await download(url, "api/export?format=sqlite");
    assert.equal(response.headers.get("content-type"), "application/vnd.sqlite3");
    assert.equal(data.subarray(0, SQLITE_MAGIC.length).toString("binary"), SQLITE_MAGIC);
    const exportedFile = path.join(server.home, "exported.sqlite");
    fs.writeFileSync(exportedFile, data);
    assert.equal(verifyDatabaseFile(exportedFile).ok, true);

    const { payload } = await readState(url, kept.id);
    await save(url, kept.id, [{ type: "upsert", section: "items", id: "k1", value: { id: "k1", title: "Changed" }, baseRevision: payload.revisionMap.records.items.k1 }]);
    const later = await createStartup(url, "Later");

    const prepared = await prepareImport(url, data, "application/octet-stream");
    assert.equal(prepared.status, 200, JSON.stringify(prepared.payload));
    assert.equal(prepared.payload.kind, "database");
    assert.equal(prepared.payload.preview.startupCount, 1);
    assert.deepEqual(prepared.payload.preview.startups, ["Kept"]);
    assert.equal((await applyImport(url, prepared.payload.token, { mode: "new" })).status, 400, "a database restores the whole database");

    const applied = await applyImport(url, prepared.payload.token, { mode: "database" });
    assert.equal(applied.status, 200, JSON.stringify(applied.payload));
    assert.deepEqual((await listStartups(url)).map((entry) => entry.id), [kept.id]);
    assert.deepEqual((await readState(url, kept.id)).payload.state.items, [{ id: "k1", title: "As exported" }]);
    assert.equal((await browserFetch(`${url}api/s/${later.id}/state`)).status, 404);
    assert.equal((await listBackups(url)).find((entry) => entry.id === applied.payload.imported.safetyBackup).kind, "safety");

    // A file that only looks like a database is refused before anything is kept.
    const broken = Buffer.from(data);
    broken.fill(0, 4_096);
    const refused = await prepareImport(url, broken, "application/octet-stream");
    assert.equal(refused.status, 400);
    assert.equal(refused.payload.code, "badDatabase");
  } finally {
    await server.stop();
  }
});

test("an import with unsafe zip entries, or that is not an export, is refused", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    for (const [archive, code] of [
      [handMadeZip({ name: "../escaped.txt" }), "pathTraversal"],
      [handMadeZip({ name: "startups/x/../../escaped.txt" }), "pathTraversal"],
      [handMadeZip({ name: "/etc/escaped.txt" }), "absolutePath"],
      [handMadeZip({ name: "link", mode: 0o120777 }), "symlink"],
    ]) {
      const refused = await prepareImport(url, archive, "application/zip");
      assert.equal(refused.status, 400, code);
      assert.equal(refused.payload.code, code);
    }
    assert.equal(fs.existsSync(path.join(server.home, "escaped.txt")), false);
    assert.equal(fs.existsSync(path.join(server.home, "backups", "escaped.txt")), false);

    const notExport = await prepareImport(url, Buffer.from(JSON.stringify({ hello: "world" })), "application/json");
    assert.equal(notExport.status, 400);
    assert.equal(notExport.payload.code, "notExport");
    assert.equal((await prepareImport(url, Buffer.alloc(0), "application/zip")).status, 400);
    assert.equal((await prepareImport(url, Buffer.from("x"), "text/csv")).status, 415);

    // An unknown token, or one that is not a token at all, finds nothing.
    const unknown = await applyImport(url, "0123456789abcdef0123456789abcdef", { mode: "new" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.code, "importExpired");
    assert.equal((await applyImport(url, "not-a-token", { mode: "new" })).status, 404);
    assert.deepEqual(await listStartups(url), []);
  } finally {
    await server.stop();
  }
});

test("a save from a page loaded before a restore is refused as restored", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Restored");
    await fillSections(url, startup.id, { items: [{ id: "a", title: "Backed up" }] });
    const backup = await takeBackup(url);
    const loaded = (await readState(url, startup.id)).payload;
    await save(url, startup.id, [{ type: "upsert", section: "items", id: "a", value: { id: "a", title: "Saved before the restore" }, baseRevision: loaded.revisionMap.records.items.a }], { knownRevision: loaded.revision });

    assert.equal((await restore(url, backup.id, { scope: "startup", startupId: startup.id })).status, 200);
    const afterRestore = (await readState(url, startup.id)).payload;

    // A page that loaded before the restore holds edits against data that is
    // gone. Its write is refused, whatever its record revisions say.
    for (const knownRevision of [0, loaded.revision]) {
      const stale = await saveOperations(url, startup.id, [{
        type: "upsert", section: "items", id: "a", value: { id: "a", title: "Stale edit" }, baseRevision: afterRestore.revisionMap.records.items.a,
      }], { knownRevision });
      assert.equal(stale.status, 409);
      const refused = await stale.json();
      assert.equal(refused.error, "restored");
      assert.equal(refused.revision, afterRestore.revision);
      assert.equal(refused.lineageStart, afterRestore.revision);
    }
    const unchanged = (await readState(url, startup.id)).payload;
    assert.equal(unchanged.revision, afterRestore.revision, "nothing was written");
    assert.deepEqual(unchanged.state.items, [{ id: "a", title: "Backed up" }]);

    // A page that reloaded after the restore saves as usual.
    const saved = await save(url, startup.id, [{
      type: "upsert", section: "items", id: "a", value: { id: "a", title: "After reload" }, baseRevision: afterRestore.revisionMap.records.items.a,
    }], { knownRevision: afterRestore.revision });
    assert.equal(saved.revision, afterRestore.revision + 1);
    assert.equal((await readState(url, startup.id)).payload.state.items[0].title, "After reload");
  } finally {
    await server.stop();
  }
});

test("the server takes an automatic backup at start only when the data changed", async () => {
  const home = makeTempHome("tracker-automatic-");
  const startupId = seedStartup(path.join(home, "data", "tracker.sqlite"), "Seeded", { items: [{ id: "s1", title: "Seeded" }] });
  let server = await startServer({ home });
  try {
    const [first] = await listBackups(server.url, startupId);
    assert.equal(first.kind, "automatic");
    assert.equal(first.reason, "first");
    assert.deepEqual(first.counts, { items: 1 });
    assert.equal((await listBackups(server.url)).length, 1);

    // Nothing changed: no second backup.
    await server.stop({ keepHome: true });
    server = await startServer({ home });
    assert.deepEqual((await listBackups(server.url)).map((backup) => backup.id), [first.id]);

    // A change since the newest backup is backed up on the next start.
    const { payload } = await readState(server.url, startupId);
    await save(server.url, startupId, [{ type: "upsert", section: "items", id: "s2", value: { id: "s2" }, baseRevision: 0 }], { knownRevision: payload.revision });
    await server.stop({ keepHome: true });
    server = await startServer({ home });
    const listed = await listBackups(server.url);
    assert.deepEqual(listed.map((backup) => [backup.kind, backup.reason]), [["automatic", "start"], ["automatic", "first"]]);
  } finally {
    await server.stop();
  }
});

test("the recycle bin is emptied of expired records when the server starts", async () => {
  const home = makeTempHome("tracker-recycle-");
  const databasePath = path.join(home, "data", "tracker.sqlite");
  const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
  const seed = new TrackerSqliteStore(databasePath);
  let startupId;
  try {
    startupId = startupsLib.createStartup(seed, { name: "Binned" }).id;
    seed.replaceState(startupId, {
      items: [{ id: "live", title: "Not in the bin" }],
      deletedItems: [
        { id: "expired", deletedAt: daysAgo(40) },
        { id: "recent", deletedAt: daysAgo(5) },
        { id: "undated" },
      ],
    }, { origin: "tool" });
    seed.replaceSection(GLOBAL_STARTUP_ID, "deletedPrompts", [{ id: "old-prompt", deletedAt: daysAgo(31) }, { id: "new-prompt", deletedAt: daysAgo(1) }], { origin: "tool" });
  } finally {
    seed.close();
  }

  const server = await startServer({ home });
  try {
    const state = (await readState(server.url, startupId)).payload.state;
    assert.deepEqual(state.deletedItems.map((record) => record.id), ["recent", "undated"], "a record without a deletedAt is kept");
    assert.deepEqual(state.items, [{ id: "live", title: "Not in the bin" }]);
    const global = (await (await browserFetch(`${server.url}api/global`)).json()).state;
    assert.deepEqual(global.deletedPrompts.map((record) => record.id), ["new-prompt"]);
    // The automatic backup at start ran first, so it still holds what was purged.
    const [backup] = await listBackups(server.url, startupId);
    assert.deepEqual(backup.counts, { items: 1, deletedItems: 3 });
  } finally {
    await server.stop();
  }
});

test("About reports where the data lives and checks integrity on request", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const about = await (await browserFetch(`${url}api/about`)).json();
    assert.equal(about.ok, true);
    assert.equal(about.version, require("../package.json").version);
    assert.equal(about.dataFolder, server.home);
    assert.equal(about.databasePath, path.join(server.home, "data", "tracker.sqlite"));
    assert.equal(about.mediaDir, path.join(server.home, "media"));
    assert.equal(about.backupDir, path.join(server.home, "backups"));
    assert.equal(about.port, Number(new URL(url).port));
    assert.equal(about.schemaVersion, SCHEMA_VERSION);
    assert.ok(about.databaseBytes > 0);
    assert.deepEqual(Object.keys(about.integrity).sort(), ["checkedAt", "ok", "problems"]);
    assert.ok(Number.isFinite(Date.parse(about.integrity.checkedAt)), "the check at start is reported");
    assert.equal(about.integrity.ok, true);

    const response = await sendJson(`${url}api/about/verify`, "POST");
    assert.equal(response.status, 200);
    const verified = await response.json();
    assert.equal(verified.integrity.ok, true);
    assert.deepEqual(verified.integrity.problems, []);
    assert.ok(Number.isFinite(Date.parse(verified.integrity.checkedAt)));
    assert.equal(verified.databasePath, about.databasePath, "the answer carries the same facts");
    // The newest check is what About shows from then on.
    assert.deepEqual((await (await browserFetch(`${url}api/about`)).json()).integrity, verified.integrity);
  } finally {
    await server.stop();
  }
});
