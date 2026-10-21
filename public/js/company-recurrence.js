// Deadlines from a company template's obligations. Each obligation says how
// often it recurs and how its due date follows from a period or a date; this
// turns that into dated occurrences inside a window, by default the next 12
// months plus the last three (so recent missed ones still show as overdue).
//
// Dates are plain "YYYY-MM-DD" strings and all arithmetic is on the calendar,
// in UTC, so a deadline never moves with the computer's time zone. Overdue is
// worked out from the date when it is shown, never stored.
//
// UMD: browsers get window.StartupTrackerCompanyRecurrence, Node gets
// module.exports (lib/company/recurrence.js re-exports it).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerCompanyRecurrence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function parse(date) {
    const match = DATE.exec(String(date || ""));
    if (!match) throw new RangeError(`Not a date: ${date}`);
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  function format({ year, month, day }) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Month arithmetic that keeps the year right: addMonths(2026, 11, 3) is
  // February 2027.
  function addMonths(year, month, count) {
    const index = year * 12 + (month - 1) + count;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
  }

  // A day in a month: a number past the month's end means its last day, as
  // does "last". "same" takes the given reference day.
  function dayIn(year, month, day, sameDay) {
    const last = daysInMonth(year, month);
    if (day === "last") return last;
    if (day === "same") return Math.min(sameDay ?? last, last);
    const value = Number(day);
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`Not a day of the month: ${day}`);
    return Math.min(value, last);
  }

  function addDays(date, days) {
    const { year, month, day } = parse(date);
    const moved = new Date(Date.UTC(year, month - 1, day + days));
    return format({ year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() });
  }

  const PERIOD_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

  // Calendar periods (months, quarters or years) that could produce a due date
  // inside the window. A due rule can push the date up to a few years past the
  // period, so the scan starts well before the window.
  function* periods(frequency, fromYear, toYear) {
    const length = PERIOD_MONTHS[frequency];
    if (!length) return;
    for (let year = fromYear; year <= toYear; year += 1) {
      for (let start = 1; start <= 12; start += length) {
        const end = start + length - 1;
        yield { start: format({ year, month: start, day: 1 }), end: format({ year, month: end, day: daysInMonth(year, end) }), year, startMonth: start, endMonth: end };
      }
    }
  }

  function applies(obligation, context) {
    const active = new Set(context.conditions || []);
    if ((obligation.conditions || []).some((condition) => !active.has(condition))) return false;
    const subdivisions = obligation.subdivisions || [];
    if (subdivisions.length && !subdivisions.includes(context.subdivision)) return false;
    return true;
  }

  // The occurrences of one obligation inside [from, to]. Rules that cannot be
  // dated from the template alone ("manual", "relative-to-event", or an
  // anniversary without an incorporation date) produce none; `needs` says what
  // is missing so the page can ask for it.
  function occurrencesOf(obligation, context = {}) {
    const from = context.from;
    const to = context.to;
    parse(from);
    parse(to);
    const result = { occurrences: [], needs: null };
    if (!applies(obligation, context)) return result;
    const due = obligation.due || { rule: "manual" };
    const fromYear = parse(from).year - 3;
    const toYear = parse(to).year + 1;
    const inWindow = (date) => date >= from && date <= to;
    const push = (dueDate, period) => {
      if (inWindow(dueDate)) result.occurrences.push({ obligationId: obligation.id, dueDate, periodStart: period?.start || "", periodEnd: period?.end || "" });
    };

    switch (due.rule) {
      case "relative-to-period-end":
      case "relative-to-period-start": {
        for (const period of periods(obligation.frequency, fromYear, toYear)) {
          const anchor = due.rule === "relative-to-period-end" ? period.endMonth : period.startMonth;
          const target = addMonths(period.year, anchor, Number(due.months) || 0);
          push(format({ ...target, day: dayIn(target.year, target.month, due.day ?? "last") }), period);
        }
        break;
      }
      case "relative-to-fiscal-year-end": {
        const [endMonth, endDay] = String(context.fiscalYearEnd || "12-31").split("-").map(Number);
        for (let year = fromYear; year <= toYear; year += 1) {
          const yearEnd = format({ year, month: endMonth, day: Math.min(endDay, daysInMonth(year, endMonth)) });
          const target = addMonths(year, endMonth, Number(due.months) || 0);
          const startMonth = addMonths(year, endMonth, -11);
          push(format({ ...target, day: dayIn(target.year, target.month, due.day ?? "last", endDay) }), {
            start: format({ ...startMonth, day: 1 }),
            end: yearEnd,
          });
        }
        break;
      }
      case "relative-to-anniversary": {
        if (!context.incorporationDate) {
          result.needs = "incorporationDate";
          break;
        }
        const founded = parse(context.incorporationDate);
        for (let year = Math.max(fromYear, founded.year + 1); year <= toYear; year += 1) {
          const anniversary = format({ year, month: founded.month, day: Math.min(founded.day, daysInMonth(year, founded.month)) });
          const moved = addMonths(year, founded.month, Number(due.months) || 0);
          const base = format({ ...moved, day: Math.min(founded.day, daysInMonth(moved.year, moved.month)) });
          push(addDays(base, Number(due.days) || 0), { start: anniversary, end: anniversary });
        }
        break;
      }
      case "fixed-date": {
        if (obligation.frequency === "monthly") {
          for (let year = fromYear; year <= toYear; year += 1) {
            for (let month = 1; month <= 12; month += 1) push(format({ year, month, day: dayIn(year, month, due.day) }));
          }
        } else {
          for (let year = fromYear; year <= toYear; year += 1) push(format({ year, month: due.month, day: dayIn(year, due.month, due.day) }));
        }
        break;
      }
      case "relative-to-event":
        result.needs = "event";
        break;
      case "manual":
        result.needs = "date";
        break;
      default:
        throw new RangeError(`Unknown due rule: ${due.rule}`);
    }

    if (obligation.frequency === "once") result.occurrences = result.occurrences.slice(0, 1);
    result.occurrences.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return result;
  }

  // The default window: three months back and twelve ahead of today.
  function defaultWindow(today) {
    const { year, month, day } = parse(today);
    const back = addMonths(year, month, -3);
    const ahead = addMonths(year, month, 12);
    return {
      from: format({ ...back, day: Math.min(day, daysInMonth(back.year, back.month)) }),
      to: format({ ...ahead, day: Math.min(day, daysInMonth(ahead.year, ahead.month)) }),
    };
  }

  // Every occurrence of every obligation, sorted by date.
  function generateDeadlines(obligations, context = {}) {
    const window = context.from && context.to ? { from: context.from, to: context.to } : defaultWindow(context.today);
    const deadlines = [];
    const needs = {};
    for (const obligation of obligations || []) {
      const { occurrences, needs: missing } = occurrencesOf(obligation, { ...context, ...window });
      deadlines.push(...occurrences);
      if (missing) needs[obligation.id] = missing;
    }
    deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligationId.localeCompare(b.obligationId));
    return { ...window, deadlines, needs };
  }

  // "overdue" when the date has passed and it is not done, "due-soon" within
  // `soonDays`, otherwise "upcoming". Done is the caller's knowledge.
  function deadlineState(dueDate, today, { done = false, soonDays = 14 } = {}) {
    if (done) return "done";
    if (dueDate < today) return "overdue";
    if (dueDate <= addDays(today, soonDays)) return "due-soon";
    return "upcoming";
  }

  return Object.freeze({ generateDeadlines, occurrencesOf, deadlineState, defaultWindow, addMonths, addDays, daysInMonth });
});
