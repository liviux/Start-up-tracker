// The Company section's data, worked out the same way in the browser and on
// the server (window.StartupTrackerCompany).
//
// A company template (content/company-templates/<id>.json) holds the text:
// setup steps, recurring obligations with their due rules, sources. What you
// do with them is yours and lives in the startup:
//   companyProfile      one object: template, subdivision, incorporation,
//                       fiscal year end, conditions, field values, people,
//                       monthly budget, document language
//   companySecrets      sensitive values (national ids, bank accounts,
//                       fields marked sensitive), read only by the page
//   companySteps        one record per step you touched or added
//   companyObligations  your own obligations, and notes on or switching off
//                       a template's
//   companyDeadlines    one record per deadline you touched (status, notes)
//   companyExpenses     expenses
// A template update changes only the text; your dates, statuses and history
// stay, because they are keyed by the template's step and obligation ids.
//
// UMD: browsers get window.StartupTrackerCompany, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerCompany = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const Recurrence = typeof module === "object" && module.exports
    ? module.require("./company-recurrence.js")
    : root.StartupTrackerCompanyRecurrence;

  const SECTIONS = Object.freeze({
    profile: "companyProfile",
    secrets: "companySecrets",
    steps: "companySteps",
    obligations: "companyObligations",
    deadlines: "companyDeadlines",
    expenses: "companyExpenses",
  });
  const RECURRING = Object.freeze(["", "monthly", "quarterly", "annual"]);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  // A bilingual template keeps { en, ro } objects; everything else is text.
  function textOf(value, language = "en") {
    if (value && typeof value === "object" && !Array.isArray(value)) return String(value[language] ?? value.en ?? Object.values(value)[0] ?? "");
    return value === null || value === undefined ? "" : String(value);
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  // The profile with every key present.
  function normalizeProfile(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const budget = Number(value.monthlyBudget);
    return {
      templateId: String(value.templateId || ""),
      subdivision: String(value.subdivision || ""),
      legalForm: String(value.legalForm || ""),
      countryName: String(value.countryName || ""),
      incorporated: value.incorporated !== false,
      incorporationDate: DATE.test(value.incorporationDate || "") ? value.incorporationDate : "",
      fiscalYearEnd: MONTH_DAY.test(value.fiscalYearEnd || "") ? value.fiscalYearEnd : "12-31",
      conditions: list(value.conditions).map(String),
      fields: value.fields && typeof value.fields === "object" && !Array.isArray(value.fields) ? { ...value.fields } : {},
      people: list(value.people).filter((person) => person && person.id).map((person) => ({
        id: String(person.id),
        role: String(person.role || ""),
        name: String(person.name || ""),
        ownershipPercent: person.ownershipPercent === null || person.ownershipPercent === undefined || person.ownershipPercent === "" ? null : Number(person.ownershipPercent),
        appointedOn: DATE.test(person.appointedOn || "") ? person.appointedOn : "",
      })),
      monthlyBudget: Number.isFinite(budget) && budget > 0 ? budget : null,
      documentLanguage: String(value.documentLanguage || ""),
    };
  }

  function normalizeSecrets(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      fields: value.fields && typeof value.fields === "object" && !Array.isArray(value.fields) ? { ...value.fields } : {},
      bankAccounts: list(value.bankAccounts).filter((account) => account && account.id).map((account) => ({
        id: String(account.id),
        label: String(account.label || ""),
        currency: String(account.currency || "").toUpperCase().slice(0, 3),
        account: String(account.account || ""),
      })),
      people: value.people && typeof value.people === "object" && !Array.isArray(value.people) ? { ...value.people } : {},
    };
  }

  // "1234 5678 9012" -> "•••• 9012". Nothing of a short value shows.
  function mask(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.length <= 6 ? "••••" : `•••• ${text.slice(-4)}`;
  }

  // Setup steps: the template's, each with your record when there is one,
  // then the ones you added.
  function steps(template, records, language) {
    const byTemplate = new Map(list(records).filter((record) => record.templateStepId).map((record) => [record.templateStepId, record]));
    const fromTemplate = list(template?.setupSteps).map((step) => {
      const record = byTemplate.get(step.id) || null;
      return {
        id: record?.id || `template:${step.id}`,
        templateStepId: step.id,
        custom: false,
        title: textOf(step.title, language),
        description: textOf(step.description, language),
        authority: textOf(step.authority, language),
        typicalCost: step.typicalCost || null,
        dependsOn: list(step.dependsOn),
        checkLocally: Boolean(step.checkLocally),
        sources: sourcesOf(template, step.sourceIds),
        status: record?.status || "",
        dueDate: record?.dueDate || "",
        doneOn: record?.doneOn || "",
        notes: record?.notes || "",
        record,
      };
    });
    const own = list(records).filter((record) => !record.templateStepId).map((record) => ({
      id: record.id,
      templateStepId: "",
      custom: true,
      title: String(record.title || ""),
      description: String(record.description || ""),
      authority: String(record.authority || ""),
      typicalCost: null,
      dependsOn: [],
      checkLocally: false,
      sources: [],
      status: record.status || "",
      dueDate: record.dueDate || "",
      doneOn: record.doneOn || "",
      notes: record.notes || "",
      record,
    }));
    return [...fromTemplate, ...own];
  }

  function sourcesOf(template, ids) {
    const byId = new Map(list(template?.sources).map((source) => [source.id, source]));
    return list(ids).map((id) => byId.get(id)).filter(Boolean);
  }

  // Obligations that apply to this company: the template's (unless you
  // switched one off, or its conditions or subdivisions do not match) and
  // your own.
  function obligations(template, profile, records, language) {
    const conditions = new Set(profile.conditions);
    const byTemplate = new Map(list(records).filter((record) => record.templateObligationId).map((record) => [record.templateObligationId, record]));
    const fromTemplate = list(template?.obligations).map((obligation) => {
      const record = byTemplate.get(obligation.id) || null;
      const missing = list(obligation.conditions).filter((id) => !conditions.has(id));
      const subdivisions = list(obligation.subdivisions);
      const elsewhere = subdivisions.length > 0 && !subdivisions.includes(profile.subdivision);
      return {
        id: obligation.id,
        custom: false,
        title: textOf(obligation.title, language),
        description: textOf(obligation.description, language),
        authority: textOf(obligation.authority, language),
        frequency: obligation.frequency,
        due: obligation.due,
        conditions: list(obligation.conditions),
        subdivisions,
        checkLocally: Boolean(obligation.checkLocally),
        sources: sourcesOf(template, obligation.sourceIds),
        applies: !missing.length && !elsewhere && !record?.disabled,
        missingConditions: missing,
        otherSubdivision: elsewhere,
        disabled: Boolean(record?.disabled),
        notes: record?.notes || "",
        record,
      };
    });
    const own = list(records).filter((record) => !record.templateObligationId).map((record) => ({
      id: record.id,
      custom: true,
      title: String(record.title || ""),
      description: String(record.description || ""),
      authority: String(record.authority || ""),
      frequency: record.frequency || "annual",
      due: record.due || { rule: "manual" },
      conditions: [],
      subdivisions: [],
      checkLocally: false,
      sources: [],
      applies: !record.disabled,
      missingConditions: [],
      otherSubdivision: false,
      disabled: Boolean(record.disabled),
      notes: record.notes || "",
      record,
    }));
    return [...fromTemplate, ...own];
  }

  function deadlineId(obligationId, dueDate) {
    return `${obligationId}@${dueDate}`;
  }

  // The deadlines of the obligations that apply, in the window around today,
  // each with your record when there is one. `isDone(status)` says which
  // statuses close a deadline.
  function deadlines(obligationList, profile, records, { today, from, to, isDone = () => false } = {}) {
    const applying = obligationList.filter((obligation) => obligation.applies);
    const generated = Recurrence.generateDeadlines(applying.map((obligation) => ({ ...obligation, conditions: [], subdivisions: [] })), {
      today,
      from,
      to,
      fiscalYearEnd: profile.fiscalYearEnd,
      incorporationDate: profile.incorporationDate,
    });
    const recordsById = new Map(list(records).map((record) => [String(record.id), record]));
    const titles = new Map(applying.map((obligation) => [obligation.id, obligation.title]));
    const items = generated.deadlines.map((occurrence) => {
      const id = deadlineId(occurrence.obligationId, occurrence.dueDate);
      const record = recordsById.get(id) || null;
      const status = record?.status || "";
      const done = Boolean(status) && isDone(status);
      return {
        id,
        obligationId: occurrence.obligationId,
        title: titles.get(occurrence.obligationId) || occurrence.obligationId,
        dueDate: occurrence.dueDate,
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        status,
        notes: record?.notes || "",
        doneOn: record?.doneOn || "",
        state: Recurrence.deadlineState(occurrence.dueDate, today, { done }),
        manual: false,
        record,
      };
    });
    // Dates you set yourself, for obligations the rules cannot date (on an
    // event, or "manual").
    const known = new Set(items.map((item) => item.id));
    for (const record of list(records)) {
      if (!record.manual || known.has(String(record.id)) || !titles.has(record.obligationId) || !DATE.test(record.dueDate || "")) continue;
      const done = Boolean(record.status) && isDone(record.status);
      items.push({
        id: String(record.id),
        obligationId: record.obligationId,
        title: titles.get(record.obligationId),
        dueDate: record.dueDate,
        periodStart: "",
        periodEnd: "",
        status: record.status || "",
        notes: record.notes || "",
        doneOn: record.doneOn || "",
        state: Recurrence.deadlineState(record.dueDate, today, { done }),
        manual: true,
        record,
      });
    }
    items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligationId.localeCompare(b.obligationId));
    return { items, needs: generated.needs, from: generated.from, to: generated.to };
  }

  // Everything the page and the calendar show, from the stored sections.
  // `template` may be null (no template picked, or it could not be read).
  function view(template, sections, { today, isDone, language } = {}) {
    const profile = normalizeProfile(sections?.[SECTIONS.profile]);
    const lang = language || profile.documentLanguage || "en";
    const stepList = steps(template, sections?.[SECTIONS.steps], lang);
    const obligationList = obligations(template, profile, sections?.[SECTIONS.obligations], lang);
    const deadlineList = profile.incorporated
      ? deadlines(obligationList, profile, sections?.[SECTIONS.deadlines], { today, isDone })
      : { items: [], needs: {}, from: "", to: "" };
    return { profile, steps: stepList, obligations: obligationList, deadlines: deadlineList };
  }

  // Calendar events: dated steps and deadlines, with their status.
  function calendarEvents(companyView, { defaultStatus = "" } = {}) {
    const events = [];
    for (const step of companyView?.steps || []) {
      if (!step.dueDate) continue;
      events.push({ id: `step:${step.templateStepId || step.id}`, parentId: step.id, parentKind: "step", section: "comp", kind: "company", date: step.dueDate, time: "", label: step.title, detail: "", status: step.status || defaultStatus, rawStatus: step.status || "" });
    }
    for (const deadline of companyView?.deadlines?.items || []) {
      events.push({ id: `deadline:${deadline.id}`, parentId: deadline.id, parentKind: "deadline", section: "comp", kind: "company", date: deadline.dueDate, time: "", label: deadline.title, detail: deadline.periodEnd ? `Period ending ${deadline.periodEnd}` : "", status: deadline.status || defaultStatus, rawStatus: deadline.status || "" });
    }
    return events;
  }

  // Steps and deadlines as records for the calendar's summary.
  function calendarRecords(companyView, { defaultStatus = "" } = {}) {
    return [
      ...(companyView?.steps || []).map((step) => ({ id: String(step.id), status: step.status || defaultStatus })),
      ...(companyView?.deadlines?.items || []).map((deadline) => ({ id: String(deadline.id), status: deadline.status || defaultStatus })),
    ];
  }

  // Expenses: monthly totals per currency, and this month's spending against
  // the budget (in the startup's currency only).
  function expenseSummary(expenses, { month, currency, budget } = {}) {
    const totals = {};
    let spent = 0;
    for (const expense of list(expenses)) {
      const amount = Number(expense.amount);
      if (!Number.isFinite(amount)) continue;
      const inMonth = monthlyShare(expense, month);
      if (!inMonth) continue;
      const code = String(expense.currency || currency || "").toUpperCase();
      totals[code] = (totals[code] || 0) + amount * inMonth;
      if (code === String(currency || "").toUpperCase()) spent += amount * inMonth;
    }
    return { totals, spent, budget: budget || null, over: Boolean(budget) && spent > budget };
  }

  // How much of an expense falls in a month ("YYYY-MM"): a one-off on its
  // date, a recurring one from its date on, spread over its period.
  function monthlyShare(expense, month) {
    const date = String(expense.date || "");
    if (!DATE.test(date) || !/^\d{4}-\d{2}$/.test(month || "")) return 0;
    const start = date.slice(0, 7);
    if (!expense.recurring) return start === month ? 1 : 0;
    if (start > month) return 0;
    if (expense.recurring === "monthly") return 1;
    const monthsBetween = (Number(month.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(month.slice(5)) - Number(start.slice(5)));
    if (expense.recurring === "quarterly") return monthsBetween % 3 === 0 ? 1 : 0;
    if (expense.recurring === "annual") return monthsBetween % 12 === 0 ? 1 : 0;
    return 0;
  }

  // The company document: the template's Markdown with the profile's values.
  // Sensitive fields never appear in it; empty ones read "(not set)".
  function documentMarkdown(template, profile, { language = "en", roleLabel = (id) => id, notSet = "(not set)" } = {}) {
    if (!template) return "";
    const source = textOf(template.documentTemplate, language);
    const fields = new Map(list(template.profileFields).map((field) => [field.key, field]));
    const people = profile.people.length
      ? profile.people.map((person) => `- ${person.name || notSet}, ${roleLabel(person.role)}${person.ownershipPercent !== null && Number.isFinite(person.ownershipPercent) ? `, ${person.ownershipPercent}%` : ""}${person.appointedOn ? `, since ${person.appointedOn}` : ""}`).join("\n")
      : notSet;
    return source.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key) => {
      if (key === "people") return people;
      const field = fields.get(key);
      if (!field || field.sensitive || !field.includeInDocument) return "";
      const value = profile.fields[key];
      return value === undefined || value === null || String(value).trim() === "" ? notSet : String(value);
    });
  }

  return Object.freeze({
    SECTIONS,
    RECURRING,
    textOf,
    normalizeProfile,
    normalizeSecrets,
    mask,
    steps,
    obligations,
    deadlineId,
    deadlines,
    view,
    calendarEvents,
    calendarRecords,
    expenseSummary,
    monthlyShare,
    documentMarkdown,
  });
});
