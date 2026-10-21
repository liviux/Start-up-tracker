"use strict";

// Backups of the whole tracker: the database and the media files.
//
//   backups/<stamp>-<kind>[-<label>]/tracker.sqlite        VACUUM INTO snapshot, verified
//   backups/<stamp>-<kind>[-<label>]/media-manifest.json   what the backup holds
//   backups/media-store/<sha256>                           each media file once, shared
//
// Kinds rotate separately: "automatic" keeps the newest N (default 20),
// "safety" keeps its own cap (default 20) so restores and imports never push
// out automatic backups, and "pinned" never rotates. A media-store file that
// no remaining manifest lists is removed when a backup goes.
//
// Everything here is synchronous on purpose. The server runs one request at a
// time through it, so a prune can never collect a media file that a backup in
// progress has copied but not yet listed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { verifyDatabaseFile } = require("../tracker-sqlite-store");

const KINDS = ["automatic", "safety", "pinned"];
const MANIFEST_FILE = "media-manifest.json";
const DATABASE_FILE = "tracker.sqlite";
const MEDIA_STORE = "media-store";
const MANIFEST_VERSION = 1;
const DEFAULT_KEEP = { automatic: 20, safety: 20 };
const FOLDER_PATTERN = /^(\d{8}-\d{6}-\d{3})-(automatic|safety|pinned)(?:-([A-Za-z0-9._-]+))?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_GRACE_MS = 10 * 60 * 1000;

