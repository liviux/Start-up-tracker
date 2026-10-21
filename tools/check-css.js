#!/usr/bin/env node
"use strict";

// Checks the stylesheet bundle (public/styles.css and everything it imports)
// for problems a browser would silently swallow: unbalanced comments, unclosed
// strings, imports of files that do not exist. Exits non-zero on any problem.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "public", "styles.css");

function resolveImport(href, parentFile) {
  if (/^(?:https?:|data:)/i.test(href)) return null;
  return path.resolve(path.dirname(parentFile), href.replace(/[?#].*$/, ""));
}

function readBundle(filePath, problems, seen = new Set()) {
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  if (!fs.existsSync(resolved)) {
    problems.push(`${path.relative(ROOT, resolved)}: imported file does not exist`);
    return [];
  }
  const files = [{ file: resolved, css: fs.readFileSync(resolved, "utf8") }];
  for (const match of files[0].css.matchAll(/@import\s+url\((["']?)([^"')]+)\1\);/g)) {
    const target = resolveImport(match[2], resolved);
    if (target) files.push(...readBundle(target, problems, seen));
  }
  return files;
}

// Walks one file, tracking comments and strings, and reports where a comment
// or string is left open.
function scanFile({ file, css }, problems) {
  const rel = path.relative(ROOT, file);
  let state = "normal";
  let openedAt = 0;
  let line = 1;
  let depth = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    const next = css[i + 1];
    if (c === "\n") line += 1;
    if (state === "comment") {
      if (c === "*" && next === "/") { state = "normal"; i += 1; }
      continue;
    }
    if (state === "dq" || state === "sq") {
      if (c === "\\") { i += 1; continue; }
      if ((state === "dq" && c === '"') || (state === "sq" && c === "'")) state = "normal";
      else if (c === "\n") { problems.push(`${rel}:${openedAt}: string is not closed on its line`); state = "normal"; }
      continue;
    }
    if (c === "/" && next === "*") { state = "comment"; openedAt = line; i += 1; continue; }
    if (c === '"') { state = "dq"; openedAt = line; continue; }
    if (c === "'") { state = "sq"; openedAt = line; continue; }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth < 0) { problems.push(`${rel}:${line}: closing brace without an opening one`); depth = 0; }
    }
  }
  if (state === "comment") problems.push(`${rel}:${openedAt}: comment is never closed`);
  if (depth > 0) problems.push(`${rel}: ${depth} unclosed brace(s) at the end of the file`);
}

function checkCss() {
  const problems = [];
  const files = readBundle(ENTRY, problems);
  for (const entry of files) scanFile(entry, problems);
  return { files: files.map((entry) => path.relative(ROOT, entry.file)), problems };
}

if (require.main === module) {
  const { files, problems } = checkCss();
  for (const problem of problems) console.log(`ERROR ${problem}`);
  console.log(`check-css: ${files.length} file(s), ${problems.length} problem(s)`);
  process.exitCode = problems.length ? 1 : 0;
}

module.exports = { checkCss, scanFile };
