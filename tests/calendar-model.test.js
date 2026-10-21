"use strict";

// The calendar's events, per-day counts, summary and month grid
// (public/js/calendar-model.js), shared by the page and the server.
const assert = require("node:assert/strict");
const test = require("node:test");
const Calendar = require("../public/js/calendar-model.js");
const Statuses = require("../public/js/status-model.js");

Statuses.setConfig(require("../content/statuses.json"), require("../content/priorities.json"));
const GROUP_IDS = [...Statuses.groups().map((group) => group.id), Statuses.UNMAPPED];

test("every record type gives its dated moments, with its section and type", () => {
  const target = Calendar.recordEvents("items", { id: "a", platform: "Forum", status: "scheduled", date: "2026-11-02", time: "10:00" });
  assert.deepEqual(target.map((event) => [event.section, event.kind, event.date, event.time, event.label]), [["mk", "next_action", "2026-11-02", "10:00", "Forum"]]);

  const program = Calendar.recordEvents("programs", {
    id: "p",
    name: "Accelerator",
    status: "submitted",
    nextActionDate: "2026-11-03",
    details: { submissionDate: "2026-11-10", interviewDate: "2026-11-20", pitchDate: "not a date" },
    timeEntries: [{ label: "Demo day", date: "2026-12-01" }],
  });
  assert.deepEqual(program.map((event) => [event.kind, event.date, event.detail]), [
    ["next_action", "2026-11-03", ""],
    ["deadline", "2026-11-10", "Submission"],
    ["milestone", "2026-11-20", "Interview"],
    ["milestone", "2026-12-01", "Demo day"],
  ]);

  const funding = Calendar.recordEvents("funding", {
    id: "f",
    funder: "Angel group",
    status: "negotiating",
    expectedCloseDate: "2026-12-15",
    payments: [{ date: "2027-01-10", amount: 5000, currency: "EUR", status: "Expected" }],
    commitments: [{ date: "2026-12-20", amount: 20000, currency: "EUR" }],
  });
  assert.deepEqual(funding.map((event) => [event.kind, event.detail]), [
    ["deadline", "Expected close"],
    ["payment", "Payment EUR 5,000"],
    ["payment", "Commitment EUR 20,000"],
  ]);
  assert.ok(funding.every((event) => event.status === "negotiating"), "events carry the record's own status");

  const campaign = Calendar.recordEvents("campaigns", { id: "c", name: "Launch", status: "active", startDate: "2026-11-01", endDate: "2026-11-30" });
  assert.deepEqual(campaign.map((event) => [event.section, event.kind, event.detail]), [["campaign", "campaign", "Starts"], ["campaign", "campaign", "Ends"]]);
});

test("Company steps and deadlines reach the calendar with their real status", () => {
  const Company = require("../public/js/company-model.js");
  const template = {
    sources: [{ id: "s", url: "https://example.com" }],
    setupSteps: [{ id: "register", title: "Register", description: "File the form.", authority: "Registry", dependsOn: [], sourceIds: ["s"] }],
    obligations: [{ id: "vat", title: "VAT return", description: "Monthly.", authority: "Tax office", frequency: "monthly", due: { rule: "relative-to-period-end", months: 1, day: 25 }, conditions: [], subdivisions: [], sourceIds: ["s"] }],
  };
  const view = Company.view(template, {
    companyProfile: { templateId: "x", incorporated: true },
    companySteps: [{ id: "st1", templateStepId: "register", status: "preparing", dueDate: "2026-11-05" }],
    companyDeadlines: [{ id: "vat@2026-11-25", status: "completed" }],
  }, { today: "2026-11-01", isDone: (status) => status === "completed" });
  const events = Company.calendarEvents(view, { defaultStatus: "new" });
  assert.deepEqual(events[0], { id: "step:register", parentId: "st1", parentKind: "step", section: "comp", kind: "company", date: "2026-11-05", time: "", label: "Register", detail: "", status: "preparing", rawStatus: "preparing" });
  const november = events.find((event) => event.date === "2026-11-25");
  assert.equal(november.status, "completed");
  assert.equal(events.find((event) => event.date === "2026-12-25").status, "new", "an untouched deadline has the default status");
  assert.equal(Company.calendarRecords(view, { defaultStatus: "new" })[0].status, "preparing");
  assert.equal(view.deadlines.items.find((item) => item.dueDate === "2026-11-25").state, "done");
});

test("filters by section, event type and status; campaign dates follow their type only", () => {
  const events = [
    { section: "mk", kind: "next_action", status: "scheduled" },
    { section: "po", kind: "deadline", status: "completed" },
    { section: "campaign", kind: "campaign", status: "paused" },
  ];
  const selection = Statuses.defaultSelection();
  const filters = { sections: new Set(["mk", "po"]), kinds: Calendar.defaultKinds(), matchesStatus: (status) => Statuses.matches(selection, status) };
  assert.deepEqual(events.filter((event) => Calendar.eventMatches(event, filters)).map((event) => event.section), ["mk"]);
  filters.kinds = new Set([...filters.kinds, "campaign"]);
  filters.sections = new Set(["po"]);
  assert.deepEqual(events.filter((event) => Calendar.eventMatches(event, filters)).map((event) => event.section), ["campaign"]);
  assert.equal(Calendar.defaultKinds().has("campaign"), false, "campaign dates start off");
});

