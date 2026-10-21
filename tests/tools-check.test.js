"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkWords, RULES } = require("../tools/check-words");
const { validateTranslations } = require("../tools/check-content");
const { checkCss, scanFile } = require("../tools/check-css");

test("banned words: an enabled rule flags the word and its allowlist lets real labels through", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "words-"));
  try {
    fs.mkdirSync(path.join(root, "public"));
    fs.writeFileSync(path.join(root, "public", "index.html"), "<h1>Your workspace</h1>\n<li>Workspace and facilities</li>\n<label>Organization</label>\n");
    const rule = { ...RULES.find((r) => r.id === "container-name"), enabled: true, files: ["public/index.html"] };
    const hits = checkWords({ rules: [rule], root });
    assert.deepEqual(hits.map((hit) => hit.line), [1]);
    assert.deepEqual(checkWords({ rules: [{ ...rule, enabled: false }], root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("translation files must be nested strings or plural objects with an other form", () => {
  const ok = [];
  validateTranslations({ app: { name: "Startup Tracker", targets: { one: "{count} target", other: "{count} targets" } } }, ok);
  assert.deepEqual(ok, []);
  const bad = [];
  validateTranslations({ app: { count: { one: "x" }, broken: 4 } }, bad);
  assert.equal(bad.length, 2);
});

test("the CSS checker reports unclosed comments and braces, and the shipped bundle is clean", () => {
  const problems = [];
  scanFile({ file: path.join(os.tmpdir(), "x.css"), css: "a { color: red; /* open\n" }, problems);
  assert.ok(problems.some((p) => /comment is never closed/.test(p)));
  const braces = [];
  scanFile({ file: path.join(os.tmpdir(), "y.css"), css: "a { color: red;\n" }, braces);
  assert.ok(braces.some((p) => /unclosed brace/.test(p)));
  assert.deepEqual(checkCss().problems, []);
});
