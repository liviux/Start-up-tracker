// The browser helpers behind Settings (Part 3): the settings cache, the
// appearance mirror, the startup icon, link types, the recycle bin and the
// pure parts of the Settings panel.
const assert = require("node:assert/strict");
const test = require("node:test");

const Settings = require("../public/js/settings-store.js");
const Appearance = require("../public/scripts/taste-switcher.js");
const Icon = require("../public/js/startup-icon.js");
const LinkTypes = require("../public/js/link-types.js");
const Recycle = require("../public/js/recycle.js");
const Panel = require("../public/js/settings.js");
const ClientApi = require("../public/js/api.js");
const { DEFAULT_SETTINGS, THEMES } = require("../lib/settings.js");
const { DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, STARTUP_PAIRS, GLOBAL_PAIRS } = require("../lib/recycle-bin.js");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("the browser's defaults are the server's defaults", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(Settings.DEFAULTS)), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  assert.deepEqual([...Appearance.THEMES], [...THEMES]);
});

test("a cached settings copy is read safely and patches merge one level deep", () => {
  assert.deepEqual(Settings.resolve(null), JSON.parse(JSON.stringify(Settings.DEFAULTS)));
  const resolved = Settings.resolve({ appName: "Ops", pageSize: "lots", appearance: { mode: "dark", theme: 3 }, recycleBin: { retentionDays: null }, extra: 1 });
  assert.equal(resolved.appName, "Ops");
  assert.equal(resolved.pageSize, 25, "a value of the wrong type keeps the default");
  assert.deepEqual(resolved.appearance, { mode: "dark", theme: "studio" });
  assert.equal(resolved.recycleBin.retentionDays, null, "null means keep until the bin is emptied");
  assert.equal(resolved.extra, undefined);

  const merged = Settings.merge(Settings.resolve(null), { backups: { keepSafety: 5 }, dateFormat: "yyyy-MM-dd" });
  assert.deepEqual(merged.backups, { automatic: true, intervalHours: 6, keepAutomatic: 20, keepSafety: 5 });
  assert.equal(merged.dateFormat, "yyyy-MM-dd");
});

test("time zone, scope and title follow the settings", () => {
  assert.equal(Settings.effectiveTimeZone({ timeZone: "" }, "Europe/Bucharest"), "Europe/Bucharest");
  assert.equal(Settings.effectiveTimeZone({ timeZone: "Asia/Tokyo" }, "Europe/Bucharest"), "Asia/Tokyo");
  assert.equal(Settings.effectiveTimeZone({ timeZone: "" }, ""), "UTC");
  assert.equal(Settings.defaultScopeChoice({ defaultScope: "startup" }), "this");
  assert.equal(Settings.defaultScopeChoice({ defaultScope: "all" }), "all");
  assert.equal(Settings.defaultScopeChoice({}), "this");
  assert.equal(Settings.pageTitle("Acme", "Ops Desk"), "Acme · Ops Desk");
  assert.equal(Settings.pageTitle("", ""), "Startup Tracker");
});

