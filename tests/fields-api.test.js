"use strict";

// The field registry over HTTP (/api/fields).
const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson } = require("./helpers/api");

test("the registry is served, and there is no shared custom field list any more", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const body = await (await browserFetch(`${url}api/fields`)).json();
    assert.ok(body.registry.common.fields.some((field) => field.key === "name"));
    assert.ok(body.registry.po.fields.some((field) => field.key === "eligibleForUs"));
    assert.ok(body.registry.common.activities.some((activity) => activity.id === "timeline"));
    assert.equal(body.custom, undefined, "a target keeps its own custom fields; none are defined app-wide");
    assert.equal((await sendJson(`${url}api/fields/custom`, "PUT", { fields: [] })).status, 404);
  } finally {
    await server.stop();
  }
});
