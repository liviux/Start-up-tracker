const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  GLOBAL_STARTUP_ID,
  STARTUPS_SECTION,
  RecordConflictError,
  RevisionConflictError,
  TrackerSqliteStore,
  verifyDatabaseFile,
} = require("./lib/tracker-sqlite-store");
const startups = require("./lib/startups");
const { searchAll, calendarAll, campaignTargets } = require("./lib/combined");
const settingsStore = require("./lib/settings");
const statusStore = require("./lib/statuses");
const taxonomyStore = require("./lib/taxonomy");
const updateCheck = require("./lib/cli/update");
const fieldRegistry = require("./lib/field-registry");
const optionStore = require("./lib/options");
const tagStore = require("./lib/tags");
const mediaFiles = require("./lib/media-files");
const agentTokens = require("./lib/agent-tokens");
const companyTemplates = require("./lib/company/templates");
const agentHarnesses = require("./lib/agents/harnesses");
const setupState = require("./lib/setup");
const demo = require("./lib/demo");
const { RunManager } = require("./lib/agents/runs");
const { createAgentRoutes } = require("./lib/agents/routes");
const CompanyModel = require("./public/js/company-model.js");
// The fixed priority list. Labels are translated in the page.
const PRIORITIES = require("./content/priorities.json");
const { purgeExpired } = require("./lib/recycle-bin");
const { createBackupService } = require("./lib/backups/service");
const { createBackupManager } = require("./lib/backups/manager");
const { resolveDataRoot, dataPaths, ensureDataFolders, readOrCreateApiToken, readFlag } = require("./lib/data-root");
const security = require("./lib/http/security");
const { createStaticHandler } = require("./lib/http/static");
const { createMediaHandler, resolveMediaFileSync, assertWritableMediaPath } = require("./lib/http/media");
const { MIME_TYPES } = require("./lib/http/mime");

const rootDir = __dirname;
const APP_VERSION = require("./package.json").version;
const publicDir = path.join(rootDir, "public");
const contentDir = path.join(rootDir, "content");
const cliArgs = process.argv.slice(2);
const isDevMode = cliArgs.includes("--dev");
// Data lives outside the code folder (lib/data-root.js explains the order).
const dataRoot = resolveDataRoot({ argv: cliArgs });
const paths = dataPaths(dataRoot.root);
const databaseFile = paths.databaseFile;
const backupDir = paths.backupDir;
const mediaDir = paths.mediaDir;
// 57322 by default and 57323 for development, so the app never starts on a
// port another tracker may already use. A taken port is reported, never
// swapped for another one: the browser keeps unsent edits per address.
const DEFAULT_PORT = 57322;
const DEV_PORT = 57323;
const requestedPort = readRequestedPort();
const shouldOpenBrowser = process.env.NO_OPEN !== "1" && !cliArgs.includes("--no-open") && !isDevMode;
const allowedHosts = security.parseAllowedHosts(process.env.ALLOWED_HOSTS);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const DEFAULT_JSON_BODY_BYTES = 10 * 1024 * 1024;
const MAX_STATE_BODY_BYTES = readPositiveIntegerEnv("MAX_STATE_BODY_BYTES", 50 * 1024 * 1024);
// Whoever is at the browser on this machine. Every edit made in the UI is a
// manual edit by the one person who runs this tracker, so the timeline can name
// them when TRACKER_UI_ACTOR is set; without it the timeline says "You". The
// server decides this rather than the page, because who is sitting at the
// keyboard is a fact about the install, not something a request should be able
// to claim.
const UI_ACTOR = String(process.env.TRACKER_UI_ACTOR || "").trim();
const MAX_IMPORT_BYTES = readPositiveIntegerEnv("MAX_IMPORT_BYTES", 512 * 1024 * 1024);
const IMPORT_CONTENT_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/json", "application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"]);
// How often the server looks at whether an automatic backup or a recycle-bin
// clean-up is due. The rules themselves are in lib/backups/schedule.js.
const BACKUP_CHECK_MS = 10 * 60 * 1000;
const RECYCLE_PURGE_MS = 24 * 60 * 60 * 1000;
// Backups that can be restored, which is a wider set than the ones that rotate:
// a snapshot given a label is restorable but never pruned.
const BACKUP_FILE_PATTERN = /^tracker-[A-Za-z0-9._-]*\.sqlite$/;
const responseCompressionCache = new Map();

// Serialized state per startup, kept against that startup's revision so an
// unchanged reload costs one revision read. Another startup's writes never
// invalidate it.
const stateBodyCache = new Map();
let store = null;
let backups = null;
// Time of the newest write this server made, for the backup schedule.
let lastWriteAt = 0;
// The result of the newest integrity check, shown in Settings > About.
let lastIntegrity = { checkedAt: "", ok: true, problems: [] };

const mimeTypes = MIME_TYPES;

ensureDataFolders(paths);
const apiToken = readOrCreateApiToken(paths);
initializeStore();
// A new database had nothing to verify before it opened; check it once now so
// Settings > About always has a result to show.
if (!lastIntegrity.checkedAt) runIntegrityCheck();
// The shared status list goes into the global scope the first time.
statusStore.seedStatuses(store);
// The category library too.
taxonomyStore.seedTaxonomy(store);
backups = createBackupService({
  store,
  backupDir,
  mediaDir,
  appVersion: APP_VERSION,
  readSettings: () => settingsStore.readSettings(store),
  onDataReplaced: forgetCachedState,
});

// Agent runs (lib/agents/runs.js). Runs left going by a server that stopped
// are marked "interrupted" and their tokens revoked.
const agentRuns = new RunManager({
  store,
  paths,
  baseUrl: () => `http://127.0.0.1:${server.address()?.port || requestedPort}`,
  extraSecrets: () => [apiToken],
  clientVersion: APP_VERSION,
  mcpScript: path.join(rootDir, "bin", "tracker-mcp.js"),
  timeZone: () => settingsStore.readSettings(store).timeZone || "",
});
agentRuns.init();
const agentRoutes = createAgentRoutes({
  store,
  paths,
  runs: agentRuns,
  appVersion: APP_VERSION,
  readJsonBody,
  sendJson,
  HttpError: security.HttpError,
  safeDecode,
  readSettings: () => settingsStore.readSettings(store),
  startupName: (startupId) => startups.getStartup(store, startupId)?.name || "",
  // Tests never reach the network.
  offline: process.env.STARTUP_TRACKER_OFFLINE === "1",
});

const staticHandler = createStaticHandler({ publicDir, contentDir, sendBody, sendNotModified });
const mediaHandler = createMediaHandler({ mediaDir });

