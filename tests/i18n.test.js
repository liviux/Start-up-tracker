const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.join(__dirname, "..");
const I18n = require("../public/js/i18n.js");
const Dates = require("../public/js/dates.js");
const en = require("../content/i18n/en.json");

const FIXTURE = {
  app: { name: "Startup Tracker" },
  greeting: "Hello, {name}!",
  twoParams: "{count} of {total} done",
  items: { count: { one: "{count} item", other: "{count} items" } },
  notPlural: { nested: { deep: "Deep value" } },
};

// A minimal DOM: just enough of Element and Document for applyTranslations.
class FakeElement {
  constructor(attributes = {}, textContent = "") {
    this.attributes = { ...attributes };
    this.textContent = textContent;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function attributeNames(selector) {
  return selector.split(",").map((part) => part.trim().replace(/^\[|\]$/g, ""));
}

class FakeRoot extends FakeElement {
  constructor(children, attributes = {}) {
    super(attributes);
    this.children = children;
  }

  matches(selector) {
    return attributeNames(selector).some((name) => this.getAttribute(name) !== null);
  }

  querySelectorAll(selector) {
    const names = attributeNames(selector);
    return this.children.filter((child) => names.some((name) => child.getAttribute(name) !== null));
  }
}

test.beforeEach(() => {
  I18n.setStrings(FIXTURE, "en");
});

test.after(() => {
  I18n.setStrings({}, "en");
});

test("t() returns translations and fills placeholders", () => {
  assert.equal(I18n.t("app.name"), "Startup Tracker");
  assert.equal(I18n.t("greeting", { name: "Ada" }), "Hello, Ada!");
  assert.equal(I18n.t("twoParams", { count: 2, total: 5 }), "2 of 5 done");
  // A placeholder without a value stays visible rather than turning into "undefined".
  assert.equal(I18n.t("greeting"), "Hello, {name}!");
  assert.equal(I18n.t("greeting", { other: "x" }), "Hello, {name}!");
  assert.equal(I18n.t("greeting", { name: 0 }), "Hello, 0!");
});

test("t() picks plural forms with Intl.PluralRules", () => {
  assert.equal(I18n.t("items.count", { count: 1 }), "1 item");
  assert.equal(I18n.t("items.count", { count: 0 }), "0 items");
  assert.equal(I18n.t("items.count", { count: 2 }), "2 items");
  // Counts use the locale's number format.
  assert.equal(I18n.t("items.count", { count: 1200 }), "1,200 items");
  // No count: the "other" form.
  assert.equal(I18n.t("items.count"), "{count} items");
});

test("t() falls back to the key when a string is missing", () => {
  assert.equal(I18n.t("does.not.exist"), "does.not.exist");
  assert.equal(I18n.t("app"), "app", "a branch of the tree is not a string");
  assert.equal(I18n.t("notPlural.nested"), "notPlural.nested");
  assert.equal(I18n.t("notPlural.nested.deep"), "Deep value");
  assert.equal(I18n.has("app.name"), true);
  assert.equal(I18n.has("app.missing"), false);
  assert.equal(I18n.t(""), "");
});

test("applyTranslations fills text, placeholder, title and aria-label", () => {
  const heading = new FakeElement({ "data-i18n": "app.name" }, "Old title");
  const input = new FakeElement({ "data-i18n-placeholder": "greeting", "data-i18n-aria-label": "app.name" });
  const button = new FakeElement({ "data-i18n-title": "notPlural.nested.deep" }, "Label stays");
  const missing = new FakeElement({ "data-i18n": "nope.missing", "data-i18n-title": "nope.title" }, "English text");
  missing.setAttribute("title", "English title");
  const plain = new FakeElement({}, "Untouched");
  const root = new FakeRoot([heading, input, button, missing, plain], { "data-i18n-aria-label": "app.name" });

  const applied = I18n.applyTranslations(root);

  assert.equal(heading.textContent, "Startup Tracker");
  assert.equal(input.getAttribute("placeholder"), "Hello, {name}!");
  assert.equal(input.getAttribute("aria-label"), "Startup Tracker");
  assert.equal(button.getAttribute("title"), "Deep value");
  assert.equal(button.textContent, "Label stays", "only data-i18n replaces text");
  // A missing key keeps the markup's own English instead of showing the key.
  assert.equal(missing.textContent, "English text");
  assert.equal(missing.getAttribute("title"), "English title");
  assert.equal(plain.textContent, "Untouched");
  // The root itself is translated too.
  assert.equal(root.getAttribute("aria-label"), "Startup Tracker");
  assert.equal(applied, 5);
  // Without a DOM it does nothing instead of throwing.
  assert.equal(I18n.applyTranslations(null), 0);
});

test("the locale is English until more languages ship", () => {
  assert.equal(I18n.getLocale(), "en");
  assert.deepEqual(I18n.getAvailableLocales(), ["en"]);
  assert.equal(I18n.formatNumber(1234.5), "1,234.5");
  assert.equal(I18n.formatNumber(1234567, { notation: "compact", maximumFractionDigits: 1 }), "1.2M");
});

function collectKeys(node, prefix = "", keys = new Set()) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") keys.add(full);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const forms = Object.keys(value);
      // The same rule as js/i18n.js: a plural object holds only plural forms.
      const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];
      if (forms.includes("other") && forms.every((form) => PLURAL_FORMS.includes(form) && typeof value[form] === "string")) keys.add(full);
      else collectKeys(value, full, keys);
    } else {
      assert.fail(`${full} must be a string, a plural object or a nested object`);
    }
  }
  return keys;
}

