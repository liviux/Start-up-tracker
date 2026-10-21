// What the calendar shows, worked out without the page: the dated moments of
// each record, the month grid, the per-day counts and the summary table. The
// page (app.js) and the server's "all startups" calendar (lib/combined.js)
// both read events from here, so the two never disagree about which dates a
// record has. The tests run it in Node.
//
// UMD: browsers get window.StartupTrackerCalendar, Node gets module.exports.
(function (root, factory) {
  const dates = root.StartupTrackerDates || (typeof module === "object" && module.require ? module.require("./dates.js") : null);
  const api = factory(dates);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerCalendar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Dates) {
  "use strict";

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const SECTION_IDS = ["mk", "po", "fu", "comp"];

  // Event types the calendar can filter by. Campaign dates are off until
  // they are turned on.
  const EVENT_KINDS = Object.freeze([
    { id: "next_action", standard: true },
    { id: "deadline", standard: true },
    { id: "milestone", standard: true },
    { id: "payment", standard: true },
    { id: "company", standard: true },
    { id: "campaign", standard: false },
  ].map((kind) => Object.freeze(kind)));

  function defaultKinds() {
    return new Set(EVENT_KINDS.filter((kind) => kind.standard).map((kind) => kind.id));
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function firstText(record, keys) {
    for (const key of keys) {
      const value = text(record?.[key]);
      if (value) return value;
    }
    return "";
  }

  function amountText(entry) {
    const amount = Number(entry?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return "";
    return `${text(entry.currency) || ""} ${amount.toLocaleString("en-US")}`.trim();
  }

  // A date ("2026-10-19") and time ("09:30") from a date, or from a
  // "2026-10-19T09:30" stamp.
  function splitDate(value, time = "") {
    const raw = text(value);
    if (!raw) return null;
    const [date, stampTime = ""] = raw.split("T");
    if (!DATE_PATTERN.test(date)) return null;
    return { date, time: text(time) || stampTime.slice(0, 5) };
  }

  // The dated moments of one record. `collection` is the state section it
  // lives in. Every event carries the record's id and status, the section it
  // belongs to, its type, and a label (the record) and detail (the moment).
  function recordEvents(collection, record) {
    if (!record || typeof record !== "object") return [];
    const events = [];
    const push = (section, kind, when, time, detail, extra = {}) => {
      const at = splitDate(when, time);
      if (!at) return;
      events.push({ id: String(record.id ?? ""), section, kind, date: at.date, time: at.time, label, detail: text(detail), status: text(record.status), ...extra });
    };
    let label = "";
    if (collection === "items") {
      label = firstText(record, ["platform", "title", "name"]) || String(record.id ?? "");
      push("mk", "next_action", record.date, record.time, record.nextAction);
    } else if (collection === "programs") {
      const details = record.details || {};
      label = firstText(record, ["name", "applicationName"]) || String(record.id ?? "");
      push("po", "next_action", record.nextActionDate, record.nextActionTime, record.nextAction || details.nextAction);
      if (details.actionDeadline && details.actionDeadline !== record.nextActionDate) push("po", "deadline", details.actionDeadline, "", "Action deadline");
      push("po", "deadline", details.submittedOn || details.submissionDate, "", "Submission");
      push("po", "milestone", details.interviewOn || details.interviewDate, "", "Interview");
      push("po", "milestone", details.pitchDate, "", "Pitch");
      push("po", "milestone", details.opensOn, "", "Opens");
      push("po", "milestone", details.decisionExpected, "", "Decision expected");
    } else if (collection === "funding") {
      label = firstText(record, ["funder", "opportunity", "name"]) || String(record.id ?? "");
      push("fu", "next_action", record.nextActionDate, record.nextActionTime, record.nextAction);
      push("fu", "deadline", record.expectedCloseDate, "", "Expected close");
      for (const payment of Array.isArray(record.payments) ? record.payments : []) {
        push("fu", "payment", payment?.date, "", ["Payment", amountText(payment)].filter(Boolean).join(" "), { entryStatus: text(payment?.status) });
      }
      for (const commitment of Array.isArray(record.commitments) ? record.commitments : []) {
        push("fu", "payment", commitment?.date, "", ["Commitment", amountText(commitment)].filter(Boolean).join(" "), { entryStatus: text(commitment?.status) });
      }
    }
    // Every target's deadline and its own milestones (the target window's
    // Details tab).
    const section = { items: "mk", programs: "po", funding: "fu" }[collection];
    if (section) {
      push(section, "deadline", record.deadline, "", "Deadline");
      for (const entry of Array.isArray(record.timeEntries) ? record.timeEntries : []) {
        push(section, "milestone", entry?.date, entry?.time, text(entry?.label) || "Milestone");
      }
    }
    if (collection === "campaigns") {
      label = firstText(record, ["name"]) || String(record.id ?? "");
      push("campaign", "campaign", record.startDate, "", "Starts");
      push("campaign", "campaign", record.endDate, "", "Ends");
    }
    return events;
  }

  // Company steps and deadlines are dated by js/company-model.js
  // (calendarEvents and calendarRecords), from the company template.

  // ---- filters and counts ------------------------------------------------

  // filters: { sections: Set, kinds: Set, matchesStatus(status) }. Campaign
  // dates follow their type only; their statuses are a separate list.
  function eventMatches(event, filters = {}) {
    if (filters.kinds && !filters.kinds.has(event.kind)) return false;
    if (event.section === "campaign") return true;
    if (filters.sections && !filters.sections.has(event.section)) return false;
    if (filters.matchesStatus && !filters.matchesStatus(event.status)) return false;
    return true;
  }

  function inRange(event, from, to) {
    return (!from || event.date >= from) && (!to || event.date <= to);
  }

  // { mk, po, fu, comp } for a list of events.
  function countBySection(events) {
    const counts = Object.fromEntries(SECTION_IDS.map((id) => [id, 0]));
    for (const event of events) if (event.section in counts) counts[event.section] += 1;
    return counts;
  }

  // How many events of one list fall in each status group.
  function countByGroup(events, groupOf) {
    const counts = {};
    for (const event of events) {
      const group = groupOf(event.status);
      counts[group] = (counts[group] || 0) + 1;
    }
    return counts;
  }

  // The summary table: per section, items per status group, the item total
  // and the event count. One target with three dates is one item and three
  // events.
  //   mode "range": items are the records with an event in `events` (already
  //     limited to the visible days).
  //   mode "all": items are every record in `records` whose status passes the
  //     filter, dated or not; `events` are all their filtered events.
  // Hidden sections keep their row (to switch them back on) but stay out of
  // the totals.
  function summarize({ mode = "range", events = [], records = {}, sections = new Set(SECTION_IDS), matchesStatus = () => true, groupOf, groupIds }) {
    const blank = () => Object.fromEntries([...groupIds.map((id) => [id, 0]), ["items", 0], ["events", 0]]);
    const rows = SECTION_IDS.map((id) => ({ section: id, hidden: !sections.has(id), counts: blank() }));
    const byId = Object.fromEntries(rows.map((row) => [row.section, row]));
    for (const event of events) {
      if (byId[event.section]) byId[event.section].counts.events += 1;
    }
    if (mode === "all") {
      for (const id of SECTION_IDS) {
        for (const record of records[id] || []) {
          if (!matchesStatus(record.status)) continue;
          byId[id].counts[groupOf(record.status)] += 1;
          byId[id].counts.items += 1;
        }
      }
    } else {
      const seen = new Set();
      for (const event of events) {
        const row = byId[event.section];
        if (!row) continue;
        const key = `${event.section}\u0000${event.startupId || ""}\u0000${event.parentId || event.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        row.counts[groupOf(event.status)] += 1;
        row.counts.items += 1;
      }
    }
    const total = blank();
    for (const row of rows) {
      if (row.hidden) continue;
      for (const key of Object.keys(total)) total[key] += row.counts[key];
    }
    return { rows, total };
  }

  // ---- month grid --------------------------------------------------------

  // Whole weeks covering the month of `date`: five or six rows (a February
  // that fills exactly four gets a fifth, so the panel keeps its height).
  function monthGrid(date, weekStart = "monday") {
    const first = Dates.startOfMonth(date);
    const last = Dates.endOfMonth(date);
    if (!first) return { month: "", first: "", last: "", weeks: [] };
    const weeks = [];
    let day = Dates.startOfWeek(first, weekStart);
    while (Dates.compareDates(day, last) <= 0 || weeks.length < 5) {
      const week = [];
      for (let index = 0; index < 7; index += 1) {
        week.push(day);
        day = Dates.addDays(day, 1);
      }
      weeks.push(week);
    }
    return { month: first.slice(0, 7), first, last, weeks };
  }

  return Object.freeze({
    SECTION_IDS,
    EVENT_KINDS,
    defaultKinds,
    recordEvents,
    eventMatches,
    inRange,
    countBySection,
    countByGroup,
    summarize,
    monthGrid,
  });
});
