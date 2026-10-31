"use strict";

// The section pages' rules (public/js/section-page.js) and their shared
// skeleton in index.html.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const SectionPage = require("../public/js/section-page.js");

const markup = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const TODAY = "2026-10-19";
const row = (id, extra = {}) => ({ id, name: `Target ${id}`, open: true, waiting: false, priority: "Medium", nextActionDate: "", nextAction: "", campaignId: "", tags: [], status: "planned", search: `Target ${id}`, ...extra });

function viewOf(id) {
  const start = markup.indexOf(`id="${id}"`);
  const end = markup.indexOf('class="app-view', start);
  return markup.slice(start, end).replace(/<section class="panel funding-rounds-panel"[\s\S]*$/, "");
}

test("the three pages have the same panels, controls and names", () => {
  const shapes = ["pipelineView", "programsView", "fundingView"].map((id) => {
    const html = viewOf(id);
    return {
      panels: [...html.matchAll(/data-sp-panel="(\w+)"/g)].map((match) => match[1]).join(","),
      headings: [...html.matchAll(/<h2(?: data-i18n="[^"]+")?>([^<]+)<\/h2>/g)].map((match) => match[1]).slice(1).join(","),
      fields: [...html.matchAll(/<(?:input|select) name="(\w+)"/g)].map((match) => match[1]).join(","),
      controls: [...html.matchAll(/data-sp-(search|view|priority|campaign|page-size|columns|statuses|tag-input|facet-key)\b/g)].map((match) => match[1]).join(","),
    };
  });
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);
  assert.equal(shapes[0].controls, "search,view,priority,campaign,page-size,columns,statuses", "no tag or custom field filter row: the search reads tags");
  assert.equal(shapes[0].panels, "focus,form,table");
  assert.equal(shapes[0].headings, "Focus queue,Add target,Targets");
  assert.equal(shapes[0].fields, "name,organization,link,status,priority,nextAction,nextActionDate,nextActionTime,campaignId,tags");
  assert.match(viewOf("pipelineView"), /<input name="nextActionTime" type="time">/, "native time input everywhere");
  assert.match(viewOf("programsView"), /<option selected(?: data-i18n="[^"]+")?>Medium<\/option>/, "Medium is the default priority in PO too");
  // Funding rounds come after the Targets.
  const funding = markup.slice(markup.indexOf('id="fundingView"'), markup.indexOf('id="extraView"'));
  assert.ok(funding.indexOf("funding-rounds-panel") > funding.indexOf('data-sp-panel="table"'));
});

test("each saved view keeps the right rows", () => {
  const rows = [
    row("overdue", { nextActionDate: "2026-10-10" }),
    row("today", { nextActionDate: TODAY, priority: "High" }),
    row("week", { nextActionDate: "2026-10-24", campaignId: "c1" }),
    row("later", { nextActionDate: "2026-11-30", priority: "Very High" }),
    row("closedOverdue", { nextActionDate: "2026-10-01", open: false }),
    row("waiting", { waiting: true, nextAction: "Wait for the reply" }),
    row("nothing"),
  ];
  const keep = (view) => SectionPage.filterRows(rows, { view, today: TODAY }).map((entry) => entry.id);
  assert.deepEqual(keep("all"), rows.map((entry) => entry.id));
  assert.deepEqual(keep("overdue"), ["overdue"]);
  assert.deepEqual(keep("due-week"), ["today", "week"]);
  assert.deepEqual(keep("due-month"), ["overdue", "today", "week"]);
  assert.deepEqual(keep("waiting"), ["waiting"]);
  assert.deepEqual(keep("no-next-action"), ["nothing"]);
  assert.deepEqual(keep("high"), ["today", "later"]);
  assert.deepEqual(keep("no-campaign"), rows.filter((entry) => !entry.campaignId).map((entry) => entry.id));
  assert.deepEqual(SectionPage.SAVED_VIEWS.map((view) => view.id), ["all", "overdue", "due-week", "due-month", "waiting", "no-next-action", "high", "no-campaign"]);
});

test("filters combine, and the search matches every word, tags included", () => {
  const rows = [row("a", { search: "Spring accelerator Lisbon launch", tags: ["launch"], priority: "High" }), row("b", { search: "Spring grant", tags: [] })];
  assert.deepEqual(SectionPage.filterRows(rows, { search: "spring lisbon", today: TODAY }).map((entry) => entry.id), ["a"]);
  assert.deepEqual(SectionPage.filterRows(rows, { search: "launch", today: TODAY }).map((entry) => entry.id), ["a"]);
  assert.deepEqual(SectionPage.filterRows(rows, { priority: "Medium", today: TODAY }).map((entry) => entry.id), ["b"]);
  assert.deepEqual(SectionPage.filterRows(rows, { statuses: () => false, today: TODAY }), []);
  assert.deepEqual(SectionPage.filterRows(rows, { today: TODAY }, (entry) => entry.id === "b").map((entry) => entry.id), ["b"]);
});

test("open targets with the nearest next action come first, undated ones last", () => {
  const rows = [row("undated"), row("closed", { open: false, nextActionDate: "2026-10-01" }), row("late", { nextActionDate: "2026-12-01" }), row("soon", { nextActionDate: "2026-10-20", nextActionTime: "09:00" }), row("soonNoTime", { nextActionDate: "2026-10-20" })];
  assert.deepEqual(SectionPage.sortRows(rows).map((entry) => entry.id), ["soon", "soonNoTime", "late", "undated", "closed"]);
  assert.deepEqual(SectionPage.sortRows(rows, { column: "name", direction: "desc" }).map((entry) => entry.id)[0], "undated");
});

test("pages never read 'Showing 1-0 of 0'", () => {
  assert.equal(SectionPage.pageOf([], 1, 10).label, "No targets to show");
  assert.equal(SectionPage.paginationHtml(SectionPage.pageOf([], 1, 10)), "");
  const info = SectionPage.pageOf(Array.from({ length: 23 }, (_, index) => index), 9, 10);
  assert.equal(info.page, 3, "a page past the end goes to the last one");
  assert.equal(info.label, "Showing 21-23 of 23");
  assert.match(SectionPage.paginationHtml(info), /Page 3 \/ 3/);
});

test("rows are read-only, open by their name, and their link opens only the link", () => {
  const html = SectionPage.rowHtml(row("t<1>", { link: "https://example.com/x", organization: "Org & Co", categoryPath: "Content > Blog", categoryCount: 3, tags: ["launch"] }), { showValue: false });
  assert.doesNotMatch(html, /<input|<select|<textarea|data-action=/);
  assert.match(html, /<button type="button" class="sp-open" data-sp-open="t&lt;1&gt;">Target t&lt;1&gt;<\/button>/);
  assert.match(html, /data-sp-external/);
  assert.match(html, /Org &amp; Co/);
  assert.match(html, /\+2/);
  assert.equal((html.match(/<td/g) || []).length, 7, "no value column in Marketing");
  assert.equal((SectionPage.rowHtml(row("x"), { showValue: true }).match(/<td/g) || []).length, 8);
  assert.match(SectionPage.rowHtml(row("y")), /Uncategorized/);
});

test("the Focus queue shows dated targets on the day or up to it", () => {
  const rows = [row("past", { nextActionDate: "2026-10-10" }), row("today", { nextActionDate: TODAY }), row("future", { nextActionDate: "2026-10-30" }), row("undated")];
  assert.deepEqual(SectionPage.focusRows(rows, { date: TODAY, mode: "on" }).map((entry) => entry.id), ["today"]);
  assert.deepEqual(SectionPage.focusRows(rows, { date: TODAY, mode: "by" }).map((entry) => entry.id), ["past", "today"]);
  assert.deepEqual(SectionPage.focusRows(rows, { date: "", mode: "by" }).map((entry) => entry.id), ["past", "today", "future"]);
  assert.match(SectionPage.focusCardHtml(row("c", { nextActionDate: TODAY, owner: "Ana", nextAction: "Call back" })), /Ana[\s\S]*Call back/);
});

test("the Columns menu adds any field as a column, and field columns sort by value", () => {
  assert.deepEqual(SectionPage.defaultColumns(false), ["priority", "name", "category", "status", "date", "campaign", "tags"]);
  assert.deepEqual(SectionPage.defaultColumns(true).at(-1), "value");
  const html = SectionPage.rowHtml(row("x", { priority: "High" }), { columns: ["name", "field:owner", "field:deadline"], fieldText: (entry, id) => (id === "field:owner" ? "Ana & Co" : ""), fieldLabel: (id) => (id === "field:owner" ? "Owner" : "Deadline") });
  assert.equal((html.match(/<td/g) || []).length, 3, "only the columns asked for");
  // The label names the value where a narrow screen shows the row as a card.
  assert.match(html, /<td class="sp-field" data-label="Owner"><div class="sp-field-text" title="Ana &amp; Co">Ana &amp; Co<\/div><\/td>/);
  assert.match(html, /<td class="sp-field" data-label="Deadline"><\/td>/, "an empty field leaves its cell empty, so the card hides it");
  const menu = SectionPage.columnPickerHtml([{ label: "Table", columns: [{ id: "name", label: "Name" }] }, { label: "Basics", columns: [{ id: "field:owner", label: "Owner" }] }], ["name"]);
  assert.match(menu, /data-sp-column="name" checked/);
  assert.match(menu, /data-sp-column="field:owner">/);
  assert.match(menu, /<legend>Basics<\/legend>/);
  const rows = [row("a"), row("b"), row("c")];
  const reach = { a: 40, b: "", c: 1200 };
  const valueOf = (entry) => reach[entry.id];
  assert.deepEqual(SectionPage.sortRows(rows, { column: "field:reach", direction: "asc" }, valueOf).map((entry) => entry.id), ["a", "c", "b"], "numbers by size, empty last");
  assert.deepEqual(SectionPage.sortRows(rows, { column: "field:reach", direction: "desc" }, valueOf).map((entry) => entry.id), ["c", "a", "b"]);
});
