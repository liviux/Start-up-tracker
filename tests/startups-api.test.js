"use strict";

// The HTTP side of several startups in one database: isolation, the startup
// list, pages, media, the global scope, the combined views, deleting a startup
// and the upgrade of a database from before startups existed. Backups,
// restores, export and import are in backups-api.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { TrackerSqliteStore, verifyDatabaseFile } = require("../lib/tracker-sqlite-store");
const { startServer, makeTempHome } = require("./helpers/server");
const { writeLegacyDatabase } = require("./helpers/legacy-schema");
const { browserFetch, sendJson, createStartup, saveOperations, uploadFile } = require("./helpers/api");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function save(serverUrl, startupId, operations, extra) {
  const response = await saveOperations(serverUrl, startupId, operations, extra);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

// A new startup holds no sections, so its first write creates them.
function fillSection(serverUrl, startupId, section, value, extra) {
  return save(serverUrl, startupId, [{ type: "replaceSection", section, value, baseRevision: 0 }], extra);
}

async function readState(serverUrl, startupId, headers = {}) {
  const response = await browserFetch(`${serverUrl}api/s/${startupId}/state`, { headers });
  assert.equal(response.status, 200);
  return { response, payload: await response.json() };
}

async function listStartups(serverUrl) {
  const response = await browserFetch(`${serverUrl}api/startups`);
  assert.equal(response.status, 200);
  return (await response.json()).startups;
}

function noRedirect(url, init = {}) {
  return browserFetch(url, { ...init, redirect: "manual" });
}

test("two startups never see each other's records, history, media, revisions or changes", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");

    // Both use the same record id.
    await fillSection(url, alpha.id, "items", [{ id: "same", title: "Alpha" }]);
    await fillSection(url, beta.id, "items", [{ id: "same", title: "Beta" }]);

    const a = (await readState(url, alpha.id)).payload;
    const { response: betaResponse, payload: b } = await readState(url, beta.id);
    assert.deepEqual(a.state.items, [{ id: "same", title: "Alpha" }]);
    assert.deepEqual(b.state.items, [{ id: "same", title: "Beta" }]);
    assert.equal(a.startupId, alpha.id);
    assert.equal(b.startupId, beta.id);
    assert.equal(a.revision, 1);
    assert.equal(b.revision, 1);
    const betaEtag = betaResponse.headers.get("etag");
    assert.equal(betaEtag, 'W/"rev-1"');

    const record = async (startupId) => (await (await browserFetch(`${url}api/s/${startupId}/state/records/items/same`)).json()).record;
    assert.equal((await record(alpha.id)).title, "Alpha");
    assert.equal((await record(beta.id)).title, "Beta");

    // A browser edit to Alpha's record.
    const edited = await save(url, alpha.id, [{
      type: "upsert", section: "items", id: "same", baseRevision: 1, value: { id: "same", title: "Alpha 2" },
    }], { origin: "ui", mutationId: "shared-mutation-id" });
    assert.equal(edited.revision, 2);

    // Beta's revision, ETag and changes feed did not move.
    const betaAgain = await browserFetch(`${url}api/s/${beta.id}/state`, { headers: { "If-None-Match": betaEtag } });
    assert.equal(betaAgain.status, 304);
    assert.equal(betaAgain.headers.get("x-state-revision"), "1");
    const betaChanges = await (await browserFetch(`${url}api/s/${beta.id}/state/changes?since=1`)).json();
    assert.equal(betaChanges.complete, true);
    assert.deepEqual(betaChanges.upserts, []);
    assert.deepEqual(betaChanges.deletes, []);
    const alphaChanges = await (await browserFetch(`${url}api/s/${alpha.id}/state/changes?since=1`)).json();
    assert.deepEqual(alphaChanges.upserts.map((entry) => entry.id), ["same"]);
    assert.equal(alphaChanges.upserts[0].value.title, "Alpha 2");
    assert.equal((await record(beta.id)).title, "Beta");

    // Alpha's history has the browser edit; Beta's does not.
    const history = async (startupId) => (await (await browserFetch(`${url}api/s/${startupId}/state/history?section=items&id=same`)).json()).entries;
    const alphaHistory = await history(alpha.id);
    const betaHistory = await history(beta.id);
    assert.ok(alphaHistory.some((entry) => entry.origin === "ui" && entry.event === "updated"));
    assert.ok(betaHistory.length >= 1);
    assert.ok(betaHistory.every((entry) => entry.origin !== "ui"), "Beta's timeline holds only its own writes");

    // Locks are per startup too: Beta's record still sits at revision 1, and
    // the same mutation id is a new mutation there.
    const betaEdit = await save(url, beta.id, [{
      type: "upsert", section: "items", id: "same", baseRevision: 1, value: { id: "same", title: "Beta 2" },
    }], { mutationId: "shared-mutation-id" });
    assert.equal(betaEdit.replayed, false);
    assert.equal(betaEdit.revision, 2);
    assert.equal((await record(beta.id)).title, "Beta 2");
    assert.equal((await record(alpha.id)).title, "Alpha 2");

    // A stale lock in one startup is a conflict only there.
    const stale = await saveOperations(url, alpha.id, [{
      type: "upsert", section: "items", id: "same", baseRevision: 1, value: { id: "same", title: "Stale" },
    }]);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "recordConflict");

    // Media lives in the startup's own folder and is served only under its id.
    const upload = await (await uploadFile(url, alpha.id, "alpha-note.txt", "alpha only", "text/plain")).json();
    assert.equal(path.dirname(upload.absolutePath), path.join(server.home, "media", alpha.id));
    assert.equal((await browserFetch(`${url}media/${alpha.id}/${upload.storedName}`)).status, 200);
    assert.equal((await browserFetch(`${url}media/${beta.id}/${upload.storedName}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(server.home, "media", beta.id)), []);
  } finally {
    await server.stop();
  }
});

test("compressed state answers are kept apart for two startups at the same revision", async () => {
  // Regression: the compressed body was once cached by revision alone, so the
  // second startup at revision 1 received the first one's state.
  const server = await startServer();
  const url = server.url;
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    // Large enough that the server compresses the answer.
    await fillSection(url, alpha.id, "items", [{ id: "x", title: "Alpha", notes: "a".repeat(4_000) }]);
    await fillSection(url, beta.id, "items", [{ id: "x", title: "Beta", notes: "b".repeat(4_000) }]);

    for (const encoding of ["br", "gzip"]) {
      for (const [startup, title] of [[alpha, "Alpha"], [beta, "Beta"], [alpha, "Alpha"]]) {
        const { response, payload } = await readState(url, startup.id, { "Accept-Encoding": encoding });
        assert.equal(response.headers.get("content-encoding"), encoding);
        assert.equal(payload.revision, 1);
        assert.equal(payload.startupId, startup.id);
        assert.equal(payload.state.items[0].title, title, `${encoding}: ${startup.name} gets its own state`);
      }
    }
  } finally {
    await server.stop();
  }
});

test("unknown and archived startups answer 404 on the API and redirect on the page", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    await fillSection(url, alpha.id, "items", [{ id: "kept", title: "Kept" }]);

    for (const id of ["nope-0000", "Bad%20Id", "_global", "%E0%A4%A"]) {
      const response = await browserFetch(`${url}api/s/${id}/state`);
      assert.equal(response.status, 404, id);
      if (id === "nope-0000") assert.equal((await response.json()).code, "unknownStartup");
      const page = await noRedirect(`${url}s/${id}/`);
      assert.equal(page.status, 302, id);
      assert.equal(page.headers.get("location"), "/");
    }

    // The page of a startup, with and without the trailing slash.
    const bare = await noRedirect(`${url}s/${beta.id}?view=1`);
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), `/s/${beta.id}/?view=1`);
    const page = await noRedirect(`${url}s/${beta.id}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal((await noRedirect(`${url}s/${beta.id}/index.html`)).status, 200);
    assert.equal((await noRedirect(`${url}s/${beta.id}/other`)).status, 404);
    assert.equal((await browserFetch(`${url}api/s/${beta.id}/nothing-here`)).status, 404);

    const archived = await sendJson(`${url}api/startups/${alpha.id}`, "PATCH", { archived: true });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).startup.archived, true);

    const archivedRoutes = [
      ["GET", "state", undefined],
      ["GET", "state/changes?since=0", undefined],
      ["GET", "state/history?section=items&id=kept", undefined],
      ["GET", "state/records/items/kept", undefined],
      ["PATCH", "state/operations", { protocolVersion: 2, operations: [{ type: "delete", section: "items", id: "kept", baseRevision: 1 }] }],
      ["PUT", "media/document", { sourceType: "upload", storedName: "x.md", content: "" }],
    ];
    for (const [method, route, body] of archivedRoutes) {
      const response = body === undefined
        ? await browserFetch(`${url}api/s/${alpha.id}/${route}`, { method })
        : await sendJson(`${url}api/s/${alpha.id}/${route}`, method, body);
      assert.equal(response.status, 404, `${method} ${route} of an archived startup`);
    }
    assert.equal((await uploadFile(url, alpha.id, "late.txt", "late")).status, 404);
    const archivedPage = await noRedirect(`${url}s/${alpha.id}/`);
    assert.equal(archivedPage.status, 302);
    assert.equal(archivedPage.headers.get("location"), "/");
    // The list still shows it, so it can be brought back.
    assert.equal((await listStartups(url)).find((startup) => startup.id === alpha.id).archived, true);

    assert.equal((await sendJson(`${url}api/startups/${alpha.id}`, "PATCH", { archived: false })).status, 200);
    const restored = (await readState(url, alpha.id)).payload;
    assert.deepEqual(restored.state.items, [{ id: "kept", title: "Kept" }], "archiving keeps the data");
    assert.equal((await noRedirect(`${url}s/${alpha.id}/`)).status, 200);
  } finally {
    await server.stop();
  }
});

