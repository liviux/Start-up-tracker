"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MAPS, mapStatus } = require("../lib/migrations/status-map");
const statuses = require("../content/statuses.json");

const known = new Set(statuses.statuses.map((status) => status.id));

// Every status value the old tracker stored, per section.
const OLD = {
  mk: ["todo", "done", "rejected", "live", "submitted", "pending", "parked", "drafting"],
  po: [
    "Discovered", "Eligibility Review", "Ineligible", "Qualified", "Prioritized", "Not Pursuing", "Skipped for now",
    "Future Reserve", "Preparing", "Drafting", "Internal Review", "Ready to Submit", "Submitted", "Confirmation Received",
    "Shortlisted", "Interview / Pitch", "Due Diligence", "Accepted", "Rejected", "Waitlisted", "Withdrawn",
    "Deadline Missed / Expired", "Cancelled", "Onboarding", "Active", "Reporting", "Completed", "Renewal / Reapply",
    "Reopen Monitoring", "Archived",
  ],
  fu: [
    "Identified", "Qualified", "Contacted", "Discovery", "Scope Defined", "Applied / Materials Sent", "Proposal Sent",
    "Due Diligence", "Terms Offered", "Negotiation", "Committed / Awarded", "Partially Received", "Fully Received",
    "On Hold", "Withdrawn", "Closed Won", "Closed Lost", "Applied", "Committed", "Awarded", "Declined",
  ],
  company: ["not_started", "de_depus", "in_progress", "in_lucru", "submitted", "revision", "completed", "depus", "intarziat", "expira", "rejected", "na"],
};

test("every old status maps to a status in the shared list", () => {
  for (const [section, values] of Object.entries(OLD)) {
    for (const value of values) {
      const mapped = mapStatus(section, value, { date: "2026-01-01" });
      assert.ok(known.has(mapped), `${section} ${value} -> ${mapped}`);
    }
    assert.deepEqual(Object.keys(MAPS[section]).sort(), [...values].sort(), `${section} maps exactly the old values`);
  }
});

test("a marketing to-do is scheduled when it had a date, otherwise new", () => {
  assert.equal(mapStatus("mk", "todo", { date: "2026-03-01" }), "scheduled");
  assert.equal(mapStatus("mk", "todo", {}), "new");
});

test("the group changes the plan calls out", () => {
  const groupOf = (id) => statuses.statuses.find((status) => status.id === id).group;
  assert.equal(groupOf(mapStatus("po", "Accepted")), "in_progress");
  assert.equal(groupOf(mapStatus("po", "Skipped for now")), "planned");
  assert.equal(groupOf(mapStatus("fu", "Contacted")), "in_progress");
  assert.equal(groupOf(mapStatus("fu", "Closed Won")), "in_progress");
  assert.equal(groupOf(mapStatus("fu", "On Hold")), "in_progress");
});

test("unknown values are kept for the import to show as unmapped", () => {
  assert.equal(mapStatus("po", "Something else"), null);
  assert.equal(mapStatus("expense", "platit"), "paid");
  assert.throws(() => mapStatus("nope", "x"), RangeError);
});
