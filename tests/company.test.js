"use strict";

// The Company tab: the shipped templates, the model the page and the calendar
// share (js/company-model.js), the page's pure helpers (js/company-page.js)
// and the server's handling of sensitive values.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Company = require("../public/js/company-model.js");
const CompanyPage = require("../public/js/company-page.js");
const { checkTemplate } = require("../lib/company/template-schema");
const templates = require("../lib/company/templates");
const { checkContent } = require("../tools/check-content");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations } = require("./helpers/api");

const DIR = path.join(__dirname, "..", "content", "company-templates");
const SHIPPED = fs.readdirSync(DIR).filter((name) => name.endsWith(".json") && name !== "index.json" && name !== "generic.json").map((name) => name.slice(0, -5)).sort();
const read = (id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8"));
const isDone = (status) => ["completed", "not_pursuing"].includes(status);

test("every shipped template passes the schema and is listed", () => {
  templates.resetCache();
  const listed = templates.listTemplates();
  assert.deepEqual(listed.templates.map((t) => t.id).sort(), [...SHIPPED, "generic"].sort());
  assert.equal(listed.templates.at(-1).id, "generic", "Generic comes last in the picker");
  assert.match(listed.ranking.title, /IMF World Economic Outlook/);
  for (const id of [...SHIPPED, "generic"]) {
    const text = fs.readFileSync(path.join(DIR, `${id}.json`), "utf8");
    const { errors } = checkTemplate(JSON.parse(text), { fileName: id, text });
    assert.deepEqual(errors, [], id);
  }
  assert.equal(templates.getTemplate("../secrets"), null, "ids are slugs only");
  assert.equal(templates.getTemplate("xx-none"), null);
});

test("the country index covers every country and every country has at least two major forms", () => {
  const index = read("index");
  const byCountry = new Map();
  for (const id of SHIPPED) {
    const template = read(id);
    if (!template.country) continue;
    if (!byCountry.has(template.country)) byCountry.set(template.country, []);
    byCountry.get(template.country).push(template);
  }
  for (const code of index.ranking.countries) {
    const forms = byCountry.get(code) || [];
    assert.ok(forms.length >= 2, `${code} has ${forms.length} template(s)`);
    for (const form of forms) assert.equal(form.country, code);
  }
  assert.ok(byCountry.size >= 195, `only ${byCountry.size} countries have templates`);
});

test("every country template has steps, obligations and a document", () => {
  for (const id of SHIPPED) {
    const template = read(id);
    assert.ok(template.setupSteps.length >= 6, `${id}: ${template.setupSteps.length} setup steps`);
    assert.ok(template.obligations.length >= 6, `${id}: ${template.obligations.length} obligations`);
    assert.ok(template.sources.length >= 1, `${id}: no source`);
    const doc = typeof template.documentTemplate === "string" ? template.documentTemplate : template.documentTemplate.en;
    assert.match(doc, /\{\{people\}\}/, `${id}: document has no people`);
  }
});

test("every step and obligation cites an official source or says to check locally", () => {
  for (const id of SHIPPED) {
    const template = read(id);
    const sources = new Map(template.sources.map((source) => [source.id, source]));
    for (const source of template.sources) {
      assert.match(source.url, /^https:\/\//, `${id}: ${source.id}`);
      assert.ok(source.verifiedOn || source.checkLocally, `${id}: ${source.id} is dated or marked check locally`);
    }
    for (const entry of [...template.setupSteps, ...template.obligations]) {
      const cited = entry.sourceIds.filter((sourceId) => sources.has(sourceId));
      assert.equal(cited.length, entry.sourceIds.length, `${id}: ${entry.id} cites known sources`);
      assert.ok(cited.length > 0 || entry.checkLocally, `${id}: ${entry.id} has a source or says check locally`);
      // An entry that rests only on sources nobody could open is "check locally".
      if (cited.length && cited.every((sourceId) => !sources.get(sourceId).verifiedOn)) assert.equal(entry.checkLocally, true, `${id}: ${entry.id}`);
    }
    assert.ok(template.disclaimer === null || Company.textOf(template.disclaimer).startsWith("Not legal or tax advice"), id);
  }
  // Only the Romanian template is bilingual, so only it shows the RO/EN toggle.
  assert.deepEqual(SHIPPED.filter((id) => read(id).bilingual), ["ro-srl"]);
  assert.deepEqual(read("ro-srl").bilingual.languages, ["en", "ro"]);
});

test("npm run check fails on a broken template and on an index country without one", () => {
  const results = checkContent();
  const problems = results.filter((result) => result.file.startsWith("company-templates/") && result.problems.length);
  assert.deepEqual(problems, []);
  const broken = checkTemplate({ ...read("uk-ltd"), obligations: [{ ...read("uk-ltd").obligations[0], sourceIds: [], checkLocally: false }] }, { fileName: "uk-ltd" });
  assert.ok(broken.errors.some((error) => /no source and checkLocally is not true/.test(error)));
});

test("the generic template has no built-in steps; your own steps and obligations work", () => {
  const generic = read("generic");
  assert.equal(generic.country, null);
  assert.equal(generic.setupSteps.length + generic.obligations.length, 0);
  const view = Company.view(generic, {
    companyProfile: { templateId: "generic", legalForm: "Oy", countryName: "Finland", incorporated: true },
    companySteps: [{ id: "s1", title: "Register with the trade register", status: "preparing", dueDate: "2026-11-02" }],
    companyObligations: [{ id: "o1", title: "VAT return", frequency: "monthly", due: CompanyPage.ownDue("monthly", { day: "12" }) }],
  }, { today: "2026-10-20", isDone });
  assert.equal(view.steps[0].custom, true);
  assert.equal(view.obligations[0].applies, true);
  assert.ok(view.deadlines.items.some((deadline) => deadline.dueDate === "2026-11-12"));
  assert.equal(view.profile.legalForm, "Oy");
});

test("a template update changes the text and keeps your dates, statuses and notes", () => {
  const v1 = read("uk-ltd");
  const records = {
    companyProfile: { templateId: "uk-ltd", incorporated: true, incorporationDate: "2025-03-10", conditions: ["vat-registered"] },
    companySteps: [{ id: "step-register", templateStepId: "register", status: "completed", doneOn: "2025-03-10", notes: "Done online" }],
    companyObligations: [{ id: "obligation-fps", templateObligationId: "fps", disabled: true, notes: "No payroll yet" }],
    companyDeadlines: [{ id: "vat-return@2026-11-07", status: "submitted", notes: "Filed early" }],
  };
  const v2 = JSON.parse(JSON.stringify(v1));
  v2.version = 2;
  v2.setupSteps.find((step) => step.id === "register").title = "Register the company (new wording)";
  v2.setupSteps.push({ ...v2.setupSteps[0], id: "new-step", title: "A step added later", dependsOn: [] });
  const before = Company.view(v1, records, { today: "2026-10-20", isDone });
  const after = Company.view(v2, records, { today: "2026-10-20", isDone });
  const step = (view) => view.steps.find((entry) => entry.templateStepId === "register");
  assert.equal(step(after).title, "Register the company (new wording)");
  for (const key of ["id", "status", "doneOn", "notes"]) assert.equal(step(after)[key], step(before)[key], key);
  assert.ok(after.steps.some((entry) => entry.templateStepId === "new-step" && entry.status === ""));
  assert.equal(after.obligations.find((entry) => entry.id === "fps").disabled, true);
  const deadline = after.deadlines.items.find((entry) => entry.id === "vat-return@2026-11-07");
  assert.equal(deadline.status, "submitted");
  assert.equal(deadline.notes, "Filed early");
});

test("conditions, regions and the incorporation date decide which deadlines show", () => {
  const llc = read("us-llc");
  const sections = (profile) => ({ companyProfile: { templateId: "us-llc", incorporated: true, ...profile } });
  const ids = (profile) => new Set(Company.view(llc, sections(profile), { today: "2026-03-01", isDone }).deadlines.items.map((deadline) => deadline.obligationId));
  assert.equal(ids({ subdivision: "US-CA" }).has("de-annual-tax"), false, "Delaware's tax only for a Delaware LLC");
  assert.equal(ids({ subdivision: "US-DE" }).has("de-annual-tax"), true);
  assert.equal(ids({}).has("form-1065"), false, "partnership return only with two members");
  assert.equal(ids({ conditions: ["multi-member"] }).has("form-1065"), true);
  const uk = Company.view(read("uk-ltd"), { companyProfile: { templateId: "uk-ltd", incorporated: true } }, { today: "2026-10-20", isDone });
  assert.equal(uk.deadlines.needs["confirmation-statement"], "incorporationDate");
  const notYet = Company.view(read("uk-ltd"), { companyProfile: { templateId: "uk-ltd", incorporated: false } }, { today: "2026-10-20", isDone });
  assert.equal(notYet.deadlines.items.length, 0, "no deadlines before incorporation");
  assert.deepEqual(CompanyPage.visibleTabs(notYet.profile), ["profile", "setup"]);
  assert.deepEqual(CompanyPage.visibleTabs(uk.profile), ["profile", "setup", "obligations", "expenses", "document"]);
});

test("dates you add for event-driven obligations show with their status", () => {
  const template = read("uk-ltd");
  const view = Company.view(template, {
    companyProfile: { templateId: "uk-ltd", incorporated: true },
    companyDeadlines: [{ id: "report-changes@2026-10-25", obligationId: "report-changes", dueDate: "2026-10-25", manual: true, status: "preparing" }],
  }, { today: "2026-10-20", isDone });
  const manual = view.deadlines.items.find((deadline) => deadline.manual);
  assert.equal(manual.title, "Report changes to Companies House");
  assert.equal(manual.state, "due-soon");
  const urgent = CompanyPage.urgentItems(view, { today: "2026-10-20", isDone });
  assert.ok(urgent.some((item) => item.id === manual.id));
  const events = Company.calendarEvents(view, { defaultStatus: "new" });
  assert.ok(events.some((event) => event.date === "2026-10-25" && event.status === "preparing" && event.section === "comp"));
});

test("the page's helpers: template groups, due rules in words, your own due rules", () => {
  const grouped = CompanyPage.groupTemplates(templates.listTemplates().templates);
  assert.equal(grouped.generic.id, "generic");
  assert.ok(grouped.countries.find((group) => group.countryName === "Germany").templates.some((t) => t.id === "de-gmbh"));
  assert.ok(grouped.countries.find((group) => group.countryName === "Germany").templates.some((t) => t.id === "de-ug"));
  const preferred = CompanyPage.groupTemplates(templates.listTemplates().templates, "US");
  assert.equal(preferred.countries[0].templates[0].country, "US", "the current template's country comes first");
  const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ""}`;
  assert.match(CompanyPage.dueText({ frequency: "monthly", due: { rule: "fixed-date", day: 22 } }, t), /everyMonth/);
  assert.match(CompanyPage.dueText({ frequency: "annual", due: { rule: "manual" } }, t), /company\.due\.manual/);
  assert.deepEqual(CompanyPage.ownDue("monthly", { day: "last" }), { rule: "fixed-date", day: "last" });
  assert.deepEqual(CompanyPage.ownDue("annual", { day: "30", month: "4" }), { rule: "fixed-date", month: 4, day: 30 });
  assert.deepEqual(CompanyPage.ownDue("annual", { day: "" }), { rule: "manual" });
  assert.match(CompanyPage.windowFieldHtml({ key: "notes", label: "Notes", type: "textarea", value: "<b>" }), /&lt;b&gt;/);
});

test("expenses: monthly totals per currency and the budget in the startup's currency", () => {
  const expenses = [
    { id: "e1", date: "2026-10-03", amount: 120, currency: "EUR" },
    { id: "e2", date: "2026-01-15", amount: 30, currency: "EUR", recurring: "monthly" },
    { id: "e3", date: "2026-07-01", amount: 90, currency: "EUR", recurring: "quarterly" },
    { id: "e4", date: "2026-10-09", amount: 50, currency: "USD" },
  ];
  const summary = Company.expenseSummary(expenses, { month: "2026-10", currency: "EUR", budget: 200 });
  assert.deepEqual(summary.totals, { EUR: 240, USD: 50 });
  assert.equal(summary.spent, 240);
  assert.equal(summary.over, true);
});

test("sensitive values are masked and stay out of the profile, the document and the prompts", () => {
  assert.equal(Company.mask("TEST-ACCOUNT-0000"), "•••• 0000");
  assert.equal(Company.mask("12345"), "••••");
  assert.equal(Company.mask(""), "");
  const secrets = Company.normalizeSecrets({ bankAccounts: [{ id: "b1", label: "Main", currency: "eur", account: "TEST-ACCOUNT-2222" }, { label: "no id" }] });
  assert.deepEqual(secrets.bankAccounts, [{ id: "b1", label: "Main", currency: "EUR", account: "TEST-ACCOUNT-2222" }]);
  const template = { ...read("generic"), profileFields: [...read("generic").profileFields, { key: "nationalId", label: "ID", description: "x", example: "", type: "text", group: "identity", sensitive: true, includeInDocument: false, sourceIds: [] }], documentTemplate: "{{legalName}} {{nationalId}} {{people}}" };
  const markdown = Company.documentMarkdown(template, Company.normalizeProfile({ fields: { legalName: "Acme", nationalId: "ID-TEST-4567" } }));
  assert.ok(!markdown.includes("ID-TEST-4567"), "a sensitive field never reaches the document");
  const promptsPage = fs.readFileSync(path.join(__dirname, "..", "public", "js", "prompts-page.js"), "utf8");
  assert.doesNotMatch(promptsPage, /companySecrets|company\/secrets/, "no prompt variable reads them");
});

test("over HTTP: sensitive values have their own route, outside /state, agents, history and exports", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const route = `${url}api/s/${startup.id}/company/secrets`;
    const listed = await (await browserFetch(`${url}api/company/templates`)).json();
    assert.ok(listed.templates.some((t) => t.id === "ro-srl"));
    assert.equal((await browserFetch(`${url}api/company/templates/ro-srl`)).status, 200);
    assert.equal((await browserFetch(`${url}api/company/templates/nope`)).status, 404);

    const secret = "TEST-ACCOUNT-0000";
    const saved = await sendJson(route, "PUT", { secrets: { bankAccounts: [{ id: "b1", label: "Main", currency: "RON", account: secret }], people: { p1: { idNumber: "ID-TEST-4567" } } } });
    assert.equal(saved.status, 200);
    assert.equal((await (await browserFetch(route)).json()).secrets.bankAccounts[0].account, secret);
    assert.equal((await fetch(route)).status, 403, "not from another site or a script without the master token");
    assert.equal((await fetch(route, { headers: { Authorization: `Bearer ${server.token}` } })).status, 200, "the master token may read them");

    const state = await (await browserFetch(`${url}api/s/${startup.id}/state`)).text();
    assert.ok(!state.includes(secret) && !state.includes("companySecrets"), "the state never carries them");
    const changes = await (await browserFetch(`${url}api/s/${startup.id}/state/changes?since=0`)).text();
    assert.ok(!changes.includes(secret));
    assert.equal((await saveOperations(url, startup.id, [{ type: "replaceSection", section: "companySecrets", value: {} }])).status, 400, "not writable through /state");
    assert.equal((await browserFetch(`${url}api/s/${startup.id}/state/history?section=companySecrets&id=x`)).status, 403);

    const made = await (await sendJson(`${url}api/s/${startup.id}/agent-tokens`, "POST", { label: "Agent" })).json();
    const agent = { Authorization: `Bearer ${made.token}` };
    assert.equal((await fetch(route, { headers: agent })).status, 403, "an agent token cannot read them");
    const agentWrite = await fetch(`${url}api/s/${startup.id}/state/operations`, { method: "PATCH", headers: { ...agent, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: 2, operations: [{ type: "upsert", section: "companySecrets", id: "x", value: { id: "x" } }] }) });
    assert.ok([400, 403].includes(agentWrite.status));

    const plain = await (await browserFetch(`${url}api/s/${startup.id}/export?format=json`)).text();
    assert.ok(!plain.includes(secret), "left out of exports by default");
    const ticked = await (await browserFetch(`${url}api/s/${startup.id}/export?format=json&includeSensitive=1`)).text();
    assert.ok(ticked.includes(secret), "included when you tick them");
  } finally {
    await server.stop();
  }
});