test("/ goes to the startup opened last, and shows the page when there are none", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const empty = await noRedirect(url);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /<html/i);

    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    const home = async (query = "") => {
      const response = await noRedirect(`${url}${query}`);
      assert.equal(response.status, 302);
      return response.headers.get("location");
    };
    // Nothing opened yet: the first in the list.
    assert.equal(await home(), `/s/${alpha.id}/`);

    const opened = await (await sendJson(`${url}api/startups/${beta.id}`, "PATCH", { opened: true })).json();
    assert.match(opened.startup.lastOpenedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await home(), `/s/${beta.id}/`);

    await delay(5);
    await sendJson(`${url}api/startups/${alpha.id}`, "PATCH", { opened: true });
    assert.equal(await home(), `/s/${alpha.id}/`);
    assert.equal(await home("?from=link"), `/s/${alpha.id}/?from=link`);

    // The time is the server's: a lastOpenedAt sent by the page is ignored.
    const claimed = await (await sendJson(`${url}api/startups/${beta.id}`, "PATCH", { lastOpenedAt: "2999-01-01T00:00:00.000Z" })).json();
    assert.notEqual(claimed.startup.lastOpenedAt, "2999-01-01T00:00:00.000Z");
    assert.equal(await home(), `/s/${alpha.id}/`);

    // An archived startup is never the target.
    await sendJson(`${url}api/startups/${alpha.id}`, "PATCH", { archived: true });
    assert.equal(await home(), `/s/${beta.id}/`);
    await sendJson(`${url}api/startups/${beta.id}`, "PATCH", { archived: true });
    assert.equal((await noRedirect(url)).status, 200, "with every startup archived the page is shown");
  } finally {
    await server.stop();
  }
});

