"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseReleases, renderReleases } = require("../public/js/changelog.js");

test("the changelog parser keeps releases, dates and grouped bullets", () => {
  const releases = parseReleases(`# Changelog

## [0.2.0] - 2026-10-28

### Added
- A version link opens the changelog.
- A **bold** line and \`code\`.

### Fixed
- A small bug.

## [0.1.0] - 2026-10-21

### Added
- The first release.
`);

  assert.equal(releases.length, 2);
  assert.deepEqual(releases[0], {
    version: "0.2.0",
    date: "2026-10-28",
    groups: [
      { title: "Added", items: ["A version link opens the changelog.", "A **bold** line and `code`."] },
      { title: "Fixed", items: ["A small bug."] },
    ],
  });
  assert.equal(releases[1].version, "0.1.0");
  assert.equal(releases[1].date, "2026-10-21");
});

test("rendered changelog entries escape text and keep simple formatting", () => {
  const html = renderReleases([
    {
      version: "0.2.0",
      date: "2026-10-28",
      groups: [{ title: "Added", items: ["A <script>alert(1)</script> entry with **bold** and `code`."] }],
    },
  ]);

  assert.match(html, /<section class="release-entry">/);
  assert.match(html, /v0\.2\.0/);
  assert.match(html, /2026-10-28/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.doesNotMatch(html, /<script>/);
});
