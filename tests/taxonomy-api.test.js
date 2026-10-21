"use strict";

// The category library over HTTP (/api/taxonomy) and the per-startup choice.
const assert = require("node:assert/strict");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations } = require("./helpers/api");

test("the library is seeded on first start, edited, and delete or merge repoint targets in every startup", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const listed = await (await browserFetch(`${url}api/taxonomy`)).json();
    assert.ok(listed.nodes.length > 500, "the shipped library is there");
    assert.ok(listed.nodes.every((node) => node.description), "every node has a description");
    assert.deepEqual(listed.updates, []);

    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");
    for (const startup of [one, two]) {
      assert.equal((await saveOperations(url, startup.id, [
        { type: "upsert", section: "items", id: "t1", baseRevision: 0, value: { id: "t1", taxonomy: ["mk.content.blog", "mk.content"] } },
      ])).status, 200);
    }

    const created = await (await sendJson(`${url}api/taxonomy/nodes`, "POST", { parentId: "mk.content", name: "Field notes", description: "Short notes from the field." })).json();
    assert.equal(created.node.id, "mk.content.field-notes");
    assert.equal(created.node.level, "subcategory");
    const renamed = await sendJson(`${url}api/taxonomy/nodes/${created.node.id}`, "PATCH", { name: "Field reports" });
    assert.equal((await renamed.json()).node.name, "Field reports");
    assert.equal((await sendJson(`${url}api/taxonomy/nodes/mk.content/delete`, "POST", {})).status, 409, "in use: choose where targets move");

    const merged = await (await sendJson(`${url}api/taxonomy/nodes/mk.content.blog/merge`, "POST", { into: created.node.id })).json();
    assert.equal(merged.moved, 2, "both startups' targets moved");
    for (const startup of [one, two]) {
      const state = await (await browserFetch(`${url}api/s/${startup.id}/state`)).json();
      assert.deepEqual(state.state.items[0].taxonomy, ["mk.content.field-notes", "mk.content"]);
    }

    const deleted = await (await sendJson(`${url}api/taxonomy/nodes/${created.node.id}/delete`, "POST", { moveTo: "mk.pr.press" })).json();
    assert.equal(deleted.moved, 2);
    const after = await (await browserFetch(`${url}api/s/${two.id}/state`)).json();
    assert.deepEqual(after.state.items[0].taxonomy, ["mk.pr.press", "mk.content"]);

    const siblings = (await (await browserFetch(`${url}api/taxonomy`)).json()).nodes.filter((node) => node.section === "fu" && !node.parentId);
    const reversed = siblings.sort((a, b) => a.order - b.order).map((node) => node.id).reverse();
    assert.equal((await sendJson(`${url}api/taxonomy/reorder`, "POST", { ids: reversed })).status, 200);
    assert.equal((await sendJson(`${url}api/taxonomy/reorder`, "POST", { ids: reversed.slice(1) })).status, 400, "every sibling must be listed");
    assert.equal((await sendJson(`${url}api/taxonomy/nodes/mk.pr/reset`, "POST", {})).status, 200);

    const exported = await browserFetch(`${url}api/taxonomy/export`);
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    const library = await exported.json();
    const imported = await (await sendJson(`${url}api/taxonomy/import`, "POST", { library: { ...library, nodes: [...library.nodes, { id: "po.extra", section: "po", level: "category", name: "Extra", shortName: "Extra", description: "Shared from another install." }] } })).json();
    assert.deepEqual(imported.added, ["po.extra"]);
  } finally {
    await server.stop();
  }
});

test("turning categories off is one startup's own choice", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");
    assert.equal((await saveOperations(url, one.id, [
      { type: "replaceSection", section: "enabledTaxonomy", baseRevision: 0, value: { enabled: ["mk.pr", "mk.pr.press"] } },
    ])).status, 200);
    const first = await (await browserFetch(`${url}api/s/${one.id}/state`)).json();
    const second = await (await browserFetch(`${url}api/s/${two.id}/state`)).json();
    assert.deepEqual(first.state.enabledTaxonomy, { enabled: ["mk.pr", "mk.pr.press"] });
    assert.equal(second.state?.enabledTaxonomy, undefined, "the other startup keeps every category on");
  } finally {
    await server.stop();
  }
});

test("category writes need the tracker page", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.url}api/taxonomy/nodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
  } finally {
    await server.stop();
  }
});
