// The theme collection: one default, ten layout themes built from five design
// skills and the closing Coda theme, each with a screenshot in the picker.
// These checks keep the server list, the browser list, the stylesheets and the
// assets in step.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Appearance = require("../public/scripts/taste-switcher.js");
const Settings = require("../lib/settings.js");
const { THEMES } = Settings;
const { previewJobs } = require("../tools/theme-previews.js");

const ROOT = path.resolve(__dirname, "..");
const SKILL_THEMES = ["ledger", "nightshift", "fieldnotes", "meridian", "lacquer", "shinjuku", "quiet", "tactile", "broadsheet", "signal"];
const NEW_THEMES = [...SKILL_THEMES, "coda"];
const SKILLS = ["UI UX Pro Max", "taste-skill", "Impeccable", "Emil Kowalski's skills", "Hallmark"];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// Selector text before every opening brace, ignoring the declarations inside
// a rule. Only @media wraps rules in these files, so depth 0 and 1 both hold
// selectors and every one must carry the theme's data-taste attribute.
function selectorsIn(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  let depth = 0;
  let buffer = "";
  for (const char of source) {
    if (char === "{") {
      const selector = buffer.trim();
      if (depth === 0 || depth === 1) {
        if (selector && !selector.startsWith("@")) found.push(selector);
      }
      buffer = "";
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
      buffer = "";
    } else if (depth <= 1) {
      buffer += char;
    }
  }
  return found;
}

test("there are twelve themes, the default first, and the server and browser agree", () => {
  assert.equal(THEMES.length, 12);
  assert.equal(new Set(THEMES).size, 12);
  assert.equal(THEMES[0], "studio");
  assert.deepEqual([...Appearance.THEMES], [...THEMES]);
  assert.deepEqual([...NEW_THEMES], THEMES.slice(1));
});

test("the ten skill themes credit their skill, two themes per skill", () => {
  const credits = SKILL_THEMES.map((id) => Appearance.THEME_CREDITS[id]);
  assert.deepEqual(new Set(credits), new Set(SKILLS));
  for (const skill of SKILLS) {
    assert.equal(credits.filter((entry) => entry === skill).length, 2, skill);
  }
  assert.equal(Appearance.THEME_CREDITS.studio, "");
  assert.equal(Appearance.THEME_CREDITS.coda, "", "the closing theme is its own design");
});

test("every theme has a real stylesheet with light and dark tokens", () => {
  const bundle = read("public/styles.css");
  for (const id of NEW_THEMES) {
    const file = `public/styles/themes/${id}.css`;
    const css = read(file);
    assert.ok(css.length > 2000, `${id} has a full theme, not a placeholder`);
    assert.match(css, new RegExp(`html(?::root)?\\[data-taste="${id}"\\]`), `${id} is scoped`);
    for (const selector of selectorsIn(css)) {
      assert.ok(selector.includes(`[data-taste="${id}"]`), `${id} selector leaks: ${selector.slice(0, 120)}`);
    }
    assert.match(css, new RegExp(`html:root\\[data-taste="${id}"\\]\\[data-theme="dark"\\]`), `${id} has a dark block`);
    assert.match(css, /--accent:/, `${id} sets an accent`);
    assert.match(css, /--bg:/, `${id} sets a ground`);
    assert.match(bundle, new RegExp(`@import url\\("\\./styles/themes/${id}\\.css"\\);`), `${id} is imported last`);
    assert.doesNotMatch(css, /transition:\s*all\b/, `${id} does not animate every property`);
    assert.doesNotMatch(css, /@import\s/, `${id} has no nested imports`);
    assert.doesNotMatch(css, /https?:\/\//, `${id} loads nothing from the network`);
    assert.doesNotMatch(css, /@font-face/, `${id} uses a bundled or system face`);
    // A layout theme touches the shell, not only the palette.
    const shellHooks = [".app-shell", ".shell-sidebar", ".topbar", "#appTabs", ".calendar-", ".summary-grid"];
    assert.ok(shellHooks.filter((hook) => css.includes(hook)).length >= 2, `${id} rearranges the shell or a shared assembly`);
  }
  assert.ok(read("public/styles/taste-variants.css").includes('data-taste="studio"'), "the default keeps its styles");
});

test("every theme has a screenshot for the picker", () => {
  const modes = Appearance.THEME_PREVIEW_MODES;
  assert.deepEqual(Object.keys(modes), [...THEMES]);
  for (const id of THEMES) {
    const file = path.join(ROOT, "public", "assets", "theme-previews", `${id}.jpg`);
    assert.ok(fs.existsSync(file), `${id}.jpg is in the picker assets`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 8 * 1024, `${id}.jpg is a real screenshot`);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${id}.jpg is a JPEG`);
  }
  assert.equal(Appearance.previewPath("ledger"), "/assets/theme-previews/ledger.jpg");
  assert.equal(Appearance.previewPath("nonsense"), "/assets/theme-previews/studio.jpg");
  assert.deepEqual(previewJobs(["ledger", "nightshift"]), [
    { id: "ledger", mode: "light" },
    { id: "nightshift", mode: "dark" },
  ]);
  for (const id of NEW_THEMES) {
    assert.ok(fs.statSync(path.join(ROOT, "public", "assets", "theme-previews", `${id}.jpg`)).size < 500 * 1024, `${id}.jpg stays light`);
  }
});

test("the picker keeps each hidden radio inside its card", () => {
  // The radio is visually hidden with position: absolute. Without a positioned
  // card it belongs to the dialog, escapes the scrolling settings content and
  // makes focusing it scroll the whole panel out of place.
  const css = read("public/styles/taste-variants.css");
  const rule = css.match(/\.taste-theme-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(rule, /position:\s*relative/, "the card is the radio's containing block");
});

test("the picker names and describes every theme in English", () => {
  const en = JSON.parse(read("content/i18n/en.json"));
  const themes = en.settings.appearance.themes;
  for (const id of THEMES) {
    assert.ok(themes[id], `${id} has a name`);
    assert.ok(themes[id].name.trim(), `${id} name is not empty`);
    assert.ok(themes[id].description.trim(), `${id} description is not empty`);
    assert.notEqual(themes[id].name, themes[id].description);
  }
  assert.ok(en.settings.appearance.themeCredit.includes("{skill}"));
  assert.ok(en.settings.appearance.themeHint.length > 40);
});

test("an old palette id opens a new theme instead of the default by accident", () => {
  assert.deepEqual({ ...Settings.THEME_ALIASES }, { ...Appearance.LEGACY_TASTES });
  for (const [oldId, next] of Object.entries(Appearance.LEGACY_TASTES)) {
    assert.ok(!THEMES.includes(oldId), `${oldId} is no longer listed`);
    assert.ok(THEMES.includes(next), `${oldId} maps to a listed theme`);
    assert.equal(Appearance.normalizeTaste(oldId), next);
  }
});

test("saved settings from before the collection keep their idea", () => {
  for (const [oldId, next] of Object.entries(Settings.THEME_ALIASES)) {
    const resolved = Settings.resolveSettings({ appearance: { mode: "dark", theme: oldId } });
    assert.deepEqual(resolved.appearance, { mode: "dark", theme: next }, oldId);
  }
  // A client that still sends an old id (an open tab, an old backup) is mapped
  // instead of having its appearance rejected.
  const current = Settings.defaults();
  const merged = Settings.mergeSettings(current, { appearance: { theme: "cyber" } });
  assert.equal(merged.appearance.theme, "nightshift");
  assert.throws(() => Settings.mergeSettings(current, { appearance: { theme: "nonsense" } }));
});
