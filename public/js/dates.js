// Date helpers shared by the browser and the Node tests.
//
// Two kinds of value go through here:
// - Calendar dates ("YYYY-MM-DD"). They name a day, not an instant, so all the
//   maths runs on Date.UTC values and the computer's own time zone never shifts
//   a date by one.
// - Instants (ISO stamps such as "2026-10-17T08:30:00.000Z"). They are shown in
//   the app's time zone with Intl.DateTimeFormat.
//
// UMD: browsers get window.StartupTrackerDates, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerDates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const formatterCache = new Map();

  function pad(value, length = 2) {
    return String(value).padStart(length, "0");
  }

  // { year, month (1-12), day } for a valid "YYYY-MM-DD", otherwise null.
  // A leading date in a longer stamp ("2026-10-17T10:00") is accepted too.
  function parseParts(value) {
    if (typeof value !== "string") return null;
    const match = DATE_PATTERN.exec(value.slice(0, 10));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function isDateString(value) {
    return typeof value === "string" && value.length === 10 && parseParts(value) !== null;
  }

  function isTimeString(value) {
    return typeof value === "string" && TIME_PATTERN.test(value);
  }

  // Number of days in a month (month is 1-12).
  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function fromParts(year, month, day) {
    // Date.UTC handles years before 100 as 1900+year; setUTCFullYear does not.
    const date = new Date(Date.UTC(2000, 0, 1));
    date.setUTCFullYear(year, month - 1, day);
    return toDateString(date);
  }

  // A Date at midnight UTC of the given calendar date, or null.
  function toUtcDate(value) {
    const parts = parseParts(value);
    if (!parts) return null;
    const date = new Date(Date.UTC(2000, 0, 1));
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    return date;
  }

  // The calendar date of a Date read in UTC ("YYYY-MM-DD").
  function toDateString(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function addDays(value, days) {
    const date = toUtcDate(value);
    if (!date) return "";
    date.setUTCDate(date.getUTCDate() + Math.trunc(Number(days) || 0));
    return toDateString(date);
  }

  // Adds whole months. A day that does not exist in the target month is clamped
  // to its last day: 31 Jan + 1 month is 28 or 29 Feb, never 2 or 3 March.
  function addMonths(value, months) {
    const parts = parseParts(value);
    if (!parts) return "";
    const total = parts.year * 12 + (parts.month - 1) + Math.trunc(Number(months) || 0);
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    return fromParts(year, month, Math.min(parts.day, daysInMonth(year, month)));
  }

  function addYears(value, years) {
    return addMonths(value, Math.trunc(Number(years) || 0) * 12);
  }

  // Whole days from a to b (positive when b is later), or NaN.
  function diffDays(a, b) {
    const start = toUtcDate(a);
    const end = toUtcDate(b);
    if (!start || !end) return Number.NaN;
    return Math.round((end.getTime() - start.getTime()) / DAY_MS);
  }

  // -1, 0 or 1. Valid "YYYY-MM-DD" strings sort correctly as text.
  function compareDates(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  // 0 = Sunday ... 6 = Saturday, like Date#getDay. -1 when invalid.
  function dayOfWeek(value) {
    const date = toUtcDate(value);
    return date ? date.getUTCDay() : -1;
  }

  // 1 = Monday ... 7 = Sunday (ISO 8601). 0 when invalid.
  function isoDayOfWeek(value) {
    const day = dayOfWeek(value);
    if (day < 0) return 0;
    return day === 0 ? 7 : day;
  }

  function mondayOfWeek(value) {
    const isoDay = isoDayOfWeek(value);
    if (!isoDay) return "";
    return addDays(value, 1 - isoDay);
  }

  function startOfMonth(value) {
    const parts = parseParts(value);
    return parts ? fromParts(parts.year, parts.month, 1) : "";
  }

  function endOfMonth(value) {
    const parts = parseParts(value);
    return parts ? fromParts(parts.year, parts.month, daysInMonth(parts.year, parts.month)) : "";
  }

  // ISO 8601 week number (weeks start on Monday; week 1 holds the first Thursday).
  function isoWeekNumber(value) {
    const isoDay = isoDayOfWeek(value);
    if (!isoDay) return 0;
    const thursday = addDays(value, 4 - isoDay);
    const yearStart = `${thursday.slice(0, 4)}-01-01`;
    return Math.floor(diffDays(yearStart, thursday) / 7) + 1;
  }

  // Milliseconds for a wall-clock date and time read as if it were UTC. Only
  // for ordering: it never depends on the computer's zone or on DST changes.
  function wallClockValue(value, time = "00:00") {
    const date = toUtcDate(value);
    if (!date) return Number.NaN;
    const match = TIME_PATTERN.exec(String(time || ""));
    if (match) date.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
    return date.getTime();
  }

  // ---- time zones ----

  function isValidTimeZone(timeZone) {
    if (!timeZone || typeof timeZone !== "string") return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(0);
      return true;
    } catch {
      return false;
    }
  }

  // The browser's own zone (what "Browser time zone" in Settings means), "UTC"
  // when the runtime cannot say.
  function defaultTimeZone() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (isValidTimeZone(zone)) return zone;
    } catch {
      // Fall through to UTC.
    }
    return "UTC";
  }

  function safeTimeZone(timeZone) {
    return isValidTimeZone(timeZone) ? timeZone : "UTC";
  }

  // A cached Intl.DateTimeFormat. Building one costs far more than using it.
  function getFormatter(locale, options = {}) {
    const key = `${locale || ""}|${JSON.stringify(options)}`;
    let formatter = formatterCache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale || undefined, options);
      if (formatterCache.size >= 256) formatterCache.clear();
      formatterCache.set(key, formatter);
    }
    return formatter;
  }

  function toInstant(value) {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // { date: "YYYY-MM-DD", time: "HH:MM" } of an instant as seen in timeZone.
  function partsIn(instant, timeZone) {
    const date = toInstant(instant);
    if (!date) return { date: "", time: "" };
    const parts = getFormatter("en-US", {
      timeZone: safeTimeZone(timeZone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const lookup = {};
    for (const part of parts) lookup[part.type] = part.value;
    // Some engines still print midnight as 24 with h23; normalise it.
    const hour = lookup.hour === "24" ? "00" : lookup.hour;
    return {
      date: `${pad(lookup.year, 4)}-${lookup.month}-${lookup.day}`,
      time: `${hour}:${lookup.minute}`,
    };
  }

  // Today's calendar date in timeZone. `now` is for tests.
  function todayIn(timeZone, now = new Date()) {
    return partsIn(now, timeZone).date;
  }

  // Current date and time ("HH:MM") in timeZone. `now` is for tests.
  function nowPartsIn(timeZone, now = new Date()) {
    return partsIn(now, timeZone);
  }

  // ---- formatting ----

  // Formats a calendar date. The date is pinned to UTC on both sides, so the
  // weekday and day number are the ones written in the string, everywhere.
  function formatDate(value, locale, options = { year: "numeric", month: "short", day: "2-digit" }) {
    const date = toUtcDate(value);
    if (!date) return "";
    return getFormatter(locale, { ...options, timeZone: "UTC" }).format(date);
  }

  // Formats an instant in timeZone.
  function formatInstant(value, locale, timeZone, options = { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) {
    const date = toInstant(value);
    if (!date) return "";
    return getFormatter(locale, { ...options, timeZone: safeTimeZone(timeZone) }).format(date);
  }

  // ---- the user's date format and week start (Settings > General) ----

  // "system" follows the interface locale; the others are fixed patterns.
  const DATE_FORMATS = Object.freeze(["system", "d MMM yyyy", "MMM d, yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy"]);
  // The settings.general.dateFormats.* key that names each format.
  const DATE_FORMAT_KEYS = Object.freeze({
    system: "system",
    "d MMM yyyy": "short",
    "MMM d, yyyy": "monthFirst",
    "yyyy-MM-dd": "iso",
    "dd/MM/yyyy": "daySlash",
    "MM/dd/yyyy": "monthSlash",
    "dd.MM.yyyy": "dayDot",
  });
  const WEEK_STARTS = Object.freeze(["monday", "sunday", "saturday"]);
  const WEEKDAY_INDEX = Object.freeze({ sunday: 0, monday: 1, saturday: 6 });
  const SYSTEM_DATE_OPTIONS = Object.freeze({ year: "numeric", month: "short", day: "2-digit" });

  function normalizeDateFormat(format) {
    return DATE_FORMATS.includes(format) ? format : "system";
  }

  function normalizeWeekStart(weekStart) {
    return WEEK_STARTS.includes(weekStart) ? weekStart : "monday";
  }

  // A calendar date in one of DATE_FORMATS: "15 Oct 2026", "Oct 15, 2026",
  // "2026-10-15", "15/10/2026", "10/15/2026", "15.10.2026" or the locale's
  // own short form.
  function formatDateAs(value, locale, format) {
    const parts = parseParts(value);
    if (!parts) return "";
    const pattern = normalizeDateFormat(format);
    const [year, month, day] = [pad(parts.year, 4), pad(parts.month), pad(parts.day)];
    if (pattern === "yyyy-MM-dd") return `${year}-${month}-${day}`;
    if (pattern === "dd/MM/yyyy") return `${day}/${month}/${year}`;
    if (pattern === "MM/dd/yyyy") return `${month}/${day}/${year}`;
    if (pattern === "dd.MM.yyyy") return `${day}.${month}.${year}`;
    if (pattern === "d MMM yyyy" || pattern === "MMM d, yyyy") {
      const name = formatDate(value, locale, { month: "short" }).replace(/\.$/, "");
      return pattern === "d MMM yyyy" ? `${parts.day} ${name} ${parts.year}` : `${name} ${parts.day}, ${parts.year}`;
    }
    return formatDate(value, locale, SYSTEM_DATE_OPTIONS);
  }

  // An instant with its time (24-hour clock) in timeZone, the date part in
  // one of DATE_FORMATS. `seconds` adds them to the time.
  function formatInstantAs(value, locale, timeZone, format, { seconds = false } = {}) {
    const date = toInstant(value);
    if (!date) return "";
    const pattern = normalizeDateFormat(format);
    if (pattern === "system") {
      return formatInstant(date, locale, timeZone, {
        ...SYSTEM_DATE_OPTIONS,
        hour: "2-digit",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
        hourCycle: "h23",
      });
    }
    const parts = partsIn(date, timeZone);
    let time = parts.time;
    if (seconds) {
      const second = getFormatter("en-US", { timeZone: safeTimeZone(timeZone), second: "2-digit" }).format(date);
      time = `${time}:${pad(Number(second) || 0)}`;
    }
    return `${formatDateAs(parts.date, locale, pattern)} ${time}`;
  }

  // The first day of the week holding value: its Monday, Sunday or Saturday.
  function startOfWeek(value, weekStart = "monday") {
    const day = dayOfWeek(value);
    if (day < 0) return "";
    const offset = (day - WEEKDAY_INDEX[normalizeWeekStart(weekStart)] + 7) % 7;
    return addDays(value, -offset);
  }

  return Object.freeze({
    DAY_MS,
    isDateString,
    isTimeString,
    parseParts,
    daysInMonth,
    toUtcDate,
    toDateString,
    addDays,
    addMonths,
    addYears,
    diffDays,
    compareDates,
    dayOfWeek,
    isoDayOfWeek,
    mondayOfWeek,
    startOfMonth,
    endOfMonth,
    isoWeekNumber,
    wallClockValue,
    isValidTimeZone,
    defaultTimeZone,
    getFormatter,
    partsIn,
    todayIn,
    nowPartsIn,
    formatDate,
    formatInstant,
    DATE_FORMATS,
    DATE_FORMAT_KEYS,
    WEEK_STARTS,
    normalizeDateFormat,
    normalizeWeekStart,
    formatDateAs,
    formatInstantAs,
    startOfWeek,
  });
});