test("startups are created, renamed, reordered and archived, and bad input is refused", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const before = (await (await browserFetch(`${url}api/startups`)).json()).revision;
    const created = await sendJson(`${url}api/startups`, "POST", { name: "  Acme   Robotics " });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    const acme = createdPayload.startup;
    assert.equal(acme.name, "Acme Robotics");
    assert.match(acme.id, /^acme-robotics-[a-z0-9]{4}$/);
    assert.equal(acme.order, 0);
    assert.equal(acme.archived, false);
    assert.equal(acme.lastOpenedAt, "");
    assert.ok(createdPayload.revision > before, "the list lives in the global scope and moves its revision");
    assert.ok(fs.statSync(path.join(server.home, "media", acme.id)).isDirectory());
    // A new startup has no data yet.
    assert.equal((await readState(url, acme.id)).payload.state, null);

    for (const [body, status, code] of [
      [{ name: "" }, 400, "nameRequired"],
      [{ name: "   " }, 400, "nameRequired"],
      [{}, 400, "nameRequired"],
      [{ name: "x".repeat(121) }, 400, "nameTooLong"],
      [{ name: "Icon", icon: "https://example.com/logo.png" }, 400, "badIcon"],
      [{ name: "Copy", copySettingsFrom: "nope-0000" }, 404, "unknownSource"],
    ]) {
      const response = await sendJson(`${url}api/startups`, "POST", body);
      assert.equal(response.status, status, JSON.stringify(body).slice(0, 60));
      assert.equal((await response.json()).code, code);
    }
    assert.equal((await listStartups(url)).length, 1, "refused requests create nothing");

    const icon = "data:image/png;base64,iVBORw0KGgo=";
    const withIcon = await createStartup(url, "Beta", { icon });
    assert.equal(withIcon.icon, icon);
    assert.equal(withIcon.order, 1);

    // Settings are copied on request, records only when asked for too.
    await save(url, acme.id, [
      { type: "replaceSection", section: "profile", value: { pitch: "Robots for labs" }, baseRevision: 0 },
      { type: "replaceSection", section: "uiPreferences", value: { density: "compact" }, baseRevision: 0 },
      { type: "replaceSection", section: "items", value: [{ id: "t1", platform: "Forum" }], baseRevision: 0 },
    ]);
    const settingsOnly = await createStartup(url, "Settings copy", { copySettingsFrom: acme.id });
    const settingsState = (await readState(url, settingsOnly.id)).payload.state;
    assert.deepEqual(settingsState.profile, { pitch: "Robots for labs" });
    assert.deepEqual(settingsState.uiPreferences, { density: "compact" });
    assert.equal(settingsState.items, undefined);
    const withRecords = await createStartup(url, "Full copy", { copySettingsFrom: acme.id, copyRecords: true });
    assert.deepEqual((await readState(url, withRecords.id)).payload.state.items, [{ id: "t1", platform: "Forum" }]);
    // Copying leaves the source as it was.
    assert.deepEqual((await readState(url, acme.id)).payload.state.items, [{ id: "t1", platform: "Forum" }]);

    // Renaming keeps the id.
    const renamed = await (await sendJson(`${url}api/startups/${acme.id}`, "PATCH", { name: "Acme Labs" })).json();
    assert.equal(renamed.startup.id, acme.id);
    assert.equal(renamed.startup.name, "Acme Labs");
    assert.equal((await readState(url, acme.id)).payload.state.profile.pitch, "Robots for labs");

    for (const [body, code] of [[{ name: "" }, "nameRequired"], [{ order: -1 }, "badOrder"], [{ order: 1.5 }, "badOrder"], [{ icon: "nope" }, "badIcon"]]) {
      const response = await sendJson(`${url}api/startups/${acme.id}`, "PATCH", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).code, code);
    }
    assert.equal((await sendJson(`${url}api/startups/nope-0000`, "PATCH", { name: "X" })).status, 404);
    assert.equal((await sendJson(`${url}api/startups/_global`, "PATCH", { name: "X" })).status, 404);

    // Reordering: the list is sorted by order.
    assert.deepEqual((await listStartups(url)).map((startup) => startup.id), [acme.id, withIcon.id, settingsOnly.id, withRecords.id]);
    await sendJson(`${url}api/startups/${acme.id}`, "PATCH", { order: 10 });
    await sendJson(`${url}api/startups/${withRecords.id}`, "PATCH", { order: 0 });
    assert.deepEqual((await listStartups(url)).map((startup) => startup.id), [withRecords.id, withIcon.id, settingsOnly.id, acme.id]);

    // Archive and unarchive.
    assert.equal((await (await sendJson(`${url}api/startups/${withIcon.id}`, "PATCH", { archived: true })).json()).startup.archived, true);
    assert.equal((await listStartups(url)).find((startup) => startup.id === withIcon.id).archived, true);
    assert.equal((await (await sendJson(`${url}api/startups/${withIcon.id}`, "PATCH", { archived: false })).json()).startup.archived, false);
    assert.equal((await browserFetch(`${url}api/s/${withIcon.id}/state`)).status, 200);
  } finally {
    await server.stop();
  }
});

