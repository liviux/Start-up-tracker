"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateDeadlines, occurrencesOf, deadlineState, defaultWindow } = require("../lib/company/recurrence");

const window2027 = { from: "2027-01-01", to: "2027-12-31" };
const dates = (obligation, context = {}) => occurrencesOf(obligation, { ...window2027, ...context }).occurrences.map((entry) => entry.dueDate);

test("monthly, quarterly and annual periods count months after the period end", () => {
  const monthly = { id: "vat", frequency: "monthly", due: { rule: "relative-to-period-end", months: 1, day: 25 } };
  assert.equal(dates(monthly).length, 12);
  assert.equal(dates(monthly)[0], "2027-01-25", "December 2026 is due on 25 January");
  const quarterly = { id: "q", frequency: "quarterly", due: { rule: "relative-to-period-end", months: 1, day: 25 } };
  assert.deepEqual(dates(quarterly), ["2027-01-25", "2027-04-25", "2027-07-25", "2027-10-25"]);
  const sameMonth = { id: "s", frequency: "monthly", due: { rule: "relative-to-period-end", months: 0, day: "last" } };
  assert.equal(dates(sameMonth)[1], "2027-02-28");
  const annual = { id: "a", frequency: "annual", due: { rule: "relative-to-period-end", months: 3, day: 31 } };
  assert.deepEqual(dates(annual), ["2027-03-31"]);
});

test("the second month of each quarter, and days past a month's end clamp to its last day", () => {
  const midQuarter = { id: "m", frequency: "quarterly", due: { rule: "relative-to-period-start", months: 1, day: 15 } };
  assert.deepEqual(dates(midQuarter), ["2027-02-15", "2027-05-15", "2027-08-15", "2027-11-15"]);
  const thirtyFirst = { id: "t", frequency: "monthly", due: { rule: "relative-to-period-end", months: 1, day: 31 } };
  assert.ok(dates(thirtyFirst).includes("2027-04-30"));
  assert.ok(dates(thirtyFirst).includes("2027-02-28"));
});

test("fiscal year end rules follow the company's own year end", () => {
  const accounts = { id: "acc", frequency: "annual", due: { rule: "relative-to-fiscal-year-end", months: 9, day: "same" } };
  assert.deepEqual(dates(accounts), ["2027-09-30"], "31 Dec year end + 9 months, same day clamps to 30 September");
  assert.deepEqual(dates(accounts, { fiscalYearEnd: "03-31" }), ["2027-12-31"]);
  const sixMonths = { id: "six", frequency: "annual", due: { rule: "relative-to-fiscal-year-end", months: 6, day: "same" } };
  assert.deepEqual(dates(sixMonths), ["2027-06-30"], "31 December + 6 months is 30 June");
  const leap = { id: "leap", frequency: "annual", due: { rule: "relative-to-fiscal-year-end", months: 2, day: "same" } };
  assert.deepEqual(dates(leap, { ...window2027, fiscalYearEnd: "12-31", from: "2028-01-01", to: "2028-12-31" }), ["2028-02-29"]);
});

test("anniversaries need the incorporation date and add months and days", () => {
  const confirmation = { id: "cs", frequency: "annual", due: { rule: "relative-to-anniversary", of: "incorporation", months: 0, days: 14 } };
  assert.equal(occurrencesOf(confirmation, window2027).needs, "incorporationDate");
  assert.deepEqual(dates(confirmation, { incorporationDate: "2025-05-20" }), ["2027-06-03"]);
  assert.deepEqual(dates(confirmation, { incorporationDate: "2027-03-01" }), [], "no anniversary in the founding year");
  assert.deepEqual(dates(confirmation, { incorporationDate: "2024-02-29" }), ["2027-03-14"], "29 February anniversaries fall on 28 February");
});

test("fixed dates, events and manual dates", () => {
  assert.deepEqual(dates({ id: "f", frequency: "annual", due: { rule: "fixed-date", month: 3, day: 1 } }), ["2027-03-01"]);
  assert.equal(dates({ id: "fm", frequency: "monthly", due: { rule: "fixed-date", day: 16 } }).length, 12);
  assert.equal(occurrencesOf({ id: "e", frequency: "on-event", due: { rule: "relative-to-event", days: 15, event: "a change of directors" } }, window2027).needs, "event");
  assert.equal(occurrencesOf({ id: "x", frequency: "annual", due: { rule: "manual" } }, window2027).needs, "date");
  assert.throws(() => occurrencesOf({ id: "bad", frequency: "annual", due: { rule: "someday" } }, window2027), RangeError);
});

test("conditions and subdivisions decide whether an obligation applies", () => {
  const payroll = { id: "p", frequency: "monthly", due: { rule: "relative-to-period-end", months: 1, day: 15 }, conditions: ["has-employees"] };
  assert.deepEqual(dates(payroll), []);
  assert.equal(dates(payroll, { conditions: ["has-employees"] }).length, 12);
  const state = { id: "s", frequency: "annual", due: { rule: "fixed-date", month: 6, day: 1 }, subdivisions: ["US-DE"] };
  assert.deepEqual(dates(state, { subdivision: "US-CA" }), []);
  assert.deepEqual(dates(state, { subdivision: "US-DE" }), ["2027-06-01"]);
});

test("the default window is three months back and twelve ahead, and states come from the date", () => {
  assert.deepEqual(defaultWindow("2026-10-18"), { from: "2026-07-18", to: "2027-10-18" });
  assert.deepEqual(defaultWindow("2026-05-31"), { from: "2026-02-28", to: "2027-05-31" });
  const { deadlines, needs } = generateDeadlines([
    { id: "vat", frequency: "monthly", due: { rule: "relative-to-period-end", months: 1, day: 25 } },
    { id: "manual", frequency: "annual", due: { rule: "manual" } },
  ], { today: "2026-10-18" });
  assert.equal(deadlines[0].dueDate, "2026-07-25");
  assert.equal(deadlines.at(-1).dueDate, "2027-09-25");
  assert.deepEqual(needs, { manual: "date" });
  assert.equal(deadlineState("2026-10-01", "2026-10-18"), "overdue");
  assert.equal(deadlineState("2026-10-25", "2026-10-18"), "due-soon");
  assert.equal(deadlineState("2026-12-25", "2026-10-18"), "upcoming");
  assert.equal(deadlineState("2026-10-01", "2026-10-18", { done: true }), "done");
});

test("a deadline does not move with the computer's time zone", () => {
  const original = process.env.TZ;
  try {
    const obligation = { id: "q", frequency: "quarterly", due: { rule: "relative-to-period-end", months: 1, day: 25 } };
    process.env.TZ = "Pacific/Kiritimati";
    const east = dates(obligation);
    process.env.TZ = "Pacific/Pago_Pago";
    assert.deepEqual(dates(obligation), east);
  } finally {
    process.env.TZ = original;
  }
});
