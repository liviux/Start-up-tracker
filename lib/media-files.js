"use strict";

// Uploaded media files, one folder per startup under the media folder
// (media/<startupId>/<storedName>).
//
// A media record in the recycle bin keeps its file. The file goes only when
// the record is deleted for good and nothing else in that startup still names
// it. Files no record names are "orphans": listOrphans finds them and never
// deletes anything.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { resolveMediaFileSync, assertWritableMediaPath } = require("./http/media");

const MEDIA_SECTIONS = ["mediaItems", "deletedMediaItems"];

class MediaError extends Error {
  constructor(message, code = "badMedia", statusCode = 400) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// The stored file name of an uploaded media record, or "".
function storedNameOf(record) {
  if (!record || record.sourceType !== "upload") return "";
  const direct = String(record.storedName || "").trim();
  if (direct) return path.basename(direct);
  const fromPath = String(record.filePath || record.path || "").split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
  try {
    return path.basename(decodeURIComponent(fromPath));
  } catch {
    return path.basename(fromPath);
  }
}

// Whether anything in the startup still names the file: a media record, a
// company document or any other text holding its name or its web path.
function isReferenced(store, startupId, storedName) {
  if (!storedName) return false;
  const text = JSON.stringify(store.readState(startupId).state || {});
  return text.includes(storedName) || text.includes(encodeURIComponent(storedName));
}

// Deletes the named files of one startup that nothing names any more.
function removeUnusedFiles(store, mediaDir, startupId, names) {
  const folder = path.join(mediaDir, startupId);
  const removed = [];
  const kept = [];
  for (const raw of new Set((Array.isArray(names) ? names : []).map((name) => path.basename(String(name || ""))).filter(Boolean))) {
    const filePath = resolveMediaFileSync(folder, raw);
    if (!filePath) continue;
    if (isReferenced(store, startupId, raw)) {
      kept.push(raw);
      continue;
    }
    fs.unlinkSync(filePath);
    removed.push(raw);
  }
  return { removed, kept };
}

function uniqueName(folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext) || "media";
  let candidate = name;
  while (fs.existsSync(path.join(folder, candidate))) candidate = `${stem}-${crypto.randomBytes(3).toString("hex")}${ext}`;
  return candidate;
}

// Copies a media record, and its file when it is an upload, to another
// startup. Links ("Used in") stay behind: they point at the first startup's
// records. Returns the new record.
function copyMediaItem({ store, mediaDir, fromStartupId, toStartupId, mediaId, origin = "ui", actor }) {
  if (!toStartupId || toStartupId === fromStartupId || toStartupId === GLOBAL_STARTUP_ID) throw new MediaError("Pick another startup to copy to.", "badTarget");
  const record = (store.readSection(fromStartupId, "mediaItems") || []).find((entry) => String(entry?.id) === String(mediaId));
  if (!record) throw new MediaError("That media item was not found.", "notFound", 404);
  const now = new Date().toISOString();
  const copy = { ...record, id: crypto.randomUUID(), pinned: false, createdAt: now, updatedAt: now, copiedFrom: { startupId: fromStartupId, id: String(record.id) } };
  const storedName = storedNameOf(record);
  if (storedName) {
    const source = resolveMediaFileSync(path.join(mediaDir, fromStartupId), storedName);
    if (!source) throw new MediaError("The file of this media item is missing from the media folder.", "fileMissing", 404);
    const folder = path.join(mediaDir, toStartupId);
    fs.mkdirSync(folder, { recursive: true });
    const name = uniqueName(folder, storedName);
    const destination = path.join(folder, name);
    assertWritableMediaPath(folder, destination);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    copy.storedName = name;
    copy.filePath = `/media/${encodeURIComponent(toStartupId)}/${encodeURIComponent(name)}`;
    copy.absolutePath = destination;
  }
  store.applyOperations(toStartupId, [{ type: "upsert", section: "mediaItems", id: copy.id, value: copy, position: 0, baseRevision: 0 }], { origin, actor, label: "Media copied from another startup" });
  return copy;
}

// Files in each startup's media folder that no record of that startup names,
// and folders of startups that no longer exist. Read-only.
function listOrphans(store, mediaDir) {
  const result = { files: [], folders: [] };
  if (!fs.existsSync(mediaDir)) return result;
  const known = new Set(store.listStartupIds());
  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(mediaDir, entry.name);
    if (!known.has(entry.name)) {
      result.folders.push({ startupId: entry.name, path: folder });
      continue;
    }
    const text = JSON.stringify(store.readState(entry.name).state || {});
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (text.includes(file.name) || text.includes(encodeURIComponent(file.name))) continue;
      const full = path.join(folder, file.name);
      result.files.push({ startupId: entry.name, name: file.name, path: full, size: fs.statSync(full).size });
    }
  }
  return result;
}

module.exports = { MEDIA_SECTIONS, MediaError, storedNameOf, isReferenced, removeUnusedFiles, copyMediaItem, listOrphans };