test("deleting a startup takes a safety backup first, which holds its records and media", async () => {
  const server = await startServer();
  const url = server.url;
  const backupDir = path.join(server.home, "backups");
  try {
    const doomed = await createStartup(url, "Doomed");
    const survivor = await createStartup(url, "Survivor");
    await fillSection(url, doomed.id, "items", [{ id: "d1", title: "Doomed record" }]);
    await fillSection(url, survivor.id, "items", [{ id: "s1", title: "Survivor record" }]);
    const upload = await (await uploadFile(url, doomed.id, "keep-me.txt", "media content")).json();
    const survivorEtag = (await readState(url, survivor.id)).response.headers.get("etag");

    const response = await browserFetch(`${url}api/startups/${doomed.id}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    const deleted = await response.json();
    assert.equal(deleted.deleted.id, doomed.id);
    assert.equal(deleted.undoSnapshot, undefined);
    assert.equal(deleted.mediaMovedTo, undefined);

    // The safety backup holds the startup as it was.
    const listed = (await (await browserFetch(`${url}api/backups?startupId=${survivor.id}`)).json()).backups;
    const safety = listed.find((backup) => backup.id === deleted.safetyBackup);
    assert.equal(safety.kind, "safety");
    assert.match(safety.reason, new RegExp(`before deleting Doomed \\(${doomed.id}\\)`));
    assert.deepEqual(safety.startups.map((entry) => entry.id).sort(), [doomed.id, survivor.id].sort());
    const snapshot = new TrackerSqliteStore(path.join(backupDir, safety.id, "tracker.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(snapshot.readState(doomed.id).state.items, [{ id: "d1", title: "Doomed record" }]);
    } finally {
      snapshot.close();
    }

    // The media folder is gone, because the backup holds its files.
    assert.equal(fs.existsSync(path.join(server.home, "media", doomed.id)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, safety.id, "media-manifest.json"), "utf8"));
    const file = manifest.files.find((entry) => entry.path === `${doomed.id}/${upload.storedName}`);
    assert.ok(file, "the manifest lists the upload");
    assert.equal(fs.readFileSync(path.join(backupDir, "media-store", file.sha256), "utf8"), "media content");

    // The startup is gone from every route.
    assert.deepEqual((await listStartups(url)).map((startup) => startup.id), [survivor.id]);
    assert.equal((await browserFetch(`${url}api/s/${doomed.id}/state`)).status, 404);
    assert.equal((await browserFetch(`${url}media/${doomed.id}/${upload.storedName}`)).status, 404);
    assert.equal((await browserFetch(`${url}api/startups/${doomed.id}`, { method: "DELETE" })).status, 404);

    // The other startup did not change at all.
    const survivorAfter = await browserFetch(`${url}api/s/${survivor.id}/state`, { headers: { "If-None-Match": survivorEtag } });
    assert.equal(survivorAfter.status, 304);

    // Restoring the startup from its safety backup brings back its records,
    // its place in the list and its media.
    const restore = await sendJson(`${url}api/backups/${safety.id}/restore`, "POST", { scope: "startup", startupId: doomed.id });
    assert.equal(restore.status, 200, await restore.clone().text());
    assert.deepEqual((await listStartups(url)).map((startup) => startup.id).sort(), [doomed.id, survivor.id].sort());
    assert.deepEqual((await readState(url, doomed.id)).payload.state.items, [{ id: "d1", title: "Doomed record" }]);
    assert.equal(await (await browserFetch(`${url}media/${doomed.id}/${upload.storedName}`)).text(), "media content");
    assert.equal((await browserFetch(`${url}api/s/${survivor.id}/state`, { headers: { "If-None-Match": survivorEtag } })).status, 304);
  } finally {
    await server.stop();
  }
});

test("the global scope has its own ETag and refuses the startup list", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const startup = await createStartup(url, "Alpha");
    await fillSection(url, startup.id, "items", [{ id: "a", title: "A" }]);
    const startupEtag = (await readState(url, startup.id)).response.headers.get("etag");

    const first = await browserFetch(`${url}api/global`);
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.match(etag, /^W\/"rev-\d+"$/);
    const global = await first.json();
    assert.equal(global.state.startups, undefined, "the startup list has its own routes");
    assert.equal(typeof global.revision, "number");

    assert.equal((await browserFetch(`${url}api/global`, { headers: { "If-None-Match": etag } })).status, 304);

    const refused = await sendJson(`${url}api/global/operations`, "PATCH", {
      operations: [{ type: "upsert", section: "startups", id: "sneaky-0000", value: { id: "sneaky-0000", name: "Sneaky" } }],
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, "startupsSection");
    const refusedReplace = await sendJson(`${url}api/global/operations`, "PATCH", {
      operations: [{ type: "replaceSection", section: "startups", value: [] }],
    });
    assert.equal(refusedReplace.status, 400);
    assert.deepEqual((await listStartups(url)).map((entry) => entry.id), [startup.id]);
    assert.equal((await browserFetch(`${url}api/global`, { headers: { "If-None-Match": etag } })).status, 304, "a refused write changes nothing");

    assert.equal((await sendJson(`${url}api/global/operations`, "PATCH", { operations: [] })).status, 400);

    const written = await sendJson(`${url}api/global/operations`, "PATCH", {
      operations: [{ type: "replaceSection", section: "appearance", value: { theme: "dark" } }],
    });
    assert.equal(written.status, 200);
    const writtenPayload = await written.json();
    assert.equal(writtenPayload.revision, global.revision + 1);

    const after = await browserFetch(`${url}api/global`, { headers: { "If-None-Match": etag } });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get("etag"), etag);
    assert.deepEqual((await after.json()).state.appearance, { theme: "dark" });

    // A global write is not a write to any startup.
    assert.equal((await browserFetch(`${url}api/s/${startup.id}/state`, { headers: { "If-None-Match": startupEtag } })).status, 304);
  } finally {
    await server.stop();
  }
});

test("combined search and calendar cover every open startup and never write", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");
    const hidden = await createStartup(url, "Hidden");
    await save(url, alpha.id, [
      { type: "replaceSection", section: "items", value: [{ id: "a1", platform: "Rocket launch post", date: "2026-11-02", status: "planned" }], baseRevision: 0 },
      { type: "replaceSection", section: "programs", value: [{ id: "p1", name: "Rocket accelerator", nextActionDate: "2026-11-05" }], baseRevision: 0 },
    ]);
    await fillSection(url, beta.id, "items", [{ id: "b1", platform: "Rocket fair", date: "2026-11-03", time: "10:00" }]);
    await fillSection(url, hidden.id, "items", [{ id: "h1", platform: "Rocket secret", date: "2026-11-04" }]);
    await sendJson(`${url}api/startups/${hidden.id}`, "PATCH", { archived: true });

    const search = async (query) => {
      const response = await browserFetch(`${url}api/all/search?${query}`);
      return { status: response.status, payload: await response.json() };
    };

    const rockets = (await search("q=rocket")).payload;
    assert.deepEqual(rockets.results.map((result) => `${result.startup.id}/${result.section}/${result.id}`).sort(), [
      `${alpha.id}/items/a1`,
      `${alpha.id}/programs/p1`,
      `${beta.id}/items/b1`,
    ].sort());
    const a1 = rockets.results.find((result) => result.id === "a1");
    assert.deepEqual(a1.startup, { id: alpha.id, name: "Alpha", icon: "" });
    assert.equal(a1.kind, "marketing");
    assert.equal(a1.title, "Rocket launch post");
    assert.equal(a1.status, "planned");
    assert.equal(rockets.truncated, false);

    assert.deepEqual((await search("q=rocket%20fair")).payload.results.map((result) => result.id), ["b1"]);
    assert.deepEqual((await search("q=secret")).payload.results, [], "archived startups are left out");
    assert.deepEqual((await search("q=")).payload.results, []);
    const limited = (await search("q=rocket&limit=1")).payload;
    assert.equal(limited.results.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal((await search("q=rocket&limit=0")).status, 400);
    assert.equal((await search("q=rocket&limit=abc")).status, 400);

    const calendar = await browserFetch(`${url}api/all/calendar?from=2026-11-01&to=2026-11-30`);
    assert.equal(calendar.status, 200);
    const { events } = await calendar.json();
    assert.deepEqual(events.map((event) => [event.date, event.startup.id, event.id]), [
      ["2026-11-02", alpha.id, "a1"],
      ["2026-11-03", beta.id, "b1"],
      ["2026-11-05", alpha.id, "p1"],
    ]);
    assert.deepEqual(events[1].startup, { id: beta.id, name: "Beta", icon: "" });
    assert.equal(events[1].time, "10:00");
    assert.equal(events[2].section, "po");
    assert.equal(events[2].kind, "next_action");
    const { records } = await (await browserFetch(`${url}api/all/calendar?from=2026-11-01&to=2026-11-30`)).json();
    assert.ok(records.some((record) => record.startupId === alpha.id && record.section === "mk" && record.id === "a1"), "records come along for the all-time summary");

    const narrowed = await (await browserFetch(`${url}api/all/calendar?from=2026-11-03&to=2026-11-04`)).json();
    assert.deepEqual(narrowed.events.map((event) => event.id), ["b1"]);
    for (const query of ["from=2026/11/01", "to=soon", "from=11-01-2026&to=2026-11-30"]) {
      assert.equal((await browserFetch(`${url}api/all/calendar?${query}`)).status, 400, query);
    }

    // Read-only, even for the page itself.
    for (const route of ["api/all/search?q=rocket", "api/all/calendar"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal((await sendJson(`${url}${route}`, method, {})).status, 405, `${method} ${route}`);
      }
    }

    // Unarchived, the startup is part of the views again.
    await sendJson(`${url}api/startups/${hidden.id}`, "PATCH", { archived: false });
    assert.deepEqual((await search("q=secret")).payload.results.map((result) => result.startup.name), ["Hidden"]);
  } finally {
    await server.stop();
  }
});

test("uploads go to the startup's folder and a document save cannot reach another startup", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    // Neither startup holds any records: media works without them.
    const alpha = await createStartup(url, "Alpha");
    const beta = await createStartup(url, "Beta");

    const response = await uploadFile(url, alpha.id, "Launch Plan.pdf", "%PDF-1.4 test", "application/pdf");
    assert.equal(response.status, 200);
    const upload = await response.json();
    assert.equal(upload.path, `/media/${alpha.id}/${encodeURIComponent(upload.storedName)}`);
    assert.equal(upload.absolutePath, path.join(server.home, "media", alpha.id, upload.storedName));
    assert.equal(fs.readFileSync(upload.absolutePath, "utf8"), "%PDF-1.4 test");

    const served = await browserFetch(`${url}${upload.path.slice(1)}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "application/pdf");
    assert.equal(await served.text(), "%PDF-1.4 test");

    // A link from before startups existed names only the file.
    const oldLink = await noRedirect(`${url}media/${upload.storedName}`);
    assert.equal(oldLink.status, 302);
    assert.equal(oldLink.headers.get("location"), `/media/${alpha.id}/${upload.storedName}`);
    assert.equal((await browserFetch(`${url}media/${upload.storedName}`)).status, 200, "the redirect leads to the file");
    assert.equal((await noRedirect(`${url}media/not-there.pdf`)).status, 404);

    // Beta's document is out of Alpha's reach, whatever path is sent.
    const betaDoc = path.join(server.home, "media", beta.id, "plan.md");
    fs.writeFileSync(betaDoc, "# Beta plan\n");
    const put = (body) => sendJson(`${url}api/s/${alpha.id}/media/document`, "PUT", { content: "# Overwritten\n", ...body });
    for (const [body, status] of [
      [{ sourceType: "local-path", externalPath: betaDoc }, 403],
      [{ sourceType: "local-path", externalPath: `../${beta.id}/plan.md` }, 403],
      [{ sourceType: "upload", absolutePath: betaDoc }, 400],
      [{ sourceType: "upload", storedName: `../${beta.id}/plan.md` }, 404],
      [{ sourceType: "upload", path: `/media/${beta.id}/plan.md` }, 404],
      [{ sourceType: "upload", filePath: `/media/${beta.id}/plan.md` }, 404],
    ]) {
      assert.equal((await put(body)).status, status, JSON.stringify(body));
    }
    assert.equal(fs.readFileSync(betaDoc, "utf8"), "# Beta plan\n");
    assert.equal(fs.existsSync(path.join(server.home, "media", alpha.id, "plan.md")), false, "nothing was created in Alpha's folder");

    // Beta can save its own document.
    const own = await sendJson(`${url}api/s/${beta.id}/media/document`, "PUT", { sourceType: "upload", storedName: "plan.md", content: "# Beta plan v2\n" });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).path, `/media/${beta.id}/plan.md`);
    assert.equal(fs.readFileSync(betaDoc, "utf8"), "# Beta plan v2\n");
  } finally {
    await server.stop();
  }
});