test("the appearance is mirrored for the first paint, with system as no key", () => {
  const storage = memoryStorage();
  Appearance.writeMirror(storage, { mode: "dark", theme: "quiet" });
  assert.equal(storage.getItem(Appearance.THEME_KEY), "dark");
  assert.equal(storage.getItem(Appearance.TASTE_KEY), "quiet");
  assert.deepEqual(Appearance.readMirror(storage), { mode: "dark", theme: "quiet" });
  Appearance.writeMirror(storage, { mode: "system", theme: "nonsense" });
  assert.equal(storage.getItem(Appearance.THEME_KEY), null, "boot.js then follows the system");
  assert.equal(storage.getItem(Appearance.TASTE_KEY), "studio");
  assert.equal(Appearance.resolveMode("system", true), "dark");
  assert.equal(Appearance.resolveMode("system", false), "light");
  assert.equal(Appearance.resolveMode("light", true), "light");
  // Old saved ids open the new theme that carries their idea.
  assert.equal(Appearance.normalizeTaste("a"), "meridian");
  assert.equal(Appearance.normalizeTaste("b"), "studio");
  assert.equal(Appearance.normalizeTaste("c"), "signal");
  assert.equal(Appearance.normalizeTaste("cyber"), "nightshift");
  assert.equal(Appearance.normalizeTaste("paper"), "broadsheet");
  assert.deepEqual(Appearance.readMirror(memoryStorage({ [Appearance.TASTE_KEY]: "c" })), { mode: "system", theme: "signal" });
  const throwing = { getItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(Appearance.readMirror(throwing), { mode: "system", theme: "studio" });
});

test("a startup without an icon gets a monogram of its initials", () => {
  assert.equal(Icon.initials("Acme Robotics"), "AR");
  assert.equal(Icon.initials("acme"), "AC");
  assert.equal(Icon.initials("  north-star labs "), "NS");
  assert.equal(Icon.initials("Ștefan & Co"), "ȘC");
  assert.equal(Icon.initials("42 Ventures"), "4V");
  assert.equal(Icon.initials(""), "?");
  assert.equal(Icon.initials("!!!"), "?");
  const svg = Icon.monogramSvg("<Evil> & Co");
  assert.match(svg, />EC<\/text>/);
  assert.doesNotMatch(svg, /<Evil>/);
  assert.match(svg, new RegExp(`fill="${Icon.MONOGRAM_BACKGROUND}"`));
  const url = Icon.monogramDataUrl("Acme Robotics");
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(url.split(",")[1], "base64").toString("utf8"), Icon.monogramSvg("Acme Robotics"));
  // An uploaded icon wins; anything that is not an image data URL does not.
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(Icon.iconFor({ name: "Acme", icon: png }), png);
  assert.equal(Icon.iconFor({ name: "Acme", icon: "javascript:alert(1)" }), Icon.monogramDataUrl("Acme"));
  assert.equal(Icon.iconMimeType(png), "image/png");
});

test("icons are PNG, SVG, JPG or ICO and fit 256 px without stretching", () => {
  for (const file of [{ type: "image/png" }, { type: "image/svg+xml" }, { type: "image/jpeg" }, { type: "image/x-icon" }, { type: "image/vnd.microsoft.icon" }, { name: "favicon.ico", type: "" }, { name: "logo.JPG" }]) {
    assert.ok(Icon.isAcceptedIconFile(file), JSON.stringify(file));
  }
  for (const file of [{ type: "image/gif" }, { type: "text/html", name: "x.png" }, { name: "logo.webp" }, null]) {
    assert.ok(!Icon.isAcceptedIconFile(file), JSON.stringify(file));
  }
  assert.deepEqual(Icon.fitSize(512, 256), { width: 256, height: 128, x: 0, y: 64 });
  assert.deepEqual(Icon.fitSize(100, 400), { width: 64, height: 256, x: 96, y: 0 });
  assert.deepEqual(Icon.fitSize(16, 16), { width: 256, height: 256, x: 0, y: 0 });
  assert.deepEqual(Icon.fitSize(0, 0), { width: 256, height: 256, x: 0, y: 0 });
});

