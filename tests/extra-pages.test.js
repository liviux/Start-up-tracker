"use strict";

// Extra's layout (public/index.html) and the AI page's Add (public/app.js):
// the page order, one header on every page, and a new AI entry that opens
// for editing and is saved with the shared data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const markup = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const extra = markup.slice(markup.indexOf('id="extraView"'), markup.indexOf('id="companyView"'));

test("Extra lists AI, Prompts, Media, Feedback, Research links, then Customize", () => {
  const order = [...extra.matchAll(/data-extra-tab="(\w+)"|data-i18n="extra\.customize"/g)].map((match) => match[1] || "|customize|");
  assert.deepEqual(order, ["ai", "prompts", "media", "feedback", "research", "|customize|", "campaigns", "tags", "categories", "fields"]);
  assert.doesNotMatch(extra, /Sub-taburi/);
});

test("every Extra page has the same header: title, count, and a filter and Add where it lists records", () => {
  const pages = [...extra.matchAll(/<div class="extra-subpage" id="extraSubpage(\w+)"/g)].map((match) => match[1].toLowerCase());
  assert.deepEqual(pages.sort(), ["ai", "campaigns", "categories", "feedback", "fields", "media", "prompts", "research", "tags"]);
  for (const page of pages) {
    const header = extra.match(new RegExp(`<header class="extra-page-header" data-extra-header="${page}">([\\s\\S]*?)</header>`))?.[1];
    assert.ok(header, `${page} has the header`);
    assert.match(header, /<h3[^>]*>[^<]+<\/h3>/, `${page} title`);
    assert.match(header, new RegExp(`data-extra-count="${page}"`), `${page} count`);
    if (["ai", "media", "feedback", "research", "campaigns", "tags"].includes(page)) {
      assert.match(header, /<input id="\w+SearchInput" type="search" placeholder="[^"]+" aria-label="[^"]+"[^>]*>/, `${page} filter`);
      assert.match(header, new RegExp(`data-extra-add="${page}"`), `${page} Add`);
      assert.match(source, new RegExp(`\\n    ${page}: \\(\\) => `), `${page} Add does something`);
    }
  }
  assert.match(source, /function extraEmptyStateHtml\(title, hint\)/);
});

test("Add on the AI page creates an entry, opens it and saves it with the shared data", () => {
  const add = source.match(/function addAiAccount\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(add, /normalizeAiAccount\(\{ id: makeId\(\), kind: "subscription", name: t\("extra\.ai\.newEntry"\) \}\)/);
  assert.match(add, /state\.aiAccounts\.unshift\(account\)/);
  assert.match(add, /state\.editingAiAccountId = account\.id/);
  assert.match(add, /persist\(/);
  const shared = source.match(/function collectGlobalSections\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(shared, /aiAccounts: state\.aiAccounts/);
  assert.match(shared, /aiSettings: state\.aiSettings/);
  // persist() hands shared data to its channel.
  assert.match(source, /async function persist\(message = t\("app\.persist\.saved"\)\) \{\s*markDataChanged\(\);\s*\/\/[^\n]*\n\s*globalChannel\?\.schedule\(\);/);
  // The rate is edited on the page and remembers when.
  const rate = source.match(/function updateAiRate\(value\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(rate, /state\.aiSettings = \{ usdToRon: rate, rateUpdatedAt: new Date\(\)\.toISOString\(\) \}/);
  assert.match(source, /const usdToRon = state\.aiSettings\.usdToRon;/);
});
