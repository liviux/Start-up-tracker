"use strict";

// The shared option lists (public/js/options.js, lib/options.js) and the
// rule that the page renders them from data, with no copies in index.html.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Options = require("../public/js/options.js");
const optionStore = require("../lib/options");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");

const root = path.join(__dirname, "..");
const shipped = JSON.parse(fs.readFileSync(path.join(root, "content", "options.json"), "utf8"));
const markup = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("the shipped lists are valid, generic and complete", () => {
  for (const name of Options.LIST_NAMES.filter((list) => list !== "documentChecklist")) {
    assert.ok(Array.isArray(shipped[name]), `${name} ships`);
    assert.deepEqual(Options.validateList(name, shipped[name]).map((option) => option.id), shipped[name].map((option) => option.id), name);
  }
  assert.ok(shipped.mediaTypes.some((option) => option.id === "thumbnail"), "Thumbnail is back");
  assert.deepEqual(shipped.feedbackSources.map((option) => option.id), ["email", "call", "interview", "survey", "social-post", "review-site", "support-ticket", "community", "event", "other"]);
  assert.deepEqual(shipped.feedbackJourneySteps.map((option) => option.id), ["discovered", "signed-up", "activated", "repeat-use", "churned"]);
  assert.deepEqual([...new Set(shipped.feedbackTypes.map((option) => option.block).filter(Boolean))].sort(), ["assumption", "journey", "person"], "three type-specific blocks");
  const text = JSON.stringify(shipped).toLowerCase();
  for (const word of ["github", "hosted", "cloud", "saas", "repo", "pull request", "local-first"]) {
    if (word === "github") {
      assert.deepEqual(shipped.researchGroups.filter((group) => group.label.toLowerCase().includes(word)).map((group) => group.id), ["github"], "GitHub only as a research group");
      continue;
    }
    assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`), `no product-specific "${word}" option`);
  }
  assert.ok(shipped.researchGroups.some((group) => group.id === "github"), "GitHub cannot go missing");
  const LinkTypes = require("../public/js/link-types.js");
  for (const group of shipped.researchGroups) assert.ok(LinkTypes.TYPES.some((type) => type.id === group.linkType), `${group.id} uses a link-type icon`);
});

test("lists are checked: unique ids, labels, known extras; ids come from labels", () => {
  assert.throws(() => Options.validateList("mediaTypes", []), /at least one/);
  assert.throws(() => Options.validateList("mediaTypes", [{ id: "a", label: "A" }, { id: "a", label: "B" }]), /Two options/);
  assert.throws(() => Options.validateList("mediaTypes", [{ id: "a", label: " " }]), /label/);
  assert.throws(() => Options.validateList("mediaTypes", [{ id: "Bad Id", label: "A" }]), /not a valid id/);
  assert.throws(() => Options.validateList("feedbackTypes", [{ id: "a", label: "A", block: "other" }]), /block must be one of/);
  assert.throws(() => Options.validateList("nope", [{ id: "a", label: "A" }]), /Unknown option list/);
  assert.deepEqual(Options.validateList("mediaTypes", [{ label: "Logo or brand" }, { label: "Logo or brand" }]).map((option) => option.id), ["logo-or-brand", "logo-or-brand-2"]);
  assert.equal(Options.idFromLabel("Ünïcode name!", ["unicode-name"]), "unicode-name-2");
});

test("an edited list replaces the shipped one, and null brings the shipped one back", () => {
  const store = new TrackerSqliteStore(":memory:");
  const first = optionStore.readOptions(store);
  assert.deepEqual(first.lists.mediaTypes, shipped.mediaTypes);
  assert.ok(first.lists.documentChecklist.some((entry) => entry.id === "pitch-deck"), "the checklist comes from the Programs fields");
  const saved = optionStore.writeOptions(store, { mediaTypes: [{ label: "Banner" }, { id: "other", label: "Other" }] });
  assert.deepEqual(saved.lists.mediaTypes.map((option) => option.id), ["banner", "other"]);
  assert.deepEqual(Object.keys(saved.stored), ["mediaTypes"]);
  assert.throws(() => optionStore.writeOptions(store, { mediaTypes: [], feedbackSources: [{ label: "Fax" }] }), /at least one/);
  assert.deepEqual(optionStore.readOptions(store).lists.feedbackSources, shipped.feedbackSources, "a refused save changes nothing");
  assert.deepEqual(optionStore.writeOptions(store, { mediaTypes: null }).lists.mediaTypes, shipped.mediaTypes);
});

test("the page shows a removed option's stored value instead of dropping it", () => {
  Options.setDefaults(shipped);
  Options.setStored({ mediaTypes: [{ id: "banner", label: "Banner" }] });
  assert.equal(Options.label("mediaTypes", "banner"), "Banner");
  assert.equal(Options.label("mediaTypes", "screenshot"), "screenshot");
  const html = Options.optionsHtml("mediaTypes", "screenshot", { allLabel: "All types" });
  assert.match(html, /<option value="all">All types<\/option>/);
  assert.match(html, /<option value="screenshot" selected>screenshot<\/option>/);
  assert.match(Options.optionsHtml("feedbackVerdicts", "", { emptyLabel: "" }), /^<option value="" selected><\/option>/);
  Options.setStored({});
  assert.match(Options.optionsHtml("mediaTypes", "logo"), /<option value="logo" selected title="[^"]+">Logo or brand<\/option>/);
});

test("option lists come from data: index.html and defaults.js hold no copies", () => {
  for (const id of ["mediaTypeInput", "mediaTypeFilter", "feedbackTypeInput", "feedbackStatusInput", "feedbackSourceInput", "feedbackStageInput", "feedbackAreaInput", "feedbackEvidenceInput", "feedbackRelationshipInput", "dailySubcategoryInput", "dailyPriorityInput", "campaignStatusInput"]) {
    assert.match(markup, new RegExp(`<select id="${id}"></select>`), `${id} is filled from data`);
  }
  const labels = Object.values(shipped).flat().map((option) => option.label);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&(?:amp;)?");
    assert.doesNotMatch(markup, new RegExp(`<option[^>]*>${escaped}</option>`), `"${label}" is not copied into index.html`);
  }
  const defaults = require("../public/scripts/defaults.js");
  for (const name of ["dailySubcategories", "feedbackTypeOptions", "feedbackSourceOptions", "mediaTypes", "feedbackConsentOptions", "feedbackDemandTypeOptions"]) {
    assert.equal(defaults[name], undefined, `${name} left defaults.js`);
  }
  // No product-specific feedback blocks are left on the page.
  for (const id of ["feedbackDemandFields", "feedbackPersonFields", "feedbackHostedPainInput", "feedbackConsentInput"]) assert.doesNotMatch(markup, new RegExp(`id="${id}"`));
});

test("npm run check catches a broken options file", () => {
  const { VALIDATORS } = require("../tools/check-content");
  const validator = VALIDATORS.find((entry) => entry.test("options.json"));
  const check = (value) => {
    const problems = [];
    validator.validate(value, problems);
    return problems;
  };
  assert.deepEqual(check(shipped), []);
  assert.match(check({ ...shipped, mediaTypes: [{ label: "No id" }] }).join("\n"), /mediaTypes\[0\]: needs an id/);
  assert.match(check({ ...shipped, colours: [] }).join("\n"), /colours: unknown list/);
  const { feedbackVerdicts, ...missing } = shipped;
  void feedbackVerdicts;
  assert.match(check(missing).join("\n"), /feedbackVerdicts: missing/);
});
