"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const model = require("../public/js/status-model.js");

model.setConfig(require("../content/statuses.json"), require("../content/priorities.json"));

test("groups, labels and open states derive from the shared list", () => {
  assert.equal(model.groupOf("submitted"), "in_progress");
  assert.equal(model.label("interview_pitch"), "Interview / pitch");
  assert.equal(model.isOpen("won"), true, "accepted work still needs doing");
  assert.equal(model.isOpen("completed"), false);
  assert.equal(model.isOpen("rejected"), false);
  assert.equal(model.isWaiting("due_diligence"), true);
  assert.equal(model.defaultStatus(), "new");
  assert.deepEqual(model.inGroup("done"), ["published", "received", "completed"]);
});

test("an unknown status is kept and shows as unmapped", () => {
  assert.equal(model.groupOf("Eligibility Review"), "unmapped");
  assert.equal(model.label("Eligibility Review"), "Eligibility Review");
  assert.equal(model.isOpen("Eligibility Review"), true, "never hidden because its value is unknown");
  const options = model.optionsHtml("Eligibility Review");
  assert.match(options, /<optgroup label="Unmapped"><option value="Eligibility Review" selected>/);
  assert.equal((options.match(/<optgroup/g) || []).length, 5);
  assert.match(model.badgeClass("Eligibility Review"), /status-group-unmapped/);
  assert.match(model.badgeClass("on_hold"), /status-on-hold status-group-in-progress/);
});

test("dropdowns list every subtype under its group", () => {
  const options = model.optionsHtml("scheduled");
  for (const group of model.groups()) assert.ok(options.includes(`<optgroup label="${group.label}">`), group.id);
  assert.equal((options.match(/<option /g) || []).length, 22);
  assert.match(options, /<option value="scheduled" selected/);
});

test("the shared filter's state per group, select all and none, and unmapped values", () => {
  let selection = model.defaultSelection();
  assert.equal(model.groupState(selection, "planned"), "all");
  assert.equal(model.groupState(selection, "done"), "off");
  assert.equal(model.matches(selection, "completed"), false);
  assert.equal(model.matches(selection, "Something old"), true, "unmapped values are in the default");
  selection = model.toggle(selection, "researching");
  assert.equal(model.groupState(selection, "planned"), "3/4");
  selection = model.setGroup(selection, "done", true);
  assert.equal(model.groupState(selection, "done"), "all");
  selection = model.setGroup(selection, model.UNMAPPED, false);
  assert.equal(model.matches(selection, "Something old"), false);
  assert.equal(model.allSelection().size, 23);
  const waiting = new Set(["submitted", "interview_pitch", "due_diligence"]);
  assert.equal(model.groupState(waiting, "in_progress"), "3/10");
});

test("a stored filter drops ids that no longer exist and never ends up empty", () => {
  assert.deepEqual([...model.restoreSelection(["new", "gone_status"])], ["new"]);
  assert.equal(model.restoreSelection(["gone_status"]).size, model.defaultSelection().size);
  assert.equal(model.restoreSelection(null).size, model.defaultSelection().size);
});

test("counts per status and per group", () => {
  const records = [{ status: "new" }, { status: "new" }, { status: "won" }, { status: "Archived" }];
  assert.equal(model.countByStatus(records).get("new"), 2);
  assert.equal(model.countByStatus(records).get(model.UNMAPPED), 1);
  assert.deepEqual(model.countByGroup(records), { planned: 2, in_progress: 1, done: 0, closed: 0, unmapped: 1 });
});

test("priorities are the values targets store, written any case", () => {
  assert.equal(model.normalizePriority("Very High"), "Very High");
  assert.equal(model.normalizePriority("very high"), "Very High");
  assert.equal(model.normalizePriority(""), "Medium");
  assert.equal(model.normalizePriority("Urgent!"), "Urgent!", "unknown values are kept");
  assert.equal(model.priorityLabel("Very Low"), "Very low");
  assert.ok(model.priorityRank("Very High") < model.priorityRank("Low"));
  assert.match(model.priorityOptionsHtml("High"), /<option value="High" selected>High<\/option>/);
});