const server = http.createServer(async (req, res) => {
  const rawPath = String(req.url || "/").split("?")[0];
  const isApiRequest = rawPath.startsWith("/api/");
  try {
    if (!security.isAllowedHost(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden: Invalid Host header");
      return;
    }

    // The URL parser quietly resolves "%2e%2e" into "..", so encoded traversal
    // is refused on the raw request path, before any parsing.
    if (/(^|\/)(?:\.|%2e){2}(?:\/|$)|%2f|%5c|%00|\\/i.test(rawPath)) {
      throw new security.HttpError(400, "Malformed URL.", "badPath");
    }

    const url = new URL(req.url, "http://localhost");

    if (isApiRequest && security.isWriteMethod(req.method)) {
      // A limited agent token (lib/agent-tokens.js) reaches one route only;
      // everything else needs the page or the master token.
      const bearer = security.bearerToken(req);
      const agent = bearer && !security.tokensMatch(bearer, apiToken) ? agentTokens.findToken(store, bearer) : null;
      if (agent) {
        agentTokens.assertAllowedWrite(agent, { method: req.method, pathname: url.pathname, body: { operations: [] } });
        req.agentToken = agent;
      } else {
        const denied = security.checkWriteAccess(req, { apiToken });
        if (denied) throw denied;
      }
    }

    if (isApiRequest) {
      await handleApiRequest(req, res, url);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") throw new security.HttpError(405, "Method not allowed", "methodNotAllowed");

    if (url.pathname === "/media" || url.pathname.startsWith("/media/")) {
      await serveMedia(req, res, url);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // The address of the page names the startup, so the bare address goes to
      // the one used last. With no startups yet, the page offers to create one.
      const target = url.pathname === "/" ? lastUsedStartup() : null;
      if (target) {
        redirect(res, `/s/${encodeURIComponent(target.id)}/${url.search}`);
        return;
      }
      await staticHandler.serve(req, res, pageUrl(url));
      return;
    }

    const pageMatch = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
    if (pageMatch) {
      const startup = findOpenStartup(safeDecode(pageMatch[1]));
      if (!startup) {
        redirect(res, "/");
        return;
      }
      if (pageMatch[2] === undefined) {
        redirect(res, `/s/${encodeURIComponent(startup.id)}/${url.search}`);
        return;
      }
      // /s/<id>/agents/<runId> opens one agent run in its own window.
      if (pageMatch[2] !== "/" && pageMatch[2] !== "/index.html" && !/^\/agents\/run-[a-z0-9]{6,40}$/.test(pageMatch[2])) throw new security.HttpError(404, "Not found", "notFound");
      await staticHandler.serve(req, res, pageUrl(url));
      return;
    }

    await staticHandler.serve(req, res, url);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (isApiRequest) {
      sendJson(res, { ok: false, error: error.message, code: error.code || "" }, status);
    } else {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end(status === 404 ? "Not found" : error.message);
    }
  }
});

async function handleApiRequest(req, res, url) {
  const pathname = url.pathname;

  const startupRoute = pathname.match(/^\/api\/s\/([^/]+)(\/.*)?$/);
  if (startupRoute) {
    const startup = findOpenStartup(safeDecode(startupRoute[1]));
    if (!startup) throw new security.HttpError(404, "Unknown startup.", "unknownStartup");
    await handleStartupApi(req, res, url, startup.id, startupRoute[2] || "/");
    return;
  }

  if (pathname === "/api/startups" && req.method === "GET") {
    const list = startups.listStartups(store);
    sendJson(res, {
      ok: true,
      startups: url.searchParams.get("counts") === "1" ? list.map((startup) => ({ ...startup, ...startupSize(startup.id) })) : list,
      revision: store.getRevision(GLOBAL_STARTUP_ID),
    });
    return;
  }

  // The setup in the browser (lib/setup.js): how far it got.
  if (pathname === "/api/setup" && req.method === "GET") {
    sendJson(res, { ok: true, setup: setupState.readSetup(store), demo: demo.findDemoStartup(store) });
    return;
  }

  if (pathname === "/api/setup" && req.method === "PUT") {
    const parsed = await readJsonBody(req);
    sendJson(res, { ok: true, setup: setupState.writeSetup(store, parsed) });
    return;
  }

  // The fictional demo startup (lib/demo.js): added in one click, removed in
  // one click, after a safety backup like any startup deletion.
  if (pathname === "/api/demo" && req.method === "POST") {
    const startup = demo.addDemoStartup(store);
    lastWriteAt = Date.now();
    sendJson(res, { ok: true, startup }, 201);
    return;
  }

  if (pathname === "/api/demo" && req.method === "DELETE") {
    const found = demo.findDemoStartup(store);
    if (!found) throw new security.HttpError(404, "There is no demo startup.", "noDemo");
    const removed = deleteStartupWithBackup(found.id);
    demo.forgetDemo(store);
    lastWriteAt = Date.now();
    sendJson(res, { ok: true, ...removed, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/startups" && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const startup = startups.createStartup(store, {
      name: parsed.name,
      icon: parsed.icon,
      copySettingsFrom: parsed.copySettingsFrom,
      copyProfileFields: Array.isArray(parsed.copyProfileFields) ? parsed.copyProfileFields : null,
      copyRecords: parsed.copyRecords === true,
    }, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    fs.mkdirSync(startupMediaDir(startup.id), { recursive: true });
    sendJson(res, { ok: true, startup, revision: store.getRevision(GLOBAL_STARTUP_ID) }, 201);
    return;
  }

  const startupMatch = pathname.match(/^\/api\/startups\/([^/]+)$/);
  if (startupMatch && req.method === "PATCH") {
    const parsed = await readJsonBody(req);
    const patch = {};
    for (const key of ["name", "icon", "order", "archived"]) {
      if (parsed[key] !== undefined) patch[key] = parsed[key];
    }
    // The page reports that it was opened; the time is the server's.
    if (parsed.opened === true) patch.lastOpenedAt = new Date().toISOString();
    const startup = startups.updateStartup(store, safeDecode(startupMatch[1]), patch, {
      origin: historyOrigin(parsed.origin),
      actor: historyActor(parsed.origin),
    });
    sendJson(res, { ok: true, startup, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (startupMatch && req.method === "DELETE") {
    const deleted = deleteStartupWithBackup(safeDecode(startupMatch[1]));
    sendJson(res, { ok: true, ...deleted, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/global" && req.method === "GET") {
    const revision = store.getRevision(GLOBAL_STARTUP_ID);
    const headers = { ETag: formatRevisionEtag(revision), "X-State-Revision": String(revision) };
    if (revisionEtagMatches(req.headers["if-none-match"], revision)) {
      sendNotModified(res, headers);
      return;
    }
    const { state } = store.readState(GLOBAL_STARTUP_ID);
    // The startup list and the agent tokens have their own routes, so they
    // are not part of this payload.
    delete state[STARTUPS_SECTION];
    delete state[agentTokens.SECTION];
    sendJson(res, { ok: true, state, revision, revisionMap: store.readRevisionMap(GLOBAL_STARTUP_ID) }, 200, headers);
    return;
  }

  if (pathname === "/api/global/operations" && req.method === "PATCH") {
    const parsed = await readJsonBody(req, MAX_STATE_BODY_BYTES);
    const operations = Array.isArray(parsed.operations) ? parsed.operations : [];
    if (operations.length === 0) throw new security.HttpError(400, "No operations were provided.", "noOperations");
    if (operations.some((operation) => operation?.section === STARTUPS_SECTION)) {
      throw new security.HttpError(400, "The startup list changes through /api/startups.", "startupsSection");
    }
    if (operations.some((operation) => operation?.section === agentTokens.SECTION)) {
      throw new security.HttpError(400, "Agent tokens change through /api/agent-tokens.", "agentTokensSection");
    }
    // An agent's command is set only through /api/agents, which asks for
    // confirmation first.
    if (operations.some((operation) => operation?.section === agentHarnesses.HARNESSES_SECTION)) {
      throw new security.HttpError(400, "AI agents change through /api/agents.", "agentHarnessesSection");
    }
    applyOperationsResponse(res, GLOBAL_STARTUP_ID, operations, parsed);
    return;
  }

  // Tags are shared: renaming, merging or deleting one rewrites the records
  // of every startup that carry it (lib/tags.js).
  if (pathname === "/api/global/tags/usage" && req.method === "GET") {
    sendJson(res, { ok: true, usage: tagStore.tagUsage(store) });
    return;
  }

  const tagAction = pathname.match(/^\/api\/global\/tags\/(rename|merge|delete)$/);
  if (tagAction && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const options = { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) };
    let result;
    if (tagAction[1] === "rename") {
      result = tagStore.renameTag(store, parsed.from, parsed.to, options);
    } else {
      // Merging and deleting cannot be undone in one step, so a safety backup
      // comes first; a failed backup stops the change.
      const safetyBackup = backups.safety(tagAction[1] === "merge" ? `before merging tags into ${tagStore.normalizeTag(parsed.to)}` : `before deleting the tag ${tagStore.normalizeTag(parsed.tag)}`);
      result = tagAction[1] === "merge" ? tagStore.mergeTags(store, parsed.from, parsed.to, options) : tagStore.deleteTag(store, parsed.tag, options);
      result.safetyBackup = safetyBackup.id;
    }
    for (const startupId of result.startupsChanged) forgetCachedState(startupId);
    lastWriteAt = Date.now();
    sendJson(res, { ok: true, ...result, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  // Limited tokens for AI agents (lib/agent-tokens.js). They are made from a
  // startup's page (POST /api/s/<startupId>/agent-tokens), listed and revoked here.
  if (pathname === "/api/agent-tokens" && req.method === "GET") {
    const startupId = url.searchParams.get("startupId") || undefined;
    sendJson(res, { ok: true, tokens: agentTokens.listTokens(store, { startupId }) });
    return;
  }

  const revokeMatch = pathname.match(/^\/api\/agent-tokens\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    sendJson(res, { ok: true, token: agentTokens.revokeToken(store, safeDecode(revokeMatch[1])) });
    return;
  }

  // Settings > AI agents and agent runs (lib/agents/routes.js).
  if (await agentRoutes.handle(req, res, url)) return;

  // Company templates (lib/company/templates.js).
  if (pathname === "/api/company/templates" && req.method === "GET") {
    sendJson(res, { ok: true, ...companyTemplates.listTemplates() });
    return;
  }

  const templateMatch = pathname.match(/^\/api\/company\/templates\/([^/]+)$/);
  if (templateMatch && req.method === "GET") {
    const template = companyTemplates.getTemplate(safeDecode(templateMatch[1]));
    if (!template) throw new security.HttpError(404, "No such company template.", "unknownTemplate");
    sendJson(res, { ok: true, template });
    return;
  }

  if (pathname === "/api/options" && req.method === "GET") {
    sendJson(res, { ok: true, ...optionStore.readOptions(store), revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/options" && req.method === "PUT") {
    const parsed = await readJsonBody(req);
    const options = optionStore.writeOptions(store, parsed.lists, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    sendJson(res, { ok: true, ...options, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname.startsWith("/api/all/")) {
    // Combined views read every open startup and never write.
    if (req.method !== "GET" && req.method !== "HEAD") throw new security.HttpError(405, "The combined views are read-only.", "methodNotAllowed");
    if (pathname === "/api/all/search") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === null ? undefined : Number(limitParam);
      if (limitParam !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
        throw new security.HttpError(400, "limit must be an integer between 1 and 500", "badLimit");
      }
      sendJson(res, { ok: true, query: url.searchParams.get("q") || "", ...searchAll(store, url.searchParams.get("q"), { limit }) });
      return;
    }
    if (pathname === "/api/all/campaign-targets") {
      let targets;
      try {
        targets = campaignTargets(store, url.searchParams.get("campaign"));
      } catch (error) {
        if (error instanceof RangeError) throw new security.HttpError(400, error.message, "badCampaign");
        throw error;
      }
      sendJson(res, { ok: true, ...targets });
      return;
    }
    if (pathname === "/api/all/calendar") {
      let calendar;
      try {
        calendar = calendarAll(store, { from: url.searchParams.get("from") || "", to: url.searchParams.get("to") || "" });
      } catch (error) {
        if (error instanceof RangeError) throw new security.HttpError(400, error.message, "badDate");
        throw error;
      }
      sendJson(res, { ok: true, ...calendar });
      return;
    }
  }

  if (pathname === "/api/statuses" && req.method === "GET") {
    sendJson(res, {
      ok: true,
      statuses: statusStore.readStatuses(store),
      priorities: PRIORITIES,
      revision: store.getRevision(GLOBAL_STARTUP_ID),
    });
    return;
  }

  if (pathname === "/api/statuses" && req.method === "PUT") {
    const parsed = await readJsonBody(req);
    const statuses = statusStore.writeStatuses(store, parsed.statuses, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    sendJson(res, { ok: true, statuses, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/fields" && req.method === "GET") {
    sendJson(res, { ok: true, registry: fieldRegistry.readRegistry(), custom: fieldRegistry.readCustomFields(store), revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/fields/custom" && req.method === "PUT") {
    const parsed = await readJsonBody(req);
    const custom = fieldRegistry.writeCustomFields(store, parsed.fields, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    sendJson(res, { ok: true, custom, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname.startsWith("/api/taxonomy")) {
    await handleTaxonomyRequest(req, res, pathname);
    return;
  }

  const statusDeleteMatch = pathname.match(/^\/api\/(statuses|campaign-statuses)\/([a-z][a-z0-9_]{0,40})\/delete$/);
  if (statusDeleteMatch && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const remove = statusDeleteMatch[1] === "statuses" ? statusStore.deleteStatus : statusStore.deleteCampaignStatus;
    const result = remove(store, statusDeleteMatch[2], parsed.moveTo, { actor: historyActor(parsed.origin) });
    // Records moved in any number of startups.
    forgetCachedState(null);
    sendJson(res, { ok: true, ...result, revision: store.getRevision(GLOBAL_STARTUP_ID) });
    return;
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, {
      ok: true,
      settings: settingsStore.readSettings(store),
      defaults: settingsStore.defaults(),
      revision: store.getRevision(GLOBAL_STARTUP_ID),
    });
    return;
  }

  if (pathname === "/api/settings" && req.method === "PATCH") {
    const parsed = await readJsonBody(req);
    const result = settingsStore.writeSettings(store, parsed.settings, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    sendJson(res, { ok: true, ...result });
    return;
  }

  if (pathname === "/api/backups" && req.method === "GET") {
    const startupId = url.searchParams.get("startupId") || "";
    if (startupId && !startups.getStartup(store, startupId)) throw new security.HttpError(404, "Unknown startup.", "unknownStartup");
    sendJson(res, { ok: true, backupDir, backups: backups.list({ startupId }) });
    return;
  }

  if (pathname === "/api/backups" && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const backup = backups.create("pinned", { label: parsed.label, reason: "requested" });
    sendJson(res, { ok: true, backup }, 201);
    return;
  }

  const backupMatch = pathname.match(/^\/api\/backups\/([^/]+)(?:\/([a-z]+))?$/);
  if (backupMatch) {
    const backupId = safeDecode(backupMatch[1]);
    const action = backupMatch[2] || "";
    if (action === "verify" && req.method === "POST") {
      const result = backups.verify(backupId);
      sendJson(res, { ok: true, id: result.id, verified: result.ok, problems: result.problems });
      return;
    }
    if (action === "compare" && req.method === "GET") {
      const startupId = url.searchParams.get("startupId") || "";
      if (!startups.getStartup(store, startupId)) throw new security.HttpError(404, "Unknown startup.", "unknownStartup");
      sendJson(res, { ok: true, ...backups.compare(backupId, startupId) });
      return;
    }
    if (action === "restore" && req.method === "POST") {
      const parsed = await readJsonBody(req);
      const restored = backups.restore(backupId, { scope: parsed.scope, startupId: parsed.startupId, records: parsed.records });
      sendJson(res, { ok: true, restored });
      return;
    }
    if (action === "download" && req.method === "GET") {
      const filePath = backups.databasePath(backupId);
      sendDownload(res, fs.readFileSync(filePath), "application/vnd.sqlite3", `startup-tracker-${backupId}.sqlite`);
      return;
    }
    if (!action && req.method === "DELETE") {
      sendJson(res, { ok: true, ...backups.remove(backupId) });
      return;
    }
  }

  if (pathname === "/api/export" && req.method === "GET") {
    const format = url.searchParams.get("format") || "zip";
    if (format === "sqlite") {
      sendDownload(res, backups.exportDatabase(), "application/vnd.sqlite3", `startup-tracker-database-${fileStamp()}.sqlite`);
      return;
    }
    const requested = (url.searchParams.get("startups") || "").split(",").map((id) => id.trim()).filter(Boolean);
    const startupIds = requested.length ? requested : startups.listStartups(store, { includeArchived: false }).map((startup) => startup.id);
    const exported = backups.exportStartups(startupIds, exportFormat(url), { includeSensitive: url.searchParams.get("includeSensitive") === "1" });
    sendDownload(res, exported.data, exported.contentType, `startup-tracker-${requested.length === 1 ? requested[0] : "startups"}-${fileStamp()}.${exported.extension}`);
    return;
  }

  if (pathname === "/api/import" && req.method === "POST") {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!IMPORT_CONTENT_TYPES.has(contentType)) {
      throw new security.HttpError(415, "Send the file as application/zip, application/json or application/octet-stream.", "unsupportedMediaType");
    }
    let body;
    try {
      body = await readRawBody(req, MAX_IMPORT_BYTES);
    } catch (error) {
      throw new security.HttpError(413, error.message, "tooLarge");
    }
    sendJson(res, { ok: true, ...backups.prepareImport(body) });
    return;
  }

  const importMatch = pathname.match(/^\/api\/import\/([0-9a-f]{32})\/apply$/);
  if (importMatch && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const applied = backups.applyPreparedImport(importMatch[1], { mode: parsed.mode, startupId: parsed.startupId });
    sendJson(res, { ok: true, imported: applied });
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, {
      ok: true,
      filePath: databaseFile,
      mediaDir,
      version: APP_VERSION,
      revision: store.getInfo().revision,
      startupCount: startups.listStartups(store).length,
    });
    return;
  }

  if (pathname === "/api/about" && req.method === "GET") {
    sendJson(res, { ok: true, ...aboutFacts() });
    return;
  }

  if (pathname === "/api/about/verify" && req.method === "POST") {
    runIntegrityCheck();
    sendJson(res, { ok: true, ...aboutFacts() });
    return;
  }

  // Whether a newer release exists (lib/cli/update.js). GET answers from the
  // day-old cache, or asks GitHub when the network switch in Settings >
  // General allows it; POST is "Check for updates now", which asks anyway.
  // Installing stays a command: startup-tracker update.
  if (pathname === "/api/about/update" && (req.method === "GET" || req.method === "POST")) {
    const offline = process.env.STARTUP_TRACKER_OFFLINE === "1";
    const result = await updateCheck.checkForUpdate({
      paths,
      pkg: require("./package.json"),
      force: req.method === "POST" && !offline,
      offline,
      networkAllowed: () => settingsStore.readSettings(store).network !== false,
    });
    sendJson(res, { ok: true, update: req.method === "POST" && offline ? { ...result, error: "The network is off for this run." } : result });
    return;
  }

  sendJson(res, { ok: false, error: "notFound", message: "Unknown API route." }, 404);
}

// Routes of one startup, under /api/s/<startupId>/. The startup was checked
// before this runs: it exists and is not archived.
async function handleStartupApi(req, res, url, startupId, subPath) {
  if (subPath === "/state" && req.method === "GET") {
    // Validate against the startup's revision counter rather than a content
    // hash. Hashing a large state costs ~200ms and the counter already changes
    // exactly when the content does, so an unchanged 304 costs nothing.
    const currentRevision = store.getRevision(startupId);
    const stateHeaders = {
      ETag: formatRevisionEtag(currentRevision),
      "X-State-Revision": String(currentRevision),
      "X-File-Path": databaseFile,
      "X-Media-Dir": startupMediaDir(startupId),
    };
    if (revisionEtagMatches(req.headers["if-none-match"], currentRevision)) {
      sendNotModified(res, stateHeaders);
      return;
    }
    const entry = readStartupStateBody(startupId);
    sendJsonBody(res, entry.body, 200, {
      ...stateHeaders,
      ETag: formatRevisionEtag(entry.revision),
      "X-State-Revision": String(entry.revision),
    }, `state\0${startupId}\0${entry.revision}`);
    return;
  }

  if (subPath === "/state/operations" && req.method === "PATCH") {
    const parsed = await readJsonBody(req, MAX_STATE_BODY_BYTES);
    if ((Array.isArray(parsed.operations) ? parsed.operations : []).some((operation) => operation?.section === CompanyModel.SECTIONS.secrets)) {
      throw new security.HttpError(400, "Sensitive company values change through /company/secrets.", "sensitiveSection");
    }
    if (req.agentToken) {
      agentTokens.assertAllowedWrite(req.agentToken, { method: req.method, pathname: url.pathname, body: parsed });
      // An agent's writes are "api" in the history, named after its token.
      parsed.origin = "api";
      parsed.agentActor = `Agent: ${req.agentToken.label}`;
      agentTokens.touchToken(store, req.agentToken);
    }
    const operations = Array.isArray(parsed.operations) ? parsed.operations.slice() : [];
    const missingLockBases = operations.filter((operation) =>
      operation && operation.type !== "replaceSection"
      && (operation.baseRevision === undefined || operation.baseRevision === null));
    const unlockedSectionReplacements = operations.filter((operation) =>
      operation && (operation.type === "reorder" || operation.type === "replaceSection")
      && operation.section !== "updatedAt"
      && (operation.baseRevision === undefined || operation.baseRevision === null));
    if (parsed.protocolVersion !== 2 || missingLockBases.length > 0 || unlockedSectionReplacements.length > 0) {
      sendJson(res, {
        ok: false,
        error: "reloadRequired",
        message: "This browser tab uses an older save format. Reload it before saving.",
        revision: store.getRevision(startupId),
      }, 409);
      return;
    }
    // A page that loaded before a restore or an import replaced this startup
    // holds edits against data that is gone. They are refused, not replayed;
    // the page keeps them for the person to decide on.
    if (parsed.knownRevision !== undefined && parsed.knownRevision !== null) {
      const known = Number(parsed.knownRevision);
      const lineageStart = store.getLineageStart(startupId);
      if (!Number.isSafeInteger(known) || known < lineageStart) {
        sendJson(res, {
          ok: false,
          error: "restored",
          message: "This startup was restored or imported after the page loaded. Nothing was saved; reload to see its data and decide on your unsent edits.",
          revision: store.getRevision(startupId),
          lineageStart,
        }, 409);
        return;
      }
    }
    if (parsed.updatedAt) {
      operations.push({ type: "replaceSection", section: "updatedAt", value: String(parsed.updatedAt) });
    }
    if (operations.length === 0) throw new security.HttpError(400, "No state operations were provided.", "noOperations");
    applyOperationsResponse(res, startupId, operations, parsed);
    return;
  }

  // Records that changed after `since`, so a client that fell behind by a few
  // revisions can catch up without refetching the whole state.
  if (subPath === "/state/changes" && req.method === "GET") {
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam === null || sinceParam === "" ? NaN : Number(sinceParam);
    if (!Number.isSafeInteger(since) || since < 0) {
      sendJson(res, { ok: false, error: "since must be a non-negative integer" }, 400);
      return;
    }
    const changes = store.readChangesSince(startupId, since);
    if (changes) changes.sections = changes.sections.filter((entry) => entry.section !== CompanyModel.SECTIONS.secrets);
    if (!changes) {
      // The gap is older than the retained tombstone window, so a delta
      // cannot be proven complete. The client must do a full load.
      sendJson(res, { ok: true, complete: false, revision: store.getRevision(startupId) });
      return;
    }
    sendJson(res, { ok: true, ...changes, revisionMap: startupRevisionMap(startupId) });
    return;
  }

  // Timeline for one record, read lazily when the History tab is opened.
  // Deliberately sends no ETag: the client asks for this once per tab open and
  // a stale 304 would show a timeline missing the edit that was just saved.
  if (subPath === "/state/history" && req.method === "GET") {
    const section = url.searchParams.get("section") || "";
    const id = url.searchParams.get("id") || "";
    if (section === CompanyModel.SECTIONS.secrets) throw new security.HttpError(403, "Sensitive company values keep no readable history.", "sensitive");
    if (!section || !id) {
      sendJson(res, { ok: false, error: "section and id are both required" }, 400);
      return;
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limitParam !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
      sendJson(res, { ok: false, error: "limit must be an integer between 1 and 500" }, 400);
      return;
    }
    const offsetParam = url.searchParams.get("offset");
    const offset = offsetParam === null ? undefined : Number(offsetParam);
    if (offsetParam !== null && (!Number.isSafeInteger(offset) || offset < 0)) {
      sendJson(res, { ok: false, error: "offset must be a non-negative integer" }, 400);
      return;
    }

    try {
      const history = readMergedRecordHistory(startupId, section, id, { limit, offset });
      sendJson(res, { ok: true, section, id, ...history });
    } catch (error) {
      sendJson(res, { ok: false, error: "badRequest", message: error.message }, 400);
    }
    return;
  }

  const recordMatch = subPath.match(/^\/state\/records\/([^/]+)\/([^/]+)$/);
  if (recordMatch && req.method === "GET") {
    const section = safeDecode(recordMatch[1]);
    const id = safeDecode(recordMatch[2]);
    const entry = store.getRecordWithRevision(startupId, section, id);
    if (!entry) {
      sendJson(res, {
        ok: false,
        error: "Record not found",
        revision: store.getRevision(startupId),
        recordRevision: null,
      }, 404);
      return;
    }
    sendJson(res, {
      ok: true,
      record: entry.record,
      recordRevision: entry.revision,
      revision: store.getRevision(startupId),
    });
    return;
  }

  if (subPath === "/export" && req.method === "GET") {
    const exported = backups.exportStartups([startupId], exportFormat(url), { includeSensitive: url.searchParams.get("includeSensitive") === "1" });
    sendDownload(res, exported.data, exported.contentType, `startup-tracker-${startupId}-${fileStamp()}.${exported.extension}`);
    return;
  }

  if (subPath === "/media/upload" && req.method === "POST") {
    const uploaded = await handleMediaUpload(req, startupId);
    sendJson(res, { ok: true, mediaDir: startupMediaDir(startupId), ...uploaded });
    return;
  }

  // Sensitive company values (national ids, bank accounts) are read and
  // written only here, by the page or with the master token: never through
  // /state, an agent token, the history or an export unless asked for.
  if (subPath === "/company/secrets") {
    const bearer = security.bearerToken(req);
    if (!(bearer ? security.tokensMatch(bearer, apiToken) : security.isSameOriginRequest(req))) {
      throw new security.HttpError(403, "Sensitive company values are only shown in the tracker page.", "sensitive");
    }
    if (req.method === "GET") {
      sendJson(res, { ok: true, secrets: CompanyModel.normalizeSecrets(store.readSection(startupId, CompanyModel.SECTIONS.secrets)) });
      return;
    }
    if (req.method === "PUT") {
      const parsed = await readJsonBody(req);
      const secrets = CompanyModel.normalizeSecrets(parsed.secrets);
      store.replaceSection(startupId, CompanyModel.SECTIONS.secrets, secrets, { origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin), label: "Company sensitive values" });
      forgetCachedState(startupId);
      sendJson(res, { ok: true, secrets });
      return;
    }
  }

  if (await agentRoutes.handleStartup(req, res, url, startupId, subPath)) return;

  if (subPath === "/agent-tokens" && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const created = agentTokens.createToken(store, { startupId, label: parsed.label, hours: parsed.hours ?? agentTokens.DEFAULT_HOURS });
    sendJson(res, { ok: true, ...created }, 201);
    return;
  }

  if (subPath === "/media/copy" && req.method === "POST") {
    const parsed = await readJsonBody(req);
    const to = String(parsed.to || "");
    if (!findOpenStartup(to)) throw new security.HttpError(404, "Pick an open startup to copy to.", "unknownStartup");
    const copy = mediaFiles.copyMediaItem({ store, mediaDir, fromStartupId: startupId, toStartupId: to, mediaId: parsed.mediaId, origin: historyOrigin(parsed.origin), actor: historyActor(parsed.origin) });
    forgetCachedState(to);
    lastWriteAt = Date.now();
    sendJson(res, { ok: true, media: copy, to });
    return;
  }

  // Files of media records deleted for good. Each goes only when nothing in
  // the startup names it any more, so a record still in the bin keeps its file.
  if (subPath === "/media/remove-files" && req.method === "POST") {
    const parsed = await readJsonBody(req);
    sendJson(res, { ok: true, ...mediaFiles.removeUnusedFiles(store, mediaDir, startupId, parsed.files) });
    return;
  }

  if (subPath === "/media/document" && req.method === "PUT") {
    const parsed = await readJsonBody(req);
    const saved = await saveMarkdownDocument(parsed, startupId);
    sendJson(res, { ok: true, ...saved });
    return;
  }

  sendJson(res, { ok: false, error: "notFound", message: "Unknown API route." }, 404);
}

// One write through the store, answered the same way for a startup and for the
// global scope.
function applyOperationsResponse(res, startupId, operations, parsed) {
  try {
    // Operations carry their own per-record baseRevision, so the startup is not
    // required to sit at the revision the client last saw. A stale revision is
    // only enforced when the client explicitly asks for it via strictRevision.
    const result = store.applyOperations(startupId, operations, {
      expectedRevision: parsed.strictRevision ? parsed.baseRevision : undefined,
      mutationId: parsed.mutationId,
      // Saves from the browser are the "ui" origin in the history timeline.
      // Anything posting without saying so is recorded as "api", which
      // normalizeHistoryContext falls back to.
      origin: parsed.origin,
      actor: parsed.agentActor || historyActor(parsed.origin),
      label: parsed.label,
    });
    if (!result.unchanged) lastWriteAt = Date.now();
    sendJson(res, {
      ok: true,
      unchanged: result.unchanged,
      replayed: Boolean(result.replayed),
      filePath: databaseFile,
      mediaDir: startupId === GLOBAL_STARTUP_ID ? mediaDir : startupMediaDir(startupId),
      revision: result.revision,
      revisionMap: startupRevisionMap(startupId),
    });
  } catch (error) {
    if (error instanceof RecordConflictError) {
      // Only the listed records collided. Everything else the client holds
      // is still valid, so it does not need to reload or stop editing.
      sendJson(res, {
        ok: false,
        error: "recordConflict",
        message: error.message,
        conflicts: error.conflicts,
        revision: store.getRevision(startupId),
        revisionMap: startupRevisionMap(startupId),
      }, 409);
      return;
    }
    if (error instanceof RevisionConflictError) {
      sendJson(res, {
        ok: false,
        error: "conflict",
        message: error.message,
        revision: store.getRevision(startupId),
      }, 409);
      return;
    }
    if (error instanceof TypeError) throw new security.HttpError(400, error.message, "badOperation");
    throw error;
  }
}

// Only a browser save gets a name attached. An "api" write is some script or
// another agent, and guessing that it was the person at the keyboard would put
// the wrong name on it.
function historyActor(origin) {
  if (origin !== "ui") return null;
  return UI_ACTOR || settingsStore.readSettings(store).yourName || null;
}

function historyOrigin(origin) {
  return origin === "ui" ? "ui" : "api";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

// The page itself, whatever address it was asked for under.
function pageUrl(url) {
  const page = new URL(url.href);
  page.pathname = "/index.html";
  return page;
}

function findOpenStartup(startupId) {
  const startup = startups.getStartup(store, startupId);
  return startup && !startup.archived ? startup : null;
}

function lastUsedStartup() {
  const open = startups.listStartups(store, { includeArchived: false });
  if (!open.length) return null;
  const opened = open.filter((startup) => startup.lastOpenedAt);
  if (!opened.length) return open[0];
  return opened.reduce((latest, startup) => (startup.lastOpenedAt > latest.lastOpenedAt ? startup : latest));
}

function startupMediaDir(startupId) {
  return path.join(mediaDir, startupId);
}

function readStartupStateBody(startupId) {
  const revision = store.getRevision(startupId);
  const cached = stateBodyCache.get(startupId);
  if (cached && cached.revision === revision) return cached;
  // The store may also be written by a maintenance process. Its durable
  // revision is authoritative, so anything cached for an older one is dropped.
  const result = store.readState(startupId);
  // Sensitive company values have their own route.
  delete result.state[CompanyModel.SECTIONS.secrets];
  const hasState = Object.keys(result.state).length > 0;
  // revisionMap ships with the state so the client knows which revision each
  // individual record is based on, which is what per-record conflict
  // detection needs on the next save.
  const body = JSON.stringify({
    ok: true,
    startupId,
    filePath: databaseFile,
    mediaDir: startupMediaDir(startupId),
    state: hasState ? result.state : null,
    fileHash: hasState ? result.stateHash : "",
    revision: result.revision,
    revisionMap: startupRevisionMap(startupId),
  });
  const entry = { revision: result.revision, body };
  stateBodyCache.set(startupId, entry);
  return entry;
}

// The revision map the page gets, without the sensitive company values' entry
// (they have their own route).
function startupRevisionMap(startupId) {
  const map = store.readRevisionMap(startupId);
  delete map.sections[CompanyModel.SECTIONS.secrets];
  delete map.records[CompanyModel.SECTIONS.secrets];
  return map;
}

// /media/<startupId>/<file>. A link from before startups existed names only
// the file, so it is sent on to the startup folder that holds that file.
async function serveMedia(req, res, url) {
  const segments = url.pathname.slice("/media".length).split("/").filter(Boolean);
  if (segments.length === 1) {
    const fileName = safeDecode(segments[0]);
    // The startup list, not the ids holding records: a startup can have uploads
    // before it has any records.
    const owner = startups.listStartups(store)
      .map((startup) => startup.id)
      .find((startupId) => resolveMediaFileSync(mediaDir, `${startupId}/${fileName}`));
    if (!owner) throw new security.HttpError(404, "Not found", "notFound");
    redirect(res, `/media/${encodeURIComponent(owner)}/${segments[0]}`);
    return;
  }
  await mediaHandler.serve(req, res, url);
}

// Takes a safety backup first, which holds the database and the media files,
// and stops if it cannot. Then removes the startup's rows and media folder.
function deleteStartupWithBackup(startupId) {
  const startup = startups.getStartup(store, startupId);
  if (!startup) throw new security.HttpError(404, "Unknown startup.", "unknownStartup");
  const safetyBackup = backups.safety(`before deleting ${startup.name} (${startup.id})`);
  startups.deleteStartup(store, startup.id, { origin: "api" });
  forgetCachedState(startup.id);
  const folder = startupMediaDir(startup.id);
  if (fs.existsSync(folder) && fs.lstatSync(folder).isDirectory()) fs.rmSync(folder, { recursive: true, force: true });
  return { deleted: startup, safetyBackup: safetyBackup.id };
}

// Drops what is cached for one startup, or for all of them when replaced data
// may touch any (a whole-database restore or import).
function forgetCachedState(startupId) {
  if (startupId) stateBodyCache.delete(startupId);
  else stateBodyCache.clear();
  responseCompressionCache.clear();
}

function startupSize(startupId) {
  const { state } = store.readState(startupId);
  let recordCount = 0;
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) recordCount += value.length;
  }
  let mediaBytes = 0;
  const visit = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) mediaBytes += fs.statSync(full).size;
    }
  };
  visit(startupMediaDir(startupId));
  return { recordCount, mediaBytes };
}

function exportFormat(url) {
  const format = url.searchParams.get("format") || "zip";
  if (format !== "zip" && format !== "json") throw new security.HttpError(400, "The export format is zip or json.", "badFormat");
  return format;
}

function fileStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

function sendDownload(res, data, contentType, fileName) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function runIntegrityCheck() {
  const report = store.checkIntegrity();
  const problems = [];
  if (report.integrity.length !== 1 || report.integrity[0] !== "ok") problems.push(`integrity_check reported: ${report.integrity.join(", ")}`);
  if (report.foreignKeyErrors.length) problems.push(`foreign_key_check reported ${report.foreignKeyErrors.length} broken reference(s)`);
  lastIntegrity = { checkedAt: new Date().toISOString(), ok: problems.length === 0, problems };
  return lastIntegrity;
}

function aboutFacts() {
  const info = store.getInfo();
  let databaseBytes = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      databaseBytes += fs.statSync(`${databaseFile}${suffix}`).size;
    } catch {}
  }
  return {
    version: APP_VERSION,
    dataFolder: dataRoot.root,
    databasePath: databaseFile,
    mediaDir,
    backupDir,
    port: server.address()?.port ?? requestedPort,
    schemaVersion: info.schemaVersion,
    databaseBytes,
    integrity: lastIntegrity,
  };
}

// Automatic backups and the recycle bin run on timers that never keep the
// process alive. A failure is logged and tried again on the next tick.
function runMaintenance({ atStart = false } = {}) {
  try {
    backups.maybeAutomatic({ atStart, lastWriteAt });
  } catch (error) {
    console.error(`Automatic backup failed: ${error.message}`);
  }
}

function purgeRecycleBin() {
  try {
    const { purged, mediaFiles: purgedFiles } = purgeExpired(store, { retentionDays: settingsStore.readSettings(store).recycleBin.retentionDays });
    if (purged.length) {
      for (const startupId of new Set(purged.map((entry) => entry.startupId))) forgetCachedState(startupId);
    }
    for (const startupId of new Set(purgedFiles.map((entry) => entry.startupId))) {
      mediaFiles.removeUnusedFiles(store, mediaDir, startupId, purgedFiles.filter((entry) => entry.startupId === startupId).map((entry) => entry.storedName));
    }
  } catch (error) {
    console.error(`Recycle bin clean-up failed: ${error.message}`);
  }
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${requestedPort} is already in use, so Startup Tracker did not start. Stop the program using it, or start with --port <number> or PORT=<number>. The tracker never moves to another port by itself: the browser keeps unsent edits per address.`);
    process.exit(1);
  }
  throw error;
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`Startup Tracker: ${url}`);
  console.log(`Data folder: ${dataRoot.root}`);
  console.log(`Saving automatically to: ${databaseFile}`);
  console.log(`Backups: ${backupDir}`);
  // run/server.json tells the CLI which server runs for this data folder.
  try {
    require("./lib/cli/run-state").writeRunState(paths.runDir, { pid: process.pid, port: address.port, url, startedAt: new Date().toISOString(), version: APP_VERSION });
  } catch (error) {
    console.error(`Could not write ${paths.runDir}: ${error.message}`);
  }
  if (shouldOpenBrowser) openBrowser(url);
  runMaintenance({ atStart: true });
  purgeRecycleBin();
  setInterval(runMaintenance, BACKUP_CHECK_MS).unref();
  setInterval(purgeRecycleBin, RECYCLE_PURGE_MS).unref();
});

function readRequestedPort() {
  const flag = readFlag(cliArgs, "--port");
  const raw = flag !== null ? flag : (process.env.PORT !== undefined && process.env.PORT !== "" ? process.env.PORT : null);
  if (raw === null) {
    if (isDevMode) return DEV_PORT;
    // The port the CLI saved in config.json (lib/cli/config.js), else the default.
    try {
      return require("./lib/cli/config").readConfig(paths.configFile).port ?? DEFAULT_PORT;
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Not a valid port: ${raw}`);
    process.exit(1);
  }
  return port;
}

// JSON bodies must say they are JSON; an empty body counts as {}.
// The category library shared by every startup (lib/taxonomy.js). Deleting
// and merging repoint targets in every startup, so the cached states go.
async function handleTaxonomyRequest(req, res, pathname) {
  const options = (parsed) => ({ origin: historyOrigin(parsed?.origin), actor: historyActor(parsed?.origin) });
  const reply = (payload) => sendJson(res, { ok: true, ...payload, revision: store.getRevision(GLOBAL_STARTUP_ID) });
  if (pathname === "/api/taxonomy" && req.method === "GET") {
    const library = taxonomyStore.readLibraryState(store);
    reply({ nodes: taxonomyStore.readNodes(store), usage: taxonomyStore.usageCounts(store), updates: taxonomyStore.libraryUpdates(store), versions: library.versions });
    return;
  }
  if (pathname === "/api/taxonomy/export" && req.method === "GET") {
    sendDownload(res, Buffer.from(JSON.stringify(taxonomyStore.exportLibrary(store), null, 2)), "application/json", "startup-tracker-categories.json");
    return;
  }
  if (req.method !== "POST" && req.method !== "PATCH") {
    sendJson(res, { ok: false, error: "methodNotAllowed", message: "Method not allowed." }, 405);
    return;
  }
  const parsed = await readJsonBody(req);
  if (pathname === "/api/taxonomy/nodes" && req.method === "POST") {
    reply({ node: taxonomyStore.createNode(store, parsed, options(parsed)) });
    return;
  }
  if (pathname === "/api/taxonomy/reorder" && req.method === "POST") {
    reply({ order: taxonomyStore.reorderNodes(store, parsed.ids, options(parsed)) });
    return;
  }
  if (pathname === "/api/taxonomy/library/accept" && req.method === "POST") {
    reply(taxonomyStore.acceptLibraryNodes(store, Array.isArray(parsed.ids) ? parsed.ids : [], undefined, options(parsed)));
    return;
  }
  if (pathname === "/api/taxonomy/import" && req.method === "POST") {
    reply(taxonomyStore.importLibrary(store, parsed.library, options(parsed)));
    return;
  }
  const match = pathname.match(/^\/api\/taxonomy\/nodes\/([a-z0-9][a-z0-9.-]{0,120})(?:\/(delete|merge|reset))?$/);
  if (match && !match[2] && req.method === "PATCH") {
    reply({ node: taxonomyStore.updateNode(store, match[1], parsed, options(parsed)) });
    return;
  }
  if (match && match[2] === "delete" && req.method === "POST") {
    const result = taxonomyStore.deleteNode(store, match[1], parsed.moveTo || "", options(parsed));
    forgetCachedState(null);
    reply(result);
    return;
  }
  if (match && match[2] === "merge" && req.method === "POST") {
    const result = taxonomyStore.mergeNode(store, match[1], parsed.into, options(parsed));
    forgetCachedState(null);
    reply(result);
    return;
  }
  if (match && match[2] === "reset" && req.method === "POST") {
    reply({ node: taxonomyStore.resetNode(store, match[1], undefined, options(parsed)) });
    return;
  }
  sendJson(res, { ok: false, error: "notFound", message: "Not found." }, 404);
}

async function readJsonBody(req, limitBytes = DEFAULT_JSON_BODY_BYTES) {
  const body = await readBody(req, limitBytes);
  if (!body) return {};
  security.requireJsonContentType(req);
  return security.parseJsonBody(body);
}

function formatRevisionEtag(revision) {
  return `W/"rev-${revision}"`;
}

function revisionEtagMatches(headerValue, revision) {
  if (!headerValue) return false;
  const expected = formatRevisionEtag(revision);
  return String(headerValue)
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === expected || value === `"rev-${revision}"`);
}

function sendNotModified(res, headers = {}) {
  res.writeHead(304, {
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
    ...headers,
  });
  res.end();
}

function initializeStore() {
  // The database is now the only copy of the data, so serving from a damaged one
  // is worse than not starting: edits made on top of corruption are unrecoverable
  // once they push the newest good snapshot out of rotation.
  //
  // This runs before the store opens. Opening read-write writes to the schema, so
  // a badly damaged file throws from inside schema setup, and a bare "database
  // disk image is malformed" stack tells nobody how to get their data back.
  if (fs.existsSync(databaseFile)) {
    const verification = verifyDatabaseFile(databaseFile);
    // A sound database from before startups existed is upgraded in place, after
    // a copy of it is kept in the backup folder.
    const onlyLegacy = verification.legacy && verification.problems.length === 1;
    lastIntegrity = { checkedAt: new Date().toISOString(), ok: verification.ok || onlyLegacy, problems: onlyLegacy ? [] : verification.problems };
    if (!verification.ok && !onlyLegacy) {
      const newestSnapshot = listRestorableSnapshots()[0];
      const advice = newestSnapshot
        ? `The newest verified backup is ${newestSnapshot.fileName} (${newestSnapshot.createdAt}).\n`
          + `  Restore it with: node tools/restore-sqlite.js --snapshot ${newestSnapshot.fileName}`
        : `No usable snapshot was found in ${backupDir}.`;
      throw new Error(
        `${databaseFile} failed its integrity check and the server will not serve from it.\n`
        + `${verification.problems.map((problem) => `  ${problem}`).join("\n")}\n`
        + `  ${advice}`,
      );
    }
  }

  let upgraded = false;
  store = new TrackerSqliteStore(databaseFile, {
    onBeforeUpgrade: ({ fromVersion }) => {
      copyBeforeUpgrade(fromVersion);
      upgraded = true;
    },
  });
  if (upgraded) moveLegacyMedia(store.getInfo().importedStartupId);
}

// The upgrade rewrites every table, so the old file is copied first. The copy
// is checked before the upgrade may start; if it cannot be made, nothing runs.
function copyBeforeUpgrade(fromVersion) {
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  const target = path.join(backupDir, `tracker-${stamp}-pre-upgrade-v${fromVersion}.sqlite`);
  const source = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(target);
  } finally {
    source.close();
  }
  const check = verifyDatabaseFile(target);
  if (!check.legacy || check.problems.length !== 1) {
    throw new Error(`The copy taken before upgrading ${databaseFile} did not verify, so the upgrade did not run: ${check.problems.join("; ")}`);
  }
  console.log(`Upgraded the database to hold several startups. The old file is kept as ${target}`);
}

// Before startups, uploads sat directly in media/. They belong to the startup
// the upgrade created, so they move into its folder; old /media/<file> links
// are redirected there.
function moveLegacyMedia(importedStartupId) {
  if (!importedStartupId) return;
  const target = startupMediaDir(importedStartupId);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destination = path.join(target, entry.name);
    if (!fs.existsSync(destination)) fs.renameSync(path.join(mediaDir, entry.name), destination);
  }
}

// Snapshots that pass verification, newest first. Used to point at a recovery
// path when the live database is unusable, so it must not assume the store is
// open or healthy.
function listRestorableSnapshots() {
  if (!fs.existsSync(backupDir)) return [];
  // Backup folders first: they hold the media files too. The store is not
  // open here, and listing and verifying backups does not need it.
  const manager = createBackupManager({ store: null, backupDir, mediaDir });
  const folders = manager.list()
    .filter((backup) => backup.complete)
    .map((backup) => ({ fileName: backup.id, filePath: manager.databasePath(backup.id), createdAt: backup.createdAt }))
    .filter(({ filePath }) => verifyDatabaseFile(filePath).ok);
  if (folders.length) return folders;
  return fs
    .readdirSync(backupDir)
    .filter((fileName) => BACKUP_FILE_PATTERN.test(fileName))
    .map((fileName) => {
      const filePath = path.join(backupDir, fileName);
      const stats = fs.statSync(filePath);
      return { fileName, filePath, createdAt: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    // A sound copy from before startups existed can be restored too; the
    // server upgrades it on the next start.
    .filter(({ filePath }) => {
      const verification = verifyDatabaseFile(filePath);
      return verification.ok || (verification.legacy && verification.problems.length === 1);
    });
}

// Deleting in the app moves a record between sections rather than removing it,
// so one logical record owns a timeline in each half of the pair. Reading only
// the section the modal is showing would end the story at the last time the
// record came back from the recycle bin.
const RECYCLE_SECTION_PAIRS = new Map([
  ["items", "deletedItems"],
  ["deletedItems", "items"],
  ["programs", "deletedPrograms"],
  ["deletedPrograms", "programs"],
  ["funding", "deletedFunding"],
  ["deletedFunding", "funding"],
]);

// Both halves are read whole and merged before slicing, because interleaving two
// separately paginated timelines by date would drop entries in the middle. A
// record's timeline is tens of entries, so reading it whole costs nothing.
const MERGED_HISTORY_READ_LIMIT = 500;

function readMergedRecordHistory(startupId, section, id, options = {}) {
  const limit = options.limit === undefined ? 200 : options.limit;
  const offset = options.offset === undefined ? 0 : options.offset;
  const sections = [section];
  const paired = RECYCLE_SECTION_PAIRS.get(section);
  if (paired) sections.push(paired);

  let available = false;
  let total = 0;
  const merged = [];
  for (const name of sections) {
    const part = store.readRecordHistory(startupId, name, id, { limit: MERGED_HISTORY_READ_LIMIT });
    if (part.available) available = true;
    total += part.total;
    for (const entry of part.entries) merged.push({ section: name, ...entry });
  }

  // Newest first, and entry_id breaks ties so a delete and the create that
  // completes the same move keep a stable order.
  merged.sort((a, b) => (
    a.changedAt === b.changedAt ? b.entryId - a.entryId : (a.changedAt < b.changedAt ? 1 : -1)
  ));

  return { entries: merged.slice(offset, offset + limit), total, available };
}

function readBody(req, limitBytes = DEFAULT_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const encoding = String(req.headers["content-encoding"] || "identity").toLowerCase();

    const rejectTooLarge = () => {
      if (settled) return;
      settled = true;
      const error = new Error(`Request body is too large. Limit is ${formatBytes(limitBytes)}.`);
      error.statusCode = 413;
      reject(error);
    };

    if (!["identity", "gzip", "br"].includes(encoding)) {
      const error = new Error(`Unsupported request content encoding: ${encoding}`);
      error.statusCode = 415;
      reject(error);
      req.resume();
      return;
    }

    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > limitBytes) {
      rejectTooLarge();
      req.resume();
      return;
    }

    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limitBytes) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      const compressed = Buffer.concat(chunks);
      const finish = (error, decoded) => {
        if (settled) return;
        if (error) {
          if (error.code === "ERR_BUFFER_TOO_LARGE" || error.name === "RangeError") {
            rejectTooLarge();
            return;
          }
          settled = true;
          reject(error);
          return;
        }
        if (decoded.length > limitBytes) {
          rejectTooLarge();
          return;
        }
        settled = true;
        resolve(decoded.toString("utf8"));
      };
      const zlibOptions = { maxOutputLength: limitBytes };
      if (encoding === "gzip") zlib.gunzip(compressed, zlibOptions, finish);
      else if (encoding === "br") zlib.brotliDecompress(compressed, zlibOptions, finish);
      else finish(null, compressed);
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") return fallback;

  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new security.HttpError(413, `Upload is too large. Limit is ${formatBytes(limitBytes)}.`, "tooLarge"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMediaUpload(req, startupId) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new security.HttpError(400, "Upload must use multipart/form-data.", "notMultipart");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const body = await readRawBody(req, MAX_UPLOAD_BYTES);
  const parts = parseMultipart(body, boundary);
  const filePart = parts.find((part) => part.filename);

  if (!filePart || !filePart.data || !filePart.data.length) {
    throw new security.HttpError(400, "No file was uploaded.", "noFile");
  }

  const originalName = sanitizeOriginalFileName(filePart.filename);
  const folder = startupMediaDir(startupId);
  fs.mkdirSync(folder, { recursive: true });
  const storedName = uniqueMediaFileName(folder, originalName);
  const filePath = path.join(folder, storedName);
  assertWritableMediaPath(folder, filePath);
  // "wx" refuses to overwrite an existing file or follow a planted symlink.
  await fs.promises.writeFile(filePath, filePart.data, { flag: "wx" });

  return {
    originalName,
    storedName,
    path: `/media/${encodeURIComponent(startupId)}/${encodeURIComponent(storedName)}`,
    absolutePath: filePath,
    mimeType: filePart.contentType || mimeTypes[path.extname(storedName).toLowerCase()] || "application/octet-stream",
    size: filePart.data.length,
  };
}

async function saveMarkdownDocument(payload, startupId) {
  const folder = startupMediaDir(startupId);
  fs.mkdirSync(folder, { recursive: true });
  const filePath = resolveEditableMarkdownPath(payload, folder);
  if (!isMarkdownFilePath(filePath)) {
    throw new security.HttpError(400, "Only Markdown files can be saved from the document viewer.", "notMarkdown");
  }

  const content = String(payload.content ?? "");
  await fs.promises.writeFile(filePath, content, "utf8");

  return {
    path: mediaWebPath(filePath),
    absolutePath: filePath,
    size: Buffer.byteLength(content, "utf8"),
    updatedAt: new Date().toISOString(),
  };
}

// Only files inside this startup's media folder can be written.
function resolveEditableMarkdownPath(payload, folder) {
  const sourceType = String(payload.sourceType || "").trim();
  if (sourceType === "upload") {
    return resolveUploadedMediaPath(payload, folder);
  }

  if (sourceType === "local-path") {
    const localPath = String(payload.externalPath || payload.absolutePath || payload.filePath || "").trim();
    if (!localPath) {
      throw new security.HttpError(400, "No file path is saved for this media item.", "noPath");
    }
    // A Windows path sent to a tracker on macOS or Linux is on another
    // computer's drive. On Windows every path looks like this.
    if (process.platform !== "win32" && pathLooksLikeWindows(localPath)) {
      throw new security.HttpError(403, "Files on other drives can be opened in their default app, but only files in the media folder can be saved here.", "outsideMedia");
    }
    // Only files inside the media folder can be written, whatever path is sent.
    const resolvedPath = path.isAbsolute(localPath) ? path.resolve(localPath) : path.resolve(folder, localPath);
    const relative = path.relative(folder, resolvedPath);
    const realPath = !relative.startsWith("..") && !path.isAbsolute(relative) ? resolveMediaFileSync(folder, relative) : null;
    if (!realPath) {
      throw new security.HttpError(403, "Only files in the media folder can be saved from the document viewer.", "outsideMedia");
    }
    return realPath;
  }

  throw new security.HttpError(400, "Only files in the media folder can be saved from the document viewer.", "outsideMedia");
}

function resolveUploadedMediaPath(payload, folder) {
  const absolutePath = String(payload.absolutePath || "").trim();
  if (absolutePath) {
    const relative = path.relative(folder, path.resolve(absolutePath));
    const realPath = !relative.startsWith("..") && !path.isAbsolute(relative) ? resolveMediaFileSync(folder, relative) : null;
    if (realPath) return realPath;
  }

  const rawStoredName = payload.storedName || mediaFileNameFromPath(payload.filePath || payload.path || "");
  if (!rawStoredName) {
    throw new security.HttpError(400, "No uploaded file path is saved for this media item.", "noPath");
  }
  const storedName = sanitizeOriginalFileName(rawStoredName);
  const realPath = resolveMediaFileSync(folder, storedName);
  if (!realPath) {
    throw new security.HttpError(404, "Uploaded file was not found in the media folder.", "notFound");
  }
  return realPath;
}

function mediaFileNameFromPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutQuery = raw.split(/[?#]/)[0].replace(/\\/g, "/");
  const mediaIndex = withoutQuery.toLowerCase().lastIndexOf("/media/");
  const fileName = mediaIndex >= 0
    ? withoutQuery.slice(mediaIndex + "/media/".length)
    : withoutQuery.split("/").filter(Boolean).pop();
  try {
    return decodeURIComponent(fileName || "");
  } catch {
    return fileName || "";
  }
}

function pathLooksLikeWindows(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || "")) || /^\\\\/.test(String(value || ""));
}

function isInsidePath(filePath, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMarkdownFilePath(filePath) {
  return /\.(md|markdown)$/i.test(String(filePath || ""));
}

// The address of a file in the media folder. The file may come back with
// symlinks resolved (/private/var on macOS, long folder names on Windows), so
// the media folder is compared both as configured and resolved.
function mediaWebPath(filePath) {
  let realMediaDir = mediaDir;
  try {
    realMediaDir = fs.realpathSync.native(mediaDir);
  } catch {
    // Not created yet; the configured path is all there is.
  }
  const root = [mediaDir, realMediaDir].find((candidate) => isInsidePath(filePath, candidate));
  if (!root) return "";
  const relativePath = path.relative(root, filePath);
  return `/media/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function parseMultipart(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    cursor += boundaryBuffer.length;

    if (body.slice(cursor, cursor + 2).toString("ascii") === "--") {
      break;
    }

    if (body.slice(cursor, cursor + 2).toString("ascii") === "\r\n") {
      cursor += 2;
    }

    const nextBoundary = body.indexOf(boundaryBuffer, cursor);
    if (nextBoundary === -1) break;

    let partBuffer = body.slice(cursor, nextBoundary);
    if (partBuffer.slice(-2).toString("ascii") === "\r\n") {
      partBuffer = partBuffer.slice(0, -2);
    }

    const headerEnd = partBuffer.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const rawHeaders = partBuffer.slice(0, headerEnd).toString("utf8");
      const data = partBuffer.slice(headerEnd + 4);
      const headers = parsePartHeaders(rawHeaders);
      const disposition = headers["content-disposition"] || "";
      const name = matchHeaderParam(disposition, "name");
      const filename = matchHeaderParam(disposition, "filename");

      parts.push({
        name,
        filename,
        contentType: headers["content-type"] || "",
        data,
      });
    }

    cursor = nextBoundary;
  }

  return parts;
}

function parsePartHeaders(rawHeaders) {
  return rawHeaders.split("\r\n").reduce((headers, line) => {
    const index = line.indexOf(":");
    if (index === -1) return headers;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
    return headers;
  }, {});
}

function matchHeaderParam(headerValue, paramName) {
  const pattern = new RegExp(`${paramName}="([^"]*)"`, "i");
  const quoted = headerValue.match(pattern);
  if (quoted) return quoted[1];

  const bare = headerValue.match(new RegExp(`${paramName}=([^;]+)`, "i"));
  return bare ? bare[1].trim() : "";
}

function sanitizeOriginalFileName(fileName) {
  const base = path.basename(String(fileName || "media-file").replace(/\\/g, "/"));
  return base.replace(/[^\w.\- ]+/g, "").trim() || "media-file";
}

function uniqueMediaFileName(folder, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const stem = path.basename(originalName, ext) || "media";
  const safeStem = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "media";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  let candidate = `${stamp}-${safeStem}${ext}`;

  if (!fs.existsSync(path.join(folder, candidate))) {
    return candidate;
  }

  candidate = `${stamp}-${safeStem}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  while (fs.existsSync(path.join(folder, candidate))) {
    candidate = `${stamp}-${safeStem}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  }

  return candidate;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function sendJson(res, payload, status = 200, headers = {}) {
  sendJsonBody(res, JSON.stringify(payload), status, headers);
}

// cacheKey names a body that is sent again unchanged (one startup's state at
// one revision), so its compressed form can be reused.
function sendJsonBody(res, body, status = 200, headers = {}, cacheKey = "") {
  sendBody(res, Buffer.from(body, "utf8"), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  }, cacheKey);
}

function sendBody(res, body, status, headers, cacheKey = "") {
  const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const encoding = source.length >= 1024 ? chooseResponseEncoding(res.req) : "";
  let output = source;
  if (encoding) {
    const compressionKey = cacheKey ? `${cacheKey}\0${encoding}` : "";
    if (compressionKey && responseCompressionCache.has(compressionKey)) {
      output = responseCompressionCache.get(compressionKey);
    } else {
      output = encoding === "br"
        ? zlib.brotliCompressSync(source, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
          })
        : zlib.gzipSync(source, { level: 6 });
      if (compressionKey) {
        if (responseCompressionCache.size >= 32) responseCompressionCache.clear();
        responseCompressionCache.set(compressionKey, output);
      }
    }
  }

  res.writeHead(status, {
    ...headers,
    Vary: "Accept-Encoding",
    ...(encoding ? { "Content-Encoding": encoding } : {}),
    "Content-Length": output.length,
  });
  res.end(output);
}

function chooseResponseEncoding(req) {
  const accepted = String(req?.headers?.["accept-encoding"] || "").toLowerCase();
  if (/\bbr\b/.test(accepted)) return "br";
  if (/\bgzip\b/.test(accepted)) return "gzip";
  return "";
}

function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function shutdown() {
  // Agents stop with the tracker, and their runs read "interrupted".
  agentRoutes.closeStreams();
  const agentsStopped = Promise.race([agentRuns.shutdown(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  agentsStopped.catch(() => {}).finally(() => server.close(() => {
    try {
      // close() checkpoints the WAL into the main database file, so the .sqlite
      // on disk is complete on its own once the process is gone.
      store?.close();
    } finally {
      require("./lib/cli/run-state").removeRunState(paths.runDir, process.pid);
      process.exit(0);
    }
  }));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
