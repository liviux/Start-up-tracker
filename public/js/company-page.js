// The Company tab (window.StartupTrackerCompanyPage): the legal entity behind
// the startup, from a company template (content/company-templates/).
//
// Sub-tabs:
//   Profile      the template, region, incorporation, conditions, the
//                template's fields, people and bank accounts
//   Setup        the template's setup steps and your own, with statuses
//   Obligations  recurring obligations and their deadlines (12 months ahead)
//   Expenses     what the company pays, against a monthly budget
//   Document     a Markdown summary of the company to copy
// Before incorporation only Profile and Setup show.
//
// The page reads and writes through hooks (see create()); js/company-model.js
// works out the steps, obligations and deadlines. Sensitive values (fields
// marked sensitive, people's id numbers, bank accounts) are fetched from
// their own route only when the Profile tab is open, and show masked.
//
// What can be tested without a browser is exported on its own.
//
// UMD: browsers get window.StartupTrackerCompanyPage, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerCompanyPage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const Model = typeof module === "object" && module.exports ? module.require("./company-model.js") : root.StartupTrackerCompany;
  const Recurrence = typeof module === "object" && module.exports ? module.require("./company-recurrence.js") : root.StartupTrackerCompanyRecurrence;

  const TABS = Object.freeze(["profile", "setup", "obligations", "expenses", "document"]);
  const BEFORE_INCORPORATION = Object.freeze(["profile", "setup"]);
  const PERSON_ID_FIELD = "idNumber";
  const FREQUENCIES = Object.freeze(["monthly", "quarterly", "annual", "once", "on-event"]);
  const SOON_DAYS = 14;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  // ---- what can be tested -----------------------------------------------------

  // The sub-tabs to show: before incorporation, only the profile and setup.
  function visibleTabs(profile) {
    return profile && profile.incorporated === false ? BEFORE_INCORPORATION.slice() : TABS.slice();
  }

  // What needs attention: deadlines and dated steps that are overdue or due
  // within two weeks, and not done.
  function urgentItems(companyView, { today, isDone = () => false } = {}) {
    const items = [];
    for (const step of companyView?.steps || []) {
      if (!step.dueDate || (step.status && isDone(step.status))) continue;
      const state = Recurrence.deadlineState(step.dueDate, today, { soonDays: SOON_DAYS });
      if (state === "overdue" || state === "due-soon") items.push({ kind: "step", id: step.id, title: step.title, date: step.dueDate, state });
    }
    for (const deadline of companyView?.deadlines?.items || []) {
      if (deadline.state === "overdue" || deadline.state === "due-soon") items.push({ kind: "deadline", id: deadline.id, title: deadline.title, date: deadline.dueDate, state: deadline.state });
    }
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }

  // The template picker's groups: by country name, Generic on its own last.
  function groupTemplates(templates) {
    const groups = new Map();
    let generic = null;
    for (const template of templates || []) {
      if (template.id === "generic") {
        generic = template;
        continue;
      }
      const key = template.countryName || template.country || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(template);
    }
    return {
      countries: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([countryName, list]) => ({ countryName, templates: list })),
      generic,
    };
  }

  // A due rule in words, for the obligations list.
  function dueText(obligation, t) {
    const due = obligation.due || { rule: "manual" };
    const day = (value) => (value === "last" ? t("company.due.lastDay") : value === "same" ? t("company.due.sameDay") : t("company.due.day", { day: value }));
    const period = t(`company.due.period.${obligation.frequency}`);
    switch (due.rule) {
      case "fixed-date":
        if (obligation.frequency === "monthly" && due.month === undefined) return t("company.due.everyMonth", { day: day(due.day) });
        return t("company.due.fixed", { date: monthDay(due.month, due.day) });
      case "relative-to-period-end":
        return due.months ? t("company.due.afterPeriodEnd", { count: due.months, day: day(due.day), period }) : t("company.due.inPeriodEnd", { day: day(due.day), period });
      case "relative-to-period-start":
        return due.months ? t("company.due.afterPeriodStart", { count: due.months, day: day(due.day), period }) : t("company.due.inPeriodStart", { day: day(due.day), period });
      case "relative-to-fiscal-year-end":
        return due.months >= 0 ? t("company.due.afterYearEnd", { count: due.months, day: day(due.day) }) : t("company.due.beforeYearEnd", { count: -due.months, day: day(due.day) });
      case "relative-to-anniversary":
        return due.months ? t("company.due.anniversaryMonths", { count: due.months }) : t("company.due.anniversaryDays", { count: due.days });
      case "relative-to-event":
        return t("company.due.event", { count: due.days, event: Model.textOf(due.event) });
      default:
        return t("company.due.manual");
    }
  }

  function monthDay(month, day) {
    const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? `${month}-${day}` : date.toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
  }

  // Your own obligation's due rule from the window's fields.
  function ownDue(frequency, { day, month } = {}) {
    const dayValue = day === "last" ? "last" : Number(day);
    const validDay = day === "last" || (Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 31);
    if (frequency === "monthly" && validDay) return { rule: "fixed-date", day: dayValue };
    if (frequency === "quarterly" && validDay) return { rule: "relative-to-period-end", months: 1, day: dayValue };
    if ((frequency === "annual" || frequency === "once") && validDay && Number(month) >= 1 && Number(month) <= 12 && dayValue !== "last") return { rule: "fixed-date", month: Number(month), day: dayValue };
    return { rule: "manual" };
  }

  // The amount in a currency, for the budget badge and the expense list.
  function money(amount, currency, locale) {
    const value = Number(amount) || 0;
    if (!/^[A-Z]{3}$/.test(currency || "")) return value.toLocaleString(locale, { maximumFractionDigits: 2 });
    try {
      return value.toLocaleString(locale, { style: "currency", currency, maximumFractionDigits: 2 });
    } catch {
      return `${value} ${currency}`;
    }
  }

  // The template's profile fields grouped as the template orders them.
  function fieldGroups(template) {
    const groups = new Map();
    for (const field of template?.profileFields || []) {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group).push(field);
    }
    return [...groups].map(([id, fields]) => ({ id, fields }));
  }

  // One field of the edit window, in the target window's field style. Long
  // text grows with its content.
  function windowFieldHtml(field, { statusOptionsHtml = () => "", defaultStatus = () => "" } = {}) {
    const id = `cw-${field.key}`;
    const value = field.value ?? "";
    let control;
    if (field.type === "textarea") control = `<textarea id="${id}" name="${field.key}" class="auto-expand-field" rows="3">${escapeHtml(value)}</textarea>`;
    else if (field.type === "select") control = `<select id="${id}" name="${field.key}">${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(value) ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select>`;
    else if (field.type === "status") control = `<select id="${id}" name="${field.key}">${statusOptionsHtml(value || defaultStatus())}</select>`;
    else if (field.type === "checkbox") control = `<label class="company-check"><input type="checkbox" id="${id}" name="${field.key}"${value ? " checked" : ""}> ${escapeHtml(field.checkLabel || field.label)}</label>`;
    else control = `<input type="${field.type || "text"}" id="${id}" name="${field.key}" value="${escapeHtml(value)}"${field.type === "number" ? ` step="any"` : ""}${field.required ? " required" : ""}>`;
    return `<div class="field-row field-row-${field.type || "text"}"><label class="field-label" for="${id}">${escapeHtml(field.label)}${field.required ? ` <span class="field-required" aria-hidden="true">*</span>` : ""}</label><div class="field-control">${control}</div>${field.help ? `<p class="field-help">${escapeHtml(field.help)}</p>` : ""}</div>`;
  }

  function makeId(prefix) {
    const random = root.crypto?.randomUUID ? root.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  // ---- the page ---------------------------------------------------------------

  // hooks:
  //   t, today(), locale(), startupCurrency()
  //   sections()                 the company sections from the state
  //   saveProfile(profile, msg)  stores companyProfile
  //   upsert(section, record, msg), remove(section, id, msg)
  //   listTemplates(), loadTemplate(id)        Promises of the API's answers
  //   loadSecrets(), saveSecrets(secrets)      the sensitive values' route
  //   statusOptionsHtml(selected), statusBadgeHtml(id), isDone(id), defaultStatus()
  //   renderLinksPanel(container, kind, id, { onChange })
  //   renderMarkdown(text), copyText(text), formatDate(date)
  //   onTemplate(template)       the picked template, for the calendar
  //   urgent(count)              the urgent count, for the tab badge
  function create(container, hooks) {
    const t = hooks.t;
    const ui = { tab: "profile", templates: null, ranking: null, template: null, templateId: "", loadError: "", secrets: null, secretsError: "", shown: new Set(), urgentOpen: false, message: "" };
    let overlay = null;
    let current = null;
    let secretsTimer = null;

    const sections = () => hooks.sections() || {};
    const profile = () => Model.normalizeProfile(sections()[Model.SECTIONS.profile]);
    const language = (p = profile()) => (ui.template?.bilingual?.languages?.includes(p.documentLanguage) ? p.documentLanguage : "en");
    const text = (value) => Model.textOf(value, language());
    const companyView = () => Model.view(ui.template, sections(), { today: hooks.today(), isDone: hooks.isDone, language: language() });
    const currency = () => hooks.startupCurrency() || ui.template?.currency || "";

    async function ensureTemplates() {
      if (ui.templates) return;
      try {
        const answer = await hooks.listTemplates();
        ui.templates = answer.templates || [];
        ui.ranking = answer.ranking || null;
      } catch (error) {
        ui.templates = [];
        ui.loadError = t("company.templatesFailed", { message: error.message });
      }
    }

    async function ensureTemplate() {
      const id = profile().templateId;
      if (ui.templateId === id) return;
      ui.templateId = id;
      ui.template = null;
      if (!id) {
        hooks.onTemplate?.(null);
        return;
      }
      try {
        ui.template = await hooks.loadTemplate(id);
        ui.loadError = "";
      } catch (error) {
        ui.loadError = t("company.templateFailed", { id, message: error.message });
      }
      hooks.onTemplate?.(ui.template);
    }

    async function ensureSecrets() {
      if (ui.secrets) return;
      try {
        ui.secrets = Model.normalizeSecrets(await hooks.loadSecrets());
        ui.secretsError = "";
      } catch (error) {
        ui.secretsError = t("company.secretsFailed", { message: error.message });
      }
    }

    function saveSecrets() {
      root.clearTimeout(secretsTimer);
      secretsTimer = root.setTimeout(async () => {
        try {
          ui.secrets = Model.normalizeSecrets(await hooks.saveSecrets(ui.secrets));
          ui.secretsError = "";
        } catch (error) {
          ui.secretsError = t("company.secretsSaveFailed", { message: error.message });
          draw();
        }
      }, 400);
    }

    function saveProfile(changes, message = t("company.saved")) {
      hooks.saveProfile({ ...profile(), ...changes }, message);
    }

    async function render() {
      await ensureTemplates();
      await ensureTemplate();
      const tabs = visibleTabs(profile());
      if (!tabs.includes(ui.tab)) ui.tab = "profile";
      if (ui.tab === "profile") await ensureSecrets();
      draw();
    }

    // ---- drawing ----

    function draw() {
      const p = profile();
      const view = companyView();
      const urgent = urgentItems(view, { today: hooks.today(), isDone: hooks.isDone });
      hooks.urgent?.(urgent.length);
      const tabs = visibleTabs(p);
      const name = ui.template ? `${text(ui.template.nameLocal)} (${ui.template.entityType})` : p.legalForm || t("company.noTemplate");
      container.innerHTML = `
        <div class="company-page" data-section="comp">
          <header class="company-hero">
            <div class="company-hero-text">
              <h3>${escapeHtml(hooks.companyName?.() || t("company.title"))}</h3>
              <p class="company-hero-form">${escapeHtml(name)}${ui.template?.countryName ? ` · ${escapeHtml(ui.template.countryName)}` : p.countryName ? ` · ${escapeHtml(p.countryName)}` : ""}</p>
              <p class="company-disclaimer" role="note">${escapeHtml(ui.template ? text(ui.template.disclaimer) : t("company.disclaimer"))}</p>
            </div>
            <div class="company-hero-actions">
              ${languageToggle(p)}
              ${budgetBadge(view, p)}
              ${urgentBadge(urgent)}
            </div>
          </header>
          ${ui.loadError ? `<p class="company-error" role="alert">${escapeHtml(ui.loadError)}</p>` : ""}
          <div class="company-subnav" role="tablist" aria-label="${escapeHtml(t("company.title"))}">
            ${tabs.map((tab) => `<button type="button" role="tab" class="company-subnav-btn${tab === ui.tab ? " active" : ""}" data-company-tab="${tab}" aria-selected="${tab === ui.tab}">${escapeHtml(t(`company.tabs.${tab}`))}${tabCount(tab, view)}</button>`).join("")}
          </div>
          ${p.incorporated ? "" : `<p class="company-note">${escapeHtml(t("company.notIncorporatedNote"))}</p>`}
          <div class="company-pane" role="tabpanel">${pane(ui.tab, view, p)}</div>
          <p class="company-message" aria-live="polite">${escapeHtml(ui.message)}</p>
        </div>`;
      ui.message = "";
      bindPane();
    }

    function tabCount(tab, view) {
      let count = 0;
      if (tab === "setup") count = view.steps.length;
      else if (tab === "obligations") count = view.obligations.filter((obligation) => obligation.applies).length;
      else if (tab === "expenses") count = (sections()[Model.SECTIONS.expenses] || []).length;
      return count ? ` <span class="company-count">${count}</span>` : "";
    }

    function languageToggle(p) {
      const languages = ui.template?.bilingual?.languages;
      if (!languages || languages.length < 2) return "";
      const active = language(p);
      return `<div class="company-language" role="group" aria-label="${escapeHtml(t("company.language"))}">${languages.map((code) => `<button type="button" class="company-language-btn${code === active ? " active" : ""}" data-company-language="${escapeHtml(code)}" aria-pressed="${code === active}">${escapeHtml(code.toUpperCase())}</button>`).join("")}</div>`;
    }

    function budgetBadge(view, p) {
      if (!p.incorporated) return "";
      const month = hooks.today().slice(0, 7);
      const code = currency(p);
      const summary = Model.expenseSummary(sections()[Model.SECTIONS.expenses], { month, currency: code, budget: p.monthlyBudget });
      if (!summary.budget && !summary.spent) return "";
      const label = summary.budget
        ? t("company.budget.ofBudget", { spent: money(summary.spent, code, hooks.locale()), budget: money(summary.budget, code, hooks.locale()) })
        : t("company.budget.spent", { spent: money(summary.spent, code, hooks.locale()) });
      return `<span class="company-budget${summary.over ? " is-over" : ""}" title="${escapeHtml(t("company.budget.help"))}">${escapeHtml(label)}</span>`;
    }

    function urgentBadge(urgent) {
      if (!urgent.length) return "";
      return `
        <div class="company-urgent">
          <button type="button" class="company-urgent-btn" data-company-urgent aria-expanded="${ui.urgentOpen}">${escapeHtml(t("company.urgent.badge", { count: urgent.length }))}</button>
          <div class="company-urgent-list"${ui.urgentOpen ? "" : " hidden"}>
            <ul>${urgent.map((item) => `<li class="is-${item.state}"><button type="button" data-company-open="${item.kind}:${escapeHtml(item.id)}"><span class="company-urgent-date">${escapeHtml(hooks.formatDate(item.date))}</span> ${escapeHtml(item.title)} <span class="company-state">${escapeHtml(t(`company.state.${item.state}`))}</span></button></li>`).join("")}</ul>
          </div>
        </div>`;
    }

    function pane(tab, view, p) {
      if (tab === "setup") return setupPane(view);
      if (tab === "obligations") return obligationsPane(view, p);
      if (tab === "expenses") return expensesPane(p);
      if (tab === "document") return documentPane(p);
      return profilePane(p);
    }

    function sourcesHtml(sources, checkLocally) {
      const parts = (sources || []).map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text(source.title))}</a>${source.verifiedOn ? ` <span class="company-verified">${escapeHtml(t("company.verifiedOn", { date: source.verifiedOn }))}</span>` : ""}`);
      if (checkLocally) parts.push(`<span class="company-check-locally" title="${escapeHtml(t("company.checkLocallyHelp"))}">${escapeHtml(t("company.checkLocally"))}</span>`);
      return parts.length ? `<p class="company-sources"><span>${escapeHtml(t("company.sources"))}</span> ${parts.join(" · ")}</p>` : "";
    }

    // ---- Profile ----

    function profilePane(p) {
      const grouped = groupTemplates(ui.templates);
      const isGeneric = p.templateId === "generic";
      const options = [
        `<option value="">${escapeHtml(t("company.pickTemplate"))}</option>`,
        ...grouped.countries.map((group) => `<optgroup label="${escapeHtml(group.countryName)}">${group.templates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === p.templateId ? " selected" : ""}>${escapeHtml(`${template.entityType}: ${text(template.nameEnglish)}`)}${template.draft ? ` (${escapeHtml(t("company.draft"))})` : ""}</option>`).join("")}</optgroup>`),
        grouped.generic ? `<option value="generic"${isGeneric ? " selected" : ""}>${escapeHtml(t("company.genericOption"))}</option>` : "",
      ].join("");
      const ranking = ui.ranking ? `<p class="field-help">${escapeHtml(t("company.ranking", { title: ui.ranking.title, year: ui.ranking.year }))} ${ui.ranking.url ? `<a href="${escapeHtml(ui.ranking.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("company.rankingSource"))}</a>` : ""}</p>` : "";
      const template = ui.template;
      return `
        <section class="company-card">
          <h3>${escapeHtml(t("company.profile.entity"))}</h3>
          <div class="field-grid">
            ${row(t("company.profile.template"), `<select id="companyTemplate" data-company-profile="templateId">${options}</select>`, ranking + (template ? `<p class="field-help">${escapeHtml(template.verifiedOn ? t("company.templateVerified", { date: template.verifiedOn }) : t("company.templateGeneric"))}</p>` : ""))}
            ${isGeneric ? row(t("company.profile.legalForm"), `<input type="text" data-company-profile="legalForm" value="${escapeHtml(p.legalForm)}" maxlength="120">`, `<p class="field-help">${escapeHtml(t("company.profile.legalFormHelp"))}</p>`) : ""}
            ${isGeneric ? row(t("company.profile.countryName"), `<input type="text" data-company-profile="countryName" value="${escapeHtml(p.countryName)}" maxlength="120">`) : ""}
            ${template?.subdivision ? row(text(template.subdivision.label), `<select data-company-profile="subdivision"><option value="">${escapeHtml(t("company.profile.pickSubdivision"))}</option>${template.subdivision.options.map((option) => `<option value="${escapeHtml(option.code)}"${option.code === p.subdivision ? " selected" : ""}>${escapeHtml(text(option.name))}</option>`).join("")}</select>`, template.subdivision.required && !p.subdivision ? `<p class="field-help is-warning">${escapeHtml(t("company.profile.subdivisionNeeded"))}</p>` : "") : ""}
            ${row(t("company.profile.incorporated"), `<label class="company-check"><input type="checkbox" data-company-profile="incorporated"${p.incorporated ? " checked" : ""}> ${escapeHtml(t("company.profile.incorporatedLabel"))}</label>`)}
            ${p.incorporated ? row(t("company.profile.incorporationDate"), `<input type="date" data-company-profile="incorporationDate" value="${escapeHtml(p.incorporationDate)}">`) : ""}
            ${p.incorporated ? row(t("company.profile.fiscalYearEnd"), `<input type="text" data-company-profile="fiscalYearEnd" value="${escapeHtml(p.fiscalYearEnd)}" pattern="\\d{2}-\\d{2}" placeholder="12-31" maxlength="5">`, `<p class="field-help">${escapeHtml(t("company.profile.fiscalYearEndHelp"))}</p>`) : ""}
            ${p.incorporated ? row(t("company.profile.monthlyBudget", { currency: currency(p) || "?" }), `<input type="number" min="0" step="any" data-company-profile="monthlyBudget" value="${p.monthlyBudget ?? ""}">`, `<p class="field-help">${escapeHtml(t("company.profile.monthlyBudgetHelp"))}</p>`) : ""}
          </div>
        </section>
        ${template?.conditions?.length ? `
          <section class="company-card">
            <h3>${escapeHtml(t("company.profile.conditions"))}</h3>
            <p class="field-help">${escapeHtml(t("company.profile.conditionsHelp"))}</p>
            <ul class="company-conditions">
              ${template.conditions.map((condition) => `<li><label class="company-check"><input type="checkbox" data-company-condition="${escapeHtml(condition.id)}"${p.conditions.includes(condition.id) ? " checked" : ""}> <strong>${escapeHtml(text(condition.label))}</strong></label><span class="field-help">${escapeHtml(text(condition.description))}</span></li>`).join("")}
            </ul>
          </section>` : ""}
        ${template ? fieldGroups(template).map((group) => `
          <section class="company-card">
            <h3>${escapeHtml(t(`company.groups.${group.id}`) === `company.groups.${group.id}` ? group.id : t(`company.groups.${group.id}`))}</h3>
            <div class="field-grid">${group.fields.map((field) => profileFieldHtml(field, p)).join("")}</div>
          </section>`).join("") : ""}
        ${template || isGeneric ? peopleHtml(p) : ""}
        ${template || isGeneric ? bankAccountsHtml() : ""}`;
    }

    // The label names the row's first control (aria-labelledby), since the
    // control is built apart from it.
    let rowCount = 0;
    function row(label, control, after = "") {
      const id = `company-row-${++rowCount}`;
      const named = control.replace(/<(input|select|textarea)\b(?![^>]*aria-label)/, `<$1 aria-labelledby="${id}"`);
      return `<div class="field-row"><label class="field-label" id="${id}">${escapeHtml(label)}</label><div class="field-control">${named}</div>${after}</div>`;
    }

    function profileFieldHtml(field, p) {
      const help = `<p class="field-help">${escapeHtml(text(field.description))}${text(field.example) ? ` ${escapeHtml(text(field.example))}` : ""}</p>`;
      if (field.sensitive) return row(text(field.label), secretControl(`field:${field.key}`, ui.secrets?.fields?.[field.key]), help);
      const value = p.fields[field.key] ?? "";
      let control;
      if (field.type === "textarea" || field.type === "markdown") control = `<textarea rows="3" data-company-field="${escapeHtml(field.key)}">${escapeHtml(value)}</textarea>`;
      else if (field.type === "select") control = `<select data-company-field="${escapeHtml(field.key)}"><option value=""></option>${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(text(option.label || option.value))}</option>`).join("")}</select>`;
      else {
        const type = { date: "date", number: "number", money: "number", percent: "number", url: "url", email: "email" }[field.type] || "text";
        control = `<input type="${type}" data-company-field="${escapeHtml(field.key)}" value="${escapeHtml(value)}"${type === "number" ? ` step="any"` : ""}>`;
      }
      return row(text(field.label), control, help);
    }

    // A sensitive value: masked until you choose Show, edited in place.
    function secretControl(key, value) {
      if (!ui.secrets) return `<span class="field-help">${escapeHtml(ui.secretsError || t("company.secretsLoading"))}</span>`;
      const shown = ui.shown.has(key);
      return `<div class="company-secret">
        <input type="${shown ? "text" : "password"}" autocomplete="off" data-company-secret="${escapeHtml(key)}" value="${escapeHtml(shown ? value || "" : value ? Model.mask(value) : "")}"${shown ? "" : " readonly"} placeholder="${escapeHtml(shown ? "" : value ? "" : t("company.secretEmpty"))}">
        <button type="button" class="secondary-button compact" data-company-show="${escapeHtml(key)}">${escapeHtml(shown ? t("company.hide") : value ? t("company.showEdit") : t("company.add"))}</button>
      </div>`;
    }

    function peopleHtml(p) {
      const roles = ui.template?.people?.roles || [];
      const hasIdNumber = !ui.template || (ui.template.people?.fields || []).includes(PERSON_ID_FIELD);
      const roleOptions = (selected) => `${roles.length ? "" : `<option value="${escapeHtml(selected)}">${escapeHtml(selected)}</option>`}${roles.map((role) => `<option value="${escapeHtml(role.id)}"${role.id === selected ? " selected" : ""} title="${escapeHtml(text(role.description))}">${escapeHtml(text(role.label))}</option>`).join("")}`;
      return `
        <section class="company-card">
          <h3>${escapeHtml(t("company.people.title"))}</h3>
          <p class="field-help">${escapeHtml(t("company.people.help"))}</p>
          ${p.people.length ? `<div class="company-people">${p.people.map((person) => `
            <div class="company-person" data-person="${escapeHtml(person.id)}">
              ${row(t("company.people.name"), `<input type="text" data-person-field="name" value="${escapeHtml(person.name)}" maxlength="160">`)}
              ${row(t("company.people.role"), roles.length ? `<select data-person-field="role">${roleOptions(person.role)}</select>` : `<input type="text" data-person-field="role" value="${escapeHtml(person.role)}" maxlength="80">`)}
              ${row(t("company.people.ownership"), `<input type="number" min="0" max="100" step="any" data-person-field="ownershipPercent" value="${person.ownershipPercent ?? ""}">`)}
              ${row(t("company.people.appointedOn"), `<input type="date" data-person-field="appointedOn" value="${escapeHtml(person.appointedOn)}">`)}
              ${hasIdNumber ? row(t("company.people.idNumber"), secretControl(`person:${person.id}`, ui.secrets?.people?.[person.id]?.[PERSON_ID_FIELD])) : ""}
              <button type="button" class="danger-button compact" data-person-remove="${escapeHtml(person.id)}">${escapeHtml(t("company.people.remove"))}</button>
            </div>`).join("")}</div>` : `<p class="empty-text">${escapeHtml(t("company.people.none"))}</p>`}
          <button type="button" class="secondary-button" data-person-add>${escapeHtml(t("company.people.add"))}</button>
          ${ownershipNote(p)}
        </section>`;
    }

    function ownershipNote(p) {
      const shares = p.people.map((person) => person.ownershipPercent).filter((value) => Number.isFinite(value));
      if (!shares.length) return "";
      const total = Math.round(shares.reduce((sum, value) => sum + value, 0) * 100) / 100;
      return `<p class="field-help${total === 100 ? "" : " is-warning"}">${escapeHtml(t("company.people.total", { total }))}</p>`;
    }

    function bankAccountsHtml() {
      if (!ui.secrets) return `<section class="company-card"><h3>${escapeHtml(t("company.bank.title"))}</h3><p class="field-help">${escapeHtml(ui.secretsError || t("company.secretsLoading"))}</p></section>`;
      const accounts = ui.secrets.bankAccounts;
      return `
        <section class="company-card">
          <h3>${escapeHtml(t("company.bank.title"))}</h3>
          <p class="field-help">${escapeHtml(t("company.bank.help"))}</p>
          ${accounts.length ? accounts.map((account) => `
            <div class="company-bank" data-bank="${escapeHtml(account.id)}">
              ${row(t("company.bank.label"), `<input type="text" data-bank-field="label" value="${escapeHtml(account.label)}" maxlength="80">`)}
              ${row(t("company.bank.currency"), `<input type="text" data-bank-field="currency" value="${escapeHtml(account.currency)}" maxlength="3" placeholder="EUR">`)}
              ${row(t("company.bank.account"), secretControl(`bank:${account.id}`, account.account))}
              <button type="button" class="danger-button compact" data-bank-remove="${escapeHtml(account.id)}">${escapeHtml(t("company.bank.remove"))}</button>
            </div>`).join("") : `<p class="empty-text">${escapeHtml(t("company.bank.none"))}</p>`}
          <button type="button" class="secondary-button" data-bank-add>${escapeHtml(t("company.bank.add"))}</button>
          ${ui.secretsError ? `<p class="company-error" role="alert">${escapeHtml(ui.secretsError)}</p>` : ""}
        </section>`;
    }

    // ---- Setup ----

    function setupPane(view) {
      if (!ui.template && profile().templateId !== "generic") return `<p class="empty-text">${escapeHtml(t("company.pickFirst"))}</p>`;
      const byTemplateId = new Map(view.steps.filter((step) => step.templateStepId).map((step) => [step.templateStepId, step]));
      const done = view.steps.filter((step) => step.status && hooks.isDone(step.status)).length;
      return `
        <p class="company-progress">${escapeHtml(t("company.setup.progress", { done, total: view.steps.length }))}</p>
        <ol class="company-steps">
          ${view.steps.map((step) => `
            <li class="company-step${step.status && hooks.isDone(step.status) ? " is-done" : ""}" data-step-id="${escapeHtml(step.id)}">
              <div class="company-item-head">
                <h4>${escapeHtml(step.title)}</h4>
                ${hooks.statusBadgeHtml(step.status || hooks.defaultStatus())}
              </div>
              ${step.description ? `<p>${escapeHtml(step.description)}</p>` : ""}
              <p class="company-meta">
                ${step.authority ? `<span>${escapeHtml(t("company.authority", { name: step.authority }))}</span>` : ""}
                ${step.typicalCost ? `<span>${escapeHtml(costText(step.typicalCost))}</span>` : ""}
                ${step.dependsOn.length ? `<span>${escapeHtml(t("company.setup.after", { steps: step.dependsOn.map((id) => byTemplateId.get(id)?.title || id).join(", ") }))}</span>` : ""}
                ${step.dueDate ? `<span>${escapeHtml(t("company.setup.due", { date: hooks.formatDate(step.dueDate) }))}</span>` : ""}
                ${step.doneOn ? `<span>${escapeHtml(t("company.setup.doneOn", { date: hooks.formatDate(step.doneOn) }))}</span>` : ""}
                ${step.custom ? `<span class="company-own">${escapeHtml(t("company.yours"))}</span>` : ""}
              </p>
              ${sourcesHtml(step.sources, step.checkLocally)}
              ${step.notes ? `<p class="company-notes">${escapeHtml(step.notes)}</p>` : ""}
              <button type="button" class="secondary-button compact" data-company-open="step:${escapeHtml(step.id)}">${escapeHtml(t("company.edit"))}</button>
            </li>`).join("")}
        </ol>
        ${view.steps.length ? "" : `<p class="empty-text">${escapeHtml(t("company.setup.none"))}</p>`}
        <button type="button" class="secondary-button" data-company-add="step">${escapeHtml(t("company.setup.add"))}</button>`;
    }

    function costText(cost) {
      if (typeof cost.amount === "number") return t("company.cost", { amount: money(cost.amount, cost.currency, hooks.locale()), date: cost.effectiveDate || "" }) + (cost.note ? ` (${text(cost.note)})` : "");
      return text(cost.note);
    }

    // ---- Obligations ----

    function obligationsPane(view, p) {
      if (!ui.template && p.templateId !== "generic") return `<p class="empty-text">${escapeHtml(t("company.pickFirst"))}</p>`;
      const conditions = new Map((ui.template?.conditions || []).map((condition) => [condition.id, text(condition.label)]));
      const deadlines = view.deadlines;
      const needs = Object.entries(deadlines.needs || {});
      return `
        <section class="company-card">
          <h3>${escapeHtml(t("company.obligations.deadlines"))}</h3>
          <p class="field-help">${escapeHtml(t("company.obligations.window", { from: hooks.formatDate(deadlines.from), to: hooks.formatDate(deadlines.to) }))}</p>
          ${deadlines.items.length ? `<table class="company-table">
            <thead><tr><th>${escapeHtml(t("company.obligations.date"))}</th><th>${escapeHtml(t("company.obligations.obligation"))}</th><th>${escapeHtml(t("company.obligations.status"))}</th><th></th></tr></thead>
            <tbody>${deadlines.items.map((deadline) => `
              <tr class="is-${deadline.state}" data-deadline-id="${escapeHtml(deadline.id)}">
                <td>${escapeHtml(hooks.formatDate(deadline.dueDate))}<br><span class="company-state">${escapeHtml(t(`company.state.${deadline.state}`))}</span></td>
                <td>${escapeHtml(deadline.title)}${deadline.periodEnd ? `<br><span class="field-help">${escapeHtml(t("company.obligations.period", { from: hooks.formatDate(deadline.periodStart), to: hooks.formatDate(deadline.periodEnd) }))}</span>` : ""}</td>
                <td>${hooks.statusBadgeHtml(deadline.status || hooks.defaultStatus())}</td>
                <td><button type="button" class="secondary-button compact" data-company-open="deadline:${escapeHtml(deadline.id)}">${escapeHtml(t("company.edit"))}</button></td>
              </tr>`).join("")}</tbody>
          </table>` : `<p class="empty-text">${escapeHtml(t("company.obligations.noDeadlines"))}</p>`}
          ${needs.length ? `<ul class="company-needs">${needs.map(([id, need]) => {
            const obligation = view.obligations.find((entry) => entry.id === id);
            return `<li>${escapeHtml(t(`company.needs.${need}`, { title: obligation?.title || id }))}${need !== "incorporationDate" ? ` <button type="button" class="secondary-button compact" data-company-add="deadline:${escapeHtml(id)}">${escapeHtml(t("company.obligations.addDate"))}</button>` : ""}</li>`;
          }).join("")}</ul>` : ""}
        </section>
        <section class="company-card">
          <h3>${escapeHtml(t("company.obligations.title"))}</h3>
          <ul class="company-obligations">
            ${view.obligations.map((obligation) => `
              <li class="company-obligation${obligation.applies ? "" : " is-off"}" data-obligation-id="${escapeHtml(obligation.id)}">
                <div class="company-item-head">
                  <h4>${escapeHtml(obligation.title)}</h4>
                  <span class="company-frequency">${escapeHtml(t(`company.frequency.${obligation.frequency}`))}</span>
                </div>
                ${obligation.description ? `<p>${escapeHtml(obligation.description)}</p>` : ""}
                <p class="company-meta">
                  <span>${escapeHtml(dueText(obligation, t))}</span>
                  ${obligation.authority ? `<span>${escapeHtml(t("company.authority", { name: obligation.authority }))}</span>` : ""}
                  ${obligation.conditions.length ? `<span>${escapeHtml(t("company.obligations.when", { conditions: obligation.conditions.map((id) => conditions.get(id) || id).join(", ") }))}</span>` : ""}
                  ${obligation.custom ? `<span class="company-own">${escapeHtml(t("company.yours"))}</span>` : ""}
                </p>
                ${obligation.missingConditions.length ? `<p class="field-help">${escapeHtml(t("company.obligations.notApplying", { conditions: obligation.missingConditions.map((id) => conditions.get(id) || id).join(", ") }))}</p>` : ""}
                ${obligation.otherSubdivision ? `<p class="field-help">${escapeHtml(t("company.obligations.otherRegion"))}</p>` : ""}
                ${obligation.disabled ? `<p class="field-help">${escapeHtml(t("company.obligations.switchedOff"))}</p>` : ""}
                ${sourcesHtml(obligation.sources, obligation.checkLocally)}
                ${obligation.notes ? `<p class="company-notes">${escapeHtml(obligation.notes)}</p>` : ""}
                <button type="button" class="secondary-button compact" data-company-open="obligation:${escapeHtml(obligation.id)}">${escapeHtml(t("company.edit"))}</button>
              </li>`).join("")}
          </ul>
          ${view.obligations.length ? "" : `<p class="empty-text">${escapeHtml(t("company.obligations.none"))}</p>`}
          <button type="button" class="secondary-button" data-company-add="obligation">${escapeHtml(t("company.obligations.add"))}</button>
        </section>`;
    }

    // ---- Expenses ----

    function categories() {
      const list = (ui.template?.expenseCategories || []).map((category) => ({ id: category.id, label: text(category.label) }));
      return list.length ? list : [{ id: "other", label: t("company.expenses.other") }];
    }

    function expensesPane(p) {
      const expenses = (sections()[Model.SECTIONS.expenses] || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      const labels = new Map(categories().map((category) => [category.id, category.label]));
      const month = hooks.today().slice(0, 7);
      const summary = Model.expenseSummary(expenses, { month, currency: currency(p), budget: p.monthlyBudget });
      const totals = Object.entries(summary.totals).map(([code, amount]) => money(amount, code, hooks.locale())).join(" · ");
      return `
        <section class="company-card">
          <p class="company-progress">${escapeHtml(t("company.expenses.thisMonth", { totals: totals || money(0, currency(p), hooks.locale()) }))}${summary.budget ? ` ${escapeHtml(t(summary.over ? "company.expenses.over" : "company.expenses.within", { budget: money(summary.budget, currency(p), hooks.locale()) }))}` : ""}</p>
          ${expenses.length ? `<table class="company-table">
            <thead><tr><th>${escapeHtml(t("company.expenses.date"))}</th><th>${escapeHtml(t("company.expenses.description"))}</th><th>${escapeHtml(t("company.expenses.category"))}</th><th>${escapeHtml(t("company.expenses.amount"))}</th><th>${escapeHtml(t("company.expenses.paid"))}</th><th></th></tr></thead>
            <tbody>${expenses.map((expense) => `
              <tr data-expense-id="${escapeHtml(expense.id)}">
                <td>${escapeHtml(hooks.formatDate(expense.date))}</td>
                <td>${escapeHtml(expense.title)}${expense.recurring ? ` <span class="company-frequency">${escapeHtml(t(`company.frequency.${expense.recurring}`))}</span>` : ""}</td>
                <td>${escapeHtml(labels.get(expense.category) || expense.category || "")}</td>
                <td class="company-amount">${escapeHtml(money(expense.amount, expense.currency || currency(p), hooks.locale()))}</td>
                <td>${escapeHtml(expense.paid ? t("company.expenses.yes") : t("company.expenses.no"))}</td>
                <td><button type="button" class="secondary-button compact" data-company-open="expense:${escapeHtml(expense.id)}">${escapeHtml(t("company.edit"))}</button></td>
              </tr>`).join("")}</tbody>
          </table>` : `<p class="empty-text">${escapeHtml(t("company.expenses.none"))}</p>`}
          <button type="button" class="secondary-button" data-company-add="expense">${escapeHtml(t("company.expenses.add"))}</button>
        </section>`;
    }

    // ---- Document ----

    function documentMarkdown(p) {
      const roles = new Map((ui.template?.people?.roles || []).map((role) => [role.id, text(role.label)]));
      if (!ui.template) {
        const lines = [`# ${hooks.companyName?.() || t("company.title")}`, "", p.legalForm ? `${t("company.profile.legalForm")}: ${p.legalForm}` : "", p.countryName ? `${t("company.profile.countryName")}: ${p.countryName}` : "", p.incorporationDate ? `${t("company.profile.incorporationDate")}: ${p.incorporationDate}` : "", "", `## ${t("company.people.title")}`, "", ...p.people.map((person) => `- ${person.name || t("company.notSet")}, ${person.role}${person.ownershipPercent !== null ? `, ${person.ownershipPercent}%` : ""}`)];
        return lines.filter((line, index, all) => line || all[index - 1]).join("\n");
      }
      return Model.documentMarkdown(ui.template, p, { language: language(p), roleLabel: (id) => roles.get(id) || id, notSet: t("company.notSet") });
    }

    function documentPane(p) {
      const markdown = documentMarkdown(p);
      return `
        <section class="company-card">
          <p class="field-help">${escapeHtml(t("company.document.help"))}</p>
          <div class="company-document-actions">
            <button type="button" class="primary-button" data-company-copy>${escapeHtml(t("company.document.copy"))}</button>
          </div>
          <div class="company-document markdown-rendered">${hooks.renderMarkdown(markdown)}</div>
        </section>`;
    }

    // ---- events ----

    function bindPane() {
      container.querySelectorAll("[data-company-tab]").forEach((button) => button.addEventListener("click", () => {
        ui.tab = button.dataset.companyTab;
        render();
      }));
      container.querySelectorAll("[data-company-language]").forEach((button) => button.addEventListener("click", () => {
        saveProfile({ documentLanguage: button.dataset.companyLanguage }, t("company.languageSaved"));
        draw();
      }));
      container.querySelector("[data-company-urgent]")?.addEventListener("click", () => {
        ui.urgentOpen = !ui.urgentOpen;
        draw();
      });
      container.querySelectorAll("[data-company-open]").forEach((button) => button.addEventListener("click", () => {
        const [kind, ...rest] = button.dataset.companyOpen.split(":");
        open(kind, rest.join(":"));
      }));
      container.querySelectorAll("[data-company-add]").forEach((button) => button.addEventListener("click", () => {
        const [kind, ...rest] = button.dataset.companyAdd.split(":");
        add(kind, rest.join(":"));
      }));
      container.querySelector("[data-company-copy]")?.addEventListener("click", async () => {
        try {
          await hooks.copyText(documentMarkdown(profile()));
          ui.message = t("company.document.copied");
        } catch (error) {
          ui.message = t("company.document.copyFailed", { message: error.message });
        }
        draw();
      });
      bindProfile();
    }

    function bindProfile() {
      container.querySelectorAll("[data-company-profile]").forEach((control) => control.addEventListener("change", () => {
        const key = control.dataset.companyProfile;
        let value = control.type === "checkbox" ? control.checked : control.value.trim();
        if (key === "monthlyBudget") value = value === "" ? null : Number(value);
        if (key === "fiscalYearEnd" && value && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
          ui.message = t("company.profile.fiscalYearEndInvalid");
          draw();
          return;
        }
        const changes = { [key]: value };
        if (key === "templateId") {
          changes.subdivision = "";
          changes.conditions = [];
          const picked = (ui.templates || []).find((template) => template.id === value);
          if (picked) hooks.templatePicked?.(picked);
        }
        saveProfile(changes);
        render();
      }));
      container.querySelectorAll("[data-company-condition]").forEach((control) => control.addEventListener("change", () => {
        const set = new Set(profile().conditions);
        if (control.checked) set.add(control.dataset.companyCondition);
        else set.delete(control.dataset.companyCondition);
        saveProfile({ conditions: [...set] });
        draw();
      }));
      container.querySelectorAll("[data-company-field]").forEach((control) => control.addEventListener("change", () => {
        saveProfile({ fields: { ...profile().fields, [control.dataset.companyField]: control.value.trim() } });
        draw();
      }));
      container.querySelectorAll("[data-person-field]").forEach((control) => control.addEventListener("change", () => {
        const id = control.closest("[data-person]").dataset.person;
        const key = control.dataset.personField;
        const value = key === "ownershipPercent" ? (control.value === "" ? null : Number(control.value)) : control.value.trim();
        saveProfile({ people: profile().people.map((person) => (person.id === id ? { ...person, [key]: value } : person)) });
        draw();
      }));
      container.querySelector("[data-person-add]")?.addEventListener("click", () => {
        const roles = ui.template?.people?.roles || [];
        saveProfile({ people: [...profile().people, { id: makeId("person"), role: roles[0]?.id || "", name: "", ownershipPercent: null, appointedOn: "" }] });
        draw();
      });
      container.querySelectorAll("[data-person-remove]").forEach((button) => button.addEventListener("click", () => {
        const id = button.dataset.personRemove;
        const person = profile().people.find((entry) => entry.id === id);
        if (!root.confirm(t("company.people.confirmRemove", { name: person?.name || t("company.people.unnamed") }))) return;
        saveProfile({ people: profile().people.filter((entry) => entry.id !== id) });
        if (ui.secrets?.people?.[id]) {
          delete ui.secrets.people[id];
          saveSecrets();
        }
        draw();
      }));
      container.querySelectorAll("[data-company-show]").forEach((button) => button.addEventListener("click", () => {
        const key = button.dataset.companyShow;
        if (ui.shown.has(key)) ui.shown.delete(key);
        else ui.shown.add(key);
        draw();
        if (ui.shown.has(key)) container.querySelector(`[data-company-secret="${CSS.escape(key)}"]`)?.focus();
      }));
      container.querySelectorAll("[data-company-secret]").forEach((control) => control.addEventListener("change", () => {
        if (!ui.secrets || control.readOnly) return;
        setSecret(control.dataset.companySecret, control.value.trim());
        saveSecrets();
      }));
      container.querySelectorAll("[data-bank-field]").forEach((control) => control.addEventListener("change", () => {
        const id = control.closest("[data-bank]").dataset.bank;
        const account = ui.secrets.bankAccounts.find((entry) => entry.id === id);
        if (!account) return;
        account[control.dataset.bankField] = control.dataset.bankField === "currency" ? control.value.trim().toUpperCase().slice(0, 3) : control.value.trim();
        saveSecrets();
      }));
      container.querySelector("[data-bank-add]")?.addEventListener("click", () => {
        const id = makeId("bank");
        ui.secrets.bankAccounts.push({ id, label: "", currency: currency() || "", account: "" });
        ui.shown.add(`bank:${id}`);
        saveSecrets();
        draw();
      });
      container.querySelectorAll("[data-bank-remove]").forEach((button) => button.addEventListener("click", () => {
        const account = ui.secrets.bankAccounts.find((entry) => entry.id === button.dataset.bankRemove);
        if (!root.confirm(t("company.bank.confirmRemove", { name: account?.label || Model.mask(account?.account) || "" }))) return;
        ui.secrets.bankAccounts = ui.secrets.bankAccounts.filter((entry) => entry.id !== button.dataset.bankRemove);
        saveSecrets();
        draw();
      }));
    }

    function setSecret(key, value) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      if (kind === "field") ui.secrets.fields[id] = value;
      else if (kind === "person") ui.secrets.people[id] = { ...(ui.secrets.people[id] || {}), [PERSON_ID_FIELD]: value };
      else if (kind === "bank") {
        const account = ui.secrets.bankAccounts.find((entry) => entry.id === id);
        if (account) account.account = value;
      }
    }

    // ---- the edit window (the target window's style) ----

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = root.document.createElement("div");
      overlay.className = "modal-overlay company-window";
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal-card record-window-card" role="dialog" aria-modal="true" aria-labelledby="companyWindowTitle" data-section="comp">
          <div class="modal-header record-window-header">
            <div class="record-window-heading">
              <span class="section-chip" data-section="comp">COMP</span>
              <h2 id="companyWindowTitle"></h2>
            </div>
            <div class="record-window-header-actions">
              <button class="close-modal-btn" type="button" data-cw-close aria-label="${escapeHtml(t("company.close"))}">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
          </div>
          <div class="modal-body record-window-body"><form class="field-grid" data-cw-form></form><div data-cw-links></div></div>
          <div class="modal-footer record-window-footer">
            <button class="danger-button" type="button" data-cw-delete>${escapeHtml(t("company.moveToBin"))}</button>
            <span class="record-window-state" aria-live="polite"></span>
            <button class="secondary-button" type="button" data-cw-cancel>${escapeHtml(t("company.cancel"))}</button>
            <button class="primary-button" type="button" data-cw-save>${escapeHtml(t("company.save"))}</button>
          </div>
        </div>`;
      root.document.body.append(overlay);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-cw-close], [data-cw-cancel]")) close();
        else if (event.target.closest("[data-cw-save]")) save();
        else if (event.target.closest("[data-cw-delete]")) removeCurrent();
      });
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      });
      overlay.addEventListener("submit", (event) => {
        event.preventDefault();
        save();
      });
      return overlay;
    }

    // Opens the window for one entry. `spec` names the title, the fields, the
    // record section and whether it can go to the recycle bin.
    function openWindow(spec) {
      ensureOverlay();
      current = spec;
      overlay.querySelector("#companyWindowTitle").textContent = spec.title;
      overlay.querySelector("[data-cw-form]").innerHTML = `${spec.intro ? `<div class="company-window-intro">${spec.intro}</div>` : ""}${spec.fields.map((field) => windowFieldHtml(field, hooks)).join("")}`;
      overlay.querySelector("[data-cw-delete]").hidden = !spec.canDelete;
      const links = overlay.querySelector("[data-cw-links]");
      links.innerHTML = "";
      if (spec.linksKind && spec.record?.id && spec.saved) {
        links.innerHTML = `<h3 class="record-window-subheading">${escapeHtml(t("company.files"))}</h3><div data-cw-links-panel></div>`;
        hooks.renderLinksPanel(links.querySelector("[data-cw-links-panel]"), spec.linksKind, spec.record.id, { onChange: () => {} });
      } else if (spec.linksKind) {
        links.innerHTML = `<p class="field-help">${escapeHtml(t("company.filesAfterSave"))}</p>`;
      }
      overlay.hidden = false;
      void overlay.offsetHeight;
      overlay.classList.add("open");
      overlay.querySelector("[data-cw-form] input, [data-cw-form] select, [data-cw-form] textarea")?.focus();
    }

    function close() {
      if (!overlay) return;
      overlay.classList.remove("open");
      overlay.hidden = true;
      current = null;
    }

    function formValues() {
      const values = {};
      for (const field of current.fields) {
        const control = overlay.querySelector(`[name="${field.key}"]`);
        if (!control) continue;
        if (field.type === "checkbox") values[field.key] = control.checked;
        else if (field.type === "number") values[field.key] = control.value === "" ? null : Number(control.value);
        else values[field.key] = control.value.trim();
      }
      return values;
    }

    function save() {
      if (!current) return;
      const values = formValues();
      const missing = current.fields.find((field) => field.required && !values[field.key]);
      if (missing) {
        overlay.querySelector(".record-window-state").textContent = t("company.required", { field: missing.label });
        return;
      }
      const record = current.build(values);
      hooks.upsert(current.section, { ...record, updatedAt: new Date().toISOString() }, t("company.saved"));
      close();
      draw();
    }

    function removeCurrent() {
      if (!current?.canDelete) return;
      if (!root.confirm(t("company.confirmBin", { name: current.title }))) return;
      hooks.remove(current.section, current.record.id, t("company.movedToBin"));
      close();
      draw();
    }

    function statusFields(record, { due = true } = {}) {
      return [
        { key: "status", label: t("company.fields.status"), type: "status", value: record?.status || "" },
        ...(due ? [{ key: "dueDate", label: t("company.fields.dueDate"), type: "date", value: record?.dueDate || "" }] : []),
        { key: "doneOn", label: t("company.fields.doneOn"), type: "date", value: record?.doneOn || "" },
        { key: "notes", label: t("company.fields.notes"), type: "textarea", value: record?.notes || "" },
      ];
    }

    function open(kind, id) {
      const view = companyView();
      if (kind === "step") {
        const step = view.steps.find((entry) => entry.id === id || entry.templateStepId === id);
        if (!step) return;
        ui.tab = "setup";
        const record = step.record || { id: `step-${step.templateStepId}`, templateStepId: step.templateStepId };
        openWindow({
          title: step.title,
          section: Model.SECTIONS.steps,
          record,
          saved: Boolean(step.record),
          linksKind: "comp",
          canDelete: step.custom,
          intro: step.custom ? "" : `${step.description ? `<p>${escapeHtml(step.description)}</p>` : ""}${sourcesHtml(step.sources, step.checkLocally)}`,
          fields: [
            ...(step.custom ? [
              { key: "title", label: t("company.fields.title"), value: record.title || "", required: true },
              { key: "description", label: t("company.fields.description"), type: "textarea", value: record.description || "" },
              { key: "authority", label: t("company.fields.authority"), value: record.authority || "" },
            ] : []),
            ...statusFields(record),
          ],
          build: (values) => ({ ...record, ...values, title: step.custom ? values.title : step.title }),
        });
      } else if (kind === "obligation") {
        const obligation = view.obligations.find((entry) => entry.id === id);
        if (!obligation) return;
        ui.tab = "obligations";
        const record = obligation.record || { id: `obligation-${obligation.id}`, templateObligationId: obligation.id };
        const due = obligation.due || {};
        openWindow({
          title: obligation.title,
          section: Model.SECTIONS.obligations,
          record,
          saved: Boolean(obligation.record),
          canDelete: obligation.custom,
          intro: obligation.custom ? "" : `${obligation.description ? `<p>${escapeHtml(obligation.description)}</p>` : ""}<p>${escapeHtml(dueText(obligation, t))}</p>${sourcesHtml(obligation.sources, obligation.checkLocally)}`,
          fields: [
            ...(obligation.custom ? [
              { key: "title", label: t("company.fields.title"), value: record.title || "", required: true },
              { key: "description", label: t("company.fields.description"), type: "textarea", value: record.description || "" },
              { key: "authority", label: t("company.fields.authority"), value: record.authority || "" },
              { key: "frequency", label: t("company.fields.frequency"), type: "select", value: record.frequency || "annual", options: FREQUENCIES.map((value) => ({ value, label: t(`company.frequency.${value}`) })) },
              { key: "dueDay", label: t("company.fields.dueDay"), value: due.day ?? "", help: t("company.fields.dueDayHelp") },
              { key: "dueMonth", label: t("company.fields.dueMonth"), type: "number", value: due.month ?? "", help: t("company.fields.dueMonthHelp") },
            ] : []),
            { key: "disabled", label: t("company.fields.applies"), type: "checkbox", checkLabel: t("company.fields.disabled"), value: obligation.disabled },
            { key: "notes", label: t("company.fields.notes"), type: "textarea", value: record.notes || "" },
          ],
          build: (values) => {
            const next = { ...record, disabled: values.disabled, notes: values.notes };
            if (obligation.custom) {
              Object.assign(next, { title: values.title, description: values.description, authority: values.authority, frequency: values.frequency, due: ownDue(values.frequency, { day: values.dueDay, month: values.dueMonth }) });
            } else {
              next.title = obligation.title;
            }
            return next;
          },
        });
      } else if (kind === "deadline") {
        const deadline = view.deadlines.items.find((entry) => entry.id === id);
        if (!deadline) return;
        ui.tab = "obligations";
        const record = deadline.record || { id: deadline.id, obligationId: deadline.obligationId, dueDate: deadline.dueDate };
        openWindow({
          title: `${deadline.title}, ${hooks.formatDate(deadline.dueDate)}`,
          section: Model.SECTIONS.deadlines,
          record,
          saved: Boolean(deadline.record),
          canDelete: false,
          fields: [
            ...(deadline.manual ? [{ key: "dueDate", label: t("company.fields.dueDate"), type: "date", value: deadline.dueDate, required: true }] : []),
            ...statusFields(record, { due: false }),
          ],
          build: (values) => ({ ...record, obligationId: deadline.obligationId, title: deadline.title, dueDate: deadline.manual ? values.dueDate : deadline.dueDate, ...values }),
        });
      } else if (kind === "expense") {
        const record = (sections()[Model.SECTIONS.expenses] || []).find((entry) => String(entry.id) === String(id));
        if (!record) return;
        ui.tab = "expenses";
        openExpense(record, true);
      }
      draw();
    }

    function openExpense(record, saved) {
      openWindow({
        title: saved ? record.title || t("company.expenses.untitled") : t("company.expenses.new"),
        section: Model.SECTIONS.expenses,
        record,
        saved,
        linksKind: "expense",
        canDelete: saved,
        fields: [
          { key: "title", label: t("company.expenses.description"), value: record.title || "", required: true },
          { key: "date", label: t("company.expenses.date"), type: "date", value: record.date || hooks.today(), required: true },
          { key: "amount", label: t("company.expenses.amount"), type: "number", value: record.amount ?? "" },
          { key: "currency", label: t("company.expenses.currency"), value: record.currency || currency() },
          { key: "category", label: t("company.expenses.category"), type: "select", value: record.category || "other", options: categories().map((category) => ({ value: category.id, label: category.label })) },
          { key: "recurring", label: t("company.expenses.recurring"), type: "select", value: record.recurring || "", options: Model.RECURRING.map((value) => ({ value, label: value ? t(`company.frequency.${value}`) : t("company.expenses.oneOff") })) },
          { key: "paid", label: t("company.expenses.paid"), type: "checkbox", checkLabel: t("company.expenses.paidLabel"), value: Boolean(record.paid) },
          { key: "notes", label: t("company.fields.notes"), type: "textarea", value: record.notes || "" },
        ],
        build: (values) => ({ ...record, ...values, currency: String(values.currency || "").toUpperCase().slice(0, 3), amount: Number.isFinite(values.amount) ? values.amount : 0 }),
      });
    }

    function add(kind, obligationId) {
      if (kind === "expense") {
        openExpense({ id: makeId("expense") }, false);
        return;
      }
      if (kind === "step") {
        const record = { id: makeId("step") };
        openWindow({
          title: t("company.setup.new"),
          section: Model.SECTIONS.steps,
          record,
          saved: false,
          linksKind: "comp",
          canDelete: false,
          fields: [
            { key: "title", label: t("company.fields.title"), value: "", required: true },
            { key: "description", label: t("company.fields.description"), type: "textarea", value: "" },
            { key: "authority", label: t("company.fields.authority"), value: "" },
            ...statusFields(record),
          ],
          build: (values) => ({ ...record, ...values }),
        });
        return;
      }
      if (kind === "obligation") {
        const record = { id: makeId("obligation") };
        openWindow({
          title: t("company.obligations.new"),
          section: Model.SECTIONS.obligations,
          record,
          saved: false,
          canDelete: false,
          fields: [
            { key: "title", label: t("company.fields.title"), value: "", required: true },
            { key: "description", label: t("company.fields.description"), type: "textarea", value: "" },
            { key: "authority", label: t("company.fields.authority"), value: "" },
            { key: "frequency", label: t("company.fields.frequency"), type: "select", value: "annual", options: FREQUENCIES.map((value) => ({ value, label: t(`company.frequency.${value}`) })) },
            { key: "dueDay", label: t("company.fields.dueDay"), value: "", help: t("company.fields.dueDayHelp") },
            { key: "dueMonth", label: t("company.fields.dueMonth"), type: "number", value: "", help: t("company.fields.dueMonthHelp") },
            { key: "notes", label: t("company.fields.notes"), type: "textarea", value: "" },
          ],
          build: (values) => ({ id: record.id, title: values.title, description: values.description, authority: values.authority, frequency: values.frequency, due: ownDue(values.frequency, { day: values.dueDay, month: values.dueMonth }), notes: values.notes }),
        });
        return;
      }
      if (kind === "deadline") {
        const obligation = companyView().obligations.find((entry) => entry.id === obligationId);
        if (!obligation) return;
        openWindow({
          title: t("company.obligations.dateFor", { title: obligation.title }),
          section: Model.SECTIONS.deadlines,
          record: { id: "" },
          saved: false,
          canDelete: false,
          fields: [
            { key: "dueDate", label: t("company.fields.dueDate"), type: "date", value: "", required: true },
            ...statusFields(null, { due: false }),
          ],
          build: (values) => ({ ...values, id: `${obligation.id}@${values.dueDate}`, obligationId: obligation.id, title: obligation.title, manual: true }),
        });
      }
    }

    // Opens an entry from the calendar or search: "step", "deadline",
    // "obligation" or "expense".
    async function show(kind, id) {
      await render();
      if (id) open(kind, id);
    }

    function forgetSecrets() {
      ui.secrets = null;
      ui.shown.clear();
    }

    return { render, show, forgetSecrets, documentMarkdown: () => documentMarkdown(profile()), currentTemplate: () => ui.template };
  }

  return Object.freeze({ TABS, BEFORE_INCORPORATION, visibleTabs, urgentItems, groupTemplates, dueText, ownDue, money, fieldGroups, windowFieldHtml, create });
});