test("pasted links get their type from the address", () => {
  const cases = [
    ["https://github.com/example/app", "github"],
    ["gitlab.com/example", "gitlab"],
    ["https://www.linkedin.com/company/example", "linkedinCompany"],
    ["https://linkedin.com/in/someone", "linkedinPerson"],
    ["https://twitter.com/example", "x"],
    ["https://x.com/example", "x"],
    ["https://youtu.be/abc", "youtube"],
    ["https://old.reddit.com/r/example", "reddit"],
    ["https://news.ycombinator.com/item?id=1", "hackerNews"],
    ["https://example.substack.com", "substack"],
    ["https://apps.apple.com/app/id1", "appStore"],
    ["https://chromewebstore.google.com/detail/x", "chromeWebStore"],
    ["https://mastodon.example.com/@someone", "mastodon"],
    ["mailto:hello@example.com", "email"],
    ["tel:+15550100", "phone"],
    ["https://calendly.com/example", "booking"],
    ["https://example.com", ""],
    ["not a url at all", ""],
    ["", ""],
  ];
  for (const [url, type] of cases) assert.equal(LinkTypes.detectLinkType(url), type, url);
  assert.equal(LinkTypes.safeHref("javascript:alert(1)"), "");
  assert.equal(LinkTypes.safeHref("example.com/about"), "https://example.com/about");
  assert.equal(LinkTypes.typeById("nope").id, "other");
  const links = LinkTypes.normalizeLinks([{ type: "github", url: " https://github.com/x " }, { type: "made-up", url: "https://example.com" }, { url: "" }]);
  assert.equal(links.length, 2);
  assert.equal(links[0].url, "https://github.com/x");
  assert.equal(links[1].type, "other");
  assert.ok(links.every((link) => link.id));
  // Every type of appendix A7 has a group and a sprite icon.
  assert.equal(LinkTypes.TYPES.length, 47);
  assert.equal(new Set(LinkTypes.TYPES.map((type) => type.id)).size, LinkTypes.TYPES.length);
  for (const type of LinkTypes.TYPES) assert.match(type.icon, /^[a-z-]+$/);
});

test("the recycle bin pairs are the server's", () => {
  const server = new Map([...STARTUP_PAIRS, ...GLOBAL_PAIRS]);
  for (const kind of Recycle.KINDS) {
    const live = kind.live === "tagDefinitions" ? "tags" : kind.live;
    assert.equal(server.get(live), kind.deleted, `${kind.live} is purged by lib/recycle-bin.js as ${kind.deleted}`);
  }
  for (const section of ["deletedMediaItems", "deletedFeedbackItems", "deletedDailyLinks", "deletedCampaigns", "deletedPrompts", "deletedTags"]) {
    assert.ok(Recycle.DELETED_SECTIONS.includes(section), section);
  }
  const days = Recycle.RETENTION_CHOICES.filter((choice) => choice !== null);
  assert.ok(days.includes(DEFAULT_RETENTION_DAYS));
  assert.ok(days.every((choice) => choice >= MIN_RETENTION_DAYS && choice <= MAX_RETENTION_DAYS));
  assert.ok(Recycle.RETENTION_CHOICES.includes(null));
});

test("soft delete, restore and delete forever move records between the pairs", () => {
  const now = new Date("2026-10-17T08:00:00.000Z");
  const media = [{ id: "m1", title: "Logo" }, { id: "m2", title: "Deck" }];
  const moved = Recycle.moveToBin(media, [{ id: "m0", title: "Old", deletedAt: "2026-10-01T00:00:00.000Z" }], "m1", now);
  assert.deepEqual(moved.live.map((record) => record.id), ["m2"]);
  assert.deepEqual(moved.deleted.map((record) => record.id), ["m1", "m0"]);
  assert.equal(moved.deleted[0].deletedAt, now.toISOString());
  assert.equal(media.length, 2, "the input arrays are not changed");
  const unchanged = Recycle.moveToBin(media, [], "missing", now);
  assert.equal(unchanged.moved, null);

  const later = new Date("2026-10-18T08:00:00.000Z");
  const restored = Recycle.restoreFromBin(moved.live, moved.deleted, "m1", later);
  assert.deepEqual(restored.live.map((record) => record.id), ["m1", "m2"]);
  assert.equal("deletedAt" in restored.live[0], false);
  assert.equal(restored.live[0].updatedAt, later.toISOString());
  assert.deepEqual(restored.deleted.map((record) => record.id), ["m0"]);
  // A restore never duplicates a record that is already back.
  const twice = Recycle.restoreFromBin([{ id: "m1", title: "Again" }], [{ id: "m1", title: "Logo", deletedAt: "x" }], "m1", later);
  assert.deepEqual(twice.live.map((record) => record.id), ["m1"]);
  assert.deepEqual(Recycle.removeFromBin(moved.deleted, "m0").map((record) => record.id), ["m1"]);

  const sections = {
    deletedItems: [{ id: "t1", platform: "Launch post", deletedAt: "2026-10-02T00:00:00Z" }],
    deletedMediaItems: [{ id: "m1", title: "Logo", deletedAt: "2026-10-03T00:00:00Z" }, { id: "m2", deletedAt: "2026-10-04T00:00:00Z" }],
    deletedTags: [{ id: "launch", label: "Launch", deletedAt: "2026-10-01T00:00:00Z" }],
    deletedPrompts: "broken",
  };
  const groups = Recycle.groupBin((section) => sections[section]);
  assert.deepEqual(groups.map((group) => group.group), ["mk", "media", "tags"]);
  assert.deepEqual(groups[1].records.map((record) => [record.id, record.title, record.section]), [["m2", "m2", "deletedMediaItems"], ["m1", "Logo", "deletedMediaItems"]]);
  assert.equal(Recycle.countBin((section) => sections[section]), 4);
});

