"use strict";

// The setup in the browser (js/setup-wizard.js): the parts that decide which
// step comes next, what is required, what Skip keeps and when the badge shows.
// The server side (saved progress, the demo startup) is in setup.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Wizard = require("../public/js/setup-wizard.js");
const LinkTypes = require("../public/js/link-types.js");
const I18n = require("../public/js/i18n.js");
const setup = require("../lib/setup");

const NODES = [
  { id: "mk.a", section: "mk", parentId: null, level: "category", name: "A", order: 1, recommended: true },
  { id: "mk.a.one", section: "mk", parentId: "mk.a", level: "subcategory", name: "A one", order: 1, recommended: true },
  { id: "mk.a.two", section: "mk", parentId: "mk.a", level: "subcategory", name: "A two", order: 2 },
  { id: "mk.a.two.x", section: "mk", parentId: "mk.a.two", level: "type", name: "A two x", order: 1 },
  { id: "mk.b", section: "mk", parentId: null, level: "category", name: "B", order: 2 },
  { id: "po.c", section: "po", parentId: null, level: "category", name: "C", order: 1 },
  { id: "po.c.one", section: "po", parentId: "po.c", level: "subcategory", name: "C one", order: 1, recommended: true },
];

test("the browser and the server know the same steps; Add startup reuses Your startup to What to track", () => {
  assert.deepEqual([...Wizard.FULL_STEPS], [...setup.STEPS]);
  const from = Wizard.FULL_STEPS.indexOf("startup");
  const to = Wizard.FULL_STEPS.indexOf("track-fu");
  assert.deepEqual([...Wizard.ADD_STEPS], [...Wizard.FULL_STEPS.slice(from, to + 1), "done"]);
  assert.equal(Wizard.stepsFor("add")[0], "startup");
  assert.equal(Wizard.stepsFor("anything else")[0], "welcome");
});

test("the setup continues at the step saved last, unless that step needs a startup that is gone", () => {
  assert.equal(Wizard.resumeStep("full", "track-po", "acme-1234"), "track-po");
  assert.equal(Wizard.resumeStep("full", "basics", ""), "basics", "steps before Your startup need none");
  assert.equal(Wizard.resumeStep("full", "links", ""), "startup");
  assert.equal(Wizard.resumeStep("full", "elsewhere", "acme-1234"), "welcome");
  assert.equal(Wizard.resumeStep("add", "welcome", ""), "startup", "Add startup has no Welcome");
  assert.equal(Wizard.resumeStep("full", undefined, ""), "welcome");
});

test("progress, Back and Next stay inside the steps", () => {
  assert.deepEqual(Wizard.progress("full", "welcome"), { index: 0, total: 11, percent: 0, first: true, last: false });
  assert.deepEqual(Wizard.progress("full", "done"), { index: 10, total: 11, percent: 100, first: false, last: true });
  assert.equal(Wizard.progress("add", "startup").first, true);
  assert.equal(Wizard.neighbour("full", "welcome", -1), "welcome");
  assert.equal(Wizard.neighbour("full", "welcome", 1), "basics");
  assert.equal(Wizard.neighbour("full", "track-fu", 1), "agents");
  assert.equal(Wizard.neighbour("add", "track-fu", 1), "done", "Add startup skips agents and backups");
  assert.equal(Wizard.neighbour("full", "done", 1), "done");
});

test("only the startup name and the time zone are required, and their steps have no Skip", () => {
  assert.deepEqual(Wizard.missing("startup", { name: "  " }), ["name"]);
  assert.deepEqual(Wizard.missing("startup", { name: "Acme" }), []);
  assert.deepEqual(Wizard.missing("basics", {}), ["timeZone"]);
  assert.deepEqual(Wizard.missing("basics", { timeZone: "Europe/Bucharest" }), []);
  for (const step of ["links", "context", "track-mk", "track-po", "track-fu", "agents", "backups"]) {
    assert.deepEqual(Wizard.missing(step, {}), [], step);
    assert.equal(Wizard.canSkip(step), true, step);
  }
  for (const step of ["welcome", "basics", "startup", "done"]) assert.equal(Wizard.canSkip(step), false, step);
});

test("Recommended nodes start ticked with their parents, and Skip on a section goes back to them", () => {
  const recommended = Wizard.recommendedSelection(NODES);
  assert.deepEqual([...recommended].sort(), ["mk.a", "mk.a.one", "po.c", "po.c.one"]);

  // Someone ticked B and unticked A in marketing, and unticked C in programs.
  const picked = new Set(["mk.b", "po.c.one"]);
  const skipped = Wizard.skipSection(picked, NODES, "mk");
  assert.deepEqual([...skipped].sort(), ["mk.a", "mk.a.one", "po.c.one"], "marketing is back to Recommended, programs untouched");
});

