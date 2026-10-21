"use strict";

// The Extra pages over HTTP: shared option lists, shared tags across
// startups, a campaign's targets in every startup, and copying media.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations, uploadFile } = require("./helpers/api");

const upsert = (section, value) => ({ type: "upsert", section, id: value.id, value, baseRevision: 0 });

async function save(url, startupId, operations) {
  const response = await saveOperations(url, startupId, operations);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

test("option lists, tags across startups and campaign targets", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");

    // Option lists: shipped, edited, refused, reset.
    const options = await (await browserFetch(`${url}api/options`)).json();
    assert.ok(options.lists.mediaTypes.some((option) => option.id === "thumbnail"));
    assert.deepEqual(options.stored, {});
    const saved = await sendJson(`${url}api/options`, "PUT", { lists: { researchGroups: [{ label: "Podcasts", linkType: "podcast" }] } });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).lists.researchGroups, [{ id: "podcasts", label: "Podcasts", linkType: "podcast" }]);
    const refused = await sendJson(`${url}api/options`, "PUT", { lists: { feedbackTypes: [{ label: "X", block: "nope" }] } });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, "badExtra");
    assert.equal((await (await sendJson(`${url}api/options`, "PUT", { lists: { researchGroups: null } })).json()).lists.researchGroups.length, options.lists.researchGroups.length);

    // Tags and a shared campaign used in both startups.
    assert.equal((await sendJson(`${url}api/global/operations`, "PATCH", { operations: [upsert("campaigns", { id: "c1", name: "Spring", tags: ["launch"] }), upsert("tags", { id: "launch", label: "launch", description: "Day one." })] })).status, 200);
    await save(url, one.id, [upsert("items", { id: "t1", platform: "Forum post", tags: ["launch"], campaignId: "c1" })]);
    await save(url, two.id, [upsert("programs", { id: "p1", name: "Accelerator", tags: ["launch", "paid"], campaignId: "c1", status: "planned" })]);

    const targets = await (await browserFetch(`${url}api/all/campaign-targets?campaign=c1`)).json();
    assert.deepEqual(targets.targets.map((target) => [target.startup.name, target.section, target.id, target.title]).sort(), [["One", "mk", "t1", "Forum post"], ["Two", "po", "p1", "Accelerator"]]);
    assert.equal((await browserFetch(`${url}api/all/campaign-targets`)).status, 400);

    const usage = await (await browserFetch(`${url}api/global/tags/usage`)).json();
    assert.equal(usage.usage.launch.total, 3);
    assert.equal(usage.usage.launch.startups[one.id].name, "One");

    const renamed = await (await sendJson(`${url}api/global/tags/rename`, "POST", { from: "launch", to: "release" })).json();
    assert.equal(renamed.tag, "release");
    assert.equal(renamed.recordsChanged, 3);
    const stateOne = await (await browserFetch(`${url}api/s/${one.id}/state`)).json();
    assert.deepEqual(stateOne.state.items[0].tags, ["release"], "the startup's own state reads the new tag at once");

    const merged = await (await sendJson(`${url}api/global/tags/merge`, "POST", { from: ["paid"], to: "release" })).json();
    assert.ok(merged.safetyBackup, "merging takes a safety backup first");
    const deleted = await (await sendJson(`${url}api/global/tags/delete`, "POST", { tag: "release" })).json();
    assert.equal(deleted.recordsChanged, 3);
    const stateTwo = await (await browserFetch(`${url}api/s/${two.id}/state`)).json();
    assert.deepEqual(stateTwo.state.programs[0].tags, []);
    const shared = await (await browserFetch(`${url}api/global`)).json();
    assert.deepEqual(shared.state.campaigns[0].tags, []);
    assert.deepEqual(shared.state.deletedTags.map((tag) => tag.id), ["release"]);
    assert.equal((await sendJson(`${url}api/global/tags/rename`, "POST", { from: "", to: "x" })).status, 400);
    assert.equal((await sendJson(`${url}api/global/tags/rename`, "POST", { from: "a", to: "b" }, { "Sec-Fetch-Site": "cross-site" })).status, 403, "writes need the page or the token");
  } finally {
    await server.stop();
  }
});

test("media copies to another startup, and files of deleted media go once nothing names them", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");
    const uploaded = await (await uploadFile(url, one.id, "shot.png", "png-bytes", "image/png")).json();
    const media = { id: "m1", title: "Shot", type: "screenshot", sourceType: "upload", storedName: uploaded.storedName, filePath: uploaded.path, tags: [] };
    const added = await save(url, one.id, [upsert("mediaItems", media)]);

    const copied = await sendJson(`${url}api/s/${one.id}/media/copy`, "POST", { mediaId: "m1", to: two.id });
    assert.equal(copied.status, 200);
    const copy = (await copied.json()).media;
    assert.equal(fs.readFileSync(path.join(server.home, "media", two.id, copy.storedName), "utf8"), "png-bytes");
    assert.equal((await sendJson(`${url}api/s/${one.id}/media/copy`, "POST", { mediaId: "m1", to: "no-such-0000" })).status, 404);

    const file = path.join(server.home, "media", one.id, uploaded.storedName);
    // In the bin, the file stays.
    const binned = await save(url, one.id, [{ type: "delete", section: "mediaItems", id: "m1", baseRevision: added.revisionMap.records.mediaItems.m1 }, upsert("deletedMediaItems", { ...media, deletedAt: new Date().toISOString() })]);
    assert.deepEqual((await (await sendJson(`${url}api/s/${one.id}/media/remove-files`, "POST", { files: [uploaded.storedName] })).json()).kept, [uploaded.storedName]);
    assert.ok(fs.existsSync(file));
    // Deleted for good, it goes.
    await save(url, one.id, [{ type: "delete", section: "deletedMediaItems", id: "m1", baseRevision: binned.revisionMap.records.deletedMediaItems.m1 }]);
    assert.deepEqual((await (await sendJson(`${url}api/s/${one.id}/media/remove-files`, "POST", { files: [uploaded.storedName] })).json()).removed, [uploaded.storedName]);
    assert.ok(!fs.existsSync(file));
  } finally {
    await server.stop();
  }
});
