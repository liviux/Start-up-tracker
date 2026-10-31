#!/usr/bin/env node
"use strict";

// Writes a fictional startup, "Northwind Robotics", into a data folder, for
// development, screenshots and trying the app. Everything is made up and every
// link points at example.com. The demo is its own startup; other startups in
// the database are not touched.
//
// Usage: node tools/demo-data.js --data-dir <folder> [--force] [--size large]
//   --force        replace the demo startup's data if it already has some
//   --size large   add 1,000+ generated records for speed and layout checks
//
// The data folder must be given explicitly, so this can never write into a real
// install by accident.

const fs = require("fs");
const path = require("path");
const { TrackerSqliteStore, verifyDatabaseFile, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { createStartup, listStartups } = require("../lib/startups");
const { dataPaths, readFlag } = require("../lib/data-root");
const { DEMO_STARTUP_NAME, buildDemoState, buildDemoShared, countRecords } = require("../lib/demo");

function writeDemoData({ dataDir, force = false, size = "normal", now } = {}) {
  if (!dataDir) throw new Error("Pass the data folder explicitly: --data-dir <folder>.");
  const paths = dataPaths(path.resolve(dataDir), {});
  if (fs.existsSync(paths.databaseFile)) {
    const verification = verifyDatabaseFile(paths.databaseFile);
    if (!verification.ok) throw new Error(`${paths.databaseFile} did not verify: ${verification.problems.join("; ")}`);
  }
  fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true, mode: 0o700 });
  const state = buildDemoState({ size, now });
  const store = new TrackerSqliteStore(paths.databaseFile);
  try {
    let startup = listStartups(store).find((entry) => entry.name === DEMO_STARTUP_NAME);
    if (startup && !force) {
      const records = countRecords(store.readState(startup.id).state || {});
      if (records > 0) throw new Error(`${DEMO_STARTUP_NAME} (${startup.id}) already holds ${records} record(s). Use --force to replace them with demo data.`);
    }
    if (!startup) startup = createStartup(store, { name: DEMO_STARTUP_NAME }, { origin: "tool" });
    store.replaceState(startup.id, state, { origin: "tool", label: "Demo data" });
    const shared = buildDemoShared({ now });
    store.applyOperations(GLOBAL_STARTUP_ID, shared.campaigns.map((campaign) => ({ type: "upsert", section: "campaigns", id: campaign.id, value: campaign })), { origin: "tool", label: "Demo campaigns" });
    return {
      databaseFile: paths.databaseFile,
      startupId: startup.id,
      urlPath: `/s/${startup.id}/`,
      records: countRecords(state) + shared.campaigns.length,
    };
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const result = writeDemoData({
      dataDir: readFlag(argv, "--data-dir"),
      force: argv.includes("--force"),
      size: readFlag(argv, "--size") || "normal",
    });
    console.log(`Wrote ${result.records} fictional records to ${DEMO_STARTUP_NAME} (${result.startupId}) in ${result.databaseFile}`);
    console.log(`Open it at ${result.urlPath}`);
  } catch (error) {
    console.error(`demo-data: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { DEMO_STARTUP_NAME, buildDemoState, buildDemoShared, writeDemoData, countRecords };
