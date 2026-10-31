"use strict";

// "Import AI results" (public/js/ai-import.js): the pasted reply is checked
// against the field registry, and likely duplicates are flagged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const AiImport = require("../public/js/ai-import.js");
const Fields = require("../public/js/fields.js");

const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "fields", `${name}.json`), "utf8"));
Fields.setRegistry({ common: read("common"), mk: read("mk"), po: read("po"), fu: read("fu") });

const context = {
  Fields,
  isStatus: (id) => ["planned", "scheduled"].includes(id),
  defaultStatus: () => "planned",
  priorities: ["Very High", "High", "Medium", "Low", "Very Low"],
  category: (id) => ({ "mk.launches": { section: "mk" }, "po.grants": { section: "po" } })[id] || null,
  existing: { mk: [{ id: "t1", name: "Clinic Forum", link: "https://www.example.com/forum/" }], po: [], fu: [] },
};

test("the JSON is found in a chat reply, fenced or not", () => {
  assert.equal(AiImport.parse("Sure!\n```json\n{\"targets\":[{\"section\":\"mk\",\"name\":\"A\"}]}\n```\nGood luck").entries.length, 1);
  assert.equal(AiImport.parse("[{\"section\":\"po\",\"name\":\"B\"}]").entries.length, 1);
  assert.match(AiImport.parse("no json here").error, /No JSON/);
  assert.match(AiImport.parse("{\"items\": []}").error, /"targets"/);
  assert.match(AiImport.parse("{\"targets\": [").error, /cut off|JSON/);
});

test("entries are checked against the field registry", () => {
  const rows = AiImport.check([
    { section: "mk", name: "Clinic newsletter", link: "https://example.com/news", nextActionDate: "2026-11-02", priority: "High", status: "scheduled", reach: "1200", inventedKey: 3, categories: ["mk.launches", "po.grants", "nope"], notes: "Weekly." },
    { section: "po", name: "City grant", nextActionDate: "next week", link: "javascript:alert(1)", status: "dreaming", details: { referenceId: "CG-7" } },
    { section: "xx", name: "Wrong" },
    { section: "fu", link: "https://example.com/fund" },
  ], context);
  const [mk, po, wrong, unnamed] = rows;
  assert.equal(mk.ok, true);
  assert.deepEqual(mk.categories, ["mk.launches"]);
  assert.equal(mk.values.nextActionDate, "2026-11-02");
  assert.equal(mk.values.priority, "High");
  assert.equal(mk.values.reach, 1200, "a section field is read with its type");
  assert.ok(mk.warnings.some((text) => /inventedKey/.test(text)));
  assert.ok(mk.warnings.some((text) => /po\.grants.*another section/.test(text)));
  assert.ok(mk.warnings.some((text) => /Unknown category "nope"/.test(text)));
  assert.equal(po.values.nextActionDate, undefined, "a date that is not a date is left out");
  assert.equal(po.values.link, undefined, "only web links");
  assert.equal(po.values.status, "planned", "an unknown status falls back to the default");
  assert.equal(po.values.referenceId, "CG-7", "fields under details are read too");
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems[0], /mk, po or fu/);
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.problems[0], /needs a name/);
});

test("likely duplicates: same link or same name, in the tracker or earlier in the reply", () => {
  const rows = AiImport.check([
    { section: "mk", name: "Another forum", link: "http://example.com/forum" },
    { section: "mk", name: "clinic  forum!", link: "https://example.com/other" },
    { section: "mk", name: "Fresh", link: "https://example.com/fresh" },
    { section: "mk", name: "Fresh again", link: "https://example.com/fresh/" },
    { section: "po", name: "Clinic Forum" },
  ], context);
  assert.deepEqual(rows.map((row) => row.duplicateOf && [row.duplicateOf.where, row.duplicateOf.reason]), [["tracker", "link"], ["tracker", "name"], null, ["import", "link"], null]);
});

test("a checked row becomes a record under the common field names", () => {
  const [row] = AiImport.check([{ section: "mk", name: "Clinic newsletter", nextActionDate: "2026-11-02", link: "https://example.com/news", notes: "Weekly." }], context);
  const record = AiImport.toRecord(row, Fields, { id: "new-1", now: "2026-10-20T10:00:00.000Z" });
  assert.equal(record.name, "Clinic newsletter");
  assert.equal(record.nextActionDate, "2026-11-02");
  assert.equal(record.link, "https://example.com/news");
  assert.equal(record.notes, "Weekly.");
  assert.equal(record.id, "new-1");
  assert.match(AiImport.formatExample("po"), /"section": "po"/);
});
