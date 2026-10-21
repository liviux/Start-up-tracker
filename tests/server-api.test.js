"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { startServer, makeTempHome, rootDir } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations, uploadFile, seedStartup } = require("./helpers/api");

// Where the server keeps the database when only STARTUP_TRACKER_HOME is set.
function defaultDatabasePath(home) {
  return path.join(home, "data", "tracker.sqlite");
}

test("state API compresses reads and applies idempotent incremental writes", async () => {
  const home = makeTempHome("tracker-server-test-");
  // The individual locations can still be moved with environment variables.
  const databasePath = path.join(home, "custom-data", "tracker.sqlite");
  const backupDir = path.join(home, "custom-backup");
  const mediaDir = path.join(home, "custom-media");
  const sourceState = {
    name: "Test tracker",
    updatedAt: "2026-08-19T08:00:00.000Z",
    categories: [{ id: "category-a", name: "A" }],
    items: [{ id: "target-a", platform: "Before" }],
    prompts: [{ id: "prompt-a", content: "Keep this exact prompt." }],
    companyProfile: { incorporated: true },
    testPadding: "x".repeat(3_000),
  };
  // The seeded data has never been backed up, so the server takes an automatic
  // backup of it when it starts.
  const startupId = seedStartup(databasePath, "Test tracker", sourceState);

  const server = await startServer({
    home,
    env: { TRACKER_DB_PATH: databasePath, TRACKER_BACKUP_DIR: backupDir, TRACKER_MEDIA_DIR: mediaDir },
  });
  const serverUrl = server.url;
  const stateUrl = `${serverUrl}api/s/${startupId}/state`;

  try {
    const health = await (await browserFetch(`${serverUrl}api/health`)).json();
    assert.equal(health.filePath, databasePath);
    assert.equal(health.version, require("../package.json").version);
    assert.equal(health.mediaDir, mediaDir);
    assert.equal(health.startupCount, 1);

    const initialResponse = await browserFetch(stateUrl, {
      headers: { "Accept-Encoding": "br" },
    });
    assert.equal(initialResponse.status, 200);
    assert.equal(initialResponse.headers.get("content-encoding"), "br");
    const initial = await initialResponse.json();
    assert.deepEqual(initial.state, sourceState);
    assert.equal(initial.startupId, startupId);
    assert.equal(initial.revision, 1);
    assert.equal(initial.mediaDir, path.join(mediaDir, startupId));
    assert.equal(typeof initial.fileHash, "string");
    // Per-record revisions ride along with the state so the client can base
    // each edit on the version of the individual record it is editing.
    assert.equal(initial.revisionMap.records.items["target-a"], 1);
    assert.equal(initial.revisionMap.records.prompts["prompt-a"], 1);

    // The ETag is the revision counter, so revalidation never hashes the state.
    const initialEtag = initialResponse.headers.get("etag");
    assert.equal(initialEtag, 'W/"rev-1"');
    const unchangedResponse = await browserFetch(stateUrl, {
      headers: { "If-None-Match": initialEtag },
    });
    assert.equal(unchangedResponse.status, 304);
    assert.equal(unchangedResponse.headers.get("x-state-revision"), "1");

    // A tab without protocolVersion 2 is told to reload instead of saving.
    const oldClientResponse = await sendJson(`${stateUrl}/operations`, "PATCH", {
      operations: [{ type: "upsert", section: "items", id: "target-a", value: { id: "target-a", platform: "Old" } }],
    });
    assert.equal(oldClientResponse.status, 409);
    assert.equal((await oldClientResponse.json()).error, "reloadRequired");

    // So is one whose operation carries no per-record lock.
    const unlockedResponse = await saveOperations(serverUrl, startupId, [
      { type: "upsert", section: "items", id: "target-a", value: { id: "target-a", platform: "Unlocked" } },
    ]);
    assert.equal(unlockedResponse.status, 409);
    assert.equal((await unlockedResponse.json()).error, "reloadRequired");

    const mutation = {
      protocolVersion: 2,
      mutationId: "api-test-mutation",
      baseRevision: 1,
      updatedAt: "2026-08-19T08:01:00.000Z",
      operations: [{
        type: "upsert",
        section: "items",
        id: "target-a",
        baseRevision: 1,
        value: { id: "target-a", platform: "After" },
        position: 0,
      }],
    };
    const saveResponse = await sendJson(`${stateUrl}/operations`, "PATCH", mutation);
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.revision, 2);
    assert.equal(saved.replayed, false);
    assert.equal(saved.mediaDir, path.join(mediaDir, startupId));

    const recordResponse = await browserFetch(`${stateUrl}/records/items/target-a`);
    assert.equal(recordResponse.status, 200);
    const recordPayload = await recordResponse.json();
    assert.deepEqual(recordPayload.record, { id: "target-a", platform: "After" });
    assert.equal(recordPayload.recordRevision, 2);

    const missingRecordResponse = await browserFetch(`${stateUrl}/records/items/missing`);
    assert.equal(missingRecordResponse.status, 404);
    const missingRecordPayload = await missingRecordResponse.json();
    assert.equal(missingRecordPayload.recordRevision, null);
    assert.equal(missingRecordPayload.revision, 2);

    // The same mutation sent again is answered from the record of it, not applied twice.
    const retryResponse = await sendJson(`${stateUrl}/operations`, "PATCH", mutation);
    assert.equal(retryResponse.status, 200);
    const retried = await retryResponse.json();
    assert.equal(retried.revision, 2);
    assert.equal(retried.replayed, true);

    const largeMutation = {
      protocolVersion: 2,
      mutationId: "compressed-api-test-mutation",
      baseRevision: 2,
      updatedAt: "2026-08-19T08:01:30.000Z",
      operations: [{
        type: "upsert",
        section: "items",
        id: "target-b",
        baseRevision: 0,
        value: { id: "target-b", platform: "Compressed", notes: "z".repeat(300_000) },
        position: 1,
      }],
    };
    const compressedSaveResponse = await browserFetch(`${stateUrl}/operations`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: zlib.gzipSync(JSON.stringify(largeMutation)),
    });
    assert.equal(compressedSaveResponse.status, 200);
    assert.equal((await compressedSaveResponse.json()).revision, 3);

    // A stale startup revision is not a conflict on its own. Work landing on
    // other records must not block an edit to a record nobody else touched.
    const unrelatedEditResponse = await saveOperations(serverUrl, startupId, [{
      type: "upsert",
      section: "prompts",
      id: "prompt-a",
      // prompt-a has sat at revision 1 the whole time, so this is current.
      baseRevision: 1,
      value: { id: "prompt-a", content: "Edited while other records moved." },
    }], { mutationId: "unrelated-record-mutation", baseRevision: 1, updatedAt: "2026-08-19T08:01:45.000Z" });
    assert.equal(unrelatedEditResponse.status, 200);
    const unrelatedEdit = await unrelatedEditResponse.json();
    assert.equal(unrelatedEdit.revision, 4);

    // Editing the same record from a stale base is still a conflict, and the
    // response names exactly which records collided.
    const conflictResponse = await saveOperations(serverUrl, startupId, [{
      type: "upsert",
      section: "items",
      id: "target-a",
      baseRevision: 1,
      value: { id: "target-a", platform: "Stale" },
    }], { mutationId: "stale-api-test-mutation", updatedAt: "2026-08-19T08:02:00.000Z" });
    assert.equal(conflictResponse.status, 409);
    const conflict = await conflictResponse.json();
    assert.equal(conflict.error, "recordConflict");
    assert.deepEqual(
      conflict.conflicts.map(({ section, id, reason }) => ({ section, id, reason })),
      [{ section: "items", id: "target-a", reason: "modified" }],
    );
    assert.equal(conflict.revision, 4);

    // Only records newer than the given revision come back in a delta.
    const changesResponse = await browserFetch(`${stateUrl}/changes?since=3`);
    assert.equal(changesResponse.status, 200);
    const changes = await changesResponse.json();
    assert.equal(changes.complete, true);
    assert.deepEqual(changes.upserts.map((entry) => entry.id), ["prompt-a"]);
    assert.deepEqual(changes.deletes, []);
    assert.equal((await browserFetch(`${stateUrl}/changes?since=-1`)).status, 400);
    assert.equal((await browserFetch(`${stateUrl}/changes`)).status, 400, "since is required");

    // A pinned backup is a verified copy of the live database, taken on demand.
    const pinnedResponse = await sendJson(`${serverUrl}api/backups`, "POST", { label: "api-test" });
    assert.equal(pinnedResponse.status, 201);
    const { backup: pinned } = await pinnedResponse.json();
    assert.match(pinned.id, /^\d{8}-\d{6}-\d{3}-pinned-api-test$/);
    assert.equal(pinned.kind, "pinned");
    assert.equal(pinned.label, "api-test");
    assert.equal(pinned.complete, true);
    // The backup's revision counts writes across the whole database.
    assert.equal(pinned.databaseRevision, (await (await browserFetch(`${serverUrl}api/health`)).json()).revision);

    // The backup has to be independently readable, not just present on disk.
    const backupStore = new TrackerSqliteStore(path.join(backupDir, pinned.id, "tracker.sqlite"), { readOnly: true });
    try {
      const { state: backupState, revision: backupStartupRevision } = backupStore.readState(startupId);
      assert.equal(backupStartupRevision, 4);
      assert.equal(backupState.items[0].platform, "After");
      assert.equal(backupState.items[1].notes.length, 300_000);
      assert.equal(backupState.prompts[0].content, "Edited while other records moved.");
      assert.equal(backupState.updatedAt, "2026-08-19T08:01:45.000Z");
    } finally {
      backupStore.close();
    }

    // The flat-file snapshot routes are gone.
    assert.equal((await sendJson(`${serverUrl}api/state/snapshot`, "POST", {})).status, 404);
    assert.equal((await sendJson(`${serverUrl}api/backups/snapshot`, "POST", { label: "old" })).status, 404);
    assert.equal((await sendJson(`${serverUrl}api/backups/restore`, "POST", { fileName: "tracker-x.sqlite" })).status, 404);

    // The seeded data was backed up automatically when the server started.
    const listing = await (await browserFetch(`${serverUrl}api/backups?startupId=${startupId}`)).json();
    assert.deepEqual(listing.backups.map((backup) => backup.kind), ["pinned", "automatic"]);
    const seedBackup = listing.backups[1];
    assert.equal(seedBackup.reason, "first");
    assert.equal(seedBackup.complete, true);
    assert.deepEqual(seedBackup.startups, [{ id: startupId, name: "Test tracker" }]);
    assert.deepEqual(seedBackup.counts, { categories: 1, items: 1, prompts: 1 });

    // Restoring rolls the startup back to the state the backup holds.
    const restoreResponse = await sendJson(`${serverUrl}api/backups/${seedBackup.id}/restore`, "POST", { scope: "startup", startupId });
    assert.equal(restoreResponse.status, 200);
    const { restored } = await restoreResponse.json();
    // Restoring the wrong backup must itself be undoable. Nothing changed since
    // the pinned backup, so that one stands as the safety backup.
    assert.equal(restored.safetyBackup, pinned.id);
    const safetyStore = new TrackerSqliteStore(path.join(backupDir, restored.safetyBackup, "tracker.sqlite"), { readOnly: true });
    try {
      assert.equal(safetyStore.readState(startupId).state.items[0].platform, "After");
    } finally {
      safetyStore.close();
    }

    const afterRestoreResponse = await browserFetch(stateUrl, { headers: { "If-None-Match": 'W/"rev-4"' } });
    assert.equal(afterRestoreResponse.status, 200, "a restore moves the revision, so an old ETag no longer matches");
    const afterRestore = await afterRestoreResponse.json();
    assert.deepEqual(afterRestore.state, sourceState);
    assert.equal(afterRestore.revision, 5);

    // A name that is not a backup, or a backup that is not there, is refused.
    assert.equal((await sendJson(`${serverUrl}api/backups/..%2ftracker.sqlite/restore`, "POST", { scope: "database" })).status, 400);
    assert.equal((await sendJson(`${serverUrl}api/backups/tracker.sqlite/restore`, "POST", { scope: "database" })).status, 404);
    assert.equal((await sendJson(`${serverUrl}api/backups/19990101-000000-000-pinned/restore`, "POST", { scope: "database" })).status, 404);
    assert.equal((await sendJson(`${serverUrl}api/backups/${pinned.id}/restore`, "POST", { scope: "everything" })).status, 400);
  } finally {
    await server.stop();
  }
});