class BackupError extends Error {
  constructor(message, code = "backupFailed", statusCode = 400) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function stampFor(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${iso.slice(20, 23)}`;
}

function cleanLabel(label) {
  return String(label || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

// Regular files under the media folder, as forward-slash paths relative to it.
// Symlinks are skipped: a backup holds the tracker's own files, never what a
// link points at.
function walkMedia(mediaDir) {
  const files = [];
  if (!fs.existsSync(mediaDir)) return files;
  const visit = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(full, relative);
      else if (entry.isFile()) files.push({ relative, full });
    }
  };
  visit(mediaDir, "");
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function isKeepCount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeFileAtomic(filePath, data) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filePath);
}

function createBackupManager({ store, backupDir, mediaDir, keep = {}, now = () => new Date(), mediaGraceMs = MEDIA_GRACE_MS }) {
  // A keep count that is missing or out of range falls back to the default.
  // Taken as given, an undefined count would make prune() slice from 0 and
  // delete every backup of that kind, the new one included.
  const limits = { ...DEFAULT_KEEP };
  for (const kind of Object.keys(DEFAULT_KEEP)) {
    const value = keep?.[kind];
    if ((typeof value === "number" || typeof value === "string") && isKeepCount(Number(value))) limits[kind] = Number(value);
  }
  const mediaStore = path.join(backupDir, MEDIA_STORE);

  function setKeep(kind, count) {
    if (!(kind in DEFAULT_KEEP)) throw new BackupError(`Only automatic and safety backups rotate (got ${kind}).`, "badKind");
    const value = Number(count);
    if (!isKeepCount(value)) throw new BackupError("Keep between 1 and 1000 backups.", "badKeep");
    limits[kind] = value;
  }

  function readManifest(folderPath) {
    try {
      const manifest = readJson(path.join(folderPath, MANIFEST_FILE));
      return manifest && manifest.version === MANIFEST_VERSION ? manifest : null;
    } catch {
      return null;
    }
  }

  // Every backup folder, newest first. A folder without a readable manifest is
  // listed as broken rather than hidden, so it can be seen and deleted.
  function list() {
    if (!fs.existsSync(backupDir)) return [];
    const backups = [];
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      const match = entry.isDirectory() ? entry.name.match(FOLDER_PATTERN) : null;
      if (!match) continue;
      const folderPath = path.join(backupDir, entry.name);
      const manifest = readManifest(folderPath);
      const databasePath = path.join(folderPath, DATABASE_FILE);
      const databaseBytes = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0;
      backups.push({
        id: entry.name,
        kind: match[2],
        label: manifest?.label ?? match[3] ?? "",
        createdAt: manifest?.createdAt || "",
        reason: manifest?.reason || "",
        databaseRevision: manifest?.database?.revision ?? null,
        stateHash: manifest?.database?.stateHash || "",
        startups: manifest?.startups || [],
        mediaFiles: manifest ? manifest.files.length : 0,
        mediaBytes: manifest ? manifest.files.reduce((sum, file) => sum + file.size, 0) : 0,
        databaseBytes,
        complete: Boolean(manifest) && databaseBytes > 0,
        sortKey: match[1],
      });
    }
    return backups.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.id.localeCompare(a.id));
  }

  function find(id) {
    const value = String(id || "");
    if (!FOLDER_PATTERN.test(value)) throw new BackupError("Unknown backup.", "unknownBackup", 404);
    const backup = list().find((entry) => entry.id === value);
    if (!backup) throw new BackupError("Unknown backup.", "unknownBackup", 404);
    return backup;
  }

  function folderOf(id) {
    return path.join(backupDir, find(id).id);
  }

  // Hashes from the newest manifest are reused for files whose size and
  // modification time have not changed, so a backup rarely reads media again.
  function knownHashes() {
    const known = new Map();
    for (const backup of list()) {
      if (!backup.complete) continue;
      const manifest = readManifest(path.join(backupDir, backup.id));
      for (const file of manifest.files) {
        if (!known.has(file.path)) known.set(file.path, file);
      }
      break;
    }
    return known;
  }

  function mediaInventory() {
    const known = knownHashes();
    return walkMedia(mediaDir).map(({ relative, full }) => {
      const stats = fs.statSync(full);
      const previous = known.get(relative);
      const sha256 = previous && previous.size === stats.size && previous.mtimeMs === stats.mtimeMs
        ? previous.sha256
        : sha256File(full);
      return { path: relative, sha256, size: stats.size, mtimeMs: stats.mtimeMs, full };
    });
  }

  function sameMedia(a, b) {
    if (a.length !== b.length) return false;
    return a.every((file, index) => file.path === b[index].path && file.sha256 === b[index].sha256);
  }

  function storeMediaFile(file) {
    const target = path.join(mediaStore, file.sha256);
    // A stored copy of the wrong size is damaged and is written again.
    if (fs.existsSync(target) && fs.statSync(target).size === file.size) return false;
    fs.mkdirSync(mediaStore, { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(file.full, temporary);
    // The file may have changed between hashing and copying; the store only
    // keeps content under its own hash.
    if (sha256File(temporary) !== file.sha256) {
      fs.unlinkSync(temporary);
      throw new BackupError(`${file.path} changed while it was being backed up. Try again.`, "mediaChanged", 409);
    }
    fs.renameSync(temporary, target);
    return true;
  }

  // kind: automatic | safety | pinned. An automatic or safety backup of data
  // that has not changed since the newest backup is not taken again; the
  // newest one is returned instead with skipped: true. A pinned backup is
  // always taken, because someone asked for it by name.
  // protect names backups that rotation must keep this time: a safety backup
  // taken before restoring backup X must not rotate X itself away.
  function create({ kind = "automatic", label = "", reason = "", protect = [] } = {}) {
    if (!KINDS.includes(kind)) throw new BackupError(`Unknown backup kind: ${kind}`, "badKind");
    const safeLabel = cleanLabel(label);
    fs.mkdirSync(backupDir, { recursive: true });

    const fingerprint = store.readDatabaseFingerprint();
    const media = mediaInventory();
    if (kind !== "pinned") {
      const newest = list().find((backup) => backup.complete);
      if (newest && newest.stateHash === fingerprint.stateHash) {
        const manifest = readManifest(path.join(backupDir, newest.id));
        if (manifest && sameMedia(manifest.files, media)) return { ...newest, skipped: true };
      }
    }

    const createdAt = new Date(now());
    let id = `${stampFor(createdAt)}-${kind}${safeLabel ? `-${safeLabel}` : ""}`;
    while (fs.existsSync(path.join(backupDir, id))) {
      createdAt.setMilliseconds(createdAt.getMilliseconds() + 1);
      id = `${stampFor(createdAt)}-${kind}${safeLabel ? `-${safeLabel}` : ""}`;
    }
    const temporaryFolder = path.join(backupDir, `.creating-${id}-${process.pid}`);
    fs.rmSync(temporaryFolder, { recursive: true, force: true });
    fs.mkdirSync(temporaryFolder);
    try {
      const snapshot = store.createSnapshot(path.join(temporaryFolder, DATABASE_FILE));
      let mediaCopied = 0;
      for (const file of media) {
        if (storeMediaFile(file)) mediaCopied += 1;
      }
      const startups = (store.readSection("_global", "startups") || []).map((startup) => ({ id: startup.id, name: startup.name }));
      const manifest = {
        version: MANIFEST_VERSION,
        id,
        kind,
        label: safeLabel,
        reason: String(reason || "").slice(0, 200),
        createdAt: createdAt.toISOString(),
        database: { file: DATABASE_FILE, revision: snapshot.revision, stateHash: snapshot.stateHash, bytes: snapshot.bytes },
        startups,
        files: media.map(({ path: filePath, sha256, size, mtimeMs }) => ({ path: filePath, sha256, size, mtimeMs })),
      };
      writeFileAtomic(path.join(temporaryFolder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.renameSync(temporaryFolder, path.join(backupDir, id));
      const removed = prune({ protect });
      return { ...find(id), skipped: false, mediaCopied, removed };
    } finally {
      fs.rmSync(temporaryFolder, { recursive: true, force: true });
    }
  }

  // Rotation per kind, then the media files nothing lists any more.
  function prune({ protect = [] } = {}) {
    const removed = [];
    const backups = list();
    const kept = new Set(protect);
    for (const kind of Object.keys(DEFAULT_KEEP)) {
      const ofKind = backups.filter((backup) => backup.kind === kind && backup.complete && !kept.has(backup.id));
      for (const backup of ofKind.slice(limits[kind])) {
        fs.rmSync(path.join(backupDir, backup.id), { recursive: true, force: true });
        removed.push(backup.id);
      }
    }
    collectMedia();
    return removed;
  }

  // A file is collected only when no manifest lists it and it is older than
  // MEDIA_GRACE_MS: another process (a tool next to the server) may be taking
  // a backup that has copied it but not yet written its manifest. Nothing is
  // collected while such a backup is visibly in progress.
  function collectMedia() {
    if (!fs.existsSync(mediaStore)) return 0;
    if (fs.readdirSync(backupDir).some((name) => name.startsWith(".creating-"))) return 0;
    const referenced = new Set();
    for (const backup of list()) {
      const manifest = readManifest(path.join(backupDir, backup.id));
      // A folder whose manifest cannot be read might still list files, so
      // nothing is collected while one exists.
      if (!manifest) return 0;
      for (const file of manifest.files) referenced.add(file.sha256);
    }
    let deleted = 0;
    const cutoff = Date.now() - mediaGraceMs;
    for (const name of fs.readdirSync(mediaStore)) {
      if (SHA256_PATTERN.test(name) && !referenced.has(name) && fs.statSync(path.join(mediaStore, name)).mtimeMs < cutoff) {
        fs.unlinkSync(path.join(mediaStore, name));
        deleted += 1;
      }
    }
    return deleted;
  }

  function remove(id) {
    const folder = folderOf(id);
    fs.rmSync(folder, { recursive: true, force: true });
    collectMedia();
    return { id: path.basename(folder) };
  }

  // Full check of one backup: the database verifies, and every media file it
  // lists is in the media store with the right hash.
  function verify(id) {
    const folder = folderOf(id);
    const manifest = readManifest(folder);
    const problems = [];
    if (!manifest) problems.push("The manifest is missing or unreadable.");
    const database = verifyDatabaseFile(path.join(folder, DATABASE_FILE), manifest ? { expectedStateHash: manifest.database.stateHash } : {});
    problems.push(...database.problems);
    for (const file of manifest?.files || []) {
      const stored = path.join(mediaStore, file.sha256);
      if (!fs.existsSync(stored)) problems.push(`Missing media file: ${file.path}`);
      else if (sha256File(stored) !== file.sha256) problems.push(`Damaged media file: ${file.path}`);
    }
    return { id: path.basename(folder), ok: problems.length === 0, problems, database };
  }

  function databasePath(id) {
    return path.join(folderOf(id), DATABASE_FILE);
  }

  function manifest(id) {
    const value = readManifest(folderOf(id));
    if (!value) throw new BackupError("This backup has no readable manifest.", "brokenBackup");
    return value;
  }

  // Puts media files back from a backup: all of them, or one startup's
  // (files under <startupId>/). A file that already holds the right content is
  // left alone; files the backup does not list are never deleted.
  function restoreMedia(id, { startupId = null } = {}) {
    const files = manifest(id).files.filter((file) => !startupId || file.path.startsWith(`${startupId}/`));
    let restored = 0;
    for (const file of files) {
      const segments = file.path.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === "..")) continue;
      const target = path.join(mediaDir, ...segments);
      if (fs.existsSync(target) && fs.lstatSync(target).isFile() && sha256File(target) === file.sha256) continue;
      const source = path.join(mediaStore, file.sha256);
      if (!fs.existsSync(source)) throw new BackupError(`The backup is missing ${file.path}.`, "missingMedia", 409);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Dot-named, so a file left by a crash is never backed up as media.
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.restoring-${process.pid}`);
      fs.copyFileSync(source, temporary);
      fs.renameSync(temporary, target);
      restored += 1;
    }
    return { restored, listed: files.length };
  }

  function newest(kind) {
    return list().find((backup) => backup.complete && (!kind || backup.kind === kind)) || null;
  }

  return {
    KINDS,
    limits,
    setKeep,
    list,
    find,
    create,
    prune,
    remove,
    verify,
    databasePath,
    manifest,
    restoreMedia,
    newest,
    collectMedia,
  };
}

module.exports = { createBackupManager, BackupError, KINDS, DEFAULT_KEEP, FOLDER_PATTERN, MANIFEST_FILE, DATABASE_FILE, MEDIA_STORE };