test("en.json parses and holds every key the page and app.js use", () => {
  const raw = fs.readFileSync(path.join(projectRoot, "content", "i18n", "en.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
  const keys = collectKeys(en);
  assert.ok(keys.has("app.name"));

  const markup = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const markupKeys = [...markup.matchAll(/\sdata-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(markupKeys.length >= 5, "the page uses translated strings");
  for (const key of markupKeys) assert.ok(keys.has(key), `index.html uses ${key}, which en.json lacks`);
  assert.match(markup, /<title data-i18n="app\.name">/);

  const app = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const appKeys = [...app.matchAll(/(?<![\w.$])t\("([\w.]+)"/g)].map((match) => match[1]);
  assert.ok(appKeys.length > 0, "app.js uses t()");
  for (const key of appKeys) assert.ok(keys.has(key), `app.js uses ${key}, which en.json lacks`);
  // Keys built from a record kind ("search.kinds.<kind>") exist for each kind.
  for (const kind of ["marketing", "program", "funding", "campaign", "media"]) assert.ok(keys.has(`search.kinds.${kind}`));

  const startupsModule = fs.readFileSync(path.join(projectRoot, "public", "js", "startups.js"), "utf8");
  const startupKeys = [...startupsModule.matchAll(/(?<![\w.$])t\("([\w.]+)"/g)].map((match) => match[1]);
  assert.ok(startupKeys.length > 0, "js/startups.js uses t()");
  for (const key of startupKeys) assert.ok(keys.has(key), `js/startups.js uses ${key}, which en.json lacks`);

  // The Settings panel and its helpers: every literal key, and every key
  // built from a list (sections, themes, link types, bin groups and so on).
  const literalKeys = (file) => [...fs.readFileSync(path.join(projectRoot, "public", ...file.split("/")), "utf8")
    .matchAll(/(?<![\w.$])t\("([\w.]+)"/g)].map((match) => match[1]);
  for (const file of ["js/taxonomy-picker.js", "js/categories-editor.js", "js/agents-page.js", "js/agents-settings.js"]) {
    for (const key of literalKeys(file)) assert.ok(keys.has(key), `${file} uses ${key}, which en.json lacks`);
  }
  const settingsKeys = literalKeys("js/settings.js");
  assert.ok(settingsKeys.length > 100, "js/settings.js uses t()");
  for (const key of settingsKeys) assert.ok(keys.has(key), `js/settings.js uses ${key}, which en.json lacks`);
  const Panel = require("../public/js/settings.js");
  const Appearance = require("../public/scripts/taste-switcher.js");
  const LinkTypes = require("../public/js/link-types.js");
  const Recycle = require("../public/js/recycle.js");
  const AgentsPage = require("../public/js/agents-page.js");
  const AgentsSettings = require("../public/js/agents-settings.js");
  const built = [
    ...Panel.SECTIONS.map((section) => `settings.sections.${section.id}`),
    ...Panel.PROFILE_FIELDS.map((field) => `settings.profile.${field}`),
    ...Appearance.MODES.map((mode) => `settings.appearance.modes.${mode}`),
    ...Appearance.THEMES.flatMap((theme) => [`settings.appearance.themes.${theme}.name`, `settings.appearance.themes.${theme}.description`]),
    ...LinkTypes.GROUPS.map((group) => `linkTypes.groups.${group.id}`),
    ...LinkTypes.TYPES.map((type) => `linkTypes.types.${type.id}`),
    ...Recycle.KINDS.map((kind) => `settings.recycle.groups.${kind.group}`),
    ...Recycle.KINDS.flatMap((kind) => [`settings.sectionNames.${kind.live}`, `settings.sectionNames.${kind.deleted}`]),
    ...["automatic", "safety", "pinned"].map((kind) => `settings.backups.kinds.${kind}`),
    ...["added", "removed", "changed"].map((change) => `settings.backups.changes.${change}`),
    ...["startup", "database", "records"].flatMap((scope) => [`settings.backups.scopes.${scope}`, `settings.backups.scopeHints.${scope}`]),
    ...["new", "replace", "database"].map((mode) => `settings.import.modes.${mode}`),
    ...["replace", "database"].map((mode) => `settings.import.confirm.${mode}`),
    ...Object.values(Dates.DATE_FORMAT_KEYS).map((format) => `settings.general.dateFormats.${format}`),
    ...["moveUp", "moveDown"].map((direction) => `settings.statuses.${direction}`),
    ...["standard", "colorblind"].map((palette) => `settings.appearance.palettes.${palette}`),
    ...["mk", "po", "fu", "comp"].map((section) => `sections.${section}.name`),
    ...["next_action", "deadline", "milestone", "payment", "company", "campaign"].map((kind) => `calendar.kinds.${kind}`),
    ...Dates.WEEK_STARTS.map((day) => `settings.general.weekStarts.${day}`),
    ...["keepAutomatic", "keepSafety"].flatMap((key) => [`settings.backups.${key}`, `settings.backups.${key}Hint`]),
    ...["version", "dataFolder", "databasePath", "mediaDir", "backupDir", "port", "schemaVersion", "databaseBytes", "integrity"].map((fact) => `settings.about.${fact}`),
    // AI agents (js/agents-page.js, js/agents-settings.js).
    ...AgentsPage.STATUSES.map((status) => `agents.status.${status}`),
    ...AgentsPage.TABS.map((tab) => `agents.tabs.${tab}`),
    ...AgentsSettings.POLICIES.flatMap((policy) => [`agents.policies.${policy}.name`, `agents.policies.${policy}.hint`]),
    ...[...AgentsSettings.CHECK_STATES, "unchecked", "consent-needed"].map((state) => `settings.agents.states.${state}`),
    ...["live", "cache", "snapshot", "catalog"].map((source) => `settings.agents.sources.${source}`),
    ...AgentsSettings.SETTING_KEYS.map((key) => `settings.agents.runSettings.${key}`),
    ...["agents.run.you", "agents.run.youLong", "agents.run.agent", "agents.run.created", "agents.run.updated", "settings.agents.tokenRun", "settings.agents.tokenPrompt"],
    ...["unresolved", "noHarness", "blocked", "noConstraints"].map((key) => `agents.dialog.${key}`),
  ];
  for (const key of built) assert.ok(keys.has(key), `en.json lacks ${key}`);

  // With the real strings loaded the page's own English matches en.json.
  I18n.setStrings(en, "en");
  assert.equal(I18n.t("app.name"), "Startup Tracker");
});

test("the pseudo-locale shows keys, keeps placeholders and plural forms", () => {
  const pseudo = I18n.pseudoStrings({ a: { b: "Hello, {name}!", items: { one: "{count} item", other: "{count} items" } } });
  assert.equal(pseudo.a.b, "⟦a.b|{name}⟧");
  assert.deepEqual(pseudo.a.items, { one: "⟦a.items|{count}⟧", other: "⟦a.items|{count}⟧" });
  I18n.setStrings(pseudo, "qps");
  assert.equal(I18n.t("a.b", { name: "Ada" }), "⟦a.b|Ada⟧", "values stay inside the brackets");
  assert.equal(I18n.t("a.items", { count: 2 }), "⟦a.items|2⟧");
  I18n.setStrings(en, "en");
});