test("a database from before startups is upgraded on start into the Imported startup", async () => {
  const home = makeTempHome();
  const databasePath = path.join(home, "data", "tracker.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacyState = {
    updatedAt: "2026-05-01T09:00:00.000Z",
    items: [{ id: "old-1", platform: "Legacy forum", date: "2026-05-02" }, { id: "old-2", platform: "Legacy blog" }],
    prompts: [{ id: "prompt-1", content: "Keep me." }],
    profile: { pitch: "Before startups" },
  };
  const written = writeLegacyDatabase(databasePath, legacyState, {
    version: 3,
    revision: 7,
    history: [{ section: "items", id: "old-1", event: "created", at: "2026-05-01T08:00:00.000Z" }],
  });
  const mediaDir = path.join(home, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "old-photo.png"), "old image bytes");

  let server = await startServer({ home });
  try {
    const url = server.url;
    const backups = fs.readdirSync(path.join(home, "backups"));
    const preUpgrade = backups.filter((name) => /^tracker-\d{8}-\d{6}-pre-upgrade-v3\.sqlite$/.test(name));
    assert.equal(preUpgrade.length, 1);

    // The copy is the old file as it was: still the old layout, same rows.
    const copyPath = path.join(home, "backups", preUpgrade[0]);
    const copyCheck = verifyDatabaseFile(copyPath);
    assert.equal(copyCheck.legacy, true);
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    try {
      assert.deepEqual(
        copy.prepare("SELECT section_name, record_id, value_json FROM state_records ORDER BY section_name, ordinal").all().map((row) => ({ ...row })),
        written.records.map((row) => ({ ...row })),
      );
    } finally {
      copy.close();
    }

    const list = await listStartups(url);
    assert.equal(list.length, 1);
    const imported = list[0];
    assert.equal(imported.name, "Imported");
    assert.match(imported.id, /^imported-[a-z0-9]{4}$/);

    const { payload } = await readState(url, imported.id);
    assert.deepEqual(payload.state, legacyState);
    assert.equal(payload.revision, 7, "the startup keeps the file's revision");
    const history = await (await browserFetch(`${url}api/s/${imported.id}/state/history?section=items&id=old-1`)).json();
    assert.ok(history.entries.some((entry) => entry.event === "created" && entry.changedAt === "2026-05-01T08:00:00.000Z"));

    // Loose uploads moved into the startup's folder; old links follow them.
    assert.equal(fs.existsSync(path.join(mediaDir, "old-photo.png")), false);
    assert.equal(fs.readFileSync(path.join(mediaDir, imported.id, "old-photo.png"), "utf8"), "old image bytes");
    const oldLink = await noRedirect(`${url}media/old-photo.png`);
    assert.equal(oldLink.status, 302);
    assert.equal(oldLink.headers.get("location"), `/media/${imported.id}/old-photo.png`);
    assert.equal(await (await browserFetch(`${url}media/old-photo.png`)).text(), "old image bytes");

    assert.equal((await noRedirect(url)).headers.get("location"), `/s/${imported.id}/`);

    // A second start finds an upgraded database and leaves it alone.
    await server.stop({ keepHome: true });
    server = await startServer({ home });
    assert.equal(fs.readdirSync(path.join(home, "backups")).filter((name) => name.includes("pre-upgrade")).length, 1);
    assert.deepEqual((await listStartups(server.url)).map((startup) => startup.id), [imported.id]);
    assert.deepEqual((await readState(server.url, imported.id)).payload.state, legacyState);
  } finally {
    await server.stop();
  }
});

