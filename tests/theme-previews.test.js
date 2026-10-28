// The screenshot tool that fills the theme picker. Only its pure parts are
// tested here; the browser run is a maintenance command.
const assert = require("node:assert/strict");
const test = require("node:test");

const { chromeCandidates, parseServerUrl, previewJobs } = require("../tools/theme-previews.js");

test("the preview server address is read from its first line", () => {
  assert.equal(parseServerUrl("Startup Tracker: http://127.0.0.1:57322/\nData folder: /tmp/x"), "http://127.0.0.1:57322/");
  assert.equal(parseServerUrl("Startup Tracker: http://localhost:8080/\r\n"), "http://localhost:8080/");
  assert.equal(parseServerUrl("nothing yet"), null);
  assert.equal(parseServerUrl(""), null);
});

test("Chrome is looked for in the configured places before the cache", () => {
  const candidates = chromeCandidates({ STARTUP_TRACKER_CHROME: "/opt/chrome" }, "/var/empty");
  assert.equal(candidates[0], "/opt/chrome");
  assert.ok(candidates.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(!candidates.some((entry) => entry.startsWith("/var/empty/.cache")), "a missing cache adds no paths");
});

test("each preview uses the theme's signature mode", () => {
  assert.deepEqual(previewJobs(["studio", "nightshift", "quiet"]), [
    { id: "studio", mode: "light" },
    { id: "nightshift", mode: "dark" },
    { id: "quiet", mode: "light" },
  ]);
  assert.deepEqual(previewJobs(["studio"], { studio: "dark" }), [{ id: "studio", mode: "dark" }]);
});
