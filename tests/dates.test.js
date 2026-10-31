const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const datesPath = path.join(__dirname, "..", "public", "js", "dates.js");
const Dates = require(datesPath);

// The same date maths run in a child process per zone. Every result must be the
// same in all of them, and equal to the expected value.
const ZONES = ["Asia/Tokyo", "America/Los_Angeles", "Europe/Bucharest"];

const CASES = [
  // Day steps across month ends, year ends and leap days.
  ["addDays", ["2024-02-28", 1], "2024-02-29"],
  ["addDays", ["2024-02-29", 1], "2024-03-01"],
  ["addDays", ["2023-02-28", 1], "2023-03-01"],
  ["addDays", ["2026-12-31", 1], "2027-01-01"],
  ["addDays", ["2026-03-01", -1], "2026-02-28"],
  ["addDays", ["2026-10-17", 0], "2026-10-17"],
  ["addDays", ["2026-10-17", 365], "2027-10-17"],
  // Daylight-saving change days: Bucharest 29 March and 25 October 2026,
  // Los Angeles 8 March and 1 November 2026.
  ["addDays", ["2026-03-28", 1], "2026-03-29"],
  ["addDays", ["2026-03-29", 1], "2026-03-30"],
  ["addDays", ["2026-10-25", 1], "2026-10-26"],
  ["addDays", ["2026-10-26", -1], "2026-10-25"],
  ["addDays", ["2026-03-08", 1], "2026-03-09"],
  ["addDays", ["2026-11-01", 1], "2026-11-02"],
  ["addDays", ["2026-11-02", -2], "2026-10-31"],
  ["diffDays", ["2026-03-28", "2026-03-30"], 2],
  ["diffDays", ["2026-10-24", "2026-10-26"], 2],
  ["diffDays", ["2026-03-07", "2026-03-09"], 2],
  ["diffDays", ["2026-11-01", "2026-10-31"], -1],
  ["diffDays", ["2024-01-01", "2025-01-01"], 366],
  ["diffDays", ["2026-01-01", "2027-01-01"], 365],
  // Months clamp to the last day of the target month.
  ["addMonths", ["2026-01-31", 1], "2026-02-28"],
  ["addMonths", ["2024-01-31", 1], "2024-02-29"],
  ["addMonths", ["2026-03-31", -1], "2026-02-28"],
  ["addMonths", ["2026-05-31", 1], "2026-06-30"],
  ["addMonths", ["2026-12-15", 1], "2027-01-15"],
  ["addMonths", ["2026-01-15", -13], "2024-12-15"],
  ["addMonths", ["2024-02-29", 12], "2025-02-28"],
  ["addYears", ["2024-02-29", 4], "2028-02-29"],
  ["addYears", ["2024-02-29", 1], "2025-02-28"],
  // Weekdays and weeks.
  ["dayOfWeek", ["2026-10-17"], 6],
  ["dayOfWeek", ["2026-10-18"], 0],
  ["dayOfWeek", ["2026-03-29"], 0],
  ["isoDayOfWeek", ["2026-10-18"], 7],
  ["mondayOfWeek", ["2026-10-17"], "2026-10-12"],
  ["mondayOfWeek", ["2026-10-12"], "2026-10-12"],
  ["mondayOfWeek", ["2026-10-18"], "2026-10-12"],
  ["mondayOfWeek", ["2026-03-29"], "2026-03-23"],
  ["mondayOfWeek", ["2026-11-01"], "2026-10-26"],
  ["mondayOfWeek", ["2026-03-01"], "2026-02-23"],
  ["isoWeekNumber", ["2026-01-01"], 1],
  ["isoWeekNumber", ["2021-01-03"], 53],
  ["isoWeekNumber", ["2024-12-30"], 1],
  ["isoWeekNumber", ["2020-12-31"], 53],
  ["isoWeekNumber", ["2026-10-17"], 42],
  // Month bounds, including century leap rules.
  ["startOfMonth", ["2024-02-10"], "2024-02-01"],
  ["endOfMonth", ["2024-02-10"], "2024-02-29"],
  ["endOfMonth", ["2026-02-10"], "2026-02-28"],
  ["endOfMonth", ["2100-02-10"], "2100-02-28"],
  ["endOfMonth", ["2000-02-01"], "2000-02-29"],
  ["endOfMonth", ["2026-12-05"], "2026-12-31"],
  ["daysInMonth", [2024, 2], 29],
  ["daysInMonth", [2026, 4], 30],
  // Validation: impossible dates are refused rather than rolled over.
  ["isDateString", ["2024-02-29"], true],
  ["isDateString", ["2026-02-29"], false],
  ["isDateString", ["2026-13-01"], false],
  ["isDateString", ["2026-1-5"], false],
  ["isDateString", ["2026-10-17T10:00"], false],
  ["addDays", ["2026-02-30", 1], ""],
  ["addMonths", ["not a date", 1], ""],
  ["diffDays", ["2026-02-30", "2026-03-01"], null],
  ["mondayOfWeek", [""], ""],
  // Wall-clock sort keys do not move with the zone or DST.
  ["wallClockValue", ["2026-03-29", "03:30"], Date.UTC(2026, 2, 29, 3, 30)],
  ["wallClockValue", ["2026-10-25", "00:00"], Date.UTC(2026, 9, 25)],
  // Date-only formatting shows the day written in the string.
  ["formatDate", ["2026-10-17", "en", { weekday: "long", day: "numeric", month: "long", year: "numeric" }], "Saturday, October 17, 2026"],
  ["formatDate", ["2026-03-29", "en", { weekday: "short" }], "Sun"],
  ["formatDate", ["2026-01-01", "en", { month: "short" }], "Jan"],
];