test("the startup list counts records and media on request", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const counted = await createStartup(url, "Counted");
    const empty = await createStartup(url, "Empty");
    await save(url, counted.id, [
      { type: "replaceSection", section: "items", value: [{ id: "a" }, { id: "b" }], baseRevision: 0 },
      { type: "replaceSection", section: "programs", value: [{ id: "p" }], baseRevision: 0 },
      // A value section holds no records.
      { type: "replaceSection", section: "profile", value: { pitch: "Not a record" }, baseRevision: 0 },
    ]);
    assert.equal((await uploadFile(url, counted.id, "deck.pdf", "12345")).status, 200);
    assert.equal((await uploadFile(url, counted.id, "logo.png", "1234567")).status, 200);

    // Without counts=1 the list stays cheap.
    const plain = await listStartups(url);
    assert.equal(plain[0].recordCount, undefined);
    assert.equal(plain[0].mediaBytes, undefined);

    const response = await browserFetch(`${url}api/startups?counts=1`);
    assert.equal(response.status, 200);
    const byId = new Map((await response.json()).startups.map((startup) => [startup.id, startup]));
    assert.equal(byId.get(counted.id).recordCount, 3);
    assert.equal(byId.get(counted.id).mediaBytes, 12);
    assert.equal(byId.get(counted.id).name, "Counted", "the counts come with the usual fields");
    assert.equal(byId.get(empty.id).recordCount, 0);
    assert.equal(byId.get(empty.id).mediaBytes, 0);
  } finally {
    await server.stop();
  }
});

