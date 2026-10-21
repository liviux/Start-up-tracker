"use strict";

// The target window's rules that need no browser (public/js/record-window.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Fields = require("../public/js/fields.js");
const RecordWindow = require("../public/js/record-window.js");

const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "fields", `${name}.json`), "utf8"));
Fields.setRegistry({ common: read("common"), mk: read("mk"), po: read("po"), fu: read("fu") });
Fields.setCustomFields([{ section: "po", label: "Partner tier", type: "text" }]);
const clone = (value) => JSON.parse(JSON.stringify(value));

test("the window has the same six tabs in every section", () => {
  assert.deepEqual(RecordWindow.TAB_IDS, ["overview", "edit", "details", "links", "extras", "history"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "record-window.js"), "utf8");
  // The tabs are drawn from TABS alone; no section adds or drops one.
  assert.doesNotMatch(source, /section === "(mk|po|fu)"[^\n]*TABS/);
});

test("opening a record and touching nothing is not a change, however it was stored", () => {
  const stored = { id: "p1", name: "Grant", status: "applied", details: { probabilityPercent: "40", maxEmployees: "50" }, extraParams: { cohortFrequency: "Twice a year" }, timeEntries: [] };
  assert.equal(RecordWindow.isDirty("po", stored, clone(stored)), false);
  const work = clone(stored);
  // The same values written the way the window writes them.
  Fields.setValue("po", work, Fields.findField("po", "probabilityPercent"), 40);
  Fields.setValue("po", work, Fields.findField("po", "maxEmployees"), "50");
  assert.equal(RecordWindow.isDirty("po", stored, work), false);
});

test("edits from fields, pickers, chips, activity and other fields all count as changes", () => {
  const stored = { id: "t1", platform: "Post", taxonomy: ["mk.content.blog", "mk.content"], tags: ["launch"], status: "planned", extraParams: { cohort: "A" } };
  const check = (change, expected) => {
    const work = clone(stored);
    change(work);
    assert.deepEqual(RecordWindow.changedFields("mk", stored, work), expected);
  };
  check((work) => { work.taxonomy = ["mk.pr.press", "mk.pr"]; }, ["taxonomy"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "tags"), ["launch", "partner"]), ["tags"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "name"), "Thread"), ["name"]);
  check((work) => { work.timeEntries = [{ id: "m1", label: "Demo day", date: "2026-12-01" }]; }, ["timeEntries"]);
  check((work) => { work.extraParams = { cohort: "B" }; }, ["otherFields"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "reach"), 0), ["reach"]);
});

test("custom field values are part of the record and its changes", () => {
  const stored = { id: "p1", name: "Grant" };
  const work = clone(stored);
  Fields.setValue("po", work, Fields.findField("po", "partnerTier"), "Gold");
  assert.deepEqual(work.custom, { partnerTier: "Gold" });
  assert.deepEqual(RecordWindow.changedFields("po", stored, work), ["partnerTier"]);
});

test("an update log entry moves the target's status and next action on", () => {
  const work = { id: "f1", opportunity: "Seed", status: "planned", nextAction: "", nextActionDate: "" };
  RecordWindow.applyUpdateLogEntry("fu", work, { statusAfter: "in_talks", nextAction: "Send the deck", nextActionDate: "2026-12-03" });
  assert.equal(work.status, "in_talks");
  assert.equal(work.nextAction, "Send the deck");
  assert.equal(work.nextActionDate, "2026-12-03");
  const untouched = { status: "planned" };
  RecordWindow.applyUpdateLogEntry("po", untouched, { statusAfter: "", nextAction: "" });
  assert.deepEqual(untouched, { status: "planned" }, "an entry without a status after leaves it");
});

test("unknown keys survive a save through the window's setters", () => {
  const stored = { id: "p1", name: "Grant", futureKey: { nested: true }, details: { oldKey: "kept", referenceId: "R" } };
  const work = clone(stored);
  Fields.setValue("po", work, Fields.findField("po", "referenceId"), "R2");
  Fields.setValue("po", work, Fields.findField("po", "name"), "Grant 2027");
  assert.deepEqual(work.futureKey, { nested: true });
  assert.equal(work.details.oldKey, "kept");
  assert.equal(RecordWindow.nameOf("po", work), "Grant 2027");
});
