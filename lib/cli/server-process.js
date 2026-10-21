"use strict";

// Starting and stopping server.js for the CLI. The server always runs on the
// node that runs the CLI (process.execPath), never through a .cmd shim, which
// Node on Windows refuses to spawn without a shell.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { readRunState, isProcessAlive, fetchHealth } = require("./run-state");

const LOG_FILE_NAME = "server.log";
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
// Node 22 calls its built-in SQLite experimental and says so on every start.
const QUIET_SQLITE = "--disable-warning=ExperimentalWarning";

function logFile(paths) {
  return path.join(paths.logsDir, LOG_FILE_NAME);
}

// One older log is kept as server.log.1, so the log never grows without end.
function rotateLog(file, maxBytes = LOG_ROTATE_BYTES) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
}

function serverArgs({ appRoot, port, dataRoot, dev = false, open = false }) {
  return [
    path.join(appRoot, "server.js"),
    "--port", String(port),
    "--data-dir", dataRoot,
    ...(dev ? ["--dev"] : []),
    ...(open ? [] : ["--no-open"]),
  ];
}

function tail(text, lines) {
  return text.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1).slice(-lines).join("\n");
}

function readLogTail(paths, lines = 20) {
  try {
    return tail(fs.readFileSync(logFile(paths), "utf8"), lines);
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Starts the server in the background with its output in logs/server.log and
// waits until it has written run/server.json and answers its health check.
async function startDetached({ appRoot, paths, port, dev = false, env = process.env, spawnImpl = spawn, timeoutMs = START_TIMEOUT_MS }) {
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const file = logFile(paths);
  rotateLog(file);
  const fd = fs.openSync(file, "a", 0o600);
  let child;
  try {
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} starting on port ${port} ---\n`);
    child = spawnImpl(process.execPath, [QUIET_SQLITE, ...serverArgs({ appRoot, port, dataRoot: paths.root, dev })], {
      // Not the app folder: on Windows a process's working folder cannot be
      // renamed, and an update renames app/.
      cwd: paths.root,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, NO_OPEN: "1" },
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  child.once("error", (error) => { exited = { code: null, signal: null, error }; });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      const reason = exited.error ? exited.error.message : `it exited with code ${exited.code ?? exited.signal}`;
      const error = new Error(`The server did not start: ${reason}.`);
      error.logTail = readLogTail(paths);
      throw error;
    }
    const run = readRunState(paths.runDir);
    if (run && run.pid === child.pid) {
      const health = await fetchHealth(run.url || `http://127.0.0.1:${run.port}/`);
      if (health) return { run, health, pid: child.pid };
    }
    await sleep(100);
  }
  const error = new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)} s.`);
  error.logTail = readLogTail(paths);
  throw error;
}

// Runs the server inside this process, attached to the terminal. Services
// (systemd, launchd) use this, so their stop signal reaches the server's own
// clean shutdown directly.
function runForeground({ appRoot, paths, port, dev = false, open = true }) {
  process.argv = [process.execPath, ...serverArgs({ appRoot, port, dataRoot: paths.root, dev, open })];
  require(path.join(appRoot, "server.js"));
}

// Asks the server to shut down cleanly (SIGTERM; on Windows this ends the
// process, and SQLite finishes its write-ahead log on the next open) and waits
// until the process is gone.
async function stopProcess(pid, { timeoutMs = STOP_TIMEOUT_MS, force = false, kill = process.kill.bind(process), isAlive = isProcessAlive } = {}) {
  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return { stopped: true, forced: false };
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { stopped: true, forced: false };
    await sleep(100);
  }
  if (!force) return { stopped: false, forced: false };
  try {
    kill(pid, "SIGKILL");
  } catch {
    // Gone in the meantime.
  }
  await sleep(200);
  return { stopped: !isAlive(pid), forced: true };
}

module.exports = {
  QUIET_SQLITE,
  LOG_FILE_NAME,
  logFile,
  rotateLog,
  serverArgs,
  readLogTail,
  tail,
  startDetached,
  runForeground,
  stopProcess,
};