test("copyProfileFields copies only the listed profile fields", async () => {
  const server = await startServer();
  const url = server.url;
  try {
    const source = await createStartup(url, "Source");
    await save(url, source.id, [
      { type: "replaceSection", section: "profile", value: { pitch: "Robots for labs", website: "https://example.com", founders: "Ana and Bo" }, baseRevision: 0 },
      { type: "replaceSection", section: "uiPreferences", value: { density: "compact" }, baseRevision: 0 },
      { type: "replaceSection", section: "items", value: [{ id: "t1", platform: "Forum" }], baseRevision: 0 },
    ]);

    const some = await createStartup(url, "Some fields", { copySettingsFrom: source.id, copyProfileFields: ["pitch", "website", "notThere"] });
    const someState = (await readState(url, some.id)).payload.state;
    assert.deepEqual(someState.profile, { pitch: "Robots for labs", website: "https://example.com" });
    // The other settings sections still come along; records do not.
    assert.deepEqual(someState.uiPreferences, { density: "compact" });
    assert.equal(someState.items, undefined);

    const none = await createStartup(url, "No fields", { copySettingsFrom: source.id, copyProfileFields: [] });
    assert.deepEqual((await readState(url, none.id)).payload.state.profile, {});

    // Left out, the whole profile is copied.
    const all = await createStartup(url, "All fields", { copySettingsFrom: source.id });
    assert.deepEqual((await readState(url, all.id)).payload.state.profile, { pitch: "Robots for labs", website: "https://example.com", founders: "Ana and Bo" });

    // The source is left as it was.
    assert.deepEqual((await readState(url, source.id)).payload.state.profile, { pitch: "Robots for labs", website: "https://example.com", founders: "Ana and Bo" });
  } finally {
    await server.stop();
  }
});
