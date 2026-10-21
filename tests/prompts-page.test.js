"use strict";

// The Prompts page's rules (public/js/prompts-page.js) with the shipped
// prompts, presets and examples (content/prompts/).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Page = require("../public/js/prompts-page.js");
const Render = require("../public/js/prompt-render.js");
const Taxonomy = require("../public/js/taxonomy-model.js");
const Fields = require("../public/js/fields.js");

const root = path.join(__dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, "content", file), "utf8"));
const shipped = { prompts: read("prompts/built-in.json").prompts, presets: read("prompts/presets.json").presets, examples: read("prompts/examples.json").examples };
const libraryNodes = ["mk", "po", "fu"].flatMap((section) => (read(`taxonomy/${section}.json`).nodes || []).map((node) => ({ section, ...node })));
Fields.setRegistry({ common: read("fields/common.json"), mk: read("fields/mk.json"), po: read("fields/po.json"), fu: read("fields/fu.json") });

const PROFILE = {
  name: "Northwind Robotics",
  oneLiner: "Picking arms for small warehouses.",
  description: "Pilot stage, hardware and software sold together.",
  website: "https://example.com",
  links: [{ type: "linkedinCompany", url: "https://example.com/in" }],
  industry: "warehouse robotics",
  aiContext: "Two founders. The company is registered in France.",
  country: "FR",
  entityType: "SAS",
  homeRegion: "Lyon",
  maxNewTargetsPerDay: 6,
};

function useLibrary() {
  Taxonomy.setNodes(libraryNodes);
  Taxonomy.setEnabled(null);
}

function valuesFor(preset, { profile = PROFILE, section } = {}) {
  const chosen = section || (preset.section === "general" ? "mk" : preset.section);
  const picks = preset.scope.coverage === "nodes" ? preset.scope.taxonomy : [];
  const selections = Page.presetExamples(preset, chosen);
  const values = {
    ...Page.profileValues(profile, { timeZone: "Europe/Paris", today: "2026-10-20" }),
    ...Page.scopeValues(chosen, picks, Taxonomy),
    TRACKER_ACCESS: Page.trackerAccess("agent", { baseUrl: "http://127.0.0.1:57322", startupId: "northwind-ab12", startupName: profile.name, token: "sta_test", Fields }),
  };
  for (const name of Page.EXAMPLE_VARIABLES) values[name] = Page.exampleValue(shipped.examples, selections[name]);
  return values;
}

test("every shipped preset points at a shipped prompt, real categories and real examples", () => {
  useLibrary();
  assert.equal(shipped.presets.length, 21);
  const exampleIds = new Set(shipped.examples.map((example) => example.id));
  for (const preset of shipped.presets) {
    assert.ok(shipped.prompts.some((prompt) => prompt.id === preset.promptId), `${preset.id} prompt`);
    for (const id of preset.scope.taxonomy || []) assert.ok(Taxonomy.get(id), `${preset.id}: ${id} is in the library`);
    for (const [name, ids] of Object.entries(preset.examples || {})) {
      assert.ok(Page.EXAMPLE_VARIABLES.includes(name), `${preset.id}: ${name}`);
      for (const id of ids) assert.ok(exampleIds.has(id), `${preset.id}: example ${id}`);
    }
    assert.ok(preset.description && preset.whenToUse, `${preset.id} says what it is for and when`);
  }
});

