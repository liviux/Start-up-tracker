"use strict";

// The field registry as the target window uses it (public/js/fields.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Fields = require("../public/js/fields.js");

const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "fields", `${name}.json`), "utf8"));
Fields.setRegistry({ common: read("common"), mk: read("mk"), po: read("po"), fu: read("fu") });
Fields.setCustomFields([]);
const field = (section, key) => Fields.findField(section, key);

test("core fields read and write the keys each section already stores", () => {
  const item = { platform: "Launch post", date: "2026-11-02", time: "09:30", link: "https://example.com/post" };
  assert.equal(Fields.getValue("mk", item, field("mk", "name")), "Launch post");
  assert.equal(Fields.getValue("mk", item, field("mk", "nextActionDate")), "2026-11-02");
  Fields.setValue("mk", item, field("mk", "name"), "  Launch thread ");
  assert.equal(item.platform, "Launch thread");
  assert.equal(item.name, undefined, "no second copy under the common name");

  const funding = { funder: "Example Angels", opportunity: "Pre-seed", askAmount: 50000, askCurrency: "EUR", probability: 40 };
  assert.equal(Fields.getValue("fu", funding, field("fu", "name")), "Pre-seed");
  assert.equal(Fields.getValue("fu", funding, field("fu", "organization")), "Example Angels");
  assert.deepEqual(Fields.getValue("fu", funding, field("fu", "askAmount")), { amount: 50000, currency: "EUR" });
  assert.equal(Fields.getValue("fu", funding, field("fu", "probabilityPercent")), 40);
  Fields.setValue("fu", funding, field("fu", "askAmount"), { amount: "75000", currency: "usd" });
  assert.equal(funding.askAmount, 75000);
  assert.equal(funding.askCurrency, "USD");

  const program = { applicationLink: "https://example.com/apply" };
  assert.equal(Fields.getValue("po", program, field("po", "link")), "https://example.com/apply");
  Fields.setValue("po", program, field("po", "referenceId"), "CALL-7");
  assert.deepEqual(program.details, { referenceId: "CALL-7" }, "detail fields live in details");
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

test("older keys with one new home move once, only into empty fields", () => {
  const program = { id: "p1", details: { refCallId: "REF-1", appId: "A-9", providerOrg: "City Hub", roEligible: "Yes", probability: 30, incorpReq: "maybe" }, extraParams: { learnings: "Apply early." } };
  const { record, changed } = Fields.migrate("po", program);
  assert.equal(changed, true);
  assert.equal(record.details.referenceId, "REF-1");
  assert.equal(record.details.applicationId, "A-9");
  assert.equal(record.details.probabilityPercent, 30);
  assert.equal(record.organization, "City Hub", "a core field moves flat");
  assert.equal(record.details.lessonsLearned, "Apply early.");
  assert.equal(record.details.refCallId, undefined, "the old key goes once its value moved");
  assert.equal(record.details.roEligible, "Yes", "keys without one clear new home stay");
  assert.equal(record.details.incorpReq, "maybe", "a value the new field cannot hold stays where it was");
  assert.equal(program.details.refCallId, "REF-1", "the input record is not changed");
  assert.equal(Fields.migrate("po", record).changed, false, "running it again changes nothing");

  const taken = Fields.migrate("po", { details: { referenceId: "NEW", refCallId: "OLD" } });
  assert.equal(taken.changed, false);
  assert.equal(taken.record.details.refCallId, "OLD", "a filled new field is never overwritten");

  const target = Fields.migrate("mk", { extraParams: { targetAudience: "Solo founders", installs: "120", warmth: "x" } });
  assert.equal(target.record.details.audience, "Solo founders");
  assert.equal(target.record.details.conversions, 120);
  assert.equal(target.record.extraParams.warmth, "x");
});

test("values no field claims are listed as other fields, and claimed ones are not", () => {
  Fields.setCustomFields([{ section: "po", label: "Partner tier", type: "select", options: ["Gold", "Silver"] }]);
  const program = {
    id: "p1", name: "Grant", applicationName: "Main application", applicationLink: "https://example.com",
    details: { referenceId: "R", roEligible: "Unclear", empty: "" },
    extraParams: { cohortFrequency: "Twice a year" },
    custom: { partnerTier: "gold", oldCustom: "kept" },
  };
  const other = Fields.otherFields("po", program).map((entry) => `${entry.place}:${entry.key}`);
  assert.deepEqual(other.sort(), ["custom:oldCustom", "details:roEligible", "extraParams:cohortFrequency", "flat:applicationName"]);
  Fields.setCustomFields([]);
});

test("activity entries keep the shape their records already have", () => {
  const payments = Fields.activities("fu").find((activity) => activity.id === "payments");
  const fieldOf = (key) => payments.fields.find((entry) => entry.key === key);
  const stored = { id: "pay1", amount: 1000, currency: "EUR", status: "Partially Received", date: "2026-12-01", linkedProgramId: "po-1" };
  assert.equal(Fields.readEntryValue(payments, fieldOf("status"), stored), "partially-received");
  assert.equal(Fields.readEntryValue(payments, fieldOf("dueDate"), stored), "2026-12-01");
  const written = Fields.writeEntry(payments, stored, { status: "received", dueDate: "2026-12-05" });
  assert.equal(written.status, "Received");
  assert.equal(written.date, "2026-12-05");
  assert.equal(written.linkedProgramId, "po-1", "keys no field describes stay on the entry");
  const updateLog = Fields.activities("po").find((activity) => activity.id === "updateLog");
  const whatHappened = updateLog.fields.find((entry) => entry.key === "whatHappened");
  assert.equal(Fields.readEntryValue(updateLog, whatHappened, { type: "verification" }), "research");
  assert.equal(Fields.writeEntry(updateLog, {}, { whatHappened: "sent" }).type, "application");
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

test("custom fields are checked before they are kept", () => {
  const made = Fields.validateCustomField({ section: "mk", label: "Partner tier!", type: "select", options: ["Gold", { value: "silver", label: "Silver", description: "Second ring." }] });
  assert.equal(made.key, "partnerTier");
  assert.deepEqual(made.options.map((option) => option.value), ["Gold", "silver"]);
  assert.throws(() => Fields.validateCustomField({ section: "mk", label: "Reach" , key: "reach" }), { code: "keyTaken" });
  assert.throws(() => Fields.validateCustomField({ section: "mk", label: "Tier", key: "partnerTier" }, [made]), { code: "keyTaken" });
  assert.throws(() => Fields.validateCustomField({ section: "mk", label: "Pick", type: "select", options: [] }), { code: "optionsRequired" });
  assert.throws(() => Fields.validateCustomField({ section: "xx", label: "A" }), { code: "badField" });
  assert.throws(() => Fields.validateCustomField({ section: "mk", label: "" }), { code: "labelRequired" });
  assert.throws(() => Fields.validateCustomField({ section: "mk", label: "A", type: "rating" }), { code: "badType" });
  Fields.setCustomFields([made, { section: "mk", label: "" }]);
  assert.deepEqual(Fields.customFields("mk").map((entry) => entry.key), ["partnerTier"], "a broken definition is left out");
  Fields.setCustomFields([]);
});

test("the documents checklist edited in Extra > Fields replaces the shipped one, and null brings it back", () => {
  const shipped = Fields.shippedDocumentChecklist();
  assert.ok(shipped.some((entry) => entry.id === "pitch-deck"));
  Fields.setDocumentChecklist([{ id: "pitch-deck", label: "Deck" }, { id: "bank-letter", label: "Bank letter", description: "From your bank." }]);
  const documents = Fields.activities("po").find((activity) => activity.checklist);
  assert.deepEqual(documents.checklist.map((entry) => entry.label), ["Deck", "Bank letter"]);
  assert.equal(Fields.activities("mk").some((activity) => activity.checklist), false, "only Programs have the checklist");
  Fields.setDocumentChecklist(null);
  assert.deepEqual(Fields.activities("po").find((activity) => activity.checklist).checklist.map((entry) => entry.id), shipped.map((entry) => entry.id));
});
