"use strict";

// Export and import of startups, as a zip (JSON per section plus media files)
// or as one JSON file without media.
//
//   manifest.json
//   startups/<id>/startup.json            the entry in the startup list
//   startups/<id>/sections/<name>.json    one file per section
//   startups/<id>/media/<file>            uploads (zip only)
//   global/sections/<name>.json           shared settings the startups use
//
// The global settings travel along so an import can tell which statuses,
// categories or tags it does not know. An import never overwrites them.

const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID, STARTUPS_SECTION, normalizeStartupId } = require("../tracker-sqlite-store");
const startups = require("../startups");
const { createZip, readZip, ZipError, DEFAULT_LIMITS } = require("./zip");

const FORMAT = "startup-tracker-export";
const FORMAT_VERSION = 1;
const SECTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

class TransferError extends Error {
  constructor(message, code = "badImport", statusCode = 400) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function countSections(state) {
  const counts = {};
  for (const [section, value] of Object.entries(state || {})) counts[section] = Array.isArray(value) ? value.length : null;
  return counts;
}

function mediaFilesOf(mediaDir, startupId) {
  const root = path.join(mediaDir, startupId);
  const files = [];
  if (!fs.existsSync(root)) return files;
  const visit = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(folder, entry.name), relative);
      else if (entry.isFile()) files.push({ relative, full: path.join(folder, entry.name) });
    }
  };
  visit(root, "");
  return files;
}

