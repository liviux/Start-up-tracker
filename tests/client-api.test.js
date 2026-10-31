"use strict";

// js/api.js: the startup id read from the page address, the URLs built from
// it, and the per-startup browser storage names (the IndexedDB naming
// contract shared by app.js and the switcher in js/startups.js).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "public");
const apiSource = fs.readFileSync(path.join(root, "js", "api.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const startupsSource = fs.readFileSync(path.join(root, "js", "startups.js"), "utf8");

// Loads js/api.js the way the browser does, as a plain script on a window.
function loadApi(pathname, extra = {}) {
  const context = { location: { pathname }, URLSearchParams, ...extra };
  context.globalThis = context;
  vm.runInNewContext(apiSource, context);
  return context.StartupTrackerApi;
}

test("the startup id comes from /s/<id>/ and nothing else", () => {
  assert.equal(loadApi("/s/acme-7f3k/").startupId, "acme-7f3k");
  assert.equal(loadApi("/s/acme-7f3k/index.html").startupId, "acme-7f3k");
  assert.equal(loadApi("/s/acme-7f3k/").hasStartup, true);
  for (const pathname of ["/", "/index.html", "/s/", "/s/acme-7f3k", "/s/acme-7f3k/other", "/s/ACME/", "/s/-acme/", "/s/_global/", "/s/a%2Fb/", "/s/%E0%A4%A/", "/x/acme-7f3k/"]) {
    const api = loadApi(pathname);
    assert.equal(api.startupId, "", pathname);
    assert.equal(api.hasStartup, false, pathname);
  }
  assert.equal(loadApi("/").parseStartupId("/s/beta-0000/"), "beta-0000");
});

test("startup routes are prefixed with /api/s/<id> and other routes are fixed", () => {
  const api = loadApi("/s/acme-7f3k/");
  assert.equal(api.api("/state"), "/api/s/acme-7f3k/state");
  assert.equal(api.api("state/operations"), "/api/s/acme-7f3k/state/operations");
  assert.equal(api.api("/media/upload"), "/api/s/acme-7f3k/media/upload");
  assert.equal(api.startupApiUrl("beta-0000", "/state/changes?since=4"), "/api/s/beta-0000/state/changes?since=4");
  assert.equal(api.urls.startups, "/api/startups");
  assert.equal(api.urls.startup("beta-0000"), "/api/startups/beta-0000");
  assert.equal(api.urls.global, "/api/global");
  assert.equal(api.urls.companyTemplates, "/api/company/templates");
  assert.equal(api.urls.companyTemplate("ro-srl"), "/api/company/templates/ro-srl");
  assert.equal(api.urls.globalOperations, "/api/global/operations");
  assert.equal(api.urls.backups, "/api/backups");
  assert.equal(api.urls.backupsFor("acme-7f3k"), "/api/backups?startupId=acme-7f3k");
  const backupId = "20261017-080000-000-pinned-before-launch";
  assert.equal(api.urls.backup(backupId), `/api/backups/${backupId}`);
  assert.equal(api.urls.backupVerify(backupId), `/api/backups/${backupId}/verify`);
  assert.equal(api.urls.backupCompare(backupId, "acme-7f3k"), `/api/backups/${backupId}/compare?startupId=acme-7f3k`);
  assert.equal(api.urls.backupRestore(backupId), `/api/backups/${backupId}/restore`);
  assert.equal(api.urls.backupDownload(backupId), `/api/backups/${backupId}/download`);
  // The routes before Part 3 are gone from the server and from the helper.
  assert.equal(api.urls.backupsSnapshot, undefined);
  assert.equal(api.urls.backupsRestore, undefined);
  assert.throws(() => api.urls.backup("../tracker"), { name: "TypeError", message: /valid backup id/ });
  assert.throws(() => api.urls.backupRestore(""), { name: "TypeError" });
  assert.equal(api.urls.settings, "/api/settings");
  assert.equal(api.urls.about, "/api/about");
  assert.equal(api.urls.aboutVerify, "/api/about/verify");
  assert.equal(api.urls.startupsWithCounts, "/api/startups?counts=1");
  assert.equal(api.urls.exportStartup("acme-7f3k"), "/api/s/acme-7f3k/export?format=zip");
  assert.equal(api.urls.exportStartup("acme-7f3k", "json"), "/api/s/acme-7f3k/export?format=json");
  assert.equal(api.urls.exportAll("sqlite"), "/api/export?format=sqlite");
  assert.equal(api.urls.exportStartup("acme-7f3k", "json", { includeSensitive: true }), "/api/s/acme-7f3k/export?format=json&includeSensitive=1");
  assert.equal(api.urls.exportAll("zip", undefined, { includeSensitive: true }), "/api/export?format=zip&includeSensitive=1");
  assert.equal(api.urls.exportAll("zip", ["acme-7f3k", "beta-0000"]), "/api/export?format=zip&startups=acme-7f3k%2Cbeta-0000");
  assert.equal(api.urls.import, "/api/import");
  assert.equal(api.urls.importApply("0123456789abcdef0123456789abcdef"), "/api/import/0123456789abcdef0123456789abcdef/apply");
  assert.throws(() => api.urls.importApply("../x"), { name: "TypeError" });
  assert.throws(() => api.urls.exportStartup("_global"), { name: "TypeError" });
  assert.equal(api.urls.allSearch("grant deadline", 50), "/api/all/search?q=grant+deadline&limit=50");
  assert.equal(api.urls.allSearch("x&y=1"), "/api/all/search?q=x%26y%3D1");
  assert.equal(api.urls.allCalendar(), "/api/all/calendar");
  assert.equal(api.urls.allCalendar("2026-01-01", "2026-01-31"), "/api/all/calendar?from=2026-01-01&to=2026-01-31");
  assert.equal(api.pageUrl("beta-0000"), "/s/beta-0000/");
  assert.equal(api.pageUrl("beta-0000", { open: "program:p-1" }), "/s/beta-0000/?open=program%3Ap-1");
  assert.equal(api.media("notes/plan one.md"), "/media/acme-7f3k/notes/plan%20one.md");
  assert.equal(api.mediaUrl("beta-0000", "a\\b.png"), "/media/beta-0000/a/b.png");
  // A bad id never reaches a URL.
  assert.throws(() => api.pageUrl("../etc"), { name: "TypeError", message: /valid startup id/ });
  assert.throws(() => api.startupApiUrl("", "/state"), { name: "TypeError", message: /valid startup id/ });
  assert.throws(() => api.urls.startup("_global"), { name: "TypeError", message: /valid startup id/ });
});

test("a page without a startup cannot build startup routes", () => {
  const api = loadApi("/");
  assert.throws(() => api.api("/state"), /no startup/);
  assert.throws(() => api.storageKey("search-scope"), /no startup/);
  assert.equal(api.urls.startups, "/api/startups");
});

test("IndexedDB naming contract: one database per startup, shared by app.js and the switcher", () => {
  const api = loadApi("/s/acme-7f3k/");
  assert.equal(api.cacheDbName("acme-7f3k"), "startup-tracker:acme-7f3k");
  assert.equal(api.ownCacheDbName(), "startup-tracker:acme-7f3k");
  assert.notEqual(api.cacheDbName("acme-7f3k"), api.cacheDbName("beta-0000"));
  assert.throws(() => api.cacheDbName(""), { name: "TypeError", message: /valid startup id/ });
  assert.equal(api.CACHE_STORE_NAME, "state");
  assert.equal(api.CACHE_DB_VERSION, 2);
  // app.js opens exactly that database and writes its outbox under sync:<tab>.
  // A cache another version wrote holds another record shape: the upgrade
  // drops it instead of replaying it.
  assert.match(appSource, /const CACHE_DB_NAME = STARTUP_ID \? Api\.cacheDbName\(STARTUP_ID\) : "";/);
  assert.match(appSource, /if \(db\.objectStoreNames\.contains\(CACHE_STORE_NAME\)\) db\.deleteObjectStore\(CACHE_STORE_NAME\);\s*db\.createObjectStore\(CACHE_STORE_NAME\);/);
  assert.match(appSource, /const CACHE_SYNC_KEY = `sync:\$\{cacheTabId\}`/);
  assert.match(appSource, /outbox: clonePersistedState\(activeOutbox\)/);
  assert.doesNotMatch(appSource, /"startup-tracker-cache"/);
  // The switcher reads other startups through the same helper.
  assert.match(startupsSource, /Api\.readOutboxStatus\(startup\.id\)/);
});

test("localStorage keys: startup choices are prefixed, global UI keys keep their names", () => {
  const api = loadApi("/s/acme-7f3k/");
  assert.equal(api.storageKey("search-scope"), "startup-tracker:acme-7f3k:search-scope");
  assert.equal(api.startupStorageKey("beta-0000", "calendar-scope"), "startup-tracker:beta-0000:calendar-scope");
  assert.equal(api.globalStorageKey("theme"), "startup-tracker-theme");
  assert.equal(api.globalStorageKey("tab-id"), "startup-tracker-tab-id");
  for (const name of ["search-scope", "calendar-scope", "calendar-filters"]) {
    assert.match(appSource, new RegExp(`STARTUP_ID \\? Api\\.storageKey\\("${name}"\\) : ""`), `${name} is per startup`);
  }
  assert.match(appSource, /const THEME_STORAGE_KEY = Api\.globalStorageKey\("theme"\);/);
  assert.match(appSource, /const CACHE_TAB_ID_KEY = Api\.globalStorageKey\("tab-id"\);/);
  // boot.js and the taste switcher read the same global names before api.js loads.
  assert.match(fs.readFileSync(path.join(root, "js", "boot.js"), "utf8"), /"startup-tracker-theme"/);
  assert.match(fs.readFileSync(path.join(root, "scripts", "taste-switcher.js"), "utf8"), /"startup-tracker-taste"/);
});

test("the version shown in the footer matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(loadApi("/").APP_VERSION, pkg.version);
});

test("an outbox summary counts edits to send and edits held by a conflict", () => {
  const { summarizeOutboxRecords } = loadApi("/");
  assert.deepEqual({ ...summarizeOutboxRecords([]) }, { pending: 0, conflicted: 0, hasUnsynced: false });
  assert.deepEqual({ ...summarizeOutboxRecords([null, { outbox: "x" }, {}]) }, { pending: 0, conflicted: 0, hasUnsynced: false });
  const summary = summarizeOutboxRecords([
    { outbox: [{ operations: [] }, { blockedByConflict: true }] },
    { outbox: [{ operations: [] }] },
  ]);
  assert.deepEqual({ ...summary }, { pending: 2, conflicted: 1, hasUnsynced: true });
});

// A small IndexedDB: enough of open, versionchange abort, getAllKeys and get.
function fakeIndexedDB({ withDatabasesList }) {
  const databases = new Map();
  const opened = [];
  const later = (fn) => setTimeout(fn, 0);
  function makeDb(name, data) {
    return {
      name,
      objectStoreNames: { contains: (store) => data.has(store) },
      close() {},
      transaction(storeName) {
        const store = data.get(storeName);
        let pending = 0;
        const transaction = {};
        const finish = () => later(() => { if (pending === 0) transaction.oncomplete?.(); });
        const request = (compute) => {
          pending += 1;
          const req = {};
          later(() => {
            req.result = compute();
            req.onsuccess?.();
            pending -= 1;
            finish();
          });
          return req;
        };
        transaction.objectStore = () => ({
          getAllKeys: () => request(() => [...store.keys()]),
          get: (key) => request(() => store.get(key)),
        });
        return transaction;
      },
    };
  }
  const idb = {
    open(name) {
      opened.push(name);
      const req = {};
      later(() => {
        if (!databases.has(name)) {
          let aborted = false;
          req.transaction = { abort: () => { aborted = true; } };
          req.onupgradeneeded?.();
          if (aborted) {
            req.error = new Error("AbortError");
            req.onerror?.();
            return;
          }
          databases.set(name, new Map());
        }
        req.result = makeDb(name, databases.get(name));
        req.onsuccess?.();
      });
      return req;
    },
  };
  if (withDatabasesList) idb.databases = async () => [...databases.keys()].map((name) => ({ name, version: 1 }));
  return { idb, databases, opened };
}

for (const withDatabasesList of [true, false]) {
  test(`reading another startup's outbox never creates its database (${withDatabasesList ? "with" : "without"} indexedDB.databases)`, async () => {
    const api = loadApi("/s/acme-7f3k/");
    const { idb, databases, opened } = fakeIndexedDB({ withDatabasesList });
    databases.set("startup-tracker:beta-0000", new Map([["state", new Map([
      ["current:tab-1", { state: {} }],
      ["sync:tab-1", { outbox: [{ operations: [] }, { blockedByConflict: true }] }],
      ["sync:tab-2", { outbox: [] }],
    ])]]));

    const beta = await api.readOutboxStatus("beta-0000", idb);
    assert.deepEqual({ ...beta }, { pending: 1, conflicted: 1, hasUnsynced: true });

    const gamma = await api.readOutboxStatus("gamma-1111", idb);
    assert.deepEqual({ ...gamma }, { pending: 0, conflicted: 0, hasUnsynced: false });
    assert.equal(databases.has("startup-tracker:gamma-1111"), false, "no database is left behind");
    // With the list available, a missing database is not even opened.
    assert.equal(opened.includes("startup-tracker:gamma-1111"), !withDatabasesList);

    assert.deepEqual({ ...(await api.readOutboxStatus("bad id", idb)) }, { pending: 0, conflicted: 0, hasUnsynced: false });
    assert.deepEqual({ ...(await api.readOutboxStatus("beta-0000", null)) }, { pending: 0, conflicted: 0, hasUnsynced: false });
  });
}
