"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DEMO_STARTUP_NAME, buildDemoState, buildDemoShared, writeDemoData } = require("../tools/demo-data");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { createStartup, listStartups } = require("../lib/startups");
const { scanText } = require("../tools/check-leaks");

test("demo data is fictional: example.com links only, nothing the leak check flags", () => {
  const state = { ...buildDemoState({ now: new Date("2026-10-17T12:00:00Z") }), ...buildDemoShared({ now: new Date("2026-10-17T12:00:00Z") }) };
  const text = JSON.stringify(state);
  for (const url of text.match(/https?:\/\/[^"\s]+/g) || []) {
    assert.match(url, /^https:\/\/example\.com\//, url);
  }
  assert.deepEqual(scanText(text), []);
  const total = ["items", "programs", "funding", "fundingRounds", "campaigns", "feedbackItems", "dailyLinks", "mediaItems"]
    .reduce((sum, key) => sum + state[key].length, 0);
  assert.ok(total >= 40, `more than 40 records, got ${total}`);
});

test("the demo covers every section, with a filled profile and linked records", () => {
  const state = buildDemoState({ now: new Date("2026-10-17T12:00:00Z") });
  assert.ok(state.items.length >= 24);
  assert.ok(state.programs.length >= 20);
  assert.ok(state.funding.length >= 12);
  assert.ok(state.fundingRounds.length >= 2);
  assert.ok(state.feedbackItems.length >= 8);
  assert.ok(state.dailyLinks.length >= 6);
  assert.ok(state.mediaItems.length >= 6);
  assert.ok(state.links.length >= 8);
  assert.equal(state.companyProfile.templateId, "uk-ltd");
  assert.ok(state.companySteps.length >= 10);
  assert.equal(state.profile.currency, "GBP");
  assert.ok(state.profile.oneLiner);
  assert.ok(state.profile.aiContext);
});

test("the large size adds more than 1,000 records", () => {
  const state = buildDemoState({ size: "large" });
  assert.ok(state.items.length + state.programs.length + state.funding.length > 1000);
});

test("demo data lands in its own startup and refuses to overwrite it without --force", () => {
  assert.throws(() => writeDemoData({}), /--data-dir/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-data-"));
  try {
    const databaseFile = path.join(dir, "data", "tracker.sqlite");
    // A startup that was there first; the demo must not touch it.
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    const setup = new TrackerSqliteStore(databaseFile);
    let otherId;
    try {
      otherId = createStartup(setup, { name: "Someone else" }).id;
      setup.replaceState(otherId, { items: [{ id: "keep", title: "Untouched" }] });
      setup.upsertRecord(GLOBAL_STARTUP_ID, "campaigns", { id: "mine", name: "My campaign" });
    } finally {
      setup.close();
    }

    const first = writeDemoData({ dataDir: dir });
    assert.ok(first.records >= 40);
    assert.equal(first.databaseFile, databaseFile);
    assert.notEqual(first.startupId, otherId);
    assert.equal(first.urlPath, `/s/${first.startupId}/`);

    assert.throws(() => writeDemoData({ dataDir: dir }), /--force/);
    const forced = writeDemoData({ dataDir: dir, force: true });
    assert.equal(forced.startupId, first.startupId, "--force reuses the demo startup");

    const store = new TrackerSqliteStore(databaseFile, { readOnly: true });
    try {
      const named = listStartups(store).filter((startup) => startup.name === DEMO_STARTUP_NAME);
      assert.deepEqual(named.map((startup) => startup.id), [first.startupId]);
      assert.ok(store.readState(first.startupId).state.items.length > 0);
      assert.deepEqual(store.readState(otherId).state.items, [{ id: "keep", title: "Untouched" }]);
      // Campaigns are shared: the demo ones are added next to yours.
      const campaigns = store.readSection(GLOBAL_STARTUP_ID, "campaigns").map((campaign) => campaign.id).sort();
      assert.deepEqual(campaigns, ["demo-campaign-community", "demo-campaign-funding", "demo-campaign-launch", "mine"]);
      assert.equal(store.readState(first.startupId).state.campaigns, undefined);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
