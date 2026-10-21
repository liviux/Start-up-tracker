"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { checkTemplate } = require("../lib/company/template-schema");

function template(overrides = {}) {
  return {
    id: "xx-test",
    version: 1,
    country: "XX",
    countryName: "Testland",
    entityType: "Ltd",
    nameLocal: "Test Limited",
    nameEnglish: "Test limited company",
    currency: "EUR",
    bilingual: null,
    subdivision: null,
    disclaimer: "Not legal or tax advice. Check with an accountant or lawyer.",
    verifiedOn: "2026-10-18",
    sources: [{ id: "registry", title: "Register", publisher: "Registry office", url: "https://registry.example.com/", verifiedOn: "2026-10-18" }],
    conditions: [{ id: "has-employees", label: "Has employees", description: "At least one person on payroll." }],
    profileFields: [
      { key: "registrationNumber", label: "Registration number", description: "From the register.", example: "e.g. 000000", type: "text", group: "identity", sensitive: false, includeInDocument: true, sourceIds: ["registry"] },
      { key: "bankAccount", label: "Bank account", description: "Main account.", example: "", type: "text", group: "banking", sensitive: true, includeInDocument: false, sourceIds: [] },
    ],
    people: { roles: [{ id: "director", label: "Director", description: "Runs the company." }], fields: ["name", "role"] },
    setupSteps: [{ id: "register", title: "Register", description: "File the form.", authority: "Registry office", typicalCost: null, dependsOn: [], checkLocally: false, sourceIds: ["registry"] }],
    obligations: [
      { id: "payroll", title: "Payroll return", description: "Monthly.", frequency: "monthly", due: { rule: "relative-to-period-start", months: 1, day: 15 }, conditions: ["has-employees"], subdivisions: [], authority: "Tax office", checkLocally: false, sourceIds: ["registry"] },
      { id: "monthly-fee", title: "Monthly fee", description: "On the 16th.", frequency: "monthly", due: { rule: "fixed-date", day: 16 }, conditions: [], subdivisions: [], authority: "Tax office", checkLocally: false, sourceIds: ["registry"] },
    ],
    expenseCategories: [{ id: "other", label: "Other" }],
    documentTemplate: "# Company\n\nNumber: {{registrationNumber}}\n\n{{people}}\n",
    ...overrides,
  };
}

test("a complete template passes, with the rules the recurrence engine supports", () => {
  const { errors } = checkTemplate(template(), { fileName: "xx-test" });
  assert.deepEqual(errors, []);
});

test("sources, sensitive fields, conditions and due rules are enforced", () => {
  const cases = [
    [{ sources: [] }, /needs at least one source/],
    [{ disclaimer: "Advice." }, /Not legal or tax advice/],
    [{ documentTemplate: "{{bankAccount}} {{people}}" }, /sensitive field/],
    [{ obligations: [{ ...template().obligations[0], conditions: ["unknown"] }] }, /not in conditions/],
    [{ obligations: [{ ...template().obligations[0], due: { rule: "someday" } }] }, /unknown due rule/],
    [{ setupSteps: [{ ...template().setupSteps[0], sourceIds: [] }] }, /no source and checkLocally is not true/],
    [{ setupSteps: [{ ...template().setupSteps[0], typicalCost: { amount: 100, currency: "EUR", note: "", effectiveDate: null } }] }, /effectiveDate/],
  ];
  for (const [overrides, message] of cases) {
    const { errors } = checkTemplate(template(overrides));
    assert.ok(errors.some((error) => message.test(error)), `${message}: ${errors.join(" | ")}`);
  }
  assert.ok(checkTemplate(template(), { fileName: "other" }).errors.some((error) => /does not match the file name/.test(error)));
});
