"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations } = require("./helpers/api");

test("the status list is seeded on first start and edited through the API", async () => {
  const server = await startServer();
  try {
    const listed = await (await browserFetch(`${server.url}api/statuses`)).json();
    assert.equal(listed.statuses.statuses.length, 22);
    assert.deepEqual(listed.statuses.groups.map((group) => group.id), ["planned", "in_progress", "done", "closed"]);
    assert.deepEqual(listed.priorities.priorities.map((priority) => priority.id), ["Very High", "High", "Medium", "Low", "Very Low"]);

    const config = listed.statuses;
    const withCustom = { ...config, statuses: [...config.statuses, { id: "waiting_list", group: "in_progress", label: "Waiting list", description: "" }] };
    const saved = await sendJson(`${server.url}api/statuses`, "PUT", { statuses: withCustom });
    assert.equal(saved.status, 200);

    const removedBuiltIn = await sendJson(`${server.url}api/statuses`, "PUT", { statuses: { ...config, statuses: config.statuses.filter((status) => status.id !== "won") } });
    assert.equal(removedBuiltIn.status, 400);
    assert.equal((await removedBuiltIn.json()).code, "builtInRemoved");

    const startup = await createStartup(server.url, "Acme");
    assert.equal((await saveOperations(server.url, startup.id, [
      { type: "upsert", section: "items", id: "a", baseRevision: 0, value: { id: "a", status: "waiting_list" } },
    ])).status, 200);
    const deleted = await sendJson(`${server.url}api/statuses/waiting_list/delete`, "POST", { moveTo: "on_hold" });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).moved, 1);
    const state = await (await browserFetch(`${server.url}api/s/${startup.id}/state`)).json();
    assert.equal(state.state.items[0].status, "on_hold", "the page reads the moved record, not a cached copy");

    assert.equal((await sendJson(`${server.url}api/statuses/new/delete`, "POST", { moveTo: "later" })).status, 400, "built-ins stay");
    assert.equal((await sendJson(`${server.url}api/campaign-statuses/paused/delete`, "POST", { moveTo: "active" })).status, 200);
  } finally {
    await server.stop();
  }
});

test("an export carries the status list, and an import keeps unknown statuses and names them", async () => {
  const server = await startServer();
  try {
    const startup = await createStartup(server.url, "Acme");
    assert.equal((await saveOperations(server.url, startup.id, [
      { type: "upsert", section: "items", id: "a", baseRevision: 0, value: { id: "a", status: "submitted" } },
      { type: "upsert", section: "programs", id: "p", baseRevision: 0, value: { id: "p", status: "Eligibility Review" } },
    ])).status, 200);
    const exported = await browserFetch(`${server.url}api/s/${startup.id}/export?format=json`);
    assert.equal(exported.status, 200);
    const body = await exported.json();
    assert.ok(body.global.statuses.statuses.some((status) => status.id === "submitted"), "the definitions travel with the export");

    const prepared = await browserFetch(`${server.url}api/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const preview = await prepared.json();
    assert.equal(prepared.status, 200, JSON.stringify(preview));
    assert.deepEqual(preview.preview.startups[0].unmappedStatuses, [{ id: "Eligibility Review", count: 1 }]);
    const applied = await sendJson(`${server.url}api/import/${preview.token}/apply`, "POST", { mode: "new" });
    assert.equal(applied.status, 200);
    const [copy] = (await applied.json()).imported.startups;
    const state = await (await browserFetch(`${server.url}api/s/${copy.id}/state`)).json();
    assert.equal(state.state.programs[0].status, "Eligibility Review", "an unknown status is kept, not replaced");
  } finally {
    await server.stop();
  }
});

test("status writes need the tracker page or the token", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.url}api/statuses`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
  } finally {
    await server.stop();
  }
});
