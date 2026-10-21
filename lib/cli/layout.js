"use strict";

// Where the code runs from. An installed copy lives in <install root>/app,
// next to app.prev (the version before the last update); a git clone or a
// downloaded folder runs from wherever it is and is never moved by the CLI.

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..", "..");

function installLayout(appRoot = APP_ROOT, { exists = fs.existsSync } = {}) {
  const installed = path.basename(appRoot) === "app" && !exists(path.join(appRoot, ".git"));
  const installRoot = installed ? path.dirname(appRoot) : null;
  return {
    appRoot,
    installed,
    installRoot,
    appDir: installed ? appRoot : null,
    appNew: installed ? path.join(installRoot, "app.new") : null,
    appPrev: installed ? path.join(installRoot, "app.prev") : null,
  };
}

// The command the installer creates: ~/.local/bin/startup-tracker on macOS and
// Linux, <install root>\bin\startup-tracker.cmd (on the user PATH) on Windows.
function launcherPath({ platform = process.platform, homedir = os.homedir(), installRoot } = {}) {
  if (platform === "win32") return path.join(installRoot || path.join(homedir, ".startup-tracker"), "bin", "startup-tracker.cmd");
  return path.join(homedir, ".local", "bin", "startup-tracker");
}

function readPackage(appRoot = APP_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
}

module.exports = { APP_ROOT, installLayout, launcherPath, readPackage };
