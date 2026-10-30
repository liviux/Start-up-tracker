"use strict";

// Effort as a launch flag, for agents that take it no other way (Cline).

const assert = require("node:assert/strict");
const test = require("node:test");
const { launchEffort, launchEffortLevels, withLaunchEffort } = require("../lib/agents/launch-effort");

test("Cline gets --thinking, replacing one typed into its arguments", () => {
  assert.ok(launchEffort({ registryId: "cline" }));
  assert.ok(launchEffort({ kind: "custom", command: "/usr/bin/cline" }));
  assert.equal(launchEffort({ registryId: "codex-acp" }), null);
  assert.equal(launchEffort({ registryId: "toString" }), null);
  assert.deepEqual(launchEffortLevels({ registryId: "cline" }).map((level) => level.name), ["None", "Low", "Medium", "High", "Xhigh"]);
  assert.deepEqual(launchEffortLevels({ registryId: "goose" }), []);
  assert.deepEqual(withLaunchEffort({ registryId: "cline", args: ["--acp", "--thinking", "low", "--x"] }, "high").args, ["--acp", "--x", "--thinking", "high"]);
  assert.deepEqual(withLaunchEffort({ registryId: "cline", args: ["--acp", "--thinking=low", "--thinking", "--y"] }, "xhigh").args, ["--acp", "--y", "--thinking", "xhigh"]);
  const plain = { registryId: "cline", args: ["--acp"] };
  assert.equal(withLaunchEffort(plain, ""), plain, "no effort picked: launched as is");
  assert.equal(withLaunchEffort(plain, "bogus"), plain);
});