test("per-day counts per section and per status group", () => {
  const events = [
    { section: "mk", status: "scheduled" },
    { section: "mk", status: "published" },
    { section: "po", status: "submitted" },
    { section: "comp", status: "Legacy" },
  ];
  assert.deepEqual(Calendar.countBySection(events), { mk: 2, po: 1, fu: 0, comp: 1 });
  assert.deepEqual(Calendar.countByGroup(events.filter((event) => event.section === "mk"), Statuses.groupOf), { planned: 1, done: 1 });
  assert.deepEqual(Calendar.countByGroup(events.filter((event) => event.section === "comp"), Statuses.groupOf), { unmapped: 1 });
});

test("the summary keeps items and events apart and follows the section toggles", () => {
  const events = [
    { section: "po", id: "p1", status: "submitted", date: "2026-11-02" },
    { section: "po", id: "p1", status: "submitted", date: "2026-11-05" },
    { section: "po", id: "p1", status: "submitted", date: "2026-11-09" },
    { section: "mk", id: "a", status: "scheduled", date: "2026-11-03" },
    { section: "fu", id: "f", status: "rejected", date: "2026-11-04" },
  ];
  const range = Calendar.summarize({ mode: "range", events, groupOf: Statuses.groupOf, groupIds: GROUP_IDS, sections: new Set(["mk", "po", "fu", "comp"]) });
  const po = range.rows.find((row) => row.section === "po");
  assert.equal(po.counts.items, 1, "one program with three dates is one item");
  assert.equal(po.counts.events, 3);
  assert.equal(po.counts.in_progress, 1);
  assert.deepEqual([range.total.items, range.total.events, range.total.planned, range.total.closed], [3, 5, 1, 1]);

  const hidden = Calendar.summarize({ mode: "range", events, groupOf: Statuses.groupOf, groupIds: GROUP_IDS, sections: new Set(["mk", "fu"]) });
  assert.equal(hidden.rows.find((row) => row.section === "po").hidden, true, "a hidden section keeps its row");
  assert.equal(hidden.total.items, 2, "but leaves the totals");

  const sameIdOtherStartup = [...events, { section: "po", id: "p1", startupId: "other", status: "won", date: "2026-11-06" }];
  assert.equal(Calendar.summarize({ mode: "range", events: sameIdOtherStartup, groupOf: Statuses.groupOf, groupIds: GROUP_IDS }).rows.find((row) => row.section === "po").counts.items, 2);
});

test("the all-time summary counts every record, with or without a date, through the status filter", () => {
  const records = { mk: [{ id: "a", status: "new" }, { id: "b", status: "published" }, { id: "c", status: "Legacy" }], po: [], fu: [{ id: "f", status: "won" }], comp: [] };
  const selection = Statuses.defaultSelection();
  const summary = Calendar.summarize({
    mode: "all",
    events: [{ section: "mk", id: "a", status: "new" }],
    records,
    matchesStatus: (status) => Statuses.matches(selection, status),
    groupOf: Statuses.groupOf,
    groupIds: GROUP_IDS,
  });
  const mk = summary.rows.find((row) => row.section === "mk");
  assert.deepEqual([mk.counts.items, mk.counts.planned, mk.counts.done, mk.counts.unmapped, mk.counts.events], [2, 1, 0, 1, 1]);
  assert.equal(summary.rows.find((row) => row.section === "fu").counts.in_progress, 1);
});

test("the month grid is whole weeks: five or six rows, starting on the chosen day", () => {
  const august = Calendar.monthGrid("2026-08-17", "monday");
  assert.equal(august.month, "2026-08");
  assert.equal(august.weeks.length, 6, "August 2026 starts on a Saturday and spans six weeks");
  assert.equal(august.weeks[0][0], "2026-07-27");
  assert.equal(august.weeks[5][6], "2026-09-06");

  const october = Calendar.monthGrid("2026-10-01", "monday");
  assert.equal(october.weeks.length, 5);
  assert.equal(october.weeks[0][0], "2026-09-28");

  const sundays = Calendar.monthGrid("2026-10-01", "sunday");
  assert.equal(sundays.weeks[0][0], "2026-09-27");

  const february = Calendar.monthGrid("2026-02-14", "sunday");
  assert.equal(february.weeks.length, 5, "a February filling exactly four weeks gets a fifth row");
  assert.equal(february.weeks[0][0], "2026-02-01");
});

test("days stay whole across daylight-saving changes", () => {
  for (const [date, weekStart] of [["2026-03-15", "monday"], ["2026-10-15", "monday"], ["2026-03-08", "sunday"], ["2026-11-01", "sunday"]]) {
    const days = Calendar.monthGrid(date, weekStart).weeks.flat();
    for (let index = 1; index < days.length; index += 1) {
      const gap = (Date.parse(`${days[index]}T00:00:00Z`) - Date.parse(`${days[index - 1]}T00:00:00Z`)) / 86400000;
      assert.equal(gap, 1, `${days[index - 1]} to ${days[index]}`);
    }
    assert.equal(new Set(days).size, days.length);
  }
  const original = process.env.TZ;
  process.env.TZ = "Europe/Bucharest";
  try {
    assert.equal(Calendar.monthGrid("2026-10-25", "monday").weeks[4][6], "2026-11-01", "the last Sunday of October is one day");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
