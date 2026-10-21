"use strict";

// The shared-data channel (public/js/global-data.js): what it sends, with
// which revisions, and what happens on a conflict or offline.
const assert = require("node:assert/strict");
const test = require("node:test");
const GlobalData = require("../public/js/global-data.js");

const urls = { global: "/api/global", globalOperations: "/api/global/operations" };

function fakeServer(initial) {
  const server = { state: initial, revisionMap: { revision: 5, sections: { aiSettings: 3 }, records: { campaigns: { c1: 4 }, aiAccounts: {} } }, sent: [], answer: null, down: false };
  server.fetch = async (url, init = {}) => {
    if (server.down) throw new Error("offline");
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      server.sent.push(body);
      if (server.answer) return server.answer(body);
      return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ ok: true, revisionMap: { ...server.revisionMap, revision: 6 } }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'W/"rev-5"' }, json: async () => ({ ok: true, state: server.state, revisionMap: server.revisionMap }) };
  };
  return server;
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
}

test("diff sends only what changed, with each record's revision", () => {
  const before = GlobalData.snapshot({ campaigns: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }], aiSettings: { usdToRon: 4.55 } });
  const revisions = { sections: { aiSettings: 3 }, records: { campaigns: { c1: 4, c2: 7 } } };
  const operations = GlobalData.diff(before, { campaigns: [{ id: "c3", name: "C" }, { id: "c1", name: "A2" }], aiSettings: { usdToRon: 5 } }, revisions);
  assert.deepEqual(operations, [
    { type: "delete", section: "campaigns", id: "c2", baseRevision: 7 },
    { type: "upsert", section: "campaigns", id: "c3", value: { id: "c3", name: "C" }, baseRevision: 0, position: 0 },
    { type: "upsert", section: "campaigns", id: "c1", value: { id: "c1", name: "A2" }, baseRevision: 4 },
    { type: "replaceSection", section: "aiSettings", value: { usdToRon: 5 }, baseRevision: 3 },
  ]);
  assert.deepEqual(GlobalData.diff(before, { campaigns: [{ id: "c2", name: "B" }, { id: "c1", name: "A" }], aiSettings: { usdToRon: 4.55 } }, revisions), [
    { type: "reorder", section: "campaigns", ids: ["c2", "c1"] },
  ]);
  assert.throws(() => GlobalData.snapshot({ tags: [{ id: "a" }, { id: "a" }] }), /unique id/);
  assert.ok(!GlobalData.SECTION_NAMES.includes("startups"), "the startup list has its own routes");
});

test("adding an AI page entry is saved with the shared data", async () => {
  const server = fakeServer({ campaigns: [{ id: "c1", name: "Spring" }], aiAccounts: [], startups: [{ id: "x" }] });
  let page = null;
  const channel = GlobalData.create({ fetchImpl: server.fetch, urls, hooks: { collect: () => page }, setTimer: () => 1, clearTimer: () => {} });
  const loaded = await channel.load();
  assert.equal(loaded.offline, false);
  assert.deepEqual(Object.keys(loaded.sections).sort(), ["aiAccounts", "campaigns"], "only shared sections, never the startup list");
  page = { ...loaded.sections, aiAccounts: [{ id: "ai1", kind: "subscription", name: "New subscription" }] };
  const result = await channel.flush();
  assert.equal(result.saved, 1);
  assert.deepEqual(server.sent[0].operations, [{ type: "upsert", section: "aiAccounts", id: "ai1", value: page.aiAccounts[0], baseRevision: 0, position: 0 }]);
  assert.equal(server.sent[0].origin, "ui");
  assert.equal(await channel.flush(), null, "nothing left to send");
});

test("a conflict reloads the shared data instead of overwriting it", async () => {
  const server = fakeServer({ campaigns: [{ id: "c1", name: "Spring" }] });
  const applied = [];
  const statuses = [];
  let page = null;
  const channel = GlobalData.create({ fetchImpl: server.fetch, urls, hooks: { collect: () => page, apply: (sections, info) => applied.push([sections, info]), status: (kind) => statuses.push(kind) }, setTimer: () => 1, clearTimer: () => {} });
  page = (await channel.load()).sections;
  page = { campaigns: [{ id: "c1", name: "Mine" }] };
  server.answer = () => ({ ok: false, status: 409, headers: { get: () => "" }, json: async () => ({ ok: false, error: "recordConflict" }) });
  server.state = { campaigns: [{ id: "c1", name: "Theirs" }] };
  const result = await channel.flush();
  assert.equal(result.conflict, true);
  assert.deepEqual(applied[0][0].campaigns, [{ id: "c1", name: "Theirs" }]);
  assert.equal(applied[0][1].reason, "conflict");
  assert.deepEqual(statuses, ["saving", "conflict"]);
});

test("offline, the last copy shows and nothing is sent", async () => {
  const storage = memoryStorage();
  const server = fakeServer({ tags: [{ id: "launch" }] });
  const first = GlobalData.create({ fetchImpl: server.fetch, urls, storage });
  await first.load();
  server.down = true;
  const second = GlobalData.create({ fetchImpl: server.fetch, urls, storage, hooks: { collect: () => ({ tags: [] }) } });
  const loaded = await second.load();
  assert.equal(loaded.offline, true);
  assert.deepEqual(loaded.sections.tags, [{ id: "launch" }]);
  assert.equal(second.isOnline(), false);
  assert.equal(await second.flush(), null, "an offline page never deletes shared records it could not read");
});

test("refresh reports newer shared data and stays quiet when nothing changed", async () => {
  const server = fakeServer({ campaigns: [{ id: "c1", name: "Spring" }] });
  const channel = GlobalData.create({ fetchImpl: server.fetch, urls, hooks: { collect: () => ({}) } });
  await channel.load();
  assert.equal(await channel.refresh(), null);
  server.state = { campaigns: [{ id: "c1", name: "Spring" }, { id: "c2", name: "Autumn" }] };
  const fresh = await channel.refresh();
  assert.equal(fresh.campaigns.length, 2);
});
