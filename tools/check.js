#!/usr/bin/env node
"use strict";

// npm run check: everything a contributor should run before a commit.
// Syntax of every JavaScript file, the CSS bundle, the content JSON, ESLint,
// the generic leak scan, the banned-words check and the check that UI text
// comes from en.json. Exits non-zero if any fails.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "temp", "tmp"]);

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : listJs(path.join(dir, entry.name));
    return entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : [];
  });
}

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const ok = result.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok && output) console.log(output.split("\n").map((line) => `     ${line}`).join("\n"));
  return ok;
}

function syntaxCheck() {
  const failures = [];
  for (const file of listJs(ROOT)) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${path.relative(ROOT, file)}\n${result.stderr.trim()}`);
  }
  console.log(`${failures.length ? "FAIL" : "ok  "} node --check on every JavaScript file`);
  for (const failure of failures) console.log(`     ${failure}`);
  return failures.length === 0;
}

const eslintBin = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const results = [
  syntaxCheck(),
  run("CSS bundle (tools/check-css.js)", process.execPath, ["tools/check-css.js"]),
  run("content JSON (tools/check-content.js)", process.execPath, ["tools/check-content.js"]),
  fs.existsSync(eslintBin)
    ? run("ESLint", process.execPath, [eslintBin, ".", "--max-warnings", "0"])
    : (console.log("FAIL ESLint is not installed: run npm install"), false),
  run("leak scan (tools/check-leaks.js)", process.execPath, ["tools/check-leaks.js"]),
  run("banned words (tools/check-words.js)", process.execPath, ["tools/check-words.js"]),
  run("UI text from en.json (tools/check-i18n.js)", process.execPath, ["tools/check-i18n.js"]),
];
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `check: ${failed} step(s) failed` : "check: all steps passed");
process.exitCode = failed ? 1 : 0;