// Instants checked in fixed zones: the process zone must not matter either.
const INSTANT_CASES = [
  // 22:30 UTC on 17 October 2026 is already the 18th in Bucharest and Tokyo.
  ["nowPartsIn", ["Europe/Bucharest", "2026-10-17T22:30:00Z"], { date: "2026-10-18", time: "01:30" }],
  ["nowPartsIn", ["Asia/Tokyo", "2026-10-17T22:30:00Z"], { date: "2026-10-18", time: "07:30" }],
  ["nowPartsIn", ["America/Los_Angeles", "2026-10-17T22:30:00Z"], { date: "2026-10-17", time: "15:30" }],
  ["nowPartsIn", ["UTC", "2026-10-17T22:30:00Z"], { date: "2026-10-17", time: "22:30" }],
  // Midnight reads as 00:00, never 24:00.
  ["nowPartsIn", ["Europe/Bucharest", "2026-10-17T21:00:00Z"], { date: "2026-10-18", time: "00:00" }],
  // Bucharest moves its clocks from 03:00 to 04:00 at 01:00 UTC on 29 March 2026.
  ["nowPartsIn", ["Europe/Bucharest", "2026-03-29T00:59:00Z"], { date: "2026-03-29", time: "02:59" }],
  ["nowPartsIn", ["Europe/Bucharest", "2026-03-29T01:00:00Z"], { date: "2026-03-29", time: "04:00" }],
  // Los Angeles goes back from 02:00 to 01:00 at 09:00 UTC on 1 November 2026.
  ["nowPartsIn", ["America/Los_Angeles", "2026-11-01T08:30:00Z"], { date: "2026-11-01", time: "01:30" }],
  ["nowPartsIn", ["America/Los_Angeles", "2026-11-01T09:30:00Z"], { date: "2026-11-01", time: "01:30" }],
  ["todayIn", ["Asia/Tokyo", "2026-10-17T15:00:00Z"], "2026-10-18"],
  ["todayIn", ["Asia/Tokyo", "2026-10-17T14:59:00Z"], "2026-10-17"],
  ["todayIn", ["America/Los_Angeles", "2026-10-18T06:59:00Z"], "2026-10-17"],
  ["todayIn", ["America/Los_Angeles", "2026-10-18T07:00:00Z"], "2026-10-18"],
  // An unknown zone falls back to UTC instead of throwing.
  ["todayIn", ["Not/AZone", "2026-10-17T23:59:00Z"], "2026-10-17"],
];

