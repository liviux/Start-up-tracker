const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Browser files live in public/.
const root = path.join(__dirname, "..", "public");
const markup = fs.readFileSync(path.join(root, "index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const shellStyles = fs.readFileSync(path.join(root, "styles/shell.css"), "utf8");
const api = require("../public/js/api.js");
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

test("shell navigation preserves all seven views and readable button names", () => {
  const nav = markup.match(/<nav\b[^>]*id="appTabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, "the existing delegated navigation root must remain");
  const buttons = [...nav[1].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const names = {
    calendar: "Calendar",
    pipeline: "Marketing",
    programs: "Programs &amp; Opportunities",
    funding: "Funding",
    company: "Company",
    extra: "Extra",
    agents: "Agents",
  };
  assert.equal(buttons.length, Object.keys(names).length);
  const seen = new Set();
  for (const [, attributes, content] of buttons) {
    const key = attributes.match(/data-app-tab="([^"]+)"/)?.[1];
    assert.ok(Object.hasOwn(names, key), `unexpected navigation target: ${key}`);
    assert.ok(!seen.has(key), `${key} must have one navigation button`);
    seen.add(key);
    assert.equal(content.replace(/<[^>]*>/g, "").trim(), names[key]);
    assert.match(attributes, /type="button"/);
    assert.match(attributes, /role="tab"/);
    assert.match(attributes, new RegExp(`aria-selected="${key === "calendar"}"`));
    const views = [...markup.matchAll(new RegExp(`<[^>]+data-app-view="${key}"[^>]*>`, "g"))];
    assert.equal(views.length, 1, `${key} must resolve to exactly one view`);
    if (key !== "calendar") assert.match(views[0][0], /\bhidden\b/);
    const sectionStart = views[0].index + views[0][0].length;
    assert.match(markup.slice(sectionStart, sectionStart + 700), /<h2\b[^>]*>[\s\S]*?\S[\s\S]*?<\/h2>/);
  }
});

test("keyboard users can skip navigation and existing controls keep unique IDs", () => {
  assert.match(markup, /<a\b[^>]*class="skip-link"[^>]*href="#mainContent"[^>]*>Skip to content<\/a>/);
  assert.match(markup, /<main\b[^>]*id="mainContent"[^>]*tabindex="-1"/);
  assert.equal(new Set(ids).size, ids.length, "duplicate IDs break labels and delegated controls");
  for (const id of [
    "saveStateLabel", "globalSearch", "globalSearchInput", "globalSearchResults",
    "themeToggleButton", "settingsButton", "settingsPanel", "projectLinksToggle", "projectLinksMenu",
    "calendarStripViewport", "calendarDaysTrack", "calendarDaysStrip", "calendarMonthPanel",
    "calListMarketing", "calListPrograms", "calListFunding", "calListCompany",
    "taskForm", "taskRows", "focusList", "categoryTabs", "subcategoryTabs",
    "programForm", "programRows", "fundingForm", "fundingRows", "fundingRoundForm",
    "dailyForm", "mediaForm", "feedbackForm", "campaignForm", "tagForm",
    "companyPage",
    "recordConflictModal", "keepMineConflictButton", "useTheirsConflictButton",
    "recordWindow",
  ]) assert.ok(ids.includes(id), `existing control #${id} must remain available`);

  const searchInput = markup.match(/<input\b[^>]*id="globalSearchInput"[^>]*>/)?.[0];
  assert.ok(searchInput);
  assert.match(searchInput, /aria-label="[^"\s][^"]*"/);
  assert.match(markup, /<label\b[^>]*for="globalSearchInput"/);
});

test("browser dependencies remain local and load before the application", () => {
  const sources = [...markup.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1].split("?")[0]);
  const appIndex = sources.indexOf("/app.js");
  assert.ok(appIndex >= 0);
  for (const dependency of [
    "/assets/marked.min.js", "/js/dates.js", "/js/i18n.js", "/js/api.js", "/js/settings-store.js", "/scripts/taste-switcher.js",
    "/js/startup-icon.js", "/js/link-types.js", "/js/recycle.js", "/js/startups.js", "/scripts/defaults.js",
    "/scripts/record-conflict-merge.js", "/scripts/record-history-diff.js", "/scripts/record-history-timeline.js",
  ]) {
    assert.ok(sources.indexOf(dependency) >= 0 && sources.indexOf(dependency) < appIndex, `${dependency} must load before app.js`);
    assert.ok(fs.existsSync(path.join(root, dependency)));
  }
  // Dates and translations come first among the body scripts; boot.js stays the
  // only script in <head> besides the vendored markdown parser. The startup
  // module needs the API helper and the translations.
  assert.ok(sources.indexOf("/js/dates.js") < sources.indexOf("/scripts/defaults.js"));
  assert.ok(sources.indexOf("/js/i18n.js") < sources.indexOf("/scripts/defaults.js"));
  assert.ok(sources.indexOf("/js/i18n.js") < sources.indexOf("/js/startups.js"));
  assert.ok(sources.indexOf("/js/api.js") < sources.indexOf("/js/startups.js"));
  // Settings and the icon helper serve the switcher too; the Settings panel
  // reaches app.js through window.StartupTrackerPage, so it loads after it.
  for (const helper of ["/js/settings-store.js", "/js/startup-icon.js"]) {
    assert.ok(sources.indexOf("/js/api.js") < sources.indexOf(helper) && sources.indexOf(helper) < sources.indexOf("/js/startups.js"), `${helper} loads before js/startups.js`);
  }
  assert.ok(sources.indexOf("/js/settings.js") > appIndex, "the Settings panel loads after app.js");
  assert.ok(fs.existsSync(path.join(root, "js", "settings.js")));
  const head = markup.slice(0, markup.indexOf("</head>"));
  assert.doesNotMatch(head, /js\/(?:dates|i18n|api|startups)\.js/);
});

test("every local asset URL on the page is absolute, because the page is served at /s/<id>/", () => {
  // A <base> tag would fix relative URLs but breaks <use href="#icon-...">.
  assert.doesNotMatch(markup, /<base\b/i);
  const urls = [...markup.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.length >= 15);
  for (const url of urls) {
    if (/^(?:https?:|data:|#)/i.test(url)) continue;
    assert.match(url, /^\/(?!\/)/, `${url} must start with /`);
    assert.ok(fs.existsSync(path.join(root, url.split("?")[0])), `${url} must exist in public/`);
  }
  // CSS url()s resolve against the stylesheet, so they may stay relative, but
  // none may point at the page's own folder.
  for (const file of fs.readdirSync(path.join(root, "styles"))) {
    const css = fs.readFileSync(path.join(root, "styles", file), "utf8");
    for (const match of css.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
      const target = match[2];
      if (/^(?:data:|https?:|#)/i.test(target)) continue;
      const resolved = target.startsWith("/") ? path.join(root, target) : path.resolve(root, "styles", target);
      assert.ok(fs.existsSync(resolved), `${file}: ${target} must resolve to a file`);
    }
  }
});

test("initial paint and application boot respect saved and system themes", () => {
  // The page allows only scripts served by the tracker, so the pre-paint theme
  // script is a file loaded in <head>, before the stylesheet-dependent body.
  assert.doesNotMatch(markup, /<script>/, "index.html must not contain inline scripts");
  const head = markup.slice(0, markup.indexOf("</head>"));
  assert.match(head, /<script src="\/js\/boot\.js"><\/script>/, "the theme must be set before the first paint");
  const inline = fs.readFileSync(path.join(root, "js", "boot.js"), "utf8");
  const boot = source.match(/const savedTheme = ([^;]+);\s*updateTheme\(savedTheme\);/)?.[0];
  assert.ok(boot, "boot must initialize the same theme");
  for (const saved of [null, "light", "dark"]) {
    for (const systemDark of [false, true]) {
      let paintedTheme;
      let bootTheme;
      const context = {
        THEME_STORAGE_KEY: api.globalStorageKey("theme"),
        localStorage: { getItem: (key) => {
          assert.ok(["startup-tracker-theme", "startup-tracker-taste"].includes(key));
          return key === "startup-tracker-theme" ? saved : null;
        } },
        window: {
          location: { pathname: "/s/acme-7f3k/" },
          matchMedia: (query) => { assert.equal(query, "(prefers-color-scheme: dark)"); return { matches: systemDark }; },
        },
        document: { documentElement: { setAttribute: (key, value) => {
          if (key === "data-theme") paintedTheme = value;
          assert.notEqual(key, "data-no-startup", "a startup page shows the tracker");
        } } },
        updateTheme: (value) => { bootTheme = value; },
      };
      vm.runInNewContext(inline, context);
      vm.runInNewContext(boot, context);
      const expected = saved || (systemDark ? "dark" : "light");
      assert.equal(paintedTheme, expected);
      assert.equal(bootTheme, expected);
    }
  }
});

test("the first paint maps saved theme styles the same way as the appearance module", () => {
  // Before Part 3 the first variants were saved as letters. boot.js runs
  // before anything else loads, so it carries its own copy of the table.
  const Appearance = require("../public/scripts/taste-switcher.js");
  const inline = fs.readFileSync(path.join(root, "js", "boot.js"), "utf8");
  for (const saved of [null, "a", "b", "c", ...Appearance.THEMES]) {
    let painted;
    vm.runInNewContext(inline, {
      localStorage: { getItem: (key) => (key === "startup-tracker-taste" ? saved : null) },
      window: { location: { pathname: "/s/acme-7f3k/" }, matchMedia: () => ({ matches: false }) },
      document: { documentElement: { setAttribute: (key, value) => { if (key === "data-taste") painted = value; } } },
    });
    assert.equal(painted, Appearance.normalizeTaste(saved), `saved ${saved}`);
  }
  assert.deepEqual(Appearance.LEGACY_TASTES, { a: "linear", b: "studio", c: "minimal" });
  // No style sheet still answers to the letters.
  const variants = fs.readFileSync(path.join(root, "styles", "taste-variants.css"), "utf8");
  assert.doesNotMatch(variants, /data-taste="[abc]"/);
  for (const theme of Appearance.THEMES.filter((id) => id !== "classic")) {
    assert.match(variants, new RegExp(`data-taste="${theme}"`), `${theme} has styles`);
  }
});

test("calendar agenda records use native buttons and escape record attributes", () => {
  const card = source.match(/<button\b[^\n]*class="calendar-item-card"[\s\S]*?<\/button>/)?.[0];
  assert.ok(card, "agenda cards need native keyboard activation");
  assert.match(card, /type="button"/);
  for (const key of ["id", "type", "parentId"]) {
    assert.ok(card.includes(`escapeAttribute(item.${key})`), `${key} must be escaped before entering markup`);
  }
  assert.match(card, /escapeAttribute\(item\.parentKind \|\| "step"\)/);
  assert.match(card, /escapeHtml\(item\.label\)/);
  assert.doesNotMatch(card, /<(?:a|input|select|textarea)\b/);
  assert.match(source, /card\.addEventListener\("click", \(\) => \{\s*jumpToCalendarItem\(card\.dataset\.type, card\.dataset\.id, card\.dataset\.parentId, card\.dataset\.parentKind, card\.dataset\.startupId\)/);
  // In "All startups" mode a card names its startup, and one from another
  // startup opens on that startup's page instead of this one.
  assert.match(card, /item\.startup \? ` data-startup-id="\$\{escapeAttribute\(item\.startup\.id\)\}"`/);
  assert.match(source, /function jumpToCalendarItem\(type, id, parentId, parentKind, startupId\) \{\s*if \(startupId && startupId !== STARTUP_ID\) \{\s*openRecordInOtherStartup\(startupId, type, id\);/);
});

test("before paint, a page without a startup hides the tracker for the create screen", () => {
  const inline = fs.readFileSync(path.join(root, "js", "boot.js"), "utf8");
  for (const [pathname, hidden] of [["/", true], ["/index.html", true], ["/s/acme-7f3k/", false], ["/s/acme-7f3k/index.html", false]]) {
    const attributes = new Map();
    vm.runInNewContext(inline, {
      localStorage: { getItem: () => null },
      window: { location: { pathname }, matchMedia: () => ({ matches: false }) },
      document: { documentElement: { setAttribute: (key, value) => attributes.set(key, value) } },
    });
    assert.equal(attributes.has("data-no-startup"), hidden, pathname);
  }
  const styles = fs.readFileSync(path.join(root, "styles", "startups.css"), "utf8");
  assert.match(styles, /html\[data-no-startup\] \.app-shell/);
  assert.match(markup, /<main\b[^>]*id="firstStartupScreen"[^>]*hidden/);
  assert.match(markup, /<label\b[^>]*for="firstStartupName"/);
});

test("the startup switcher is an accessible menu button and the shell names no workspace", () => {
  const button = markup.match(/<button\b[^>]*id="startupSwitcherButton"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button, /type="button"/);
  assert.match(button, /aria-haspopup="menu"/);
  assert.match(button, /aria-expanded="false"/);
  assert.match(button, /aria-controls="startupSwitcherMenu"/);
  assert.match(markup, /<div\b[^>]*id="startupSwitcherMenu"[^>]*role="menu"[^>]*hidden/);
  assert.match(markup, /<dialog\b[^>]*id="newStartupDialog"[^>]*aria-labelledby="newStartupTitle"/);
  for (const id of ["newStartupName", "newStartupCopyFrom"]) assert.match(markup, new RegExp(`<label\\b[^>]*for="${id}"`));
  // Breadcrumb is startup / view; the footer carries the app name and version.
  assert.match(markup, /<nav class="shell-breadcrumb"[^>]*><span id="breadcrumbStartup"><\/span><span aria-hidden="true">\/<\/span><span id="breadcrumbView"/);
  // The app name is a setting (Settings > General), filled in by js/settings.js.
  // The version opens the changelog and is not plain text.
  assert.match(markup, /<div class="sidebar-footer"><span data-app-name>Startup Tracker<\/span><button\b[^>]*id="appVersionButton"[^>]*aria-haspopup="dialog"[^>]*><span id="appVersionLabel"><\/span><\/button><\/div>/);
  assert.match(markup, /<dialog\b[^>]*id="changelogDialog"[^>]*aria-labelledby="changelogTitle"/);
  assert.match(markup, /<h1 data-app-name>Startup Tracker<\/h1>/);
  assert.doesNotMatch(markup + source, /workspace-(?:sidebar|breadcrumb|heading)/);
  assert.doesNotMatch(markup, />\s*Workspace\s*</);
  const stylesheet = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  for (const name of ["shell", "surfaces", "calendar-agenda", "startups", "changelog"]) assert.match(stylesheet, new RegExp(`@import url\\("\\./styles/${name}\\.css"\\)`));
  assert.doesNotMatch(stylesheet, /workspace/);
});

test("search and the calendar switch between this startup and all startups", () => {
  for (const attribute of ["data-search-scope", "data-calendar-scope"]) {
    const buttons = [...markup.matchAll(new RegExp(`<button\\b[^>]*${attribute}="(this|all)"[^>]*>`, "g"))];
    assert.deepEqual(buttons.map((match) => match[1]), ["this", "all"]);
    for (const [tag] of buttons) {
      assert.match(tag, /type="button"/);
      assert.match(tag, /aria-pressed="(?:true|false)"/);
    }
  }
  assert.match(markup, /role="group" aria-label="Search in"/);
  assert.match(markup, /role="group" aria-label="Show dates from"/);
  // The choice is remembered per startup. While none was made there, the
  // default comes from Settings > General ("This startup" unless changed);
  // tests/client-settings.test.js checks defaultScopeChoice itself.
  assert.match(source, /const SEARCH_SCOPE_STORAGE_KEY = STARTUP_ID \? Api\.storageKey\("search-scope"\)/);
  assert.match(source, /const CALENDAR_SCOPE_STORAGE_KEY = STARTUP_ID \? Api\.storageKey\("calendar-scope"\)/);
  assert.match(source, /return value === SCOPE_ALL \|\| value === SCOPE_THIS \? value : "";/);
  assert.match(source, /return stored \|\| Settings\.defaultScopeChoice\(Settings\.get\(\)\);/);
  assert.match(source, /if \(!readStoredScopeChoice\(SEARCH_SCOPE_STORAGE_KEY\)\) state\.searchScope = Settings\.defaultScopeChoice\(settings\);/);
  assert.match(source, /fetch\(Api\.urls\.allSearch\(query, ALL_SEARCH_LIMIT\)/);
  assert.match(source, /fetch\(Api\.urls\.allCalendar\(\)/);
  // A result from another startup opens there with a full page load.
  assert.match(source, /window\.location\.assign\(Api\.pageUrl\(startupId, \{ open: `\$\{type\}:\$\{id\}` \}\)\)/);
  assert.match(source, /if \(result\.startup\?\.id && result\.startup\.id !== STARTUP_ID\) \{/);
  // The startup's name and icon are escaped before they enter markup.
  const chip = source.match(/function renderStartupChip\(startup\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(chip);
  assert.match(chip, /escapeAttribute\(icon\)/);
  assert.match(chip, /escapeHtml\(startup\.name/);
  assert.match(chip, /\^data:image/);
});

test("shell fonts and decorative navigation icons are bundled locally", () => {
  assert.doesNotMatch(markup + shellStyles, /https?:\/\/fonts\.(?:googleapis|gstatic)\.com/);
  const fontPaths = [...shellStyles.matchAll(/url\("([^"\n]+\.woff2)"\)/g)].map((match) => match[1]);
  assert.ok(fontPaths.length >= 2, "Latin and extended Latin fonts cover English and Romanian labels");
  for (const fontPath of fontPaths) {
    const bytes = fs.readFileSync(path.resolve(root, "styles", fontPath));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2", `${fontPath} must contain a real WOFF2 font`);
  }
  const preload = markup.match(/<link\b[^>]*rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/);
  assert.ok(preload);
  assert.ok(fontPaths.some((fontPath) => path.resolve(root, "styles", fontPath) === path.join(root, preload[1])));
  const icons = [...markup.matchAll(/<img\b[^>]*src="(\/assets\/icons\/[^"\n]+)"[^>]*>/g)];
  assert.equal(icons.length, 7);
  for (const [tag, iconPath] of icons) {
    assert.match(tag, /alt=""/);
    assert.match(tag, /aria-hidden="true"/);
    assert.match(fs.readFileSync(path.join(root, iconPath), "utf8"), /<svg\b/);
  }
  for (const license of ["assets/fonts/OFL.txt", "assets/icons/LICENSE"]) {
    assert.ok(fs.readFileSync(path.join(root, license), "utf8").trim().length > 0);
  }
});

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("light and dark shell text meets WCAG AA contrast", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  const palettes = [...shellStyles.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter(([, , declarations]) => /--bg:/.test(declarations) && /--text:/.test(declarations));
  assert.equal(palettes.length, 2, "both light and dark palettes must be checked");
  let inherited = {};
  for (const [, selector, declarations] of palettes) {
    const colors = { ...inherited, ...Object.fromEntries([...declarations.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]])) };
    const theme = selector.includes('data-theme="dark"') ? "dark" : "light";
    for (const background of ["bg", "surface", "surface-soft"]) {
      for (const text of ["text", "text-soft", "muted"]) {
        const ratio = contrastRatio(colors[text], colors[background]);
        assert.ok(ratio >= 4.5, `${theme} ${text} on ${background}: ${ratio.toFixed(2)}:1`);
      }
    }
    for (const [foreground, background] of [["accent-contrast", "accent"], ["sidebar-text", "sidebar-bg"], ["sidebar-muted", "sidebar-bg"]]) {
      const ratio = contrastRatio(colors[foreground], colors[background]);
      assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
    inherited = colors;
  }
});