test("serveStatic blocks path traversal attempts and serves valid static files", async () => {
  const server = await startServer({ home: makeTempHome("tracker-static-test-") });
  try {
    const validRes = await browserFetch(`${server.url}index.html`);
    assert.equal(validRes.status, 200);

    const traversalRes1 = await browserFetch(`${server.url}..%2fpackage.json`);
    assert.equal(traversalRes1.status, 400);

    const traversalRes2 = await browserFetch(`${server.url}..%2f..%2fpackage.json`);
    assert.equal(traversalRes2.status, 400);

    // The startup in the page address is checked the same way.
    const startup = await createStartup(server.url, "Static");
    assert.equal((await browserFetch(`${server.url}s/${startup.id}/..%2f..%2fpackage.json`)).status, 400);
  } finally {
    await server.stop();
  }
});

test("media document API saves markdown asynchronously", async () => {
  const server = await startServer({ home: makeTempHome("tracker-doc-api-") });
  try {
    const startup = await createStartup(server.url, "Docs");
    const folder = path.join(server.home, "media", startup.id);
    assert.ok(fs.statSync(folder).isDirectory(), "creating a startup creates its media folder");

    const mdFileName = "test-doc.md";
    const mdFilePath = path.join(folder, mdFileName);
    fs.writeFileSync(mdFilePath, "# Original Content\n", "utf8");

    const newContent = "# Updated Content\n\nAsync write test.";
    const response = await sendJson(`${server.url}api/s/${startup.id}/media/document`, "PUT", {
      sourceType: "upload",
      storedName: mdFileName,
      content: newContent,
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.path, `/media/${startup.id}/${mdFileName}`);
    assert.equal(result.size, Buffer.byteLength(newContent, "utf8"));
    assert.equal(fs.readFileSync(mdFilePath, "utf8"), newContent);

    // Only Markdown can be saved, and a missing file is not created.
    fs.writeFileSync(path.join(folder, "note.txt"), "text");
    assert.equal((await sendJson(`${server.url}api/s/${startup.id}/media/document`, "PUT", {
      sourceType: "upload", storedName: "note.txt", content: "x",
    })).status, 400);
    assert.equal(fs.readFileSync(path.join(folder, "note.txt"), "utf8"), "text");
    assert.equal((await sendJson(`${server.url}api/s/${startup.id}/media/document`, "PUT", {
      sourceType: "upload", storedName: "missing.md", content: "x",
    })).status, 404);
  } finally {
    await server.stop();
  }
});

test("media upload handles collisions efficiently and generates unique file names", async () => {
  const server = await startServer({ home: makeTempHome("tracker-upload-test-") });
  try {
    const startup = await createStartup(server.url, "Uploads");

    const res1 = await uploadFile(server.url, startup.id, "test-image.png", "png data", "image/png");
    assert.equal(res1.status, 200);
    const payload1 = await res1.json();
    assert.equal(payload1.ok, true);
    assert.equal(payload1.originalName, "test-image.png");

    // Second upload with same filename induces collision
    const res2 = await uploadFile(server.url, startup.id, "test-image.png", "png data", "image/png");
    assert.equal(res2.status, 200);
    const payload2 = await res2.json();
    assert.equal(payload2.ok, true);
    assert.notEqual(payload1.storedName, payload2.storedName);
    assert.ok(fs.existsSync(payload1.absolutePath));
    assert.ok(fs.existsSync(payload2.absolutePath));
  } finally {
    await server.stop();
  }
});

test("validates Host header to prevent DNS rebinding attacks", async () => {
  const server = await startServer({ home: makeTempHome("tracker-host-header-") });

  try {
    const serverPort = Number(new URL(server.url).port);

    const makeRequestWithHost = (hostHeader, requestPath = "/api/health") => {
      return new Promise((resolve, reject) => {
        const req = require("node:http").request({
          hostname: "127.0.0.1",
          port: serverPort,
          path: requestPath,
          headers: { Host: hostHeader },
        }, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("error", reject);
        req.end();
      });
    };

    // Valid Host headers should be allowed
    const validHosts = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      `127.0.0.1:${serverPort}`,
      `localhost:${serverPort}`,
    ];

    for (const host of validHosts) {
      const res = await makeRequestWithHost(host);
      assert.equal(res.status, 200, `Host header ${host} should be accepted`);
    }

    // Invalid / malicious Host headers should be rejected with 403 Forbidden
    const invalidHosts = [
      "evil.com",
      "attacker.example.com",
      "localhost.evil.com",
      "127.0.0.1.attacker.com",
    ];

    for (const host of invalidHosts) {
      for (const requestPath of ["/api/health", "/api/startups", "/"]) {
        const res = await makeRequestWithHost(host, requestPath);
        assert.equal(res.status, 403, `Host header ${host} should be rejected on ${requestPath}`);
        assert.equal(res.body, "Forbidden: Invalid Host header");
      }
    }
  } finally {
    await server.stop();
  }
});

test("server enforces decompression maxOutputLength on gzip and brotli requests to prevent zip bombs", async () => {
  const server = await startServer({ home: makeTempHome("tracker-zipbomb-"), env: { MAX_STATE_BODY_BYTES: "1024" } });

  try {
    const startup = await createStartup(server.url, "Zip");
    const operationsUrl = `${server.url}api/s/${startup.id}/state/operations`;

    const largePayload = JSON.stringify({
      protocolVersion: 2,
      padding: "a".repeat(2048),
    });

    const send = (encoding, body) => browserFetch(operationsUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Encoding": encoding },
      body,
    });

    assert.equal((await send("gzip", zlib.gzipSync(largePayload))).status, 413);
    assert.equal((await send("br", zlib.brotliCompressSync(largePayload))).status, 413);
    // The global scope has the same limit.
    assert.equal((await browserFetch(`${server.url}api/global/operations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: zlib.gzipSync(largePayload),
    })).status, 413);
    // An encoding the server cannot decode is refused rather than guessed at.
    assert.equal((await send("deflate", zlib.deflateSync(largePayload))).status, 415);

    const validPayload = JSON.stringify({
      protocolVersion: 2,
      mutationId: "valid-zip-test",
      baseRevision: 1,
      operations: [],
    });
    const validResponse = await send("gzip", zlib.gzipSync(validPayload));
    assert.notEqual(validResponse.status, 413);
    assert.equal(validResponse.status, 400, "an empty operation list is decoded and then refused");
  } finally {
    await server.stop();
  }
});

test("media upload API handles multipart file upload asynchronously", async () => {
  const server = await startServer({ home: makeTempHome("tracker-upload-test-") });

  try {
    const startup = await createStartup(server.url, "Upload");
    const content = Buffer.from("Hello world media content");
    const response = await uploadFile(server.url, startup.id, "sample.png", content, "image/png");

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.originalName, "sample.png");
    assert.equal(payload.mimeType, "image/png");
    assert.equal(payload.size, content.length);
    assert.equal(payload.mediaDir, path.join(server.home, "media", startup.id));
    assert.equal(path.dirname(payload.absolutePath), payload.mediaDir);
    assert.ok(fs.existsSync(payload.absolutePath));
    assert.equal(fs.readFileSync(payload.absolutePath, "utf8"), "Hello world media content");

    const served = await browserFetch(`${server.url}${payload.path.slice(1)}`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "Hello world media content");

    // A body that is not multipart is refused.
    const notMultipart = await sendJson(`${server.url}api/s/${startup.id}/media/upload`, "POST", {});
    assert.equal(notMultipart.status, 400);
    const noFile = await browserFetch(`${server.url}api/s/${startup.id}/media/upload`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=empty" },
      body: "--empty--\r\n",
    });
    assert.equal(noFile.status, 400);
  } finally {
    await server.stop();
  }
});

test("a damaged database is refused instead of served", async () => {
  const home = makeTempHome("tracker-integrity-");
  const databasePath = defaultDatabasePath(home);
  const backupDir = path.join(home, "backups");

  const startupId = seedStartup(databasePath, "Damaged", { updatedAt: "seed", items: [{ id: "a", title: "Real" }] });
  const seed = new TrackerSqliteStore(databasePath);
  try {
    // Enough rows that the corruption below lands on table pages.
    seed.upsertRecord(startupId, "items", { id: "b", title: "x".repeat(40_000) });
    fs.mkdirSync(backupDir, { recursive: true });
    seed.createSnapshot(path.join(backupDir, "tracker-20260819-090000.sqlite"));
  } finally {
    seed.close();
  }

  // Corrupt pages in the middle of the file, which is what a bad disk or a
  // half-copied database looks like.
  const damaged = fs.readFileSync(databasePath);
  damaged.fill(0, 4_096, 20_000);
  fs.writeFileSync(databasePath, damaged);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: { ...process.env, PORT: "0", NO_OPEN: "1", STARTUP_TRACKER_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));

    // Serving from a damaged database would let good edits pile on top of
    // corruption until the last clean snapshot rotates away.
    assert.notEqual(exitCode, 0);
    assert.match(output, /failed its integrity check/);
    // The operator is told which snapshot to restore, not just that it broke.
    assert.match(output, /tracker-20260819-090000\.sqlite/);
    assert.doesNotMatch(output, /Startup Tracker: http/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("backups rotate per kind by the keep settings while pinned ones are kept", async () => {
  const home = makeTempHome("tracker-rotation-");
  let server = await startServer({ home });
  const backupDir = path.join(home, "backups");
  const kindsOnDisk = () => fs.readdirSync(backupDir)
    .map((name) => name.match(/^\d{8}-\d{6}-\d{3}-(automatic|safety|pinned)(?:-(.+))?$/))
    .filter(Boolean)
    .map((match) => (match[2] ? `${match[1]}-${match[2]}` : match[1]))
    .sort();

  try {
    const startup = await createStartup(server.url, "Rotation");
    assert.equal((await sendJson(`${server.url}api/backups`, "POST", { label: "keep-me" })).status, 201);
    // A new startup holds no sections; its first record creates the collection.
    const firstRecord = await saveOperations(server.url, startup.id, [{
      type: "upsert", section: "items", id: "early", baseRevision: 0, value: { id: "early" },
    }]);
    assert.equal(firstRecord.status, 200);
    assert.equal((await saveOperations(server.url, startup.id, [
      { type: "replaceSection", section: "items", value: [], baseRevision: 1 },
    ])).status, 200);

    const settings = await sendJson(`${server.url}api/settings`, "PATCH", { settings: { backups: { keepSafety: 2, keepAutomatic: 1 } } });
    assert.equal(settings.status, 200);
    assert.deepEqual((await settings.json()).settings.backups, { automatic: true, keepSafety: 2, keepAutomatic: 1 });

    // Deleting a startup takes a safety backup. Each one is taken after a
    // change, so these are four genuinely different backups rather than
    // repeats of one state.
    for (let index = 0; index < 4; index += 1) {
      const doomed = await createStartup(server.url, `Doomed ${index}`);
      const deleted = await browserFetch(`${server.url}api/startups/${doomed.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
    }
    // keepSafety bounds the safety backups...
    assert.deepEqual(kindsOnDisk(), ["pinned-keep-me", "safety", "safety"]);

    // ...and keepAutomatic the automatic ones, taken at start after a change.
    for (let round = 0; round < 2; round += 1) {
      assert.equal((await saveOperations(server.url, startup.id, [{
        type: "upsert", section: "items", id: `round-${round}`, baseRevision: 0, value: { id: `round-${round}` },
      }])).status, 200);
      await server.stop({ keepHome: true });
      server = await startServer({ home });
    }
    // The pinned one is not spent to make room for either kind, and the
    // automatic ones never push out the safety ones.
    assert.deepEqual(kindsOnDisk(), ["automatic", "pinned-keep-me", "safety", "safety"]);
    const listed = (await (await browserFetch(`${server.url}api/backups`)).json()).backups;
    assert.deepEqual(listed.map((backup) => backup.kind).sort(), ["automatic", "pinned", "safety", "safety"]);
  } finally {
    await server.stop();
  }
});

test("external store writes invalidate API caches", async () => {
  const home = makeTempHome("tracker-external-writer-");
  const databasePath = defaultDatabasePath(home);
  const startupId = seedStartup(databasePath, "External", { items: [{ id: "a", title: "Before" }] });
  const server = await startServer({ home });
  try {
    const firstResponse = await browserFetch(`${server.url}api/s/${startupId}/state`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal((await firstResponse.json()).state.items[0].title, "Before");

    // A maintenance tool writing through the store while the server runs, which
    // is the supported way to script bulk edits.
    const writer = new TrackerSqliteStore(databasePath);
    try {
      writer.applyOperations(startupId, [{
        type: "upsert", section: "items", id: "a", baseRevision: 1,
        value: { id: "a", title: "External" },
      }]);
    } finally {
      writer.close();
    }

    // The durable revision moved, so every cached and compressed response built
    // from the older one has to be discarded rather than revalidated as fresh.
    const refreshed = await browserFetch(`${server.url}api/s/${startupId}/state`, {
      headers: { "If-None-Match": firstResponse.headers.get("etag"), "Accept-Encoding": "gzip" },
    });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).state.items[0].title, "External");
  } finally {
    await server.stop();
  }
});

test("history API serves a record timeline and refuses malformed queries", async () => {
  const home = makeTempHome("tracker-history-api-");
  const startupId = seedStartup(defaultDatabasePath(home), "History", {
    updatedAt: "2026-08-19T08:00:00.000Z",
    items: [{ id: "target-a", platform: "Before", notes: "one" }],
  });
  const server = await startServer({ home });
  const historyUrl = `${server.url}api/s/${startupId}/state/history`;

  try {
    const save = await saveOperations(server.url, startupId, [{
      type: "upsert",
      section: "items",
      id: "target-a",
      baseRevision: 1,
      value: { id: "target-a", platform: "After", notes: "one\ntwo" },
    }], { origin: "ui", updatedAt: "2026-08-19T08:01:00.000Z" });
    assert.equal(save.status, 200);

    const response = await browserFetch(`${historyUrl}?section=items&id=target-a`);
    assert.equal(response.status, 200);
    // A cached 304 here would show a timeline missing the edit just saved.
    assert.equal(response.headers.get("etag"), null);

    const history = await response.json();
    assert.equal(history.ok, true);
    assert.equal(history.available, true);
    assert.equal(history.section, "items");
    const edit = history.entries.find((entry) => entry.event === "updated");
    assert.equal(edit.origin, "ui");
    assert.deepEqual(
      edit.fields.map((field) => field.path).sort(),
      ["notes", "platform"],
      "updatedAt is never reported as a change",
    );
    assert.equal(edit.fields.find((field) => field.path === "notes").before, "one");

    assert.equal((await browserFetch(`${historyUrl}?section=items`)).status, 400);
    assert.equal((await browserFetch(`${historyUrl}?section=items&id=target-a&limit=9000`)).status, 400);
    assert.equal((await browserFetch(`${historyUrl}?section=items&id=target-a&offset=-1`)).status, 400);
    const unknownRecord = await browserFetch(`${historyUrl}?section=items&id=nope`);
    assert.equal(unknownRecord.status, 200);
    assert.deepEqual((await unknownRecord.json()).entries, []);

    // Paging slices the merged timeline.
    const paged = await (await browserFetch(`${historyUrl}?section=items&id=target-a&limit=1&offset=0`)).json();
    assert.equal(paged.entries.length, 1);
    assert.ok(paged.total >= 1);
  } finally {
    await server.stop();
  }
});

test("a browser edit is attributed to the person at the keyboard, an API write is not", async () => {
  // Every edit made in the UI is one person editing by hand, so the timeline can
  // name them rather than reporting only that a browser was involved. An "api"
  // write is a script or another agent, and putting that name on it would be a
  // guess.
  const home = makeTempHome("tracker-actor-");
  const startupId = seedStartup(defaultDatabasePath(home), "Actor", {
    updatedAt: "2026-08-22T08:00:00.000Z",
    items: [{ id: "target-a", platform: "Start" }],
  });

  // The default has to be observed with the variable absent, or a value already
  // in the environment would decide the result and the test would prove nothing.
  const previousActor = process.env.TRACKER_UI_ACTOR;
  delete process.env.TRACKER_UI_ACTOR;

  // Every operation has to carry the revision of the record it edits, so the
  // save reports back the new one for the next edit to lock against.
  async function save(serverUrl, { origin, updatedAt, platform, baseRevision }) {
    const extra = { updatedAt };
    if (origin) extra.origin = origin;
    const response = await saveOperations(serverUrl, startupId, [{
      type: "upsert",
      section: "items",
      id: "target-a",
      baseRevision,
      value: { id: "target-a", platform },
    }], extra);
    assert.equal(response.status, 200, `save should succeed, got ${response.status}`);
    return (await response.json()).revisionMap.records.items["target-a"];
  }

  async function readEntries(serverUrl) {
    const response = await browserFetch(`${serverUrl}api/s/${startupId}/state/history?section=items&id=target-a`);
    assert.equal(response.status, 200);
    return (await response.json()).entries;
  }

  let revision = 1;
  try {
    let server = await startServer({ home });
    try {
      revision = await save(server.url, {
        origin: "ui",
        updatedAt: "2026-08-22T08:01:00.000Z",
        platform: "Edited in the browser",
        baseRevision: revision,
      });

      // No origin, so the route records it as "api". Session coalescing folds
      // edits by the same writer, and a different actor is one of the things that
      // breaks the session, so this lands as its own entry.
      revision = await save(server.url, {
        updatedAt: "2026-08-22T08:02:00.000Z",
        platform: "Edited by a script",
        baseRevision: revision,
      });

      const entries = await readEntries(server.url);
      const browserEdit = entries.find((entry) => entry.origin === "ui");
      const scriptEdit = entries.find((entry) => entry.origin === "api");
      // Without TRACKER_UI_ACTOR no name is stored, and the timeline says "You".
      assert.equal(browserEdit.actor, null);
      assert.equal(scriptEdit.actor, null);
    } finally {
      await server.stop({ keepHome: true });
    }

    // The name is a fact about the install, so it is configurable rather than
    // compiled in.
    server = await startServer({ home, env: { TRACKER_UI_ACTOR: "Someone Else" } });
    try {
      await save(server.url, {
        origin: "ui",
        updatedAt: "2026-08-22T08:03:00.000Z",
        platform: "Edited by the other operator",
        baseRevision: revision,
      });

      const uiActors = (await readEntries(server.url))
        .filter((entry) => entry.origin === "ui")
        .map((entry) => entry.actor);
      assert.ok(uiActors.includes("Someone Else"));
      // The earlier entry keeps what it was written with (no name) rather than
      // being relabelled by whatever the server is configured with now.
      assert.ok(uiActors.includes(null));
    } finally {
      await server.stop();
    }
  } finally {
    if (previousActor === undefined) delete process.env.TRACKER_UI_ACTOR;
    else process.env.TRACKER_UI_ACTOR = previousActor;
  }
});

test("a record's timeline survives a trip through the recycle bin", async () => {
  // Deleting moves the record into a parallel section, so its history is split
  // across two section names. Reading only the section the modal shows would end
  // the story at the last time the record came back out of the bin.
  const home = makeTempHome("tracker-history-bin-");
  const startupId = seedStartup(defaultDatabasePath(home), "Bin", {
    updatedAt: "2026-08-19T08:00:00.000Z",
    items: [{ id: "bin-a", platform: "Original" }],
    deletedItems: [],
  });
  const server = await startServer({ home });
  const serverUrl = server.url;

  try {
    // Every operation carries its own per-record lock, so each save reads the
    // current revisions rather than assuming what the last one left behind.
    const revisionOf = async (section, id) => {
      const state = await (await browserFetch(`${serverUrl}api/s/${startupId}/state`)).json();
      const sectionMap = (state.revisionMap && state.revisionMap.records) || {};
      const bySection = sectionMap[section] || {};
      return bySection[id] === undefined ? 0 : bySection[id];
    };

    const send = async (updatedAt, operations) => {
      const response = await saveOperations(serverUrl, startupId, operations, { origin: "ui", updatedAt });
      assert.equal(response.status, 200, await response.text());
    };

    await send("2026-08-19T08:01:00.000Z", [
      {
        type: "upsert",
        section: "items",
        id: "bin-a",
        baseRevision: await revisionOf("items", "bin-a"),
        value: { id: "bin-a", platform: "Edited" },
      },
    ]);
    // One save carries both halves of the move, which is what makes the pair
    // share a timestamp and collapse into a single timeline entry in the browser.
    await send("2026-08-19T08:02:00.000Z", [
      { type: "delete", section: "items", id: "bin-a", baseRevision: await revisionOf("items", "bin-a") },
      {
        type: "upsert",
        section: "deletedItems",
        id: "bin-a",
        baseRevision: await revisionOf("deletedItems", "bin-a"),
        value: { id: "bin-a", platform: "Edited" },
      },
    ]);
    await send("2026-08-19T08:03:00.000Z", [
      { type: "delete", section: "deletedItems", id: "bin-a", baseRevision: await revisionOf("deletedItems", "bin-a") },
      {
        type: "upsert",
        section: "items",
        id: "bin-a",
        baseRevision: await revisionOf("items", "bin-a"),
        value: { id: "bin-a", platform: "Back" },
      },
    ]);

    // Asking about either half returns the whole story, tagged by section.
    for (const section of ["items", "deletedItems"]) {
      const response = await browserFetch(`${serverUrl}api/s/${startupId}/state/history?section=${section}&id=bin-a`);
      assert.equal(response.status, 200);
      const history = await response.json();
      const sections = new Set(history.entries.map((entry) => entry.section));
      assert.deepEqual([...sections].sort(), ["deletedItems", "items"]);
      assert.equal(history.total, history.entries.length);
      // Newest first, so the modal shows the most recent change at the top.
      const stamps = history.entries.map((entry) => entry.changedAt);
      assert.deepEqual(stamps, [...stamps].sort().reverse());
      assert.ok(
        history.entries.some((entry) => entry.event === "deleted" && entry.section === "items"),
        "the move into the bin is in the timeline",
      );
      assert.ok(
        history.entries.some((entry) => entry.event === "deleted" && entry.section === "deletedItems"),
        "the move back out is in the timeline",
      );
    }
  } finally {
    await server.stop();
  }
});
