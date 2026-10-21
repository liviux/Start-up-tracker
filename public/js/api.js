// Addresses of the tracker's HTTP API and the names of this page's browser
// storage, both worked out from the page's own address.
//
// The page for one startup is /s/<startupId>/. Every call about that startup's
// data goes under /api/s/<startupId>, and everything the browser keeps for it
// (the IndexedDB cache with its outbox, a few localStorage choices) is named
// after the id too. Switching startups is a full page load, so a page only
// ever talks to one startup and its unsynced edits cannot reach another.
//
// UMD: browsers get window.StartupTrackerApi, Node gets module.exports (where
// createApi(location) builds the same object for any address, for tests).
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Kept in step with package.json by tests/client-api.test.js.
  const APP_VERSION = "0.1.0";
  // Same rule as the server's ids: a slug plus a random suffix.
  const STARTUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const STORAGE_PREFIX = "startup-tracker";
  // The object store inside each startup's cache database. Keys in it:
  // `current[:<tabId>]` (the state) and `sync[:<tabId>]` (revision and outbox).
  const CACHE_STORE_NAME = "state";
  const CACHE_DB_VERSION = 1;

  function isStartupId(value) {
    return typeof value === "string" && STARTUP_ID_PATTERN.test(value);
  }

  // "/s/acme-7f3k/" -> "acme-7f3k", and the same for an agent run in its own
  // window ("/s/acme-7f3k/agents/run-..."). Anything else, including
  // "/s/acme-7f3k" without the slash (the server redirects that), has no
  // startup.
  function parseStartupId(pathname) {
    const match = String(pathname || "").match(/^\/s\/([^/]+)\/(?:index\.html|agents\/run-[a-z0-9]{6,40})?$/);
    if (!match) return "";
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return "";
    }
    return isStartupId(id) ? id : "";
  }

  function requireStartupId(startupId) {
    if (!isStartupId(startupId)) throw new TypeError(`A valid startup id is required (got ${JSON.stringify(startupId)}).`);
    return startupId;
  }

  function encodeId(startupId) {
    return encodeURIComponent(requireStartupId(startupId));
  }

  // Names in the browser's storage. The IndexedDB database of a startup holds
  // its cached state and its outbox; nothing of one startup is ever kept in
  // another startup's database.
  function cacheDbName(startupId) {
    return `${STORAGE_PREFIX}:${requireStartupId(startupId)}`;
  }

  function startupStorageKey(startupId, name) {
    return `${STORAGE_PREFIX}:${requireStartupId(startupId)}:${name}`;
  }

  // Global keys predate startups and keep their old names, so a saved theme
  // survives the upgrade.
  function globalStorageKey(name) {
    return `${STORAGE_PREFIX}-${name}`;
  }

  // Backup ids are folder names such as 20261017T080000Z-pinned-before-launch.
  const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  function encodeBackupId(backupId) {
    if (typeof backupId !== "string" || !BACKUP_ID_PATTERN.test(backupId) || backupId.includes("..")) {
      throw new TypeError(`A valid backup id is required (got ${JSON.stringify(backupId)}).`);
    }
    return encodeURIComponent(backupId);
  }

  function encodeImportToken(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      throw new TypeError("A valid import token is required.");
    }
    return token;
  }

  const RUN_ID_PATTERN = /^run-[a-z0-9]{6,40}$/;
  function encodeRunId(runId) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw new TypeError(`A valid run id is required (got ${JSON.stringify(runId)}).`);
    return runId;
  }

  // The run shown in its own window: "/s/<id>/agents/<runId>" -> "<runId>".
  function parseRunId(pathname) {
    const match = String(pathname || "").match(/^\/s\/[^/]+\/agents\/(run-[a-z0-9]{6,40})$/);
    return match ? match[1] : "";
  }

  function runPageUrl(startupId, runId) {
    return `/s/${encodeId(startupId)}/agents/${encodeRunId(runId)}`;
  }

  // Harness ids are UUIDs; request ids too.
  function encodeUuid(value) {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new TypeError(`A valid id is required (got ${JSON.stringify(value)}).`);
    return value;
  }

  function pageUrl(startupId, params) {
    const base = `/s/${encodeId(startupId)}/`;
    const search = params ? new URLSearchParams(params).toString() : "";
    return search ? `${base}?${search}` : base;
  }

  function startupApiUrl(startupId, routePath = "") {
    const suffix = String(routePath || "");
    return `/api/s/${encodeId(startupId)}${suffix && !suffix.startsWith("/") ? "/" : ""}${suffix}`;
  }

  function mediaUrl(startupId, relativePath) {
    const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return `/media/${encodeId(startupId)}/${parts.map(encodeURIComponent).join("/")}`;
  }

  function withQuery(path, params) {
    const search = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    const text = search.toString();
    return text ? `${path}?${text}` : path;
  }

  // Routes that are not about one startup.
  const urls = Object.freeze({
    startups: "/api/startups",
    startup: (startupId) => `/api/startups/${encodeId(startupId)}`,
    global: "/api/global",
    globalOperations: "/api/global/operations",
    allSearch: (query, limit) => withQuery("/api/all/search", { q: query, limit }),
    allCalendar: (from, to) => withQuery("/api/all/calendar", { from, to }),
    // The targets of one shared campaign in every open startup.
    campaignTargets: (campaignId) => withQuery("/api/all/campaign-targets", { campaign: campaignId }),
    // Shared tags: usage across startups, and rename, merge or delete everywhere.
    tagUsage: "/api/global/tags/usage",
    tagAction: (action) => {
      if (!["rename", "merge", "delete"].includes(action)) throw new TypeError(`Unknown tag action ${JSON.stringify(action)}.`);
      return `/api/global/tags/${action}`;
    },
    // GET reads the shared option lists (with the shipped ones), PUT saves edited lists.
    options: "/api/options",
    startupsWithCounts: "/api/startups?counts=1",
    // The company templates, and one of them (lib/company/templates.js).
    companyTemplates: "/api/company/templates",
    companyTemplate: (templateId) => `/api/company/templates/${encodeURIComponent(templateId)}`,
    settings: "/api/settings",
    // GET reads the shared status list and the priorities, PUT saves it.
    statuses: "/api/statuses",
    // GET reads the field registry and the custom fields; PUT customFields saves them.
    fields: "/api/fields",
    customFields: "/api/fields/custom",
    // Deleting a status first moves its records; kind is "status" or "campaign".
    statusDelete: (kind, statusId) => `/api/${kind === "campaign" ? "campaign-statuses" : "statuses"}/${encodeURIComponent(statusId)}/delete`,
    about: "/api/about",
    aboutVerify: "/api/about/verify",
    // GET: whether a newer release exists (cached for a day); POST: ask now.
    aboutUpdate: "/api/about/update",
    // GET and PUT the setup's progress (lib/setup.js); POST adds the demo
    // startup, DELETE removes it (lib/demo.js).
    setup: "/api/setup",
    demo: "/api/demo",
    // The shared category library.
    taxonomy: "/api/taxonomy",
    // GET lists (with counts for one startup when given), POST takes a pinned backup.
    backups: "/api/backups",
    backupsFor: (startupId) => withQuery("/api/backups", { startupId: requireStartupId(startupId) }),
    backup: (backupId) => `/api/backups/${encodeBackupId(backupId)}`,
    backupVerify: (backupId) => `/api/backups/${encodeBackupId(backupId)}/verify`,
    backupCompare: (backupId, startupId) => withQuery(`/api/backups/${encodeBackupId(backupId)}/compare`, { startupId: requireStartupId(startupId) }),
    backupRestore: (backupId) => `/api/backups/${encodeBackupId(backupId)}/restore`,
    backupDownload: (backupId) => `/api/backups/${encodeBackupId(backupId)}/download`,
    // format: "zip" or "json"; the whole database is exportAll("sqlite").
    // Sensitive company values are left out unless includeSensitive is set.
    exportStartup: (startupId, format = "zip", { includeSensitive = false } = {}) => withQuery(`/api/s/${encodeId(startupId)}/export`, { format, includeSensitive: includeSensitive ? "1" : "" }),
    exportAll: (format = "zip", startupIds, { includeSensitive = false } = {}) => withQuery("/api/export", {
      format,
      startups: Array.isArray(startupIds) && startupIds.length ? startupIds.map(requireStartupId).join(",") : "",
      includeSensitive: includeSensitive ? "1" : "",
    }),
    import: "/api/import",
    importApply: (token) => `/api/import/${encodeImportToken(token)}/apply`,
    // Settings > AI agents and agent runs (lib/agents/routes.js).
    agents: "/api/agents",
    agentsRescan: "/api/agents/rescan",
    agentsSettings: "/api/agents/settings",
    harnesses: "/api/agents/harnesses",
    harness: (harnessId) => `/api/agents/harnesses/${encodeUuid(harnessId)}`,
    harnessCheck: (harnessId) => `/api/agents/harnesses/${encodeUuid(harnessId)}/check`,
    harnessAuthenticate: (harnessId) => `/api/agents/harnesses/${encodeUuid(harnessId)}/authenticate`,
    agentTokens: (startupId) => withQuery("/api/agent-tokens", { startupId: startupId ? requireStartupId(startupId) : "" }),
    agentTokenRevoke: (tokenId) => `/api/agent-tokens/${encodeUuid(tokenId)}/revoke`,
    agentRuns: (startupId) => withQuery("/api/agent-runs", { startupId: startupId ? requireStartupId(startupId) : "" }),
    agentRunsStopAll: "/api/agent-runs/stop-all",
    agentRun: (runId) => `/api/agent-runs/${encodeRunId(runId)}`,
    agentRunEvents: (runId, after = 0) => withQuery(`/api/agent-runs/${encodeRunId(runId)}/events`, { after: after > 0 ? after : "" }),
    agentRunAction: (runId, action) => {
      if (!["cancel", "message", "undo"].includes(action)) throw new TypeError(`Unknown run action ${JSON.stringify(action)}.`);
      return `/api/agent-runs/${encodeRunId(runId)}/${action}`;
    },
    agentRunPermission: (runId, requestId) => `/api/agent-runs/${encodeRunId(runId)}/permissions/${encodeUuid(requestId)}`,
    agentRunLog: (runId, { download = false } = {}) => withQuery(`/api/agent-runs/${encodeRunId(runId)}/log`, { download: download ? "1" : "" }),
  });

  // What a startup's outbox holds, from the `sync*` records of its cache
  // database: edits still to send, and edits held back by a conflict.
  function summarizeOutboxRecords(records) {
    let pending = 0;
    let conflicted = 0;
    (Array.isArray(records) ? records : []).forEach((record) => {
      const outbox = Array.isArray(record?.outbox) ? record.outbox : [];
      outbox.forEach((batch) => {
        if (batch?.blockedByConflict) conflicted += 1;
        else pending += 1;
      });
    });
    return { pending, conflicted, hasUnsynced: pending + conflicted > 0 };
  }

  const EMPTY_OUTBOX = Object.freeze({ pending: 0, conflicted: 0, hasUnsynced: false });

  // Reads another startup's outbox without ever creating its database: with
  // indexedDB.databases() a missing database is not opened at all, and where
  // that is unavailable, an open that would create one is aborted in
  // onupgradeneeded, which leaves nothing behind.
  async function readOutboxStatus(startupId, idb = root.indexedDB) {
    if (!idb || !isStartupId(startupId)) return EMPTY_OUTBOX;
    const name = cacheDbName(startupId);
    if (typeof idb.databases === "function") {
      try {
        const databases = await idb.databases();
        if (!databases.some((entry) => entry && entry.name === name)) return EMPTY_OUTBOX;
      } catch {
        // Fall back to the guarded open below.
      }
    }
    let db;
    try {
      db = await new Promise((resolve, reject) => {
        const request = idb.open(name);
        request.onupgradeneeded = () => {
          // The database did not exist; do not create it.
          request.transaction.abort();
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open the cache"));
        request.onblocked = () => reject(new Error("The cache is blocked"));
      });
    } catch {
      return EMPTY_OUTBOX;
    }
    try {
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) return EMPTY_OUTBOX;
      const records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const keysRequest = store.getAllKeys();
        const found = [];
        keysRequest.onsuccess = () => {
          (keysRequest.result || [])
            .filter((key) => typeof key === "string" && (key === "sync" || key.startsWith("sync:")))
            .forEach((key) => {
              const request = store.get(key);
              request.onsuccess = () => found.push(request.result);
            });
        };
        transaction.oncomplete = () => resolve(found);
        transaction.onerror = () => reject(transaction.error || new Error("Could not read the cache"));
        transaction.onabort = () => reject(transaction.error || new Error("Cache read was aborted"));
      });
      return summarizeOutboxRecords(records);
    } catch {
      return EMPTY_OUTBOX;
    } finally {
      db.close();
    }
  }

  // The API for a page at `location`. The page's own startup is fixed once:
  // the address does not change without a page load.
  function createApi(location) {
    const startupId = parseStartupId(location?.pathname);
    const own = (fn) => (...args) => {
      if (!startupId) throw new Error("This page has no startup.");
      return fn(startupId, ...args);
    };
    return Object.freeze({
      APP_VERSION,
      CACHE_STORE_NAME,
      CACHE_DB_VERSION,
      startupId,
      hasStartup: Boolean(startupId),
      isStartupId,
      parseStartupId,
      cacheDbName,
      startupStorageKey,
      globalStorageKey,
      pageUrl,
      runPageUrl,
      parseRunId,
      startupApiUrl,
      mediaUrl,
      urls,
      summarizeOutboxRecords,
      readOutboxStatus,
      // Shortcuts for the page's own startup.
      api: own(startupApiUrl),
      media: own(mediaUrl),
      storageKey: own(startupStorageKey),
      ownCacheDbName: own(cacheDbName),
      createApi,
    });
  }

  return createApi(root.location);
});
