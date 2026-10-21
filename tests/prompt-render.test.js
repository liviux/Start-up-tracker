"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { render, variablesIn } = require("../public/js/prompt-render.js");

test("only double braces are variables", () => {
  const { text, unresolved } = render("See https://example.com/{section}/x and {{TAB}}.", { TAB: "Marketing" });
  assert.equal(text, "See https://example.com/{section}/x and Marketing.");
  assert.deepEqual(unresolved, []);
});

test("names ignore case and spaces, and old date names still work", () => {
  const { text } = render("{{ startup_name }} on {{TODAY_DATE}} / {{date}}", { STARTUP_NAME: "Northwind", TODAY: "2026-10-18" });
  assert.equal(text, "Northwind on 2026-10-18 / 2026-10-18");
});

test("variables inside values are filled too", () => {
  const { text } = render("Focus: {{SEARCH_FOCUS}}", { SEARCH_FOCUS: "events for {{SECTOR}} near {{HOME_REGION}}", SECTOR: "robotics", HOME_REGION: "Lyon" });
  assert.equal(text, "Focus: events for robotics near Lyon");
});

test("an empty block variable takes its heading with it", () => {
  const template = "# Task\nDo it.\n\n## Constraints\n{{CONSTRAINTS}}\n\n## Search focus\n\n{{SEARCH_FOCUS}}\n\n## Done\nEnd.";
  const { text } = render(template, { CONSTRAINTS: "", SEARCH_FOCUS: "" });
  assert.equal(text, "# Task\nDo it.\n\n## Done\nEnd.");
  assert.match(render(template, { CONSTRAINTS: "Two founders.", SEARCH_FOCUS: "" }).text, /## Constraints\nTwo founders\./);
});

test("an empty value drops a label line but keeps a sentence", () => {
  const { text } = render("- Category: {{CATEGORY}}\n- Type: {{TYPE}}\nLook in {{TYPE}} places too.", { CATEGORY: "Launches", TYPE: "" });
  assert.equal(text, "- Category: Launches\nLook in  places too.");
});

test("unknown names are left in place and reported", () => {
  const { text, unresolved, used } = render("{{STARTUP_NAME}} {{NOT_A_VARIABLE}}", { STARTUP_NAME: "Northwind" });
  assert.equal(text, "Northwind {{NOT_A_VARIABLE}}");
  assert.deepEqual(unresolved, ["NOT_A_VARIABLE"]);
  assert.deepEqual(used, ["STARTUP_NAME"]);
  assert.deepEqual(variablesIn("{{a}} {{ B }} {c} {{date}}"), ["A", "B", "TODAY"]);
});

test("an empty value leaves no dangling comma or empty brackets", () => {
  const { text } = render("- Startup: {{STARTUP_NAME}}, {{STARTUP_ONE_LINER}}\n- Today: {{TODAY}} ({{TIMEZONE}})\n- Links: {{A}}, {{B}}.", { STARTUP_NAME: "Acme", STARTUP_ONE_LINER: "", TODAY: "2026-10-20", TIMEZONE: "", A: "x", B: "" });
  assert.equal(text, "- Startup: Acme\n- Today: 2026-10-20\n- Links: x.");
});
