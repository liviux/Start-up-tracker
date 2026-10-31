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
  assert.deepEqual(order, ["ai", "prompts", "media", "feedback", "research", "|customize|", "campaigns", "tags", "categories"]);
  assert.doesNotMatch(extra, /Sub-taburi/);
});

test("every Extra page has the same header: title, count, and a filter and Add where it lists records", () => {
  const pages = [...extra.matchAll(/<div class="extra-subpage" id="extraSubpage(\w+)"/g)].map((match) => match[1].toLowerCase());
  assert.deepEqual(pages.sort(), ["ai", "campaigns", "categories", "feedback", "media", "prompts", "research", "tags"]);
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
  // The totals use one or two chosen currencies, and each subscription has
  // its own currency.
  const settings = source.match(/function normalizeAiSettings\(value\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(settings, /currencies = saved\.length \? saved : \["RON", "USD"\]/);
  assert.match(source, /costCurrency: aiCurrencyCode\(account\.costCurrency\) \|\| inferAiCurrency\(account\.cost\)/);
  const totals = source.match(/function calculateSubscriptionTotals\(accounts\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(totals, /const currencies = state\.aiSettings\.currencies/);
  assert.match(totals, /aiConversionRate\(from, to\)/);
  assert.match(source, /data-ai-field="costCurrency"/);
  // Changing a chosen currency resets the rate for the new pair and fetches
  // it again.
  const currency = source.match(/function updateAiCurrency\(index, value\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(currency, /currencies\[0\] = code|currencies\.reverse\(\)/);
  assert.match(currency, /rateFrom: currencies\[0\],\s*rateTo: currencies\[1\],\s*rate: 0/);
  assert.match(currency, /refreshAiRate\(\{ auto: true \}\)/);
  // A fetched rate is taken for the chosen pair once a day and kept in the
  // shared settings, with the date the service used.
  const refresh = source.match(/async function refreshAiRate\(\{ auto = false \} = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(refresh, /Api\.urls\.exchangeRate\(pair\.from, pair\.to, \{ refresh: !auto \}\)/);
  assert.match(refresh, /rateFrom: pair\.from,\s*rateTo: pair\.to,/);
  assert.match(source, /AI_RATE_REFRESH_MS = 24 \* 60 \* 60 \* 1000/);
});

test("every tag usage group collapses by default and pages at 25", () => {
  assert.match(source, /TAG_USAGE_PAGE_SIZE = 25/);
  const render = source.match(/function renderTagUsageSections\(record\) \{[\s\S]*?\n  \}\n\n  function renderLinkedTargetList/)?.[0] || "";
  for (const group of ['group: "targets"', 'group: "programs"', 'group: "funding"', 'group: "media"', 'group: "campaigns"', 'group: "feedback"']) {
    assert.ok(render.includes(group), `${group} is its own collapsible group`);
  }
  assert.match(source, /function renderTagUsageGroup\(\{ tagId, group, title, items, emptyText, renderItems \}\)/);
  assert.match(source, /const pageItems = items\.slice\(start, start \+ TAG_USAGE_PAGE_SIZE\)/);
  assert.match(source, /data-tag-usage-page=/);
  assert.match(source, /state\.tagUsagePages\[usagePage\.dataset\.tagUsagePage\]/);
});

test("Extra's Media, Feedback, Campaigns and Tags keep their add form closed until Add", () => {
  for (const page of ["media", "feedback", "campaigns", "tags"]) {
    assert.match(extra, new RegExp(`data-extra-form="${page}"`), `${page} layout`);
    assert.match(extra, new RegExp(`data-extra-form-close="${page}"`), `${page} close button`);
    assert.match(source, new RegExp(`${page}: \\(\\) => openExtraForm\\("${page}",`), `${page} Add opens the form`);
  }
  assert.match(source, /function openExtraForm\(page, input\) \{[\s\S]*classList\.add\("is-form-open"\)/);
  assert.match(source, /function closeExtraForm\(page\) \{[\s\S]*classList\.remove\("is-form-open"\)/);
});
