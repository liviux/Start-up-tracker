"use strict";

// The pure parts of the run view (js/agents-page.js) and of Settings > AI
// agents (js/agents-settings.js).
const assert = require("node:assert/strict");
const test = require("node:test");
const Page = require("../public/js/agents-page.js");
const SettingsUi = require("../public/js/agents-settings.js");
const Api = require("../public/js/api.js");

test("the conversation joins chunks, merges tool call updates and drops repeated events", () => {
  const events = [
    { seq: 1, type: "status", data: { status: "queued" } },
    { seq: 2, type: "message", data: { role: "user", text: "Find grants" } },
    { seq: 3, type: "chunk", data: { role: "thought", text: "Let me " } },
    { seq: 4, type: "chunk", data: { role: "thought", text: "think." } },
    { seq: 5, type: "chunk", data: { role: "agent", text: "Working" } },
    { seq: 6, type: "chunk", data: { role: "agent", text: " on it." } },
    { seq: 7, type: "tool_call", data: { toolCallId: "t1", title: "Create a target", kind: "other", status: "in_progress" } },
    { seq: 8, type: "tool_call_update", data: { toolCallId: "t1", title: "", kind: "", status: "completed" } },
    { seq: 9, type: "chunk", data: { role: "agent", text: "Done." } },
    { seq: 10, type: "plan", data: { entries: [{ content: "Search", status: "in_progress" }] } },
    { seq: 11, type: "plan", data: { entries: [{ content: "Search", status: "completed" }] } },
    { seq: 12, type: "permission", data: { id: "p1", title: "Edit", kind: "edit", options: [], decision: "" } },
    { seq: 13, type: "permission", data: { id: "p1", title: "Edit", kind: "edit", options: [], decision: "yes", decidedBy: "you" } },
    { seq: 14, type: "usage", data: { used: 10, size: 100 } },
    { seq: 15, type: "status", data: { status: "done", stopReason: "end_turn", jsonFallback: true } },
  ];
  const model = Page.conversation(events);
  assert.deepEqual(model.entries.map((entry) => entry.type), ["message", "thought", "message", "tool", "message", "plan", "permission", "status"]);
  assert.equal(model.entries[1].text, "Let me think.");
  assert.equal(model.entries[2].text, "Working on it.");
  assert.deepEqual([model.entries[3].title, model.entries[3].kind, model.entries[3].status], ["Create a target", "other", "completed"], "an update keeps what it does not repeat");
  assert.equal(model.entries[4].text, "Done.", "text after a tool call is a new message");
  assert.equal(model.entries[5].entries[0].status, "completed");
  assert.equal(model.entries[6].decision, "yes");
  assert.deepEqual(model.usage, { used: 10, size: 100 });
  assert.equal(model.status, "done");
  assert.equal(model.jsonFallback, true);
  assert.equal(model.lastSeq, 15);
  // Replaying the stream after a reconnect changes nothing.
  const again = events.reduce(Page.applyEvent, model);
  assert.equal(again.entries.length, 8);
  assert.equal(again.entries[2].text, "Working on it.");
});

test("idle until the next update", () => {
  const model = Page.conversation([{ seq: 1, type: "idle", data: { minutes: 10 } }]);
  assert.equal(model.idle, true);
  Page.applyEvent(model, { seq: 2, type: "chunk", data: { role: "agent", text: "Still here" } });
  assert.equal(model.idle, false);
});

test("durations, model choices and the run dialog's checks", () => {
  assert.equal(Page.duration("2026-10-20T10:00:00Z", "2026-10-20T10:00:12Z"), "12 s");
  assert.equal(Page.duration("2026-10-20T10:00:00Z", "2026-10-20T10:03:05Z"), "3 min 5 s");
  assert.equal(Page.duration("2026-10-20T10:00:00Z", "2026-10-20T11:04:00Z"), "1 h 4 min");
  assert.equal(Page.duration("", ""), "");
  const choices = Page.modelChoices({ models: [{ value: "a", name: "A" }, { value: "b", name: "B" }], preferredModels: ["b", "custom-id"] });
  assert.deepEqual(choices.map((model) => [model.value, model.preferred]), [["b", true], ["custom-id", true], ["a", false]]);
  assert.deepEqual(Page.modelChoices({}), []);
  const harness = { name: "Fake", blocked: false };
  assert.equal(Page.dialogChecks({ unresolved: [], constraints: "Only EU", harness }).canStart, true);
  const unresolved = Page.dialogChecks({ unresolved: ["SECTOR"], constraints: "x", harness });
  assert.equal(unresolved.canStart, false);
  assert.equal(unresolved.blocking[0].params.names, "{{SECTOR}}");
  const empty = Page.dialogChecks({ unresolved: [], constraints: " ", harness });
  assert.equal(empty.canStart, true, "an empty CONSTRAINTS text only warns");
  assert.equal(empty.warnings[0].key, "agents.dialog.noConstraints");
  assert.equal(Page.dialogChecks({ harness: { name: "x", blocked: true }, constraints: "c" }).canStart, false);
  assert.equal(Page.dialogChecks({ harness, constraints: "c", placeholderLeft: true }).canStart, false);
  assert.equal(Page.dialogChecks({ constraints: "c" }).canStart, false, "no agent picked");
  assert.match(Page.logLine(JSON.stringify({ at: "2026-10-20T10:00:01.000Z", kind: "rpc", direction: "out", text: "{}" })), /^10:00:01 → \{\}$/);
  assert.equal(Page.logLine("not json"), "not json");
});