function childScript() {
  return `
    const Dates = require(${JSON.stringify(datesPath)});
    const cases = ${JSON.stringify(CASES)};
    const instantCases = ${JSON.stringify(INSTANT_CASES)};
    const results = cases.map(([name, args]) => {
      const value = Dates[name](...args);
      return typeof value === "number" && Number.isNaN(value) ? null : value;
    });
    const instants = instantCases.map(([name, [zone, at]]) => Dates[name](zone, new Date(at)));
    const legacyLocalMidnight = new Date("2026-10-17T00:00:00").toISOString();
    process.stdout.write(JSON.stringify({
      results,
      instants,
      defaultTimeZone: Dates.defaultTimeZone(),
      legacyLocalMidnight,
    }));
  `;
}

function runInZone(timeZone) {
  const output = execFileSync(process.execPath, ["-e", childScript()], {
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("date maths gives the same answers in Tokyo, Los Angeles and Bucharest", () => {
  const runs = ZONES.map((zone) => ({ zone, ...runInZone(zone) }));
  // The child processes really did run in different zones: the old approach
  // (local midnight) lands on three different instants.
  const localMidnights = new Set(runs.map((run) => run.legacyLocalMidnight));
  assert.equal(localMidnights.size, ZONES.length, "each child process must run in its own zone");

  for (const run of runs) {
    assert.equal(run.defaultTimeZone, run.zone, "the default zone is the computer's own");
    CASES.forEach(([name, args, expected], index) => {
      assert.deepEqual(run.results[index], expected, `${name}(${JSON.stringify(args)}) in ${run.zone}`);
    });
    INSTANT_CASES.forEach(([name, args, expected], index) => {
      assert.deepEqual(run.instants[index], expected, `${name}(${JSON.stringify(args)}) in ${run.zone}`);
    });
  }
});

test("todayIn and nowPartsIn use the given instant and zone", () => {
  const instant = new Date("2026-10-17T22:30:00Z");
  assert.equal(Dates.todayIn("Asia/Tokyo", instant), "2026-10-18");
  assert.equal(Dates.todayIn("America/Los_Angeles", instant), "2026-10-17");
  assert.deepEqual(Dates.nowPartsIn("Europe/Bucharest", instant), { date: "2026-10-18", time: "01:30" });
  // Without an instant they read the clock.
  assert.match(Dates.todayIn("UTC"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(Dates.nowPartsIn("UTC").time, /^\d{2}:\d{2}$/);
  assert.deepEqual(Dates.partsIn("not a date", "UTC"), { date: "", time: "" });
});

test("instants format in the requested zone and locale", () => {
  const instant = "2026-10-17T22:30:00Z";
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  assert.equal(Dates.formatInstant(instant, "en", "Asia/Tokyo", options), "07:30");
  assert.equal(Dates.formatInstant(instant, "en", "America/Los_Angeles", options), "15:30");
  assert.equal(Dates.formatInstant(instant, "en", "UTC", { day: "numeric", month: "long", year: "numeric" }), "October 17, 2026");
  assert.equal(Dates.formatInstant("", "en", "UTC"), "");
  assert.equal(Dates.formatDate("2026-02-30", "en"), "");
  // Formatters are cached, so asking twice returns the same object.
  assert.equal(Dates.getFormatter("en", { month: "short" }), Dates.getFormatter("en", { month: "short" }));
});

test("time zone names are checked", () => {
  assert.equal(Dates.isValidTimeZone("Europe/Bucharest"), true);
  assert.equal(Dates.isValidTimeZone("UTC"), true);
  assert.equal(Dates.isValidTimeZone("Not/AZone"), false);
  assert.equal(Dates.isValidTimeZone(""), false);
  assert.ok(Dates.isValidTimeZone(Dates.defaultTimeZone()));
});

test("dates follow the chosen format (Settings > General)", () => {
  assert.deepEqual([...Dates.DATE_FORMATS], ["system", "d MMM yyyy", "MMM d, yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy"]);
  // The server accepts the same formats and week starts.
  const ServerSettings = require("../lib/settings.js");
  assert.deepEqual(ServerSettings.DATE_FORMATS, [...Dates.DATE_FORMATS]);
  assert.deepEqual(ServerSettings.WEEK_STARTS, [...Dates.WEEK_STARTS]);
  assert.deepEqual(Object.keys(Dates.DATE_FORMAT_KEYS), [...Dates.DATE_FORMATS]);
  assert.equal(Dates.formatDateAs("2026-10-15", "en", "d MMM yyyy"), "15 Oct 2026");
  assert.equal(Dates.formatDateAs("2026-10-05", "en", "d MMM yyyy"), "5 Oct 2026");
  assert.equal(Dates.formatDateAs("2026-10-05", "en", "MMM d, yyyy"), "Oct 5, 2026");
  assert.equal(Dates.formatDateAs("2026-10-15", "en", "yyyy-MM-dd"), "2026-10-15");
  assert.equal(Dates.formatDateAs("2026-10-05", "en", "dd/MM/yyyy"), "05/10/2026");
  assert.equal(Dates.formatDateAs("2026-10-05", "en", "MM/dd/yyyy"), "10/05/2026");
  assert.equal(Dates.formatDateAs("2026-10-05", "en", "dd.MM.yyyy"), "05.10.2026");
  assert.equal(Dates.formatInstantAs("2026-10-15T22:30:05.000Z", "en", "UTC", "dd.MM.yyyy"), "15.10.2026 22:30");
  assert.equal(Dates.formatDateAs("2026-10-15", "en-US", "system"), Dates.formatDate("2026-10-15", "en-US", { year: "numeric", month: "short", day: "2-digit" }));
  assert.equal(Dates.formatDateAs("2026-10-15", "en", "bogus"), Dates.formatDateAs("2026-10-15", "en", "system"));
  assert.equal(Dates.formatDateAs("not a date", "en", "yyyy-MM-dd"), "");
  // An instant is read in the chosen zone before its date is formatted.
  const instant = "2026-10-15T22:30:05.000Z";
  assert.equal(Dates.formatInstantAs(instant, "en", "Asia/Tokyo", "yyyy-MM-dd"), "2026-10-16 07:30");
  assert.equal(Dates.formatInstantAs(instant, "en", "America/Los_Angeles", "d MMM yyyy"), "15 Oct 2026 15:30");
  assert.equal(Dates.formatInstantAs(instant, "en", "UTC", "yyyy-MM-dd", { seconds: true }), "2026-10-15 22:30:05");
  assert.match(Dates.formatInstantAs(instant, "en", "UTC", "system"), /2026.*22:30/);
  assert.equal(Dates.formatInstantAs("", "en", "UTC", "system"), "");
});

test("weeks start on Monday, Sunday or Saturday", () => {
  assert.equal(Dates.startOfWeek("2026-10-17", "monday"), "2026-10-12");
  assert.equal(Dates.startOfWeek("2026-10-18", "monday"), "2026-10-12");
  assert.equal(Dates.startOfWeek("2026-10-17", "sunday"), "2026-10-11");
  assert.equal(Dates.startOfWeek("2026-10-18", "sunday"), "2026-10-18");
  assert.equal(Dates.startOfWeek("2026-03-01", "sunday"), "2026-03-01");
  assert.equal(Dates.startOfWeek("2027-01-01", "sunday"), "2026-12-27");
  assert.equal(Dates.startOfWeek("2026-10-17", "saturday"), "2026-10-17");
  assert.equal(Dates.startOfWeek("2026-10-18", "saturday"), "2026-10-17");
  assert.equal(Dates.startOfWeek("2026-10-16", "saturday"), "2026-10-10");
  assert.equal(Dates.normalizeWeekStart("saturday"), "saturday");
  assert.equal(Dates.startOfWeek("2026-10-18"), "2026-10-12", "Monday is the default");
  assert.equal(Dates.startOfWeek("2026-10-18", "friday"), "2026-10-12");
  assert.equal(Dates.startOfWeek("nope", "sunday"), "");
  assert.equal(Dates.normalizeWeekStart("sunday"), "sunday");
  assert.equal(Dates.normalizeWeekStart(""), "monday");
});
