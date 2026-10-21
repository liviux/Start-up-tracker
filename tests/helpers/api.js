"use strict";

// Small helpers for tests that talk to a running server.js over HTTP.

const startups = require("../../lib/startups");
const { TrackerSqliteStore } = require("../../lib/tracker-sqlite-store");

// The tests stand in for the tracker page: a browser marks the page's own
// requests as same-origin, which the server requires for every write. Tests of
// that check itself use plain fetch.
function browserFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { "Sec-Fetch-Site": "same-origin", ...(init.headers || {}) } });
}

function sendJson(url, method, body, headers = {}) {
  return browserFetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createStartup(serverUrl, name, extra = {}) {
  const response = await sendJson(`${serverUrl}api/startups`, "POST", { name, ...extra });
  if (response.status !== 201) throw new Error(`Creating ${name} answered ${response.status}: ${await response.text()}`);
  return (await response.json()).startup;
}

// Writes through the per-startup operations route with the current protocol.
function saveOperations(serverUrl, startupId, operations, extra = {}) {
  return sendJson(`${serverUrl}api/s/${startupId}/state/operations`, "PATCH", { protocolVersion: 2, operations, ...extra });
}

function multipartFile(fileName, content, contentType = "application/octet-stream") {
  const boundary = "----StartupTrackerTestBoundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadFile(serverUrl, startupId, fileName, content, contentType) {
  const file = multipartFile(fileName, content, contentType);
  return browserFetch(`${serverUrl}api/s/${startupId}/media/upload`, {
    method: "POST",
    headers: { "Content-Type": file.contentType },
    body: file.body,
  });
}

// Seeds a database before the server starts: one startup in the list, holding
// `state`. Returns its id. Writes go through the store's own methods.
function seedStartup(databasePath, name, state) {
  const store = new TrackerSqliteStore(databasePath);
  try {
    const startup = startups.createStartup(store, { name });
    if (state) store.replaceState(startup.id, state);
    return startup.id;
  } finally {
    store.close();
  }
}

module.exports = { browserFetch, sendJson, createStartup, saveOperations, multipartFile, uploadFile, seedStartup };