// options.omit(startupId, section, state) may return a copy of a section with
// sensitive fields left out, or undefined to leave the section out; by
// default everything is exported. Agent tokens never leave the database.
function exportData(store, { startupIds, mediaDir, format = "zip", appVersion = "", omit = null, now = new Date() } = {}) {
  if (!Array.isArray(startupIds) || startupIds.length === 0) throw new TransferError("Choose at least one startup to export.", "noStartups");
  if (format !== "zip" && format !== "json") throw new TransferError("The export format is zip or json.", "badFormat");
  const exported = [];
  for (const startupId of startupIds) {
    const startup = startups.getStartup(store, startupId);
    if (!startup) throw new TransferError(`Unknown startup: ${startupId}`, "unknownStartup", 404);
    const { state } = store.readState(startup.id);
    for (const section of Object.keys(state)) {
      if (!omit) continue;
      const kept = omit(startup.id, section, state[section]);
      if (kept === undefined) delete state[section];
      else state[section] = kept;
    }
    const media = format === "zip" && mediaDir ? mediaFilesOf(mediaDir, startup.id) : [];
    exported.push({ startup, state, media });
  }
  const globalState = store.readState(GLOBAL_STARTUP_ID).state;
  delete globalState[STARTUPS_SECTION];
  delete globalState.agentTokens;

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: now.toISOString(),
    app: { name: "Startup Tracker", version: appVersion },
    includesMedia: format === "zip",
    startups: exported.map(({ startup, state, media }) => ({
      id: startup.id,
      name: startup.name,
      sections: countSections(state),
      mediaFiles: media.length,
    })),
    globalSections: Object.keys(globalState),
  };

  if (format === "json") {
    const body = {
      manifest,
      startups: exported.map(({ startup, state }) => ({ startup, state })),
      global: globalState,
    };
    return { contentType: "application/json", extension: "json", data: Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8"), manifest };
  }

  const entries = [{ name: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n` }];
  for (const { startup, state, media } of exported) {
    const base = `startups/${startup.id}`;
    entries.push({ name: `${base}/startup.json`, data: `${JSON.stringify(startup, null, 2)}\n` });
    for (const [section, value] of Object.entries(state)) {
      entries.push({ name: `${base}/sections/${section}.json`, data: JSON.stringify(value) });
    }
    for (const file of media) entries.push({ name: `${base}/media/${file.relative}`, data: fs.readFileSync(file.full) });
  }
  for (const [section, value] of Object.entries(globalState)) {
    entries.push({ name: `global/sections/${section}.json`, data: JSON.stringify(value) });
  }
  return { contentType: "application/zip", extension: "zip", data: createZip(entries, { now }), manifest };
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new TransferError(`${label} is not valid JSON: ${error.message}`, "badJson");
  }
}

function checkManifest(manifest) {
  if (!manifest || manifest.format !== FORMAT) throw new TransferError("This file is not a Startup Tracker export.", "notExport");
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new TransferError(`This export uses format version ${manifest.formatVersion}; this version reads ${FORMAT_VERSION}.`, "formatVersion");
  }
}

function checkState(state, label) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TransferError(`${label} has no state.`, "badState");
  for (const [section, value] of Object.entries(state)) {
    if (!SECTION_NAME.test(section)) throw new TransferError(`${label} has a section with an unusable name: ${section}`, "badSection");
    if (Array.isArray(value)) {
      const ids = new Set();
      for (const record of value) {
        if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || !record.id) {
          throw new TransferError(`${label}: every record in ${section} needs an id.`, "badRecord");
        }
        if (ids.has(record.id)) throw new TransferError(`${label}: ${section} lists ${record.id} twice.`, "duplicateRecord");
        ids.add(record.id);
      }
    }
  }
}

// Reads an export without changing anything and returns what an import would
// bring in, with record counts per section for the preview.
function readImport(buffer, limits = DEFAULT_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TransferError("The file is empty.", "empty");
  let manifest;
  let parsed;
  if (buffer.subarray(0, 4).toString("binary") === "PK\x03\x04") {
    let files;
    try {
      files = readZip(buffer, limits);
    } catch (error) {
      if (error instanceof ZipError) throw new TransferError(error.message, error.code);
      throw error;
    }
    const byName = new Map(files.map((file) => [file.name, file.data]));
    if (!byName.has("manifest.json")) throw new TransferError("The archive has no manifest.json.", "notExport");
    manifest = parseJson(byName.get("manifest.json"), "manifest.json");
    checkManifest(manifest);
    parsed = { startups: [], global: {} };
    for (const entry of manifest.startups || []) {
      const id = normalizeImportedId(entry.id);
      const base = `startups/${id}/`;
      const startupFile = byName.get(`${base}startup.json`);
      if (!startupFile) throw new TransferError(`The archive is missing ${base}startup.json.`, "incomplete");
      const state = {};
      const media = [];
      for (const [name, data] of byName) {
        if (!name.startsWith(base)) continue;
        const rest = name.slice(base.length);
        const section = rest.match(/^sections\/([^/]+)\.json$/);
        if (section) state[section[1]] = parseJson(data, name);
        else if (rest.startsWith("media/")) media.push({ path: rest.slice("media/".length), data });
      }
      parsed.startups.push({ startup: parseJson(startupFile, `${base}startup.json`), state, media });
    }
    for (const [name, data] of byName) {
      const section = name.match(/^global\/sections\/([^/]+)\.json$/);
      if (section) parsed.global[section[1]] = parseJson(data, name);
    }
  } else {
    const body = parseJson(buffer, "The file");
    manifest = body.manifest;
    checkManifest(manifest);
    parsed = {
      startups: (body.startups || []).map((entry) => ({ startup: entry.startup, state: entry.state, media: [] })),
      global: body.global && typeof body.global === "object" ? body.global : {},
    };
  }

  if (!parsed.startups.length) throw new TransferError("The export holds no startups.", "noStartups");
  for (const entry of parsed.startups) {
    if (!entry.startup || typeof entry.startup.name !== "string") throw new TransferError("A startup in the export has no name.", "badStartup");
    entry.startup.id = normalizeImportedId(entry.startup.id);
    checkState(entry.state, entry.startup.name);
  }
  return {
    manifest,
    startups: parsed.startups,
    global: parsed.global,
    preview: parsed.startups.map((entry) => ({
      id: entry.startup.id,
      name: entry.startup.name,
      sections: countSections(entry.state),
      mediaFiles: entry.media.length,
    })),
  };
}

function normalizeImportedId(value) {
  try {
    return normalizeStartupId(value);
  } catch {
    throw new TransferError(`The export names an unusable startup id: ${JSON.stringify(value)}`, "badStartupId");
  }
}

// Links to uploads name the startup they belong to, so they follow it.
function moveMediaLinks(state, fromId, toId) {
  if (fromId === toId) return state;
  const text = JSON.stringify(state);
  return JSON.parse(text.split(`/media/${fromId}/`).join(`/media/${toId}/`));
}

function writeMedia(mediaDir, startupId, media) {
  const root = path.join(mediaDir, startupId);
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const file of media) {
    const segments = file.path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) continue;
    const target = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new TransferError(`Refusing to write through a symbolic link: ${file.path}`, "symlink", 403);
    }
    const temporary = `${target}.importing-${process.pid}`;
    fs.writeFileSync(temporary, file.data);
    fs.renameSync(temporary, target);
    written += 1;
  }
  return written;
}

// mode "new": every startup in the export becomes a new startup.
// mode "replace": the export's only startup replaces targetStartupId.
// The caller takes the safety backup first.
function applyImport(store, imported, { mode, targetStartupId = "", mediaDir, origin = "import" }) {
  const options = { origin, label: `Imported from an export of ${imported.manifest.exportedAt || "an unknown date"}` };
  if (mode === "replace") {
    if (imported.startups.length !== 1) throw new TransferError("Replacing a startup needs an export of exactly one startup.", "needsOneStartup");
    const target = startups.getStartup(store, targetStartupId);
    if (!target) throw new TransferError("Unknown startup.", "unknownStartup", 404);
    const [entry] = imported.startups;
    const state = moveMediaLinks(entry.state, entry.startup.id, target.id);
    const result = store.replaceState(target.id, state, options);
    const mediaWritten = mediaDir ? writeMedia(mediaDir, target.id, entry.media) : 0;
    return { mode, startups: [{ id: target.id, name: target.name, revision: result.revision, mediaWritten }] };
  }
  if (mode !== "new") throw new TransferError("Choose to add the import as a new startup or to replace the current one.", "badMode");
  const created = [];
  for (const entry of imported.startups) {
    const startup = startups.createStartup(store, { name: entry.startup.name, icon: entry.startup.icon || "" }, { origin });
    const state = moveMediaLinks(entry.state, entry.startup.id, startup.id);
    const result = Object.keys(state).length ? store.replaceState(startup.id, state, options) : { revision: 0 };
    const mediaWritten = mediaDir ? writeMedia(mediaDir, startup.id, entry.media) : 0;
    created.push({ id: startup.id, name: startup.name, revision: result.revision, mediaWritten });
  }
  return { mode, startups: created };
}

module.exports = { FORMAT, FORMAT_VERSION, TransferError, exportData, readImport, applyImport, moveMediaLinks };
