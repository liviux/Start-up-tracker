#!/usr/bin/env node
"use strict";

// Runs the test suite with a throwaway data folder, no browser and random
// ports, so tests can never reach a running tracker or real data.
// Usage: node tools/run-tests.js [test files...]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const requested = process.argv.slice(2);
const files = requested.length
  ? requested
  : fs.readdirSync(path.join(ROOT, "tests")).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join("tests", name));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "startup-tracker-tests-"));
try {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, STARTUP_TRACKER_HOME: home, NO_OPEN: "1", PORT: "0", STARTUP_TRACKER_OFFLINE: "1", STARTUP_TRACKER_TEST_RUN: "1" },
  });
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
