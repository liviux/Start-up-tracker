"use strict";

// run/server.json: which server is running for this data folder. The server
// writes it once it listens and removes it on a clean shutdown; the CLI reads
// it. A file left behind by a crash is recognised because its process is gone.

const fs = require("fs");
const path = require("path");

const RUN_FILE_NAME = "server.json";
const HEALTH_TIMEOUT_MS = 2_000;

function runFile(runDir) {
  return path.join(runDir, RUN_FILE_NAME);
}

// state: { pid, port, url, startedAt, version }
function writeRunState(runDir, state) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = runFile(runDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function readRunState(runDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(runFile(runDir), "utf8"));
    if (!parsed || !Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Removes the file only when it still describes `pid`, so a server that exits
// late never deletes the file a newer server wrote.
function removeRunState(runDir, pid) {
  const current = readRunState(runDir);
  if (pid !== undefined && current && current.pid !== pid) return false;
  try {
    fs.unlinkSync(runFile(runDir));
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

// GET /api/health, or null when nothing answers like a Startup Tracker.
async function fetchHealth(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(new URL("api/health", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.ok === true && typeof body.version === "string" ? body : null;
  } catch {
    return null;
  }
}

function sameFile(a, b) {
  return Boolean(a && b) && path.resolve(a) === path.resolve(b);
}

// One of:
//   running       run/server.json names a live process and the server answers for this data folder
//   unresponsive  the process is alive but its health check fails or names another data folder
//   stale         run/server.json names a process that is gone
//   stopped       no run/server.json
async function getServerStatus(paths, { fetchImpl, isAlive = isProcessAlive } = {}) {
  const run = readRunState(paths.runDir);
  if (!run) return { state: "stopped", run: null, health: null };
  if (!isAlive(run.pid)) return { state: "stale", run, health: null };
  const url = run.url || `http://127.0.0.1:${run.port}/`;
  const health = await fetchHealth(url, { fetchImpl });
  if (health && sameFile(health.filePath, paths.databaseFile)) return { state: "running", run: { ...run, url }, health };
  return { state: "unresponsive", run: { ...run, url }, health };
}

module.exports = {
  RUN_FILE_NAME,
  runFile,
  writeRunState,
  readRunState,
  removeRunState,
  isProcessAlive,
  fetchHealth,
  getServerStatus,
  sameFile,
};
