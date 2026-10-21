"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createZip, listZip, readZip, ZipError } = require("../lib/backups/zip");
const { handMadeZip } = require("./helpers/zip");

test("a written archive reads back byte for byte", () => {
  const random = require("node:crypto").randomBytes(4096);
  const entries = [
    { name: "manifest.json", data: JSON.stringify({ hello: "wörld" }) },
    { name: "sections/items.json", data: "[]".repeat(2000) },
    { name: "media/photo.bin", data: random },
    { name: "empty.txt", data: "" },
  ];
  const archive = createZip(entries);
  const read = readZip(archive);
  assert.deepEqual(read.map((entry) => entry.name), entries.map((entry) => entry.name));
  for (const [index, entry] of entries.entries()) {
    const expected = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    assert.ok(read[index].data.equals(expected), entry.name);
  }
  const listed = listZip(archive);
  assert.equal(listed.find((entry) => entry.name === "media/photo.bin").method, 0, "incompressible data is stored");
  assert.equal(listed.find((entry) => entry.name === "sections/items.json").method, 8, "text is deflated");
});

test("other zip tools can read what it writes", (t) => {
  if (spawnSync("unzip", ["-v"]).status !== 0) {
    t.skip("unzip is not installed");
    return;
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zip-test-"));
  try {
    const file = path.join(folder, "export.zip");
    fs.writeFileSync(file, createZip([{ name: "a/b.json", data: "{\"ok\":true}" }]));
    const result = spawnSync("unzip", ["-p", file, "a/b.json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{\"ok\":true}");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("names that leave the archive are refused on both sides", () => {
  for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/x", "a\\b", "a//b"]) {
    assert.throws(() => createZip([{ name, data: "x" }]), ZipError, name);
    assert.throws(() => listZip(handMadeZip({ name })), ZipError, name);
  }
});

test("symbolic links, oversized and lying entries are refused", () => {
  assert.throws(() => listZip(handMadeZip({ name: "link", mode: 0o120777 })), { code: "symlink" });
  assert.throws(() => listZip(createZip([{ name: "big.txt", data: "a".repeat(5000) }]), { maxEntryBytes: 1000 }), { code: "entryTooLarge" });
  assert.throws(() => listZip(createZip([{ name: "a.txt", data: "a".repeat(600) }, { name: "b.txt", data: "b".repeat(600) }]), { maxTotalBytes: 1000 }), { code: "tooLarge" });
  assert.throws(() => listZip(createZip([{ name: "a", data: "1" }, { name: "b", data: "2" }]), { maxEntries: 1 }), { code: "tooManyEntries" });
  assert.throws(() => readZip(handMadeZip({ name: "x.txt", data: Buffer.from("hello"), claimedSize: 3 })), { code: "corrupt" });
  const archive = createZip([{ name: "x.txt", data: "hello" }]);
  archive[archive.indexOf("hello")] = "j".charCodeAt(0);
  assert.throws(() => readZip(archive), { code: "badChecksum" });
  assert.throws(() => listZip(Buffer.from("not a zip at all, just text padding it out")), { code: "notZip" });
  assert.throws(() => createZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), { code: "duplicateEntry" });
});

test("a deflate bomb stops at the cap", () => {
  const zlib = require("node:zlib");
  const huge = Buffer.alloc(20 * 1024 * 1024);
  const compressed = zlib.deflateRawSync(huge);
  // Claims a tiny size; the reader must not inflate past it.
  const archive = handMadeZip({ name: "bomb.bin", data: compressed, method: 8, claimedSize: 10 });
  assert.throws(() => readZip(archive), ZipError);
});
