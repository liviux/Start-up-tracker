const assert = require("node:assert/strict");
const test = require("node:test");

const { diffLines, diffWords, groupHunks, summarize } = require("../public/scripts/record-history-diff");

const textOf = (rows, type) => rows.filter((row) => row.type === type).map((row) => row.text);

test("reports no changes for identical text", () => {
  const rows = diffLines("one\ntwo\nthree", "one\ntwo\nthree");
  assert.deepEqual(summarize(rows), { added: 0, removed: 0, changed: false });
  assert.equal(rows.every((row) => row.type === "context"), true);
  assert.equal(groupHunks(rows).unchanged, true);
});

test("treats an append as additions only", () => {
  const rows = diffLines("one\ntwo", "one\ntwo\nthree");
  assert.deepEqual(textOf(rows, "add"), ["three"]);
  assert.deepEqual(textOf(rows, "remove"), []);
  assert.deepEqual(summarize(rows), { added: 1, removed: 0, changed: true });
});

test("treats a deletion as removals only", () => {
  const rows = diffLines("one\ntwo\nthree", "one\nthree");
  assert.deepEqual(textOf(rows, "remove"), ["two"]);
  assert.deepEqual(textOf(rows, "add"), []);
});

test("keeps original line numbers on both sides", () => {
  const rows = diffLines("a\nb\nc", "a\nB\nc");
  const removed = rows.find((row) => row.type === "remove");
  const added = rows.find((row) => row.type === "add");
  assert.equal(removed.beforeLine, 2);
  assert.equal(removed.afterLine, null);
  assert.equal(added.afterLine, 2);
  assert.equal(added.beforeLine, null);
  assert.equal(rows.at(-1).beforeLine, 3);
  assert.equal(rows.at(-1).afterLine, 3);
});

test("diffs text from and to empty", () => {
  assert.deepEqual(textOf(diffLines("", "hello"), "add"), ["hello"]);
  assert.deepEqual(textOf(diffLines("hello", ""), "remove"), ["hello"]);
  assert.deepEqual(summarize(diffLines("", "")), { added: 0, removed: 0, changed: false });
});

test("normalizes CRLF so a line ending change is not a diff", () => {
  const rows = diffLines("one\r\ntwo", "one\ntwo");
  assert.equal(summarize(rows).changed, false);
});

test("handles null and undefined as empty text", () => {
  assert.deepEqual(textOf(diffLines(null, "x"), "add"), ["x"]);
  assert.deepEqual(textOf(diffLines(undefined, undefined), "add"), []);
});

test("attaches word segments to a line edited in place", () => {
  const rows = diffLines("posted on tuesday", "posted on thursday");
  const removed = rows.find((row) => row.type === "remove");
  const added = rows.find((row) => row.type === "add");

  assert.ok(removed.segments, "expected inline segments on the removed line");
  assert.ok(added.segments, "expected inline segments on the added line");
  assert.equal(removed.segments.some((segment) => segment.type === "add"), false);
  assert.equal(added.segments.some((segment) => segment.type === "remove"), false);
  assert.equal(removed.segments.map((segment) => segment.text).join(""), "posted on tuesday");
  assert.equal(added.segments.map((segment) => segment.text).join(""), "posted on thursday");
  assert.deepEqual(
    added.segments.filter((segment) => segment.type === "add").map((segment) => segment.text),
    ["thursday"],
  );
});

test("skips word refinement for two unrelated lines", () => {
  const rows = diffLines("submitted the awesome-list PR", "waiting on legal review");
  const removed = rows.find((row) => row.type === "remove");
  assert.equal(removed.segments, undefined);
});

test("diffWords returns null for dissimilar lines", () => {
  assert.equal(diffWords("alpha beta gamma", "nothing alike here"), null);
});

test("groups nearby changes into one hunk and records the hidden gap", () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  const after = before.replace("line 5", "line five").replace("line 35", "line thirty-five");
  const rows = diffLines(before, after);
  const { hunks, gaps, unchanged } = groupHunks(rows, { contextLines: 3 });

  assert.equal(unchanged, false);
  assert.equal(hunks.length, 2, "two distant edits should stay two hunks");
  assert.ok(gaps.length >= 1, "the untouched middle should be reported as a gap");
  assert.ok(
    gaps.some((gap) => gap.rows.length > 0 && gap.rows.every((row) => row.type === "context")),
    "gap rows should all be unchanged context",
  );
});

test("merges edits that are closer than twice the context", () => {
  const before = "a\nb\nc\nd\ne\nf";
  const after = "a\nB\nc\nd\nE\nf";
  const { hunks } = groupHunks(diffLines(before, after), { contextLines: 3 });
  assert.equal(hunks.length, 1);
});

test("every row appears exactly once across hunks and gaps", () => {
  const before = Array.from({ length: 60 }, (_, index) => `x${index}`).join("\n");
  const after = before.replace("x10", "y10").replace("x50", "y50");
  const rows = diffLines(before, after);
  const { hunks, gaps } = groupHunks(rows, { contextLines: 2 });
  const covered = hunks.reduce((total, hunk) => total + hunk.rows.length, 0)
    + gaps.reduce((total, gap) => total + gap.rows.length, 0);
  assert.equal(covered, rows.length);
});

test("falls back to a replaced block instead of allocating a huge table", () => {
  const before = Array.from({ length: 1600 }, (_, index) => `before ${index}`).join("\n");
  const after = Array.from({ length: 1600 }, (_, index) => `after ${index}`).join("\n");
  const rows = diffLines(before, after);
  const counts = summarize(rows);
  assert.equal(counts.added, 1600);
  assert.equal(counts.removed, 1600);
  assert.equal(rows.some((row) => row.type === "context"), false);
});

test("stays fast on a realistic note append", () => {
  const before = Array.from({ length: 400 }, (_, index) => `- entry ${index}`).join("\n");
  const after = `${before}\n- entry 400`;
  // The quickest of five runs: one run can be slowed by the rest of a
  // parallel test run, the quickest shows what the diff itself costs.
  let rows = [];
  let elapsedMs = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = process.hrtime.bigint();
    rows = diffLines(before, after);
    elapsedMs = Math.min(elapsedMs, Number(process.hrtime.bigint() - started) / 1e6);
  }

  assert.deepEqual(summarize(rows), { added: 1, removed: 0, changed: true });
  assert.ok(elapsedMs < 100, `expected the common-prefix trim to keep this fast, took ${elapsedMs}ms`);
});
