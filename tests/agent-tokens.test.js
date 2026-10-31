"use strict";

// Limited tokens for AI agents (lib/agent-tokens.js): a copied prompt carries
// one; it adds and updates records of one startup and does nothing else.
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const tokens = require("../lib/agent-tokens");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup } = require("./helpers/api");

const NOW = new Date("2026-10-20T10:00:00.000Z");

test("a token is shown once, stored as a hash, and ends", () => {
  const store = new TrackerSqliteStore(":memory:");
  const { token, record } = tokens.createToken(store, { startupId: "acme-1", now: NOW });
  assert.match(token, /^sta_[A-Za-z0-9_-]{32}$/);
  assert.equal(record.expiresAt, "2026-10-21T10:00:00.000Z", "24 hours by default");
  assert.equal("hash" in record, false);
  const stored = store.readSection(GLOBAL_STARTUP_ID, tokens.SECTION)[0];
  assert.notEqual(stored.hash, token);
  assert.ok(!JSON.stringify(stored).includes(token), "the token itself is never stored");
  assert.equal(tokens.findToken(store, token, NOW.getTime()).id, record.id);
  assert.equal(tokens.findToken(store, token, Date.parse("2026-10-21T10:00:01Z")), null, "expired");
  assert.equal(tokens.findToken(store, "sta_wrong", NOW.getTime()), null);
  assert.equal(tokens.findToken(store, "not-a-token", NOW.getTime()), null);
  tokens.revokeToken(store, record.id, { now: NOW });
  assert.equal(tokens.findToken(store, token, NOW.getTime()), null, "revoked");
  assert.equal(tokens.listTokens(store, { now: NOW.getTime() })[0].active, false);
  assert.throws(() => tokens.createToken(store, { startupId: GLOBAL_STARTUP_ID }), /one startup/);
  assert.throws(() => tokens.createToken(store, { startupId: "acme-1", hours: 0 }), /lasts between/);
});

test("old tokens are cleaned up a week after they end", () => {
  const store = new TrackerSqliteStore(":memory:");
  const first = tokens.createToken(store, { startupId: "acme-1", now: NOW });
  tokens.createToken(store, { startupId: "acme-1", now: new Date("2026-10-29T10:00:00.000Z") });
  const ids = store.readSection(GLOBAL_STARTUP_ID, tokens.SECTION).map((entry) => entry.id);
  assert.equal(ids.includes(first.record.id), false);
  assert.equal(ids.length, 1);
});

test("a token may only add and update records of its own startup", () => {
  const record = { startupId: "acme-1" };
  const ok = { method: "PATCH", pathname: "/api/s/acme-1/state/operations", body: { operations: [{ type: "upsert", section: "items" }, { type: "upsert", section: "links" }] } };
  assert.doesNotThrow(() => tokens.assertAllowedWrite(record, ok));
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, pathname: "/api/s/other-2/state/operations" }), /another startup/);
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, pathname: "/api/backups" }), /only add and update/);
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, pathname: "/api/global/operations" }), /only add and update/);
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, body: { operations: [{ type: "delete", section: "items" }] } }), /not delete/);
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, body: { operations: [{ type: "replaceSection", section: "items" }] } }), /not delete/);
  assert.throws(() => tokens.assertAllowedWrite(record, { ...ok, body: { operations: [{ type: "upsert", section: "profile" }] } }), /cannot change profile/);
});

test("over HTTP: the page makes a token, an agent uses it within its limits", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");
    const made = await sendJson(`${url}api/s/${one.id}/agent-tokens`, "POST", { label: "Copied prompt" });
    assert.equal(made.status, 201);
    const { token } = await made.json();
    assert.notEqual(token, server.token, "never the master token");
    const agent = (path, method, body) => fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const added = await agent(`api/s/${one.id}/state/operations`, "PATCH", { protocolVersion: 3, origin: "ui", operations: [{ type: "upsert", section: "items", id: "a1", value: { id: "a1", name: "Found by an agent" }, baseRevision: 0 }] });
    assert.equal(added.status, 200);
    const history = await (await browserFetch(`${url}api/s/${one.id}/state/history?section=items&id=a1`)).json();
    assert.equal(history.entries[0].origin, "api", "an agent's write is never recorded as the page");
    assert.equal(history.entries[0].actor, "Agent: Copied prompt");
    assert.equal((await agent(`api/s/${two.id}/state/operations`, "PATCH", { protocolVersion: 3, operations: [] })).status, 403, "another startup");
    assert.equal((await agent(`api/s/${one.id}/state/operations`, "PATCH", { protocolVersion: 3, operations: [{ type: "delete", section: "items", id: "a1", baseRevision: 99 }] })).status, 403, "no deletes");
    assert.equal((await agent("api/backups", "POST", {})).status, 403, "no backups");
    assert.equal((await agent(`api/s/${one.id}/agent-tokens`, "POST", {})).status, 403, "a token cannot make tokens");
    assert.equal((await agent("api/global/operations", "PATCH", { operations: [] })).status, 403);
    // The page lists and revokes.
    const listed = await (await browserFetch(`${url}api/agent-tokens?startupId=${one.id}`)).json();
    assert.equal(listed.tokens.length, 1);
    assert.equal("hash" in listed.tokens[0], false);
    assert.equal((await sendJson(`${url}api/agent-tokens/${listed.tokens[0].id}/revoke`, "POST", {})).status, 200);
    assert.equal((await agent(`api/s/${one.id}/state/operations`, "PATCH", { protocolVersion: 3, operations: [] })).status, 403, "revoked");
    const shared = await (await browserFetch(`${url}api/global`)).json();
    assert.equal(shared.state.agentTokens, undefined, "tokens are not part of the shared data");
    assert.equal((await sendJson(`${url}api/global/operations`, "PATCH", { operations: [{ type: "upsert", section: "agentTokens", id: "x", value: { id: "x" } }] })).status, 400);
  } finally {
    await server.stop();
  }
});
