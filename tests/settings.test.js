"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { readSettings, writeSettings, mergeSettings, resolveSettings, defaults } = require("../lib/settings");

test("a new tracker reads the defaults", () => {
  const store = new TrackerSqliteStore(":memory:");
  const settings = readSettings(store);
  assert.equal(settings.appName, "Startup Tracker");
  assert.deepEqual(settings.backups, { automatic: true, keepAutomatic: 20, keepSafety: 20 });
  assert.equal(settings.recycleBin.retentionDays, 30);
  assert.equal(settings.defaultScope, "startup");
});

test("a change merges one level deep and is stored in the global scope", () => {
  const store = new TrackerSqliteStore(":memory:");
  writeSettings(store, { backups: { keepSafety: 5 }, appName: "  Acme   Ops " });
  const settings = readSettings(store);
  assert.deepEqual(settings.backups, { automatic: true, keepAutomatic: 20, keepSafety: 5 });
  assert.equal(settings.appName, "Acme Ops");
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, "settings").appName, "Acme Ops");
  writeSettings(store, { recycleBin: { retentionDays: null } });
  assert.equal(readSettings(store).recycleBin.retentionDays, null);
});

test("bad values name their field and change nothing", () => {
  const current = defaults();
  const cases = [
    [{ appName: "" }, "appName"],
    [{ timeZone: "Mars/Olympus" }, "timeZone"],
    [{ dateFormat: "dd.mm" }, "dateFormat"],
    [{ pageSize: 5 }, "pageSize"],
    [{ network: "yes" }, "network"],
    [{ appearance: { theme: "neon" } }, "appearance.theme"],
    [{ appearance: { colour: "red" } }, "appearance.colour"],
    [{ backups: { keepAutomatic: 0 } }, "backups.keepAutomatic"],
    [{ recycleBin: { retentionDays: 3 } }, "recycleBin.retentionDays"],
    [{ secret: 1 }, "secret"],
  ];
  for (const [patch, field] of cases) {
    assert.throws(() => mergeSettings(current, patch), (error) => error.field === field && error.statusCode === 400, field);
  }
  assert.deepEqual(current, defaults());
});

test("a stored value that no longer validates falls back to its default", () => {
  const resolved = resolveSettings({ appearance: { mode: "dark", theme: "removed-theme" }, timeZone: "Europe/Berlin", pageSize: "lots" });
  assert.equal(resolved.appearance.mode, "system");
  assert.equal(resolved.timeZone, "Europe/Berlin");
  assert.equal(resolved.pageSize, 25);
});