test("the startup profile is complete and keeps fields it does not know", () => {
  const profile = Panel.normalizeProfile({ oneLiner: "Robots for farms", country: "ro", currency: "eur", maxNewTargetsPerDay: "x", future: { a: 1 } }, LinkTypes.normalizeLinks);
  assert.equal(profile.oneLiner, "Robots for farms");
  assert.equal(profile.country, "RO");
  assert.equal(profile.currency, "EUR");
  assert.equal(profile.maxNewTargetsPerDay, Panel.DEFAULT_MAX_NEW_TARGETS);
  assert.equal(Panel.DEFAULT_MAX_NEW_TARGETS, 10);
  assert.deepEqual(profile.links, []);
  assert.deepEqual(profile.future, { a: 1 });
  assert.equal(Panel.normalizeProfile({ maxNewTargetsPerDay: 0 }).maxNewTargetsPerDay, 0);
  assert.equal(Panel.normalizeProfile({ description: "x".repeat(5000) }).description.length, 4000);
  for (const field of Panel.PROFILE_FIELDS) assert.ok(Object.hasOwn(profile, field), field);
  assert.ok(!Panel.PROFILE_FIELDS.includes("name") && !Panel.PROFILE_FIELDS.includes("icon"));
});

test("the panel lists every section, and the startup ones say so", () => {
  assert.deepEqual(Panel.SECTIONS.map((section) => section.id), ["profile", "startups", "appearance", "general", "statuses", "agents", "backups", "recycle", "about"]);
  assert.deepEqual(Panel.SECTIONS.filter((section) => section.scope === "startup").map((section) => section.id), ["profile", "backups", "recycle"]);
});

test("restore requests name their scope, and records need a tick", () => {
  assert.deepEqual(Panel.buildRestoreRequest("database", "acme-7f3k"), { scope: "database" });
  assert.deepEqual(Panel.buildRestoreRequest("startup", "acme-7f3k"), { scope: "startup", startupId: "acme-7f3k" });
  assert.deepEqual(Panel.buildRestoreRequest("records", "acme-7f3k", [{ section: "items", id: 7 }, { section: "", id: "x" }]), {
    scope: "records",
    startupId: "acme-7f3k",
    records: [{ section: "items", id: "7" }],
  });
  assert.throws(() => Panel.buildRestoreRequest("records", "acme-7f3k", []), RangeError);
  assert.throws(() => Panel.buildRestoreRequest("startup", ""), TypeError);
  assert.throws(() => Panel.buildRestoreRequest("everything", "acme-7f3k"), RangeError);
});

