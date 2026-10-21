"use strict";

// The setup in the browser: its saved progress (lib/setup.js) and the demo
// startup added and removed in one click (lib/demo.js).
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const startups = require("../lib/startups");
const setup = require("../lib/setup");
const demo = require("../lib/demo");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup } = require("./helpers/api");

test("an empty install needs the setup; an install with startups from before does not", () => {
  const empty = new TrackerSqliteStore(":memory:");
  assert.deepEqual(setup.readSetup(empty), { step: "welcome", startupId: "", skipped: [], open: true, completed: false, needsSetup: true });
  const older = new TrackerSqliteStore(":memory:");
  startups.createStartup(older, { name: "Acme" });
  assert.equal(setup.readSetup(older).completed, true, "nobody is sent through the setup again");
  assert.equal(setup.readSetup(older).needsSetup, false);
});

test("progress is saved step by step and the setup continues where it stopped", () => {
  const store = new TrackerSqliteStore(":memory:");
  const startup = startups.createStartup(store, { name: "Acme" });
  setup.writeSetup(store, { step: "startup", startupId: startup.id, open: true, completed: false });
  let state = setup.writeSetup(store, { step: "track-po", skipped: ["links", "links", "nope"] });
  assert.equal(state.step, "track-po");
  assert.deepEqual(state.skipped, ["links"]);
  assert.equal(state.startupId, startup.id);
  assert.equal(state.needsSetup, true, "the badge stays until Done");
  state = setup.writeSetup(store, { step: "done", completed: true, open: false });
  assert.equal(state.needsSetup, false);
  assert.match(state.completedAt, /^\d{4}-/);
  assert.throws(() => setup.writeSetup(store, { step: "elsewhere" }), /step must be one of/);
  assert.throws(() => setup.writeSetup(store, { startupId: "missing-0000" }), /No such startup/);
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, setup.SECTION).step, "done");
});

test("the demo startup is added once, with its campaigns, and forgotten again", () => {
  const store = new TrackerSqliteStore(":memory:");
  const added = demo.addDemoStartup(store, { now: new Date("2026-10-20T10:00:00Z") });
  assert.equal(added.name, demo.DEMO_STARTUP_NAME);
  assert.equal(demo.findDemoStartup(store).id, added.id);
  assert.ok(demo.countRecords(store.readState(added.id).state) > 10);
  assert.throws(() => demo.addDemoStartup(store), (error) => error.statusCode === 409);
  assert.equal(store.readSection(GLOBAL_STARTUP_ID, "campaigns").filter((campaign) => campaign.id.startsWith(demo.DEMO_CAMPAIGN_PREFIX)).length, 3);
  startups.deleteStartup(store, added.id);
  assert.equal(demo.forgetDemo(store), 3);
  assert.equal(demo.findDemoStartup(store), null);
  assert.equal((store.readSection(GLOBAL_STARTUP_ID, "campaigns") || []).length, 0);
});

test("over HTTP: setup state, and a demo startup added and removed in one click each", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const first = await (await browserFetch(`${url}api/setup`)).json();
    assert.equal(first.setup.needsSetup, true);
    assert.equal(first.demo, null);
    const startup = await createStartup(url, "Acme");
    const saved = await (await sendJson(`${url}api/setup`, "PUT", { step: "links", startupId: startup.id, open: true })).json();
    assert.equal(saved.setup.step, "links");
    const bad = await sendJson(`${url}api/setup`, "PUT", { step: "elsewhere" });
    assert.equal(bad.status, 400);

    const added = await sendJson(`${url}api/demo`, "POST", {});
    assert.equal(added.status, 201);
    const demoStartup = (await added.json()).startup;
    const list = (await (await browserFetch(`${url}api/startups`)).json()).startups;
    assert.ok(list.some((entry) => entry.id === demoStartup.id));
    assert.equal((await sendJson(`${url}api/demo`, "POST", {})).status, 409);
    const state = (await (await browserFetch(`${url}api/s/${demoStartup.id}/state`)).json()).state;
    assert.ok(state.items.length > 5);

    const removed = await (await sendJson(`${url}api/demo`, "DELETE")).json();
    assert.equal(removed.deleted.id, demoStartup.id);
    assert.ok(removed.safetyBackup, "a safety backup first, like any deletion");
    const after = (await (await browserFetch(`${url}api/startups`)).json()).startups;
    assert.deepEqual(after.map((entry) => entry.id), [startup.id], "only the demo goes");
    assert.equal((await sendJson(`${url}api/demo`, "DELETE")).status, 404);
  } finally {
    await server.stop();
  }
});
