"use strict";

// Starts server.js on a throwaway data folder and a random free port, so tests
// never reach a running tracker or the user's real data folder.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..", "..");

function makeTempHome(prefix = "startup-tracker-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function waitForUrl(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start.\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      const match = output.match(/Startup Tracker: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}.\n${output}`));
    });
  });
}

async function startServer({ home = makeTempHome(), env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, ["server.js", ...args], {
    cwd: rootDir,
    env: { ...process.env, PORT: "0", NO_OPEN: "1", STARTUP_TRACKER_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await waitForUrl(child);
  const token = fs.readFileSync(path.join(home, "secrets", "api-token"), "utf8").trim();
  return {
    child,
    url,
    home,
    token,
    async stop({ keepHome = false } = {}) {
      if (child.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.kill("SIGTERM");
        });
      }
      if (!keepHome) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

module.exports = { rootDir, makeTempHome, startServer, waitForUrl };
