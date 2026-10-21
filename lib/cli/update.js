"use strict";

// startup-tracker update: find the latest GitHub release, download its archive
// and SHA256SUMS, check the archive against them, take a safety backup of the
// database, swap app.new in as app (the old version stays as app.prev),
// restart and show the changelog.
//
// Nothing is swapped unless the checksum matches and the unpacked folder looks
// like the app. If the new version does not start, the old one comes back.
// The network calls go through an injectable fetch so tests run offline.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { extractTarGz } = require("./tar");

const RELEASE_ARCHIVE = "startup-tracker.tar.gz";
const CHECKSUM_FILE = "SHA256SUMS";
const REQUIRED_FILES = ["package.json", "server.js", path.join("bin", "startup-tracker.js")];
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_FILE = "update-check.json";

class UpdateError extends Error {
  constructor(message, code = "update") {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

// package.json "repository": "owner/repo", "github:owner/repo", a GitHub URL
// in any of its forms, or { url }. Anything else is not something to update from.
function parseRepository(repository) {
  const raw = typeof repository === "string" ? repository : repository && typeof repository.url === "string" ? repository.url : "";
  const value = raw.trim();
  if (!value) return null;
  const patterns = [
    /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^(?:git\+)?https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    /^(?:git\+ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

// "1.2.3" against "1.2.3-dev": a pre-release sorts before its release.
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ""] = String(value).replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number(part) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

// SHA256SUMS lines: "<64 hex>  <name>" (or " *<name>" in binary mode).
function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return sums;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyChecksum(file, checksumsText, name = path.basename(file)) {
  const expected = parseChecksums(checksumsText).get(name);
  if (!expected) throw new UpdateError(`${CHECKSUM_FILE} has no line for ${name}, so the download cannot be checked. Nothing was changed.`, "checksumMissing");
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new UpdateError(`${name} does not match its checksum (expected ${expected}, got ${actual}). The download may be damaged or altered. Nothing was changed.`, "checksumMismatch");
  }
  return actual;
}

function githubHeaders() {
  return { Accept: "application/vnd.github+json", "User-Agent": "startup-tracker-cli" };
}

async function fetchLatestRelease({ owner, repo }, { fetchImpl = globalThis.fetch } = {}) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const response = await fetchImpl(url, { headers: githubHeaders(), signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new UpdateError(`No release is published at github.com/${owner}/${repo} yet.`, "noRelease");
  // GitHub allows 60 unauthenticated API calls an hour per address; a shared
  // network can use them up.
  if ((response.status === 403 || response.status === 429) && response.headers?.get?.("x-ratelimit-remaining") === "0") {
    throw new UpdateError("GitHub's limit on update checks from your network is used up for now. Try again in an hour.", "rateLimited");
  }
  if (!response.ok) throw new UpdateError(`GitHub answered ${response.status} for ${url}.`, "github");
  const body = await response.json();
  const assets = {};
  for (const asset of body.assets || []) assets[asset.name] = asset.browser_download_url;
  return { tag: body.tag_name, version: String(body.tag_name || "").replace(/^v/, ""), notes: body.body || "", assets };
}

async function download(url, file, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "startup-tracker-cli" }, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new UpdateError(`Downloading ${url} answered ${response.status}.`, "download");
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function missingAppFiles(dir) {
  return REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(dir, file)));
}

// Unpacks a release archive and moves its one top folder to `appNew`.
function unpackRelease(archiveFile, appNew, { workDir = path.dirname(appNew) } = {}) {
  const staging = path.join(workDir, `.unpack-${process.pid}-${Date.now()}`);
  try {
    extractTarGz(fs.readFileSync(archiveFile), staging);
    const top = fs.readdirSync(staging, { withFileTypes: true });
    if (top.length !== 1 || !top[0].isDirectory()) throw new UpdateError("The archive must hold exactly one top folder with the app in it.", "badArchive");
    const unpacked = path.join(staging, top[0].name);
    const missing = missingAppFiles(unpacked);
    if (missing.length) throw new UpdateError(`The archive is not a Startup Tracker release: ${missing.join(", ")} missing.`, "badArchive");
    fs.rmSync(appNew, { recursive: true, force: true });
    fs.renameSync(unpacked, appNew);
    return JSON.parse(fs.readFileSync(path.join(appNew, "package.json"), "utf8"));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// app.new becomes app, and app becomes app.prev (replacing an older app.prev).
// If the second rename fails, the first is undone.
function swapApp({ appDir, appNew, appPrev }) {
  if (!fs.existsSync(appNew)) throw new UpdateError(`${appNew} does not exist; nothing to swap in.`, "noAppNew");
  const missing = missingAppFiles(appNew);
  if (missing.length) throw new UpdateError(`${appNew} is incomplete (${missing.join(", ")} missing); it was not swapped in.`, "badArchive");
  if (!fs.existsSync(appDir) && fs.existsSync(appPrev)) {
    throw new UpdateError(`${appDir} is missing but ${appPrev} is there. Run "startup-tracker update --rollback" or reinstall first.`, "brokenLayout");
  }
  fs.rmSync(appPrev, { recursive: true, force: true });
  const hadApp = fs.existsSync(appDir);
  if (hadApp) fs.renameSync(appDir, appPrev);
  try {
    fs.renameSync(appNew, appDir);
  } catch (error) {
    if (hadApp) fs.renameSync(appPrev, appDir);
    throw error;
  }
  return { appDir, appPrev: hadApp ? appPrev : null };
}

// app and app.prev trade places, so a second rollback goes forward again.
function rollbackApp({ appDir, appPrev }) {
  if (!fs.existsSync(appPrev)) throw new UpdateError(`There is no ${appPrev} to go back to.`, "noAppPrev");
  const parked = `${appDir}.rollback-${process.pid}`;
  const hadApp = fs.existsSync(appDir);
  if (hadApp) fs.renameSync(appDir, parked);
  try {
    fs.renameSync(appPrev, appDir);
  } catch (error) {
    if (hadApp) fs.renameSync(parked, appDir);
    throw error;
  }
  if (hadApp) fs.renameSync(parked, appPrev);
  return { appDir, appPrev: hadApp ? appPrev : null };
}

// A safety backup (reason "update") before anything changes. The update does
// not touch data, but the new version may upgrade the database when it opens
// it, and that upgrade takes its own backup too.
function takeSafetyBackup(paths) {
  if (!fs.existsSync(paths.databaseFile)) return { skipped: true, reason: "no database yet" };
  const { verifyDatabaseFile, TrackerSqliteStore } = require("../tracker-sqlite-store");
  const { createBackup, isSoundLegacy, openBackupManager } = require("../../tools/backup-sqlite");
  const source = verifyDatabaseFile(paths.databaseFile);
  if (isSoundLegacy(source)) {
    return createBackup({ databasePath: paths.databaseFile, outputDir: paths.backupDir, mediaDir: paths.mediaDir, label: "before-update" });
  }
  if (!source.ok) throw new UpdateError(`The database did not verify, so the update stopped before changing anything: ${source.problems.join("; ")}`, "database");
  const store = new TrackerSqliteStore(paths.databaseFile);
  try {
    const manager = openBackupManager(store, { backupDir: paths.backupDir, mediaDir: paths.mediaDir });
    return manager.create({ kind: "safety", label: "before-update", reason: "update" });
  } finally {
    store.close();
  }
}

// The "## [x.y.z]" section of a Keep a Changelog file.
function changelogSection(text, version) {
  const lines = String(text || "").split(/\r?\n/);
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`).test(line));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trim();
}

// Runs "node bin/startup-tracker.js version" in a folder, to prove the new
// code loads before the old one is given up.
function defaultVersionCheck(appDir) {
  const result = spawnSync(process.execPath, [path.join(appDir, "bin", "startup-tracker.js"), "version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

// options: layout, paths, pkg, out (a line printer), check (only report),
// fetchImpl, getStatus, stopServer, startServer(appDir), versionCheck.
async function runUpdate(options) {
  const { layout, pkg, out, fetchImpl, check = false } = options;
  const repository = parseRepository(pkg.repository);
  if (!repository) {
    out("Updates arrive once the project is published: this copy names no repository to update from.");
    return 0;
  }
  if (!check && !layout.installed) {
    out(`This copy runs from ${layout.appRoot}, which the installer did not create. Update it with "git pull" and "npm ci", or install with install.sh.`);
    return 0;
  }
  const release = await fetchLatestRelease(repository, { fetchImpl });
  if (compareVersions(release.version, pkg.version) <= 0) {
    out(`Startup Tracker ${pkg.version} is the latest version.`);
    return 0;
  }
  if (check) {
    out(`Startup Tracker ${release.version} is available (you have ${pkg.version}). Run "startup-tracker update" to install it.`);
    return 0;
  }
  if (!release.assets[RELEASE_ARCHIVE] || !release.assets[CHECKSUM_FILE]) {
    throw new UpdateError(`Release ${release.tag} has no ${RELEASE_ARCHIVE} or ${CHECKSUM_FILE}.`, "badRelease");
  }

  const workDir = path.join(layout.installRoot, `.update-${process.pid}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  try {
    out(`Downloading Startup Tracker ${release.version}...`);
    const archive = await download(release.assets[RELEASE_ARCHIVE], path.join(workDir, RELEASE_ARCHIVE), { fetchImpl });
    const sums = await download(release.assets[CHECKSUM_FILE], path.join(workDir, CHECKSUM_FILE), { fetchImpl });
    return await installArchive({ ...options, archive, checksumsText: fs.readFileSync(sums, "utf8"), release });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Everything after the download, shared with tests that use a local archive.
async function installArchive(options) {
  const { layout, paths, out, archive, checksumsText, release = {} } = options;
  const getStatus = options.getStatus || (async () => ({ state: "stopped" }));
  const stopServer = options.stopServer || (async () => true);
  const startServer = options.startServer || (async () => true);
  const versionCheck = options.versionCheck || defaultVersionCheck;

  verifyChecksum(archive, checksumsText, RELEASE_ARCHIVE);
  out("Checksum verified.");
  const newPkg = unpackRelease(archive, layout.appNew, { workDir: layout.installRoot });

  const backup = takeSafetyBackup(paths);
  out(backup.skipped ? "Safety backup: the newest backup already holds this data." : `Safety backup: ${backup.id}.`);

  const wasRunning = (await getStatus()).state === "running";
  if (wasRunning) {
    out("Stopping the tracker...");
    if (!(await stopServer())) throw new UpdateError("The running tracker did not stop, so the update was not swapped in. Stop it and run the update again.", "stop");
  }

  swapApp(layout);
  const loads = versionCheck(layout.appDir);
  const started = !wasRunning || (loads.ok && (await startServer(layout.appDir).catch(() => false)));
  if (!loads.ok || !started) {
    rollbackApp(layout);
    if (wasRunning) await startServer(layout.appDir).catch(() => false);
    throw new UpdateError(`Version ${newPkg.version} did not ${loads.ok ? "start" : "load"}, so the previous version is back.${loads.output ? `\n${loads.output}` : ""}`, "newVersionFailed");
  }

  out(`Startup Tracker ${newPkg.version} is installed. The previous version is kept in ${layout.appPrev} ("startup-tracker update --rollback" goes back to it).`);
  if (wasRunning) out("The tracker was restarted.");
  let notes = "";
  try {
    notes = changelogSection(fs.readFileSync(path.join(layout.appDir, "CHANGELOG.md"), "utf8"), newPkg.version);
  } catch {
    // No changelog in the archive.
  }
  notes = notes || String(release.notes || "").trim();
  if (notes) out(`\n${notes}`);
  return 0;
}

// The network switch in Settings > General. When the database cannot be read,
// the answer is "off", so a damaged install never calls out on its own.
function readNetworkSetting(paths) {
  if (!fs.existsSync(paths.databaseFile)) return true;
  try {
    const { TrackerSqliteStore } = require("../tracker-sqlite-store");
    const { readSettings } = require("../settings");
    const store = new TrackerSqliteStore(paths.databaseFile, { readOnly: true });
    try {
      return readSettings(store).network !== false;
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

function readUpdateCache(paths) {
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(paths.cacheDir, UPDATE_CHECK_FILE), "utf8"));
    return cached && typeof cached.checkedAt === "string" ? cached : null;
  } catch {
    return null;
  }
}

// Whether a newer release exists, as { configured, current, latest,
// available, checkedAt, error }. The answer is cached in cache/
// update-check.json for a day; `force` asks GitHub again ("Check for updates
// now"). Without `force`, nothing goes online when the network switch is off
// or `offline` is set, and the cached answer (if any) is returned.
async function checkForUpdate({ paths, pkg, fetchImpl, force = false, offline = false, now = Date.now(), networkAllowed = readNetworkSetting }) {
  const repository = parseRepository(pkg.repository);
  const base = { configured: Boolean(repository), current: pkg.version, latest: "", available: false, checkedAt: "", error: "" };
  if (!repository) return base;
  const cached = readUpdateCache(paths);
  const fromCache = cached ? { ...base, latest: cached.latest || "", checkedAt: cached.checkedAt, available: Boolean(cached.latest) && compareVersions(cached.latest, pkg.version) > 0 } : base;
  const fresh = cached && now - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS;
  if (!force && (fresh || offline || !networkAllowed(paths))) return fromCache;
  try {
    const release = await fetchLatestRelease(repository, { fetchImpl });
    const checkedAt = new Date(now).toISOString();
    fs.mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.cacheDir, UPDATE_CHECK_FILE), `${JSON.stringify({ checkedAt, latest: release.version })}\n`);
    return { ...base, latest: release.version, checkedAt, available: compareVersions(release.version, pkg.version) > 0 };
  } catch (error) {
    return { ...fromCache, error: error.message };
  }
}

// The check the plain "startup-tracker" command runs at most once a day. It
// respects the network switch, never installs anything and never fails the
// command; it returns a line to print, or "".
async function automaticUpdateCheck({ paths, pkg, fetchImpl, now = Date.now(), networkAllowed = readNetworkSetting }) {
  const cached = readUpdateCache(paths);
  if (cached && now - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS) return "";
  const result = await checkForUpdate({ paths, pkg, fetchImpl, now, networkAllowed });
  return result.available && !result.error ? `Startup Tracker ${result.latest} is available. Run "startup-tracker update" to install it.` : "";
}

module.exports = {
  RELEASE_ARCHIVE,
  CHECKSUM_FILE,
  UpdateError,
  parseRepository,
  compareVersions,
  parseChecksums,
  sha256File,
  verifyChecksum,
  fetchLatestRelease,
  unpackRelease,
  swapApp,
  rollbackApp,
  takeSafetyBackup,
  changelogSection,
  runUpdate,
  installArchive,
  readNetworkSetting,
  checkForUpdate,
  automaticUpdateCheck,
};
