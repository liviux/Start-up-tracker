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
const clone = (value) => JSON.parse(JSON.stringify(value));

test("the window has the same five tabs in every section", () => {
  assert.deepEqual(RecordWindow.TAB_IDS, ["overview", "edit", "details", "links", "history"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "record-window.js"), "utf8");
  // The tabs are drawn from TABS alone; no section adds or drops one.
  assert.doesNotMatch(source, /section === "(mk|po|fu)"[^\n]*TABS/);
});

test("opening a record and touching nothing is not a change, however it was stored", () => {
  const stored = { id: "p1", name: "Grant", status: "applied", details: { probabilityPercent: "40", maxEmployees: "50" }, timeline: [], customFields: [{ label: "Cohort", value: "Twice a year" }] };
  assert.equal(RecordWindow.isDirty("po", stored, clone(stored)), false);
  const work = clone(stored);
  // The same values written the way the window writes them.
  Fields.setValue("po", work, Fields.findField("po", "probabilityPercent"), 40);
  Fields.setValue("po", work, Fields.findField("po", "maxEmployees"), "50");
  // A row added and left empty is not a change either.
  work.customFields.push({ label: "", value: "" });
  assert.equal(RecordWindow.isDirty("po", stored, work), false);
});

test("edits from fields, pickers, chips, the timeline and custom fields all count as changes", () => {
  const stored = { id: "t1", name: "Post", taxonomy: ["mk.content.blog", "mk.content"], tags: ["launch"], status: "planned", customFields: [{ label: "Cohort", value: "A" }] };
  const check = (change, expected) => {
    const work = clone(stored);
    change(work);
    assert.deepEqual(RecordWindow.changedFields("mk", stored, work), expected);
  };
  check((work) => { work.taxonomy = ["mk.pr.press", "mk.pr"]; }, ["taxonomy"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "tags"), ["launch", "partner"]), ["tags"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "name"), "Thread"), ["name"]);
  check((work) => { work.timeline = [{ id: "m1", type: "key-date", title: "Demo day", date: "2026-12-01" }]; }, ["timeline"]);
  check((work) => { work.customFields = [{ label: "Cohort", value: "B" }]; }, ["customFields"]);
  check((work) => Fields.setValue("mk", work, Fields.findField("mk", "reach"), 0), ["reach"]);
});

test("priority sits where the categories end, and there is no kind field", () => {
  const order = Fields.coreFields("po").map((field) => field.key);
  assert.equal(order.indexOf("priority"), order.indexOf("taxonomy") + 1);
  assert.equal(order.indexOf("status"), order.indexOf("priority") + 1);
  assert.equal(Fields.findField("po", "recordKind"), null);
});

test("a timeline entry moves the target's status and next action on", () => {
  const work = { id: "f1", name: "Seed", status: "planned", nextAction: "", nextActionDate: "" };
  RecordWindow.applyTimelineEntry("fu", work, { statusAfter: "in_talks", nextAction: "Send the deck", nextActionDate: "2026-12-03" });
  assert.equal(work.status, "in_talks");
  assert.equal(work.nextAction, "Send the deck");
  assert.equal(work.nextActionDate, "2026-12-03");
  const untouched = { status: "planned" };
  RecordWindow.applyTimelineEntry("po", untouched, { statusAfter: "", nextAction: "" });
  assert.deepEqual(untouched, { status: "planned" }, "an entry without a status after leaves it");
});

test("the timeline lists the latest date first and undated entries last", () => {
  const entries = [
    { date: "2026-10-01", type: "sent" },
    { date: "2026-12-01", type: "key-date" },
    { date: "" },
    { date: "2026-10-01", time: "15:00", type: "reply" },
  ];
  assert.deepEqual(RecordWindow.timelineOrder(entries), [1, 3, 0, 2]);
  assert.deepEqual(RecordWindow.timelineOrder([]), []);
});

test("unknown keys survive a save through the window's setters", () => {
  const stored = { id: "p1", name: "Grant", futureKey: { nested: true }, details: { referenceId: "R" } };
  const work = clone(stored);
  Fields.setValue("po", work, Fields.findField("po", "referenceId"), "R2");
  Fields.setValue("po", work, Fields.findField("po", "name"), "Grant 2027");
  assert.deepEqual(work.futureKey, { nested: true });
  assert.equal(RecordWindow.nameOf("po", work), "Grant 2027");
});