test("comparisons and counts show only what would change", () => {
  const compare = {
    sections: [
      { section: "items", current: 3, backup: 4, added: 1, removed: 0, changed: 0 },
      { section: "programs", current: 2, backup: 2, added: 0, removed: 0, changed: 0 },
      { section: "profile", current: null, backup: null, added: 0, removed: 0, changed: 1 },
    ],
    records: [
      { section: "items", id: "a", change: "added", title: "A" },
      { section: "items", id: "b", change: "removed", title: "B" },
      { section: "profile", id: null, change: "changed", title: "" },
    ],
  };
  assert.deepEqual(Panel.changedSections(compare).map((row) => row.section), ["items", "profile"]);
  assert.deepEqual(Panel.restorableRecords(compare).map((record) => record.id), ["a"]);
  assert.deepEqual(Panel.countsList({ items: 3, deletedItems: 0, profile: null, programs: 2 }), [{ section: "items", count: 3 }, { section: "programs", count: 2 }]);
  assert.equal(Panel.formatBytes(0), "0 B");
  assert.equal(Panel.formatBytes(2048), "2 KB");
  assert.equal(Panel.formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("an import offers what its file allows and sends the right type", () => {
  assert.deepEqual(Panel.importChoices("database", {}), ["database"]);
  assert.deepEqual(Panel.importChoices("export", { startups: [{ id: "a" }] }), ["new", "replace"]);
  assert.deepEqual(Panel.importChoices("export", { startups: [{ id: "a" }, { id: "b" }] }), ["new"]);
  assert.equal(Panel.importContentType("acme.zip"), "application/zip");
  assert.equal(Panel.importContentType("ACME.JSON"), "application/json");
  assert.equal(Panel.importContentType("tracker.sqlite"), "application/octet-stream");
  assert.equal(Panel.importContentType("noext", "application/zip"), "application/zip");
});

test("after an import the page reloads or opens the new startup", async () => {
  const pageUrl = (id) => `/s/${id}/`;
  assert.deepEqual(Panel.pageAfterReplace({ kind: "import", mode: "new", result: { startups: [{ id: "new-1a2b" }] }, pageUrl }), { action: "navigate", url: "/s/new-1a2b/" });
  assert.deepEqual(Panel.pageAfterReplace({ kind: "import", mode: "replace", currentStartupId: "acme-7f3k", pageUrl }), { action: "reload" });
  assert.deepEqual(Panel.pageAfterReplace({ kind: "import", mode: "database", currentStartupId: "acme-7f3k", result: { startups: [{ id: "acme-7f3k" }] }, pageUrl }), { action: "reload" });
  assert.deepEqual(Panel.pageAfterReplace({ kind: "import", mode: "database", currentStartupId: "acme-7f3k", result: { startups: [{ id: "other-0000" }] }, pageUrl }), { action: "navigate", url: "/" });

  const api = ClientApi.createApi({ pathname: "/s/acme-7f3k/" });
  const token = "0123456789abcdef0123456789abcdef"; // gitleaks:allow (a made-up token)
  for (const [mode, body, expected] of [
    ["new", { mode: "new", origin: "ui" }, "assign /s/new-1a2b/"],
    ["replace", { mode: "replace", startupId: "acme-7f3k", origin: "ui" }, "reload"],
  ]) {
    const calls = [];
    const actions = Panel.createBackupActions({
      fetch: async (url, options) => {
        calls.push([url, JSON.parse(options.body)]);
        return { ok: true, status: 200, json: async () => ({ ok: true, imported: { mode, startups: [{ id: mode === "new" ? "new-1a2b" : "acme-7f3k" }] } }) };
      },
      location: { reload: () => calls.push("reload"), assign: (url) => calls.push(`assign ${url}`) },
      api,
      startupId: "acme-7f3k",
    });
    await actions.applyImport(token, mode);
    assert.deepEqual(calls, [[`/api/import/${token}/apply`, body], expected]);
  }

  // The preview sends the file itself as the body, typed by its name.
  const sent = [];
  const actions = Panel.createBackupActions({
    fetch: async (url, options) => {
      sent.push({ url, method: options.method, type: options.headers["Content-Type"], body: options.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, token, kind: "export", preview: { startups: [] } }) };
    },
    location: {},
    api,
    startupId: "acme-7f3k",
  });
  const file = { name: "acme.zip", type: "" };
  await actions.previewImport(file);
  assert.deepEqual(sent, [{ url: "/api/import", method: "POST", type: "application/zip", body: file }]);
});

test("countries, currencies and time zones come from the runtime", () => {
  const countries = Panel.countryOptions("en");
  const codes = new Set(countries.map((country) => country.code));
  for (const code of ["RO", "DE", "US", "JP", "BR"]) assert.ok(codes.has(code), code);
  for (const code of ["EU", "UN", "ZZ", "XA", "QO"]) assert.ok(!codes.has(code), `${code} is not a country`);
  assert.ok(countries.length > 200);
  const currencies = Panel.currencyOptions("en");
  assert.ok(currencies.some((currency) => currency.code === "EUR" && /euro/i.test(currency.name)));
  assert.ok(currencies.every((currency) => /^[A-Z]{3}$/.test(currency.code)));
  const zones = Panel.timeZoneList();
  assert.ok(zones.includes("Europe/Bucharest") && zones.includes("UTC"));
  assert.deepEqual(Panel.filterTimeZones("new york", zones), ["America/New_York"]);
  assert.ok(Panel.filterTimeZones("europe", zones).every((zone) => zone.startsWith("Europe/")));
  assert.equal(Panel.filterTimeZones("", ["A", "B"]).length, 2);
});

test("the status editor's helpers keep ids stable and the list in group order", () => {
  const config = {
    statuses: [
      { id: "new", group: "planned", label: "New" },
      { id: "later", group: "planned", label: "Later" },
      { id: "preparing", group: "in_progress", label: "Preparing" },
    ],
    campaignStatuses: [{ id: "planned", label: "Planned" }, { id: "active", label: "Active" }],
  };
  assert.equal(Panel.statusIdFromLabel("Waiting list", []), "waiting_list");
  assert.equal(Panel.statusIdFromLabel("Năpăstuit!", []), "napastuit");
  assert.equal(Panel.statusIdFromLabel("2nd round", []), "status_2nd_round");
  assert.equal(Panel.statusIdFromLabel("New", ["new", "new_2"]), "new_3");
  assert.match(Panel.statusIdFromLabel("x".repeat(80), []), /^[a-z][a-z0-9_]{0,40}$/);

  const added = Panel.addStatusEntry(config, "statuses", "  Waiting   list ", "planned");
  assert.deepEqual(added.statuses.map((status) => status.id), ["new", "later", "waiting_list", "preparing"], "added after the group's last status");
  assert.deepEqual(added.statuses[2], { id: "waiting_list", group: "planned", label: "Waiting list", description: "", custom: true });
  assert.equal(Panel.addStatusEntry(config, "statuses", "   ", "planned"), config, "an empty name adds nothing");

  const renamed = Panel.updateStatusEntry(added, "statuses", "waiting_list", { label: "Wait list" });
  assert.equal(renamed.statuses[2].id, "waiting_list", "a rename keeps the id");

  assert.deepEqual(Panel.moveStatusEntry(added, "statuses", "waiting_list", -1).statuses.map((status) => status.id), ["new", "waiting_list", "later", "preparing"]);
  assert.equal(Panel.moveStatusEntry(added, "statuses", "waiting_list", 1), added, "never moves into another group");
  assert.deepEqual(Panel.moveStatusEntry(config, "campaignStatuses", "active", -1).campaignStatuses.map((status) => status.id), ["active", "planned"]);

  assert.deepEqual(Panel.statusMoveTargets(added, "statuses", "waiting_list").map((status) => status.id), ["new", "later", "preparing"], "the same group first");
  assert.equal(Panel.canDeleteStatusEntry(added, "statuses", "waiting_list"), true);
  assert.equal(Panel.canDeleteStatusEntry(added, "statuses", "new"), false, "built-ins stay");
  assert.equal(Panel.canDeleteStatusEntry(config, "campaignStatuses", "active"), true);
  assert.equal(Panel.canDeleteStatusEntry({ campaignStatuses: [{ id: "only" }] }, "campaignStatuses", "only"), false);
});
