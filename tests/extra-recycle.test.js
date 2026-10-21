"use strict";

// Soft delete and restore for media, feedback and campaigns: deleting moves a
// record to its bin with everything it held, restoring brings it back as it
// was. Campaigns are shared, so their bin is the global one.
const assert = require("node:assert/strict");
const test = require("node:test");
const Recycle = require("../public/js/recycle.js");
const GlobalData = require("../public/js/global-data.js");
const { pairedSection, GLOBAL_PAIRS, STARTUP_PAIRS } = require("../lib/recycle-bin");

const NOW = new Date("2026-10-19T10:00:00Z");
const LATER = new Date("2026-10-20T10:00:00Z");

for (const [live, record] of [
  ["mediaItems", { id: "m1", title: "Shot", type: "screenshot", sourceType: "upload", storedName: "shot.png", tags: ["launch"] }],
  ["feedbackItems", { id: "f1", title: "Could not sign up", type: "onboarding-friction", journeyStep: "signed-up", dropOffReason: "No email arrived", tags: [] }],
  ["campaigns", { id: "c1", name: "Spring launch", status: "active", goal: "50 sign-ups", tags: ["high-impact"] }],
]) {
  test(`${live}: soft delete keeps the whole record, restore brings it back`, () => {
    const kind = Recycle.kindOfLive(live);
    assert.ok(kind, `${live} has a bin`);
    const other = { id: "other", title: "Other", name: "Other" };
    const moved = Recycle.moveToBin([record, other], [], record.id, NOW);
    assert.deepEqual(moved.live, [other]);
    assert.equal(moved.deleted[0].deletedAt, NOW.toISOString());
    const { deletedAt, updatedAt, ...kept } = moved.deleted[0];
    void deletedAt;
    void updatedAt;
    assert.deepEqual(kept, record, "nothing is lost on the way to the bin");
    assert.equal(Recycle.groupBin((section) => (section === kind.deleted ? moved.deleted : []))[0].records[0].id, record.id);

    const restored = Recycle.restoreFromBin(moved.live, moved.deleted, record.id, LATER);
    assert.deepEqual(restored.deleted, []);
    const { updatedAt: restoredAt, ...back } = restored.live[0];
    assert.equal(restoredAt, LATER.toISOString());
    assert.deepEqual(back, record);
    assert.equal(pairedSection(kind.deleted), live);
  });
}

test("the campaign and tag bins are shared; media and feedback bins belong to a startup", () => {
  assert.ok(GLOBAL_PAIRS.some(([live]) => live === "campaigns"));
  assert.ok(STARTUP_PAIRS.some(([live]) => live === "mediaItems"));
  assert.ok(STARTUP_PAIRS.some(([live]) => live === "feedbackItems"));
  for (const section of ["campaigns", "deletedCampaigns", "tags", "deletedTags"]) assert.ok(GlobalData.SECTION_NAMES.includes(section), `${section} is saved with the shared data`);
  assert.ok(!GlobalData.SECTION_NAMES.includes("deletedMediaItems"));
});
