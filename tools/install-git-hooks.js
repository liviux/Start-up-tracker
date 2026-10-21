#!/usr/bin/env node
"use strict";

// Installs a pre-commit hook that runs tools/check-leaks.js on the staged files of
// this project. Works both when this folder is its own repository and when it sits
// inside a larger one (the hook then checks only staged files under this folder).
//
// Usage: node tools/install-git-hooks.js [--force]
// An existing pre-commit hook that this script did not write is left alone unless
// --force is given; with --force it is kept as pre-commit.backup-<timestamp>.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MARKER = "# startup-tracker leak check (tools/install-git-hooks.js)";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function hookScript(prefix) {
  const script = prefix ? `${prefix}/tools/check-leaks.js` : "tools/check-leaks.js";
  return [
    "#!/bin/sh",
    MARKER,
    "# Set LEAK_PATTERNS_FILE to a private patterns file to check your own names too.",
    `if ! node "${script}" --staged; then`,
    "  echo \"Leak check failed: fix or unstage the files listed above.\" >&2",
    "  exit 1",
    "fi",
    "",
  ].join("\n");
}

function install({ root = ROOT, force = false } = {}) {
  const topLevel = git(["rev-parse", "--show-toplevel"], root);
  const prefix = path.relative(fs.realpathSync(topLevel), fs.realpathSync(root)).split(path.sep).join("/");
  const hooksDir = path.resolve(root, git(["rev-parse", "--git-path", "hooks"], root));
  const hookFile = path.join(hooksDir, "pre-commit");
  fs.mkdirSync(hooksDir, { recursive: true });

  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, "utf8");
    if (!existing.includes(MARKER)) {
      if (!force) {
        throw new Error(`${hookFile} already exists and was not written by this tool. Re-run with --force to replace it (a backup is kept).`);
      }
      const backup = `${hookFile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(hookFile, backup);
      console.log(`Kept the previous hook as ${backup}`);
    }
  }
  fs.writeFileSync(hookFile, hookScript(prefix), { mode: 0o755 });
  fs.chmodSync(hookFile, 0o755);
  console.log(`Installed ${hookFile}`);
  return hookFile;
}

if (require.main === module) {
  try {
    install({ force: process.argv.includes("--force") });
  } catch (error) {
    console.error(`install-git-hooks: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { install, hookScript, MARKER };
