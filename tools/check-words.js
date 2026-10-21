#!/usr/bin/env node
"use strict";

// Words that must not appear in the interface. Each rule switches on from the
// part of the release plan that removes the word, so the check never fails on
// work that has not happened yet. The old product name is covered by the leak
// check (tools/check-leaks.js), which stores it only as a hash.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Interface copy: the page, the browser code and the translation file.
const UI_FILES = ["public/index.html", "public/app.js", "public/js/startups.js", "public/js/company-page.js", "content/i18n/en.json"];

const RULES = [
  {
    id: "container-name",
    enabled: true, // on since startups replaced the old single container (Part 2)
    description: "The app's container is a \"startup\", never a workspace, business or organisation.",
    pattern: /\b(workspace|business|organisation)\b/gi,
    // Category labels and field names that use these words in their ordinary sense.
    allow: [/workspace and facilities/i, /business plan/i, /business model/i, /business account/i, /business profile/i, /business days?/i, /\borganization\b/i],
    files: UI_FILES,
  },
  {
    id: "srl-outside-template",
    enabled: true, // on since the SRL tab became the Company tab (Part 12)
    description: "\"SRL\" belongs only in the Romanian company template.",
    pattern: /\bSRL\b/g,
    allow: [],
    files: UI_FILES,
  },
];

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function checkWords({ rules = RULES, root = ROOT } = {}) {
  const hits = [];
  for (const rule of rules.filter((r) => r.enabled)) {
    for (const rel of rule.files) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      rule.pattern.lastIndex = 0;
      for (const match of text.matchAll(rule.pattern)) {
        const line = lineAt(text, match.index);
        if (rule.allow.some((allowed) => allowed.test(lines[line - 1]))) continue;
        hits.push({ file: rel, line, rule: rule.id });
      }
    }
  }
  return hits;
}

if (require.main === module) {
  const hits = checkWords();
  for (const hit of hits) console.log(`ERROR ${hit.file}:${hit.line} [${hit.rule}]`);
  console.log(`check-words: ${hits.length} problem(s), ${RULES.filter((r) => r.enabled).length} of ${RULES.length} rule(s) active`);
  process.exitCode = hits.length ? 1 : 0;
}

module.exports = { RULES, checkWords };
