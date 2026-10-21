"use strict";

// The field registry and custom fields over HTTP (/api/fields).
const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson } = require("./helpers/api");

test("the registry is served, and custom fields are checked, saved and shared", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const first = await (await browserFetch(`${url}api/fields`)).json();
    assert.ok(first.registry.common.fields.some((field) => field.key === "name"));
    assert.ok(first.registry.po.fields.some((field) => field.key === "eligibleForUs"));
    assert.deepEqual(first.custom, []);

    const saved = await sendJson(`${url}api/fields/custom`, "PUT", { fields: [{ section: "mk", label: "Partner tier", type: "select", options: ["Gold", "Silver"] }] });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.custom[0].key, "partnerTier");
    assert.equal((await (await browserFetch(`${url}api/fields`)).json()).custom[0].label, "Partner tier");

    const clash = await sendJson(`${url}api/fields/custom`, "PUT", { fields: [{ section: "mk", label: "Reach", key: "reach" }] });
    assert.equal(clash.status, 400);
    assert.equal((await clash.json()).code, "keyTaken");
    assert.equal((await sendJson(`${url}api/fields/custom`, "PUT", { fields: "nope" })).status, 400);
    assert.equal((await (await browserFetch(`${url}api/fields`)).json()).custom.length, 1, "a refused list changes nothing");
  } finally {
    await server.stop();
  }
});
