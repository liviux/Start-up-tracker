// The floating live theme switcher and the three-letter keys it shows. These
// checks keep the bar, the Settings trigger and the list of themes in step
// without needing a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Appearance = require("../public/scripts/taste-switcher.js");
const LiveThemes = require("../public/scripts/live-themes.js");

const ROOT = path.resolve(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

test("the live bar has a unique, short key for every theme", () => {
  const options = LiveThemes.themeOptions(Appearance);
  assert.equal(options.length, Appearance.THEMES.length);
  assert.deepEqual(options.map((entry) => entry.id), [...Appearance.THEMES]);
  for (const option of options) {
    assert.match(option.code, /^[A-Z]{2,3}$/);
    assert.ok(option.code.length <= 3);
  }
  assert.equal(new Set(options.map((entry) => entry.code)).size, options.length);
  assert.equal(options.at(-1).id, "coda");
  assert.equal(options.at(-1).code, "COD");
  assert.deepEqual(LiveThemes.themeOptions(null), []);
});

test("arrow movement wraps through the theme list", () => {
  assert.equal(LiveThemes.neighbourIndex(12, 0, -1), 11);
  assert.equal(LiveThemes.neighbourIndex(12, 11, 1), 0);
  assert.equal(LiveThemes.neighbourIndex(12, -1, 1), 1);
  assert.equal(LiveThemes.neighbourIndex(0, 0, 1), -1);
  assert.equal(LiveThemes.nextTheme(["studio", "coda"], "studio", -1), "coda");
  assert.equal(LiveThemes.nextTheme(["studio", "coda"], "coda", 1), "studio");
  assert.equal(LiveThemes.nextTheme([], "studio", 1), null);
});

test("the live switcher is the first button under Theme style", () => {
  const settings = read("public/js/settings.js");
  const liveButton = settings.indexOf('className: "settings-live-themes"');
  const themeGrid = settings.indexOf("taste-theme-grid settings-theme-grid");
  assert.ok(liveButton > 0, "the trigger is built");
  assert.ok(liveButton < themeGrid, "the trigger comes before the cards");
  assert.match(settings, /root\.StartupTrackerLiveThemes/);
  assert.match(settings, /aria-controls": "liveThemeBar"/);
  assert.match(settings, /liveThemes\.open\(\)/);
});

test("the live bar loads after every theme and before the application", () => {
  const bundle = read("public/styles.css");
  const liveCss = bundle.indexOf('./styles/live-themes.css');
  for (const theme of Appearance.THEMES) {
    if (theme === "studio") continue;
    assert.ok(bundle.indexOf(`./styles/themes/${theme}.css`) < liveCss, `${theme} loads before the live bar`);
  }
  const markup = read("public/index.html");
  const sources = [...markup.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]);
  const live = sources.indexOf("/scripts/live-themes.js");
  assert.ok(live >= 0, "the live module is loaded");
  assert.ok(live < sources.indexOf("/app.js"), "the live module loads before the application");
  assert.ok(live > sources.indexOf("/scripts/taste-switcher.js"));
});

test("the live bar keeps its open state in this tab only", () => {
  assert.equal(LiveThemes.SESSION_KEY, "startup-tracker-live-themes");
  assert.equal(LiveThemes.isBarOpen(null), false);
  assert.equal(LiveThemes.isBarOpen({ isConnected: true }), true);
});