test("ticking a branch ticks what is under it and the way up; unticking clears what is under it", () => {
  let selection = Wizard.setBranch(new Set(), NODES, "mk.a.two", true);
  assert.deepEqual([...selection].sort(), ["mk.a", "mk.a.two", "mk.a.two.x"]);
  selection = Wizard.setBranch(selection, NODES, "mk.a", false);
  assert.deepEqual([...selection], []);
  assert.deepEqual(Wizard.countOn(new Set(["mk.a", "po.c"]), NODES, "mk"), { on: 1, total: 5 });
  const tree = Wizard.sectionTree(NODES, "mk");
  assert.deepEqual(tree.map((entry) => entry.node.id), ["mk.a", "mk.b"]);
  assert.deepEqual(tree[0].children.map((entry) => entry.node.id), ["mk.a.one", "mk.a.two"]);
});

test("\"Turn everything on\" comes after the notice, never first", () => {
  assert.ok(Wizard.TRACK_PARTS.indexOf("everything") > Wizard.TRACK_PARTS.indexOf("notice"));
  assert.equal(Wizard.TRACK_PARTS[0], "notice");
});

test("the Finish setup badge shows until the setup is done, and the setup reopens if it was on screen", () => {
  assert.deepEqual(Wizard.badgeState({ needsSetup: true, open: false }), { hidden: false, autoOpen: false });
  assert.deepEqual(Wizard.badgeState({ needsSetup: true, open: true }), { hidden: false, autoOpen: true });
  assert.deepEqual(Wizard.badgeState({ needsSetup: false, open: true }), { hidden: true, autoOpen: false });
  assert.deepEqual(Wizard.badgeState(null), { hidden: true, autoOpen: false });
});

test("currency and company templates follow the country", () => {
  assert.equal(Wizard.suggestCurrency({ country: "de" }), "EUR");
  assert.equal(Wizard.suggestCurrency({ country: "RO" }), "RON");
  assert.equal(Wizard.suggestCurrency({ country: "ZZ" }), "");
  assert.equal(Wizard.suggestCurrency({ template: { currency: "USD" }, country: "DE" }), "USD");
  const groups = Wizard.templatesFor([
    { id: "de-gmbh", country: "DE" },
    { id: "us-llc", country: "US" },
    { id: "generic", country: "" },
    { id: "xx-draft", country: "DE", draft: true },
  ], "de");
  assert.deepEqual(groups.own.map((entry) => entry.id), ["de-gmbh"]);
  assert.deepEqual(groups.rest.map((entry) => entry.id), ["us-llc"]);
  assert.equal(groups.generic.id, "generic");
});

test("every text the setup shows is in en.json", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/setup-wizard.js"), "utf8");
  const fixed = [...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const dynamic = [
    ...Wizard.FULL_STEPS.map((step) => `setup.steps.${step}`),
    ...Object.values(Wizard.TRACK_SECTIONS).map((section) => `setup.track.title.${section}`),
    ...["one", "two", "three"].map((key) => `setup.welcome.points.${key}`),
    "setup.required.name",
    "setup.required.timeZone",
  ];
  const missing = [...new Set([...fixed, ...dynamic])].filter((key) => !I18n.has(key));
  assert.deepEqual(missing, []);
});

test("every link type's icon is a symbol in the page's sprite", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const symbols = new Set([...html.matchAll(/<symbol id="icon-([a-z0-9-]+)"/g)].map((match) => match[1]));
  const missing = LinkTypes.TYPES.filter((type) => !symbols.has(type.icon)).map((type) => `${type.id}: ${type.icon}`);
  assert.deepEqual(missing, []);
  assert.ok(LinkTypes.TYPES.filter((type) => type.icon.startsWith("brand-")).length >= 20, "the brands have their own logos");
});

test("a time zone is one from the list or one the date formatter accepts", () => {
  assert.equal(Wizard.isTimeZone("Europe/Bucharest", ["Europe/Bucharest"]), true);
  assert.equal(Wizard.isTimeZone("UTC", []), true, "UTC is missing from some browsers' lists");
  assert.equal(Wizard.isTimeZone("Mars/Olympus", []), false);
  assert.equal(Wizard.isTimeZone("", []), false);
});
