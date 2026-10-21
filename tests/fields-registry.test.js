"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkFieldRegistry } = require("../lib/fields-schema");

test("the shipped field registry has no errors", () => {
  const { errors, files } = checkFieldRegistry();
  assert.deepEqual(errors, []);
  for (const name of ["common", "mk", "po", "fu"]) assert.ok(files[name].fields.length > 10, name);
});

test("a field without a description or with an undescribed option is an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fields-"));
  try {
    for (const name of ["common", "mk", "po", "fu"]) fs.copyFileSync(path.join(__dirname, "..", "content", "fields", `${name}.json`), path.join(dir, `${name}.json`));
    const mk = JSON.parse(fs.readFileSync(path.join(dir, "mk.json"), "utf8"));
    mk.fields[0].description = "";
    const select = mk.fields.find((field) => field.options);
    select.options[0].description = "";
    fs.writeFileSync(path.join(dir, "mk.json"), JSON.stringify(mk));
    const { errors } = checkFieldRegistry(dir);
    assert.ok(errors.some((error) => error.includes(mk.fields[0].key)), errors.join("\n"));
    assert.ok(errors.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
