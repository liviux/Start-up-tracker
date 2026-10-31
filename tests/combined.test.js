"use strict";

// The read-only views across startups (lib/combined.js). Campaigns are shared
// by every startup, so they are read once from the global scope and carry no
// startup; the page opens them where it is.
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const { createStartup } = require("../lib/startups");
const { searchAll, calendarAll, campaignTargets } = require("../lib/combined");

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  const one = createStartup(store, { name: "One" }, { origin: "tool" }).id;
  const two = createStartup(store, { name: "Two" }, { origin: "tool" }).id;
  store.replaceState(one, { items: [{ id: "t1", name: "Spring post", nextActionDate: "2026-10-20", status: "scheduled", campaignId: "c1" }] }, { origin: "tool" });
  store.replaceState(two, { funding: [{ id: "f1", name: "Spring seed", nextActionDate: "2026-10-21", status: "planned", campaignId: "c1" }] }, { origin: "tool" });
  store.replaceSection(GLOBAL_STARTUP_ID, "campaigns", [{ id: "c1", name: "Spring launch", status: "active", startDate: "2026-10-20", endDate: "2026-11-20" }], { origin: "tool" });
  return { store, one, two };
}

test("search finds a shared campaign once, without a startup", () => {
  const { store } = setup();
  const results = searchAll(store, "spring").results;
  const campaigns = results.filter((result) => result.kind === "campaign");
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].startup, null);
  assert.equal(campaigns[0].shared, true);
  assert.deepEqual(results.filter((result) => result.kind !== "campaign").map((result) => [result.startup.name, result.id]).sort(), [["One", "t1"], ["Two", "f1"]]);
});

test("the combined calendar shows shared campaign dates once", () => {
  const { store } = setup();
  const { events, records } = calendarAll(store, { from: "2026-10-01", to: "2026-11-30" });
  const campaignEvents = events.filter((event) => event.section === "campaign");
  assert.ok(campaignEvents.length >= 1);
  assert.ok(campaignEvents.every((event) => event.startup === null && event.shared));
  assert.equal(new Set(campaignEvents.map((event) => `${event.id}:${event.date}:${event.kind}`)).size, campaignEvents.length, "no duplicates");
  assert.ok(!records.some((record) => record.section === "campaign"), "campaigns are not counted as targets");
});

test("a campaign lists its targets in every startup", () => {
  const { store, one, two } = setup();
  const { targets } = campaignTargets(store, "c1");
  assert.deepEqual(targets.map((target) => [target.startup.id, target.section, target.id, target.title, target.date]).sort(), [[one, "mk", "t1", "Spring post", "2026-10-20"], [two, "fu", "f1", "Spring seed", "2026-10-21"]].sort());
  assert.throws(() => campaignTargets(store, ""), RangeError);
});
