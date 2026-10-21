"use strict";

// tools/check-i18n.js: UI text written straight into the page or a template
// is flagged; text from en.json, data and codes are not.
const assert = require("node:assert/strict");
const test = require("node:test");
const { checkMarkup, checkScript, checkFiles, defaultFiles } = require("../tools/check-i18n");

test("markup: text and text attributes need a data-i18n binding", () => {
  const problems = checkMarkup([
    "<h2 data-i18n=\"a.b\">Calendar</h2>",
    "<p>Plain words</p>",
    "<button aria-label=\"Close\" data-i18n-aria-label=\"x.close\"></button>",
    "<input placeholder=\"Search here\">",
    "<span data-app-name>Startup Tracker</span>",
    "<svg><title>Icon</title></svg>",
    "<span>EUR</span><span>42</span>",
  ].join("\n"));
  assert.deepEqual(problems.map((problem) => [problem.line, problem.text]), [[2, "Plain words"], [4, "placeholder=\"Search here\""]]);
});

test("scripts: template text, text attributes and dialog messages", () => {
  const source = [
    "const a = `<h3>${escapeHtml(t(\"k\"))}</h3><p>${name}</p>`;",
    "const b = `<h3>Funding rounds</h3>`;",
    "const c = `<button title=\"Delete it\"></button>`;",
    "window.confirm(\"Delete this?\");",
    "window.confirm(t(\"k.confirm\"));",
    "const d = `<span class=\"x\">COMP</span>`;",
    "const e = `<b>Fixed</b>`; // i18n-ignore",
  ].join("\n");
  assert.deepEqual(checkScript(source, "x.js").map((problem) => problem.line), [2, 3, 4]);
});

test("the page and the browser scripts have no hard-coded UI text", () => {
  const files = defaultFiles();
  assert.ok(files.some((file) => file.endsWith("app.js")) && files.some((file) => file.endsWith("index.html")));
  assert.deepEqual(checkFiles(files), []);
});