test("every variable resolves from the profile and settings, inside examples too", () => {
  useLibrary();
  for (const preset of shipped.presets) {
    for (const prompt of shipped.prompts) {
      const { text, unresolved } = Render.render(prompt.body, valuesFor(preset));
      assert.deepEqual(unresolved, [], `${preset.id} / ${prompt.id}`);
      assert.doesNotMatch(text, /\{\{/, `${preset.id} / ${prompt.id} has no leftover variables`);
    }
  }
  const research = shipped.prompts.find((prompt) => prompt.id === "target-research");
  const { text } = Render.render(research.body, valuesFor(shipped.presets.find((preset) => preset.id === "ev1")));
  assert.match(text, /Northwind Robotics, Picking arms/);
  assert.match(text, /warehouse robotics or related conferences/, "{{SECTOR}} inside an example is filled");
  assert.match(text, /in person only in Lyon/, "{{HOME_REGION}} inside an example");
  assert.match(text, /more than 6 items/);
  assert.match(text, /Two founders\. The company is registered in France\./);
  assert.match(text, /Token: `sta_test`/);
});

test("an empty example variable, and empty CONSTRAINTS, take their line and the line above", () => {
  useLibrary();
  const research = shipped.prompts.find((prompt) => prompt.id === "target-research");
  const preset = shipped.presets.find((entry) => entry.id === "mk2");
  const values = { ...valuesFor(preset, { profile: { ...PROFILE, aiContext: "" } }), SEARCH_FOCUS: "", AVOID: "" };
  const { text } = Render.render(research.body, values);
  assert.doesNotMatch(text, /What to look for/);
  assert.doesNotMatch(text, /Leave out entirely/);
  assert.doesNotMatch(text, /Company and founders/);
  assert.match(text, /Verification rules for this run/, "filled ones stay");
});

test("presets for categories turned off are hidden", () => {
  useLibrary();
  const conferences = shipped.presets.find((preset) => preset.id === "ev1");
  const general = shipped.presets.find((preset) => preset.id === "gen1");
  assert.equal(Page.presetVisible(conferences, (id) => Taxonomy.isEnabled(id)), true);
  Taxonomy.setEnabled({ enabled: libraryNodes.filter((node) => !node.id.startsWith("po.visibility")).map((node) => node.id) });
  assert.equal(Page.presetVisible(conferences, (id) => Taxonomy.isEnabled(id)), false);
  assert.equal(Page.presetVisible(general, (id) => Taxonomy.isEnabled(id)), true, "presets over all enabled categories stay");
  const two = shipped.presets.find((preset) => preset.id === "po7");
  assert.equal(Page.presetVisible(two, (id) => id === two.scope.taxonomy[1]), true, "one enabled category is enough");
  Taxonomy.setEnabled(null);
});

test("a general preset swaps in its section's examples", () => {
  const topic = shipped.presets.find((preset) => preset.id === "gen2");
  assert.deepEqual(Page.presetExamples(topic, "po").VERIFIED_ACTIVITY, ["v-program"]);
  assert.deepEqual(Page.presetExamples(topic, "mk").VERIFIED_ACTIVITY, ["v-list", "v-comm"]);
  const value = Page.exampleValue(shipped.examples, ["f-topic"], { fills: { "f-topic": "school canteens" } });
  assert.match(value, /Topic: school canteens\./);
  assert.doesNotMatch(value, /write it here/);
  assert.equal(Page.exampleValue(shipped.examples, ["f-conf", "f-shortlist"], { extra: "Only free events." }).split("\n  - ").length, 3, "one bullet per example and one for the run's text");
});

test("your edits win over the shipped ones and can be undone; your own entries are added", () => {
  const lib = Page.library({ shipped, stored: { prompts: [{ id: "target-research", name: "Mine", body: "Short." }, { id: "p-own", name: "Own", body: "Hello {{STARTUP_NAME}}" }], examples: [{ id: "x1", variable: "AVOID", label: "No fees", text: "Anything with a fee." }] } });
  const research = lib.prompts.find((prompt) => prompt.id === "target-research");
  assert.equal(research.body, "Short.");
  assert.equal(research.builtIn, true);
  assert.equal(research.edited, true);
  assert.equal(research.shipped.name, "Target research and creation");
  assert.equal(lib.prompts.find((prompt) => prompt.id === "p-own").builtIn, false);
  assert.equal(lib.examples.length, shipped.examples.length + 1);
  assert.equal(Page.library({ shipped, stored: {} }).prompts.find((prompt) => prompt.id === "target-research").edited, false);
});

test("the scope tree's picks become three readable lists and back", () => {
  const node = (id, level, parentId, order = 1) => ({ id, section: "mk", level, parentId, name: id, description: `About ${id}.`, order, ...(level === "category" ? { shortName: id } : {}) });
  Taxonomy.setNodes([
    node("mk.a", "category", null),
    node("mk.a.one", "subcategory", "mk.a"),
    node("mk.a.one.x", "type", "mk.a.one"),
    node("mk.a.one.y", "type", "mk.a.one", 2),
    node("mk.a.two", "subcategory", "mk.a", 2),
    node("mk.b", "category", null, 2),
    node("mk.b.three", "subcategory", "mk.b"),
  ]);
  Taxonomy.setEnabled(null);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(Page.scopeFromPicks("mk", [], Taxonomy)), { categories: ["all"], subcategories: ["all"], types: ["all"] });
  assert.deepEqual(plain(Page.scopeFromPicks("mk", ["mk.a"], Taxonomy)), { categories: ["mk.a"], subcategories: ["all"], types: ["all"] });
  assert.deepEqual(plain(Page.scopeFromPicks("mk", ["mk.a.two", "mk.a", "mk.b"], Taxonomy)), { categories: ["mk.a", "mk.b"], subcategories: ["mk.a.two", "mk.b.three"], types: ["all"] });
  assert.deepEqual(plain(Page.scopeFromPicks("mk", ["mk.a.one.x", "mk.a.one", "mk.a"], Taxonomy)), { categories: ["mk.a"], subcategories: ["mk.a.one"], types: ["mk.a.one.x"] });
  assert.deepEqual(plain(Page.picksFromScope("mk", { categories: ["all"], subcategories: ["all"], types: ["all"] }, Taxonomy)), []);
  assert.deepEqual(plain(Page.picksFromScope("mk", { categories: ["mk.a", "mk.b"], subcategories: ["mk.a.two", "mk.b.three"], types: ["all"] }, Taxonomy)), ["mk.a.two", "mk.b"]);
  assert.deepEqual(plain(Page.picksFromScope("mk", { categories: ["mk.a"], subcategories: ["mk.a.one", "mk.a.two"], types: ["mk.a.one.x", "mk.a.one.y"] }, Taxonomy)), ["mk.a"]);
  const values = Page.scopeValues("mk", ["mk.a.one.x"], Taxonomy);
  assert.equal(values.TAB, "MK");
  assert.equal(values.CATEGORY, "mk.a");
  assert.equal(values.TYPE, "mk.a.one.x");
  assert.match(values.SCOPE_DETAILS, /About mk\.a\.one\.x\./);
  assert.equal(Page.scopeValues("mk", ["mk.b"], Taxonomy).TYPE, "", "a level without nodes is left empty, so its line goes");
});

test("selections read as a few names, all except a few, or all", () => {
  const items = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((name, index) => ({ id: `c${index + 1}`, name }));
  const f = (ids) => Page.formatSmartSelectionList(ids, items, "all subcategories");
  assert.equal(f(["all"]), "all subcategories");
  assert.equal(f([]), "all subcategories");
  assert.equal(f(items.map((item) => item.id)), "all subcategories");
  assert.equal(f(["c1"]), "Alpha");
  assert.equal(f(["c1", "c2"]), "Alpha and Beta");
  assert.equal(f(["c1", "c2", "c4"]), "Alpha, Beta and Delta");
  assert.equal(f(["c1", "c2", "c3", "c4"]), "all except Epsilon and Zeta");
  assert.equal(Page.formatSmartSelectionList(["only"], [{ id: "only", name: "Solo" }], "all"), "Solo");
});

test("tracker access: commands with the token for agents, a JSON reply for chats", () => {
  const agent = Page.trackerAccess("agent", { baseUrl: "http://127.0.0.1:57322", startupId: "acme-1", startupName: "Acme", token: "sta_abc", expiresAt: "21 Oct 2026, 10:00", Fields });
  assert.match(agent, /Bearer sta_abc/);
  assert.match(agent, /api\/s\/acme-1\/state\/operations/);
  assert.match(agent, /stops working at 21 Oct 2026, 10:00/);
  assert.match(agent, /MK: name is "platform", nextActionDate is "date"/, "stored key names are spelled out");
  const preview = Page.trackerAccess("agent", { baseUrl: "x", startupId: "acme-1", startupName: "Acme" });
  assert.match(preview, /a new token is made when you copy/);
  const chat = Page.trackerAccess("chat", { formatExample: () => "{\"targets\":[]}" });
  assert.match(chat, /```json\n\{"targets":\[\]\}\n```/);
  assert.doesNotMatch(chat, /Bearer|curl/);
});

test("prompt packs export what you made and import it back, checked", () => {
  const stored = { prompts: [{ id: "p1", name: "One", body: "Body" }], presets: [{ id: "s1", name: "Sweep" }], examples: [] };
  const pack = Page.exportPack(stored);
  assert.equal(pack.format, Page.PACK_FORMAT);
  const { merged, counts } = Page.importPack({ ...pack, prompts: [{ id: "p1", name: "One v2", body: "New" }, { id: "p2", name: "Two", body: "B" }], examples: [{ id: "e1", variable: "AVOID", text: "No fees." }] }, stored);
  assert.deepEqual(counts, { added: 2, replaced: 2 });
  assert.equal(merged.prompts.find((prompt) => prompt.id === "p1").body, "New");
  assert.equal(merged.examples.length, 1);
  assert.throws(() => Page.importPack({ prompts: [] }, stored), /not a prompt pack/);
  assert.throws(() => Page.importPack({ format: Page.PACK_FORMAT, prompts: [{ id: "x", name: "No body" }] }, stored), /needs a name and a body/);
  assert.throws(() => Page.importPack({ format: Page.PACK_FORMAT, examples: [{ id: "x", variable: "NOPE", text: "t" }] }, stored), /needs a variable/);
});

test("npm run check catches a preset that names a missing prompt or example", () => {
  const { VALIDATORS } = require("../tools/check-content");
  const presets = VALIDATORS.find((entry) => entry.test("prompts/presets.json"));
  const problems = [];
  presets.validate({ presets: [{ id: "x", section: "mk", promptId: "nope", examples: { AVOID: ["missing"] } }] }, problems);
  assert.deepEqual(problems, ["x: unknown prompt nope", "x: unknown example missing"]);
  const examples = VALIDATORS.find((entry) => entry.test("prompts/examples.json"));
  const exampleProblems = [];
  examples.validate({ examples: [{ id: "e", variable: "OTHER", text: "" }, { id: "e", variable: "AVOID", text: "ok" }] }, exampleProblems);
  assert.deepEqual(exampleProblems, ["e: used twice", "e: unknown variable OTHER", "e: needs a text"]);
});