test("Settings helpers: arguments, environment lines, check states, registry search", () => {
  assert.deepEqual(SettingsUi.parseArgs("--acp --name \"two words\" 'x y'"), ["--acp", "--name", "two words", "x y"]);
  assert.equal(SettingsUi.formatArgs(["--acp", "two words"]), "--acp \"two words\"");
  assert.deepEqual(SettingsUi.parseEnv("API_KEY=abc=def\n\nOTHER=***\nbad line"), { env: { API_KEY: "abc=def", OTHER: "***" }, problems: ["bad line"] });
  assert.equal(SettingsUi.formatEnv({ A: "***" }), "A=***");
  assert.equal(SettingsUi.checkState({}), "unchecked");
  assert.equal(SettingsUi.checkState({ lastCheck: { state: "ready" } }), "ready");
  const agents = [{ id: "b", name: "Beta", description: "code", installed: false }, { id: "a", name: "Alpha", description: "chat", installed: false }, { id: "z", name: "Zed", description: "code", installed: true }];
  assert.deepEqual(SettingsUi.filterAgents(agents, "").map((agent) => agent.id), ["z", "a", "b"], "installed first, then by name");
  assert.deepEqual(SettingsUi.filterAgents(agents, "code").map((agent) => agent.id), ["z", "b"]);
});

test("an agent card prefers the version its check reported to the catalog's", () => {
  const binary = { kind: "binary", registryVersion: "1.86.3", lastCheck: { state: "ready", agentInfo: { version: "1.88.1" } } };
  assert.equal(SettingsUi.harnessVersion(binary), "1.88.1");
  assert.equal(SettingsUi.harnessVersion({ ...binary, lastCheck: { state: "failed", agentInfo: { version: "1.88.1" } } }), "1.88.1", "a failed test prompt still read the installed version");
  assert.equal(SettingsUi.harnessVersion({ kind: "binary", registryVersion: "1.86.3", lastCheck: null }), "", "the catalog version is not the installed one");
  assert.equal(SettingsUi.harnessVersion({ kind: "npx", registryVersion: "1.2.3", lastCheck: null }), "1.2.3", "the registry pins the package version");
  assert.equal(SettingsUi.harnessVersion({ kind: "npx", registryVersion: "1.2.3", lastCheck: { agentInfo: { version: "1.2.4" } } }), "1.2.4");
  assert.equal(SettingsUi.harnessVersion({ kind: "custom", registryVersion: "" }), "");
  assert.equal(SettingsUi.harnessVersion({}), "");
});

test("the add list shows an installed agent's version, not the registry's", () => {
  const commandCode = { kind: "binary", version: "1.86.3", installed: true, installedBin: "command-code" };
  assert.equal(SettingsUi.registryAgentVersion(commandCode, { kind: "binary", registryVersion: "1.86.3", lastCheck: { agentInfo: { version: "1.88.1" } } }), "1.88.1");
  assert.equal(SettingsUi.registryAgentVersion(commandCode, null), "", "an installed binary has no known version before a check");
  assert.equal(SettingsUi.registryAgentVersion({ ...commandCode, installed: false }, null), "1.86.3", "the registry version is what would be installed");
  assert.equal(SettingsUi.registryAgentVersion({ kind: "npx", version: "1.2.3", installed: true, installedBin: "agent" }, null), "", "an installed package has no known version before a check");
  assert.equal(SettingsUi.registryAgentVersion({ kind: "npx", version: "1.2.3", installed: true, installedBin: "" }, null), "1.2.3", "a native CLI found for an adapter still runs the registry package");
  assert.equal(SettingsUi.registryAgentVersion({ kind: "npx", version: "1.2.3", installed: false }, { kind: "npx", registryVersion: "1.2.3", lastCheck: null }), "1.2.3");
  assert.equal(SettingsUi.registryAgentVersion({ kind: "npx", version: "1.2.3", installed: false }, { kind: "npx", registryVersion: "1.2.3", lastCheck: { agentInfo: { version: "1.2.4" } } }), "1.2.4");
  assert.equal(SettingsUi.registryAgentVersion({}, null), "");
});

test("the run window's address", () => {
  assert.equal(Api.parseStartupId("/s/acme-0001/agents/run-abc123def"), "acme-0001");
  assert.equal(Api.parseRunId("/s/acme-0001/agents/run-abc123def"), "run-abc123def");
  assert.equal(Api.parseRunId("/s/acme-0001/"), "");
  assert.equal(Api.parseStartupId("/s/acme-0001/agents/other"), "");
  assert.equal(Api.runPageUrl("acme-0001", "run-abc123def"), "/s/acme-0001/agents/run-abc123def");
  assert.throws(() => Api.urls.agentRun("../x"), /run id/);
  assert.equal(Api.urls.agentRunEvents("run-abc123def", 5), "/api/agent-runs/run-abc123def/events?after=5");
  assert.equal(Api.urls.agentRunLog("run-abc123def", { download: true }), "/api/agent-runs/run-abc123def/log?download=1");
});
