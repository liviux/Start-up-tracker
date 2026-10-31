"use strict";

// The field registry as the target window uses it (public/js/fields.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Fields = require("../public/js/fields.js");

const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "fields", `${name}.json`), "utf8"));
Fields.setRegistry({ common: read("common"), mk: read("mk"), po: read("po"), fu: read("fu") });
const field = (section, key) => Fields.findField(section, key);

test("core fields are stored flat under the same names in every section, detail fields in details", () => {
  for (const section of Fields.SECTIONS) {
    const record = {};
    Fields.setValue(section, record, field(section, "name"), "  Launch thread ");
    Fields.setValue(section, record, field(section, "organization"), "Example Org");
    Fields.setValue(section, record, field(section, "link"), "https://example.com/post");
    Fields.setValue(section, record, field(section, "nextActionDate"), "2026-11-02");
    Fields.setValue(section, record, field(section, "nextActionTime"), "09:30");
    assert.deepEqual(record, { name: "Launch thread", organization: "Example Org", link: "https://example.com/post", nextActionDate: "2026-11-02", nextActionTime: "09:30" }, section);
  }

  const funding = {};
  Fields.setValue("fu", funding, field("fu", "askAmount"), { amount: "75000", currency: "usd" });
  Fields.setValue("fu", funding, field("fu", "probabilityPercent"), "40");
  assert.deepEqual(funding.details, { askAmount: { amount: 75000, currency: "USD" }, probabilityPercent: 40 });
  assert.deepEqual(Fields.getValue("fu", funding, field("fu", "askAmount")), { amount: 75000, currency: "USD" });

  const program = {};
  Fields.setValue("po", program, field("po", "referenceId"), "CALL-7");
  assert.deepEqual(program.details, { referenceId: "CALL-7" });
  Fields.setValue("po", program, field("po", "referenceId"), "");
  assert.deepEqual(program.details, {}, "an emptied detail is removed, not stored as an empty string");
});

test("empty and 0 stay different in number fields", () => {
  const record = {};
  const reach = field("mk", "reach");
  Fields.setValue("mk", record, reach, "0");
  assert.equal(Fields.getValue("mk", record, reach), 0);
  assert.equal(Fields.isEmpty(reach, 0), false);
  Fields.setValue("mk", record, reach, "");
  assert.equal(Fields.getValue("mk", record, reach), null);
  assert.equal(Fields.isEmpty(reach, null), true);
  assert.equal(record.details.reach, undefined);
  assert.equal(Fields.normalize({ type: "percent" }, "130"), 100);
  assert.equal(Fields.normalize({ type: "number" }, "12,500"), 12500);
  assert.equal(Fields.normalize({ type: "number" }, "abc"), null);
});

test("values are normalized by type, and unknown choices are kept", () => {
  assert.equal(Fields.normalize({ type: "tristate" }, true), "yes");
  assert.equal(Fields.normalize({ type: "tristate" }, "No"), "no");
  assert.equal(Fields.normalize({ type: "tristate" }, "maybe"), "");
  assert.equal(Fields.normalize({ type: "datetime" }, "2026-11-02 14:30:00"), "2026-11-02T14:30");
  assert.equal(Fields.normalize({ type: "datetime" }, "2026-11-02"), "2026-11-02");
  assert.equal(Fields.normalize({ type: "date" }, "02/11/2026"), "");
  const relationship = field("fu", "relationship");
  assert.equal(Fields.normalize(relationship, "Warm"), "warm", "matched by label");
  assert.equal(Fields.normalize(relationship, "lukewarm"), "lukewarm", "an unknown value is kept as it is");
  const benefits = field("po", "benefits");
  assert.deepEqual(Fields.normalize(benefits, "Cash, mentoring, coffee"), ["cash", "mentoring", "coffee"]);
  assert.deepEqual(Fields.normalize({ type: "money-range" }, { min: "10000", max: "", currency: "eur" }), { min: 10000, max: null, currency: "EUR" });
});

test("a target's custom fields are text pairs in their order, and empty pairs are dropped", () => {
  const record = { customFields: [{ label: " Post URL ", value: "https://example.com/p/1" }, { label: "", value: "" }, { label: "Upvotes", value: 12 }, { value: "no label" }, "junk"] };
  assert.deepEqual(Fields.customFieldsOf(record), [
    { label: "Post URL", value: "https://example.com/p/1" },
    { label: "Upvotes", value: "12" },
    { label: "", value: "no label" },
  ]);
  assert.deepEqual(Fields.customFieldsOf({}), []);
  assert.equal(Fields.customFieldsOf({ customFields: [{ label: "x".repeat(200), value: "v" }] })[0].label.length, 80);
});

test("activity entries are stored under the activity, with each field's own key and option value", () => {
  const payments = Fields.activities("fu").find((activity) => activity.id === "payments");
  const fieldOf = (key) => payments.fields.find((entry) => entry.key === key);
  const stored = { id: "pay1", amount: 1000, currency: "EUR", status: "partially-received", dueDate: "2026-12-01", note: "kept" };
  assert.equal(Fields.readEntryValue(payments, fieldOf("status"), stored), "partially-received");
  assert.equal(Fields.readEntryValue(payments, fieldOf("dueDate"), stored), "2026-12-01");
  const written = Fields.writeEntry(payments, stored, { status: "Received", dueDate: "2026-12-05" });
  assert.equal(written.status, "received", "a label is read as its option");
  assert.equal(written.dueDate, "2026-12-05");
  assert.equal(written.note, "kept", "keys no field describes stay on the entry");
  assert.deepEqual(Fields.activityEntries({ payments: [stored] }, payments), [stored]);

  const timeline = Fields.activities("po").find((activity) => activity.id === "timeline");
  assert.ok(timeline, "every section has the timeline");
  assert.deepEqual(Fields.activities("po").map((activity) => activity.id), ["timeline"], "Programs have no documents list");
  assert.ok(timeline.fields.find((entry) => entry.key === "type").options.some((option) => option.value === "key-date"));
});

test("examples are placeholders and never become values", () => {
  const html = Fields.inputHtml(field("po", "referenceId"), "");
  assert.match(html, /placeholder="e\.g\./);
  assert.match(html, /value=""/);
  const holder = {
    querySelector: (selector) => (selector === "[data-field-input]" ? { value: "" } : null),
  };
  const container = { querySelector: (selector) => (selector === '[data-field="referenceId"]' ? holder : null) };
  assert.equal(Fields.readInput(field("po", "referenceId"), container), "");
  assert.match(Fields.inputHtml(field("fu", "relationship"), "lukewarm"), /lukewarm \(not in the list\)/);
  assert.match(Fields.inputHtml({ key: "x", type: "text", label: "X" }, "<b>"), /value="&lt;b&gt;"/);
});
