"use strict";

// Limited tokens for AI agents. A copied prompt carries one: it can add and
// update targets of one startup and link records there, and nothing else
// (no deletes, restores, imports, settings or other startups). Each expires,
// 24 hours after it was made by default, and can be revoked in Settings > AI
// agents. The master API token in secrets/api-token never appears in a prompt.
//
// Only a hash of each token is kept, in the global "agentTokens" section.

const crypto = require("crypto");
const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");

const SECTION = "agentTokens";
const PREFIX = "sta_";
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;
const KEEP_EXPIRED_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;
// Records an agent may add or change, and the links between them.
const WRITABLE_SECTIONS = Object.freeze(["items", "programs", "funding", "links"]);

class AgentTokenError extends Error {
  constructor(message, code = "agentToken", statusCode = 403) {
    super(message);
    this.name = "AgentTokenError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function readTokens(store) {
  const list = store.readSection(GLOBAL_STARTUP_ID, SECTION);
  return Array.isArray(list) ? list : [];
}

function publicView(record, now = Date.now()) {
  const { hash, ...rest } = record;
  void hash;
  return { ...rest, active: isActive(record, now) };
}

function isActive(record, now = Date.now()) {
  return Boolean(record) && !record.revokedAt && Date.parse(record.expiresAt) > now;
}

// Makes a token for one startup. Returns the token itself, shown once, and
// what is stored about it. Tokens that ended more than a week ago are cleaned
// up on the way.
// `runId` makes a run token (lib/agents/runs.js): it may only call the
// tracker tools of that run, and is revoked when the run ends.
function createToken(store, { startupId, label = "", hours = DEFAULT_HOURS, now = new Date(), origin = "ui", runId = "" } = {}) {
  if (!startupId || startupId === GLOBAL_STARTUP_ID) throw new AgentTokenError("An agent token belongs to one startup.", "badStartup", 400);
  const span = Number(hours);
  if (!Number.isFinite(span) || span <= 0 || span > MAX_HOURS) throw new AgentTokenError(`A token lasts between 1 hour and ${MAX_HOURS / 24} days.`, "badHours", 400);
  const token = `${PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const record = {
    id: crypto.randomUUID(),
    startupId,
    label: String(label || "Copied prompt").trim().slice(0, 80) || "Copied prompt",
    hash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + span * HOUR_MS).toISOString(),
    revokedAt: "",
    lastUsedAt: "",
    scope: runId ? "run" : "prompt",
    runId: runId ? String(runId) : "",
  };
  const cutoff = now.getTime() - KEEP_EXPIRED_DAYS * 24 * HOUR_MS;
  const operations = readTokens(store)
    .filter((entry) => Date.parse(entry.revokedAt || entry.expiresAt) < cutoff)
    .map((entry) => ({ type: "delete", section: SECTION, id: String(entry.id) }));
  operations.push({ type: "upsert", section: SECTION, id: record.id, value: record, baseRevision: 0 });
  store.applyOperations(GLOBAL_STARTUP_ID, operations, { origin, label: "Agent token created" });
  return { token, record: publicView(record, now.getTime()) };
}

// The active token record for a bearer token, or null.
function findToken(store, token, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
  const hash = hashToken(token);
  const record = readTokens(store).find((entry) => entry.hash && entry.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(entry.hash), Buffer.from(hash)));
  return isActive(record, now) ? record : null;
}

function listTokens(store, { startupId, now = Date.now() } = {}) {
  return readTokens(store)
    .filter((entry) => !startupId || entry.startupId === startupId)
    .map((entry) => publicView(entry, now))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function revokeToken(store, id, { now = new Date(), origin = "ui" } = {}) {
  const record = readTokens(store).find((entry) => String(entry.id) === String(id));
  if (!record) throw new AgentTokenError("No such agent token.", "notFound", 404);
  if (record.revokedAt) return publicView(record);
  const next = { ...record, revokedAt: now.toISOString() };
  store.applyOperations(GLOBAL_STARTUP_ID, [{ type: "upsert", section: SECTION, id: record.id, value: next }], { origin, label: "Agent token revoked" });
  return publicView(next, now.getTime());
}

// Which writes a token may make. A copied prompt's token: the operations
// route of its own startup, adding or updating records in WRITABLE_SECTIONS.
// A run token: the tracker tools of its own startup and run. Throws when
// anything else is asked.
function assertAllowedWrite(record, { method, pathname, body }) {
  if (record.scope === "run") {
    const tools = String(pathname || "").match(/^\/api\/s\/([^/]+)\/agent-tools\/[a-z_]+$/);
    if (!tools || String(method).toUpperCase() !== "POST") throw new AgentTokenError("A run token can only call the tracker tools.", "agentRoute");
    let runStartup = tools[1];
    try {
      runStartup = decodeURIComponent(runStartup);
    } catch {
      // Left as written; it will not match.
    }
    if (runStartup !== record.startupId) throw new AgentTokenError("This run token belongs to another startup.", "agentStartup");
    if (body?.runId !== undefined && body.runId !== record.runId) throw new AgentTokenError("This token belongs to another run.", "agentRun");
    return;
  }
  const match = String(pathname || "").match(/^\/api\/s\/([^/]+)\/state\/operations$/);
  if (!match || String(method).toUpperCase() !== "PATCH") {
    throw new AgentTokenError("An agent token can only add and update records through /api/s/<startup>/state/operations.", "agentRoute");
  }
  let startupId = match[1];
  try {
    startupId = decodeURIComponent(startupId);
  } catch {
    // Left as written; it will not match.
  }
  if (startupId !== record.startupId) throw new AgentTokenError("This agent token belongs to another startup.", "agentStartup");
  const operations = Array.isArray(body?.operations) ? body.operations : [];
  for (const operation of operations) {
    if (operation?.type !== "upsert") throw new AgentTokenError("An agent token can add and update records, not delete, reorder or replace them.", "agentOperation");
    if (!WRITABLE_SECTIONS.includes(operation.section)) throw new AgentTokenError(`An agent token cannot change ${String(operation.section)}.`, "agentSection");
  }
}

// Notes the last use, at most once a minute so a busy agent does not write a
// history entry per request.
function touchToken(store, record, now = new Date()) {
  if (record.lastUsedAt && now.getTime() - Date.parse(record.lastUsedAt) < 60 * 1000) return;
  store.applyOperations(GLOBAL_STARTUP_ID, [{ type: "upsert", section: SECTION, id: record.id, value: { ...record, lastUsedAt: now.toISOString() } }], { origin: "api", label: "Agent token used" });
}

module.exports = {
  SECTION,
  PREFIX,
  DEFAULT_HOURS,
  WRITABLE_SECTIONS,
  AgentTokenError,
  createToken,
  findToken,
  listTokens,
  revokeToken,
  assertAllowedWrite,
  touchToken,
};
