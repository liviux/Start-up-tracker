#!/usr/bin/env node
"use strict";

// Lists uploaded media files that no record names any more, and media folders
// of startups that no longer exist. It never deletes anything: check the list,
// then remove what you are sure about yourself.
//
// Usage: node tools/media-orphans.js [--data-dir <folder>] [--json]
//
// The database is opened read-only. A file counts as used when any record of
// its startup names it, in the recycle bin too, so a media item waiting in the
// bin keeps its file.

const fs = require("fs");
const { resolveDataRoot, dataPaths } = require("../lib/data-root");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { listOrphans } = require("../lib/media-files");

function findOrphans({ argv = process.argv.slice(2), env = process.env } = {}) {
  const dataRoot = resolveDataRoot({ argv, env });
  const paths = dataPaths(dataRoot.root, env);
  if (!fs.existsSync(paths.databaseFile)) throw new Error(`No database at ${paths.databaseFile}.`);
  const store = new TrackerSqliteStore(paths.databaseFile, { readOnly: true });
  try {
    return { dataFolder: dataRoot.root, mediaDir: paths.mediaDir, ...listOrphans(store, paths.mediaDir) };
  } finally {
    store.close();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const argv = process.argv.slice(2);
  const result = findOrphans({ argv });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Media folder: ${result.mediaDir}`);
  if (!result.files.length && !result.folders.length) {
    console.log("No orphan files.");
    return;
  }
  for (const file of result.files) console.log(`unused file  ${file.path}  (${formatBytes(file.size)})`);
  for (const folder of result.folders) console.log(`no startup   ${folder.path}`);
  const total = result.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`${result.files.length} unused file(s), ${formatBytes(total)}; ${result.folders.length} folder(s) of startups that no longer exist. Nothing was deleted.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`media-orphans: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { findOrphans };
