"use strict";

// Agent runs end to end with the fake ACP agent (tests/fixtures/fake-acp-agent.js):
// Settings > AI agents over HTTP, a run that uses the tracker tools, the
// three permission policies, cancel, the event stream, undo, the log, the
// run token's limits, and runs that wait in the queue or go quiet.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { startServer } = require("./helpers/server");
const { browserFetch, sendJson, createStartup, saveOperations } = require("./helpers/api");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const startups = require("../lib/startups");
const harnesses = require("../lib/agents/harnesses");
const { RunManager, decidePermission, redactor, jsonFallback } = require("../lib/agents/runs");

const FIXTURE = path.join(__dirname, "fixtures", "fake-acp-agent.js");
const FINISHED = ["done", "failed", "cancelled", "interrupted"];

async function json(response) {
  const body = await response.json();
  return { status: response.status, ...body };
}

async function addFakeAgent(url, { policy = "allow", env = {} } = {}) {
  const custom = { command: process.execPath, args: [FIXTURE] };
  const unconfirmed = await json(await sendJson(`${url}api/agents/harnesses`, "POST", { custom, name: "Fake" }));
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.code, "confirmNeeded");
  assert.equal(unconfirmed.preview, `${process.execPath} ${FIXTURE}`, "the exact command, before anything is stored");
  const preview = await json(await sendJson(`${url}api/agents/harnesses`, "POST", { custom, name: "Fake", preview: true }));
  assert.deepEqual([preview.status, preview.preview], [200, `${process.execPath} ${FIXTURE}`]);
  const added = await json(await sendJson(`${url}api/agents/harnesses`, "POST", { custom, name: "Fake", confirmed: true }));
  assert.equal(added.status, 201);
  const patched = await json(await sendJson(`${url}api/agents/harnesses/${added.harness.id}`, "PATCH", { policy, env }));
  assert.equal(patched.status, 200, patched.error);
  return patched.harness;
}

async function startRun(url, startupId, harnessId, template, extra = {}) {
  const created = await json(await sendJson(`${url}api/s/${startupId}/agent-runs`, "POST", { harnessId, template, values: {}, title: "Test run", ...extra }));
  assert.equal(created.status, 201, created.error);
  return created.run.id;
}

async function waitFor(url, runId, predicate, timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const body = await json(await browserFetch(`${url}api/agent-runs/${runId}`));
    if (predicate(body)) return body;
    if (Date.now() > until) throw new Error(`Run ${runId} stayed ${body.run.status}: ${JSON.stringify(body.run.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const finished = (body) => FINISHED.includes(body.run.status) && !body.live;
const finishedTurn = (body) => FINISHED.includes(body.run.status);

async function eventsOf(url, runId) {
  return (await json(await browserFetch(`${url}api/agent-runs/${runId}/events?format=json`))).events;
}

function agentText(events) {
  return events.filter((event) => event.type === "chunk" && event.data.role === "agent").map((event) => event.data.text).join("");
}

// Reads Server-Sent Events until `count` events with ids arrived or the stream ends.
async function readStream(url, { headers = {}, count = Infinity, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers: { Accept: "text/event-stream", ...headers }, signal: controller.signal });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
        split = buffer.indexOf("\n\n");
      }
      if (events.filter((event) => event.seq).length >= count || events.some((event) => event.type === "closed")) break;
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

test("decisions of the three permission policies", () => {
  const options = [{ optionId: "y", kind: "allow_once" }, { optionId: "a", kind: "allow_always" }, { optionId: "n", kind: "reject_once" }];
  const request = (kind, title = "") => ({ toolCall: { kind, title }, options });
  assert.equal(decidePermission("allow", request("execute")).optionId, "y");
  assert.equal(decidePermission("research", request("read")).optionId, "y");
  assert.equal(decidePermission("research", request("fetch")).optionId, "y");
  for (const kind of ["edit", "delete", "move", "execute"]) assert.equal(decidePermission("research", request(kind)).optionId, "n", kind);
  assert.equal(decidePermission("research", request("other", "tracker: create_target")).optionId, "y", "the tracker tools are allowed");
  assert.equal(decidePermission("research", request("other", "Something else")).optionId, "n");
  assert.deepEqual(decidePermission("ask", request("read")), { ask: true });
  assert.equal(redactor(["supersecret", "abc"])("key supersecret and abc"), "key *** and abc", "values under 4 characters are left");
  assert.match(jsonFallback("Done.\n\n```json\n{\"targets\":[{\"section\":\"mk\",\"name\":\"A\",\"link\":\"https://example.com/a\"}]}\n```\n"), /"targets"/);
  assert.equal(jsonFallback("No JSON here."), "");
});

test("a run uses the tracker tools; history names it; undo puts things back; the log hides secrets", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url, { env: { FAKE_SECRET: "very-secret-value" } });
    assert.deepEqual(harness.env, { FAKE_SECRET: "***" }, "the page never sees the value");
    const checked = await json(await sendJson(`${url}api/agents/harnesses/${harness.id}/check`, "POST", {}));
    assert.equal(checked.check.state, "ready", checked.check.message);
    assert.deepEqual(checked.harness.models.map((model) => model.value), ["fake-small", "fake-large"]);
    assert.deepEqual(checked.harness.modelEfforts[""], [{ value: "low", name: "Low" }, { value: "high", name: "High" }], "the check keeps the effort levels");

    const unresolved = await json(await sendJson(`${url}api/s/${startup.id}/agent-runs`, "POST", { harnessId: harness.id, template: "Look at {{SECTOR}}", values: {} }));
    assert.equal(unresolved.status, 400);
    assert.equal(unresolved.code, "unresolved");

    const runId = await startRun(url, startup.id, harness.id, "Find a grant. USE_TOOLS FS\n\n{{TRACKER_ACCESS}}", { model: "fake-large", effort: "high" });
    const done = await waitFor(url, runId, finishedTurn);
    assert.equal(done.run.status, "done", done.run.error);
    assert.equal(done.run.stopReason, "end_turn");
    assert.equal(done.run.model, "fake-large");
    assert.equal(done.run.effort, "high");
    assert.match(done.run.prompt, /tracker tools of the "tracker" MCP server/, "the server filled {{TRACKER_ACCESS}} for a run");
    assert.deepEqual(done.run.usage, { used: 1234, size: 200000, cost: { amount: 0.01, currency: "USD" } });
    assert.equal(done.run.changes.length, 1);
    assert.equal(done.canMessage, true, "the agent stays for a follow-up");
    const text = agentText(await eventsOf(url, runId));
    assert.match(text, /Working with fake-large at high/, "the model and effort were set before the prompt");
    assert.match(text, /fs-error:-32601/, "the tracker offers no file system");
    assert.match(text, /versions:2026-07-28,2025-11-25,2025-06-18 tools:11 created:agent-/);

    const state = (await json(await browserFetch(`${url}api/s/${startup.id}/state`))).state;
    const grant = state.programs.find((record) => record.name === "Fake grant");
    assert.ok(grant, "the target is saved at once");
    assert.ok(grant.taxonomy.includes("po.grants"));
    const history = await json(await browserFetch(`${url}api/s/${startup.id}/state/history?section=programs&id=${grant.id}`));
    assert.equal(history.entries[0].origin, "agent");
    assert.equal(history.entries[0].actor, "Fake · fake-large");
    assert.equal(history.entries[0].label, `Run ${runId}`);

    // A follow-up message goes to the same session.
    const followUp = await json(await sendJson(`${url}api/agent-runs/${runId}/message`, "POST", { text: "One more, JSON please" }));
    assert.equal(followUp.status, 200, followUp.error);
    const second = await waitFor(url, runId, (body) => finishedTurn(body) && body.run.turns === 2);
    assert.equal(second.run.status, "done");

    const log = await (await browserFetch(`${url}api/agent-runs/${runId}/log`)).text();
    assert.match(log, /using secret \*\*\*/);
    assert.ok(!log.includes("very-secret-value"), "configured values are redacted");
    assert.ok(!/sta_[A-Za-z0-9_-]{20}/.test(log), "the run token is redacted");
    assert.ok(!log.includes(server.token), "the master token never appears");

    const undone = await json(await sendJson(`${url}api/agent-runs/${runId}/undo`, "POST", {}));
    assert.equal(undone.status, 200, undone.error);
    assert.equal(undone.undone.length, 1);
    const after = (await json(await browserFetch(`${url}api/s/${startup.id}/state`))).state;
    assert.ok(!after.programs.some((record) => record.id === grant.id));
    assert.ok(after.deletedPrograms.some((record) => record.id === grant.id), "created targets go to the recycle bin");
    assert.equal((await json(await sendJson(`${url}api/agent-runs/${runId}/undo`, "POST", {}))).status, 409, "once only");

    const list = await json(await browserFetch(`${url}api/s/${startup.id}/agent-runs`));
    assert.equal(list.runs[0].id, runId);
    assert.equal(list.runs[0].changeCount, 1);
    assert.equal("prompt" in list.runs[0], false, "the list leaves the prompt out");
  } finally {
    await server.stop();
  }
});

test("undo leaves a target someone changed after the run", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const runId = await startRun(url, startup.id, harness.id, "USE_TOOLS");
    await waitFor(url, runId, finishedTurn);
    const body = await json(await browserFetch(`${url}api/s/${startup.id}/state`));
    const grant = body.state.programs.find((record) => record.name === "Fake grant");
    const saved = await saveOperations(url, startup.id, [{ type: "upsert", section: "programs", id: grant.id, value: { ...grant, notes: "Mine now" }, baseRevision: body.revisionMap.records.programs[grant.id] }]);
    assert.equal(saved.status, 200);
    const undone = await json(await sendJson(`${url}api/agent-runs/${runId}/undo`, "POST", {}));
    assert.equal(undone.undone.length, 0);
    assert.deepEqual(undone.skipped.map((entry) => entry.reason), ["changed since"]);
    const after = (await json(await browserFetch(`${url}api/s/${startup.id}/state`))).state;
    assert.equal(after.programs.find((record) => record.id === grant.id).notes, "Mine now");
  } finally {
    await server.stop();
  }
});

test("Research only refuses edits; Ask me waits for you; a cancel answers cancelled", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const research = await addFakeAgent(url, { policy: "research" });
    const researchRun = await startRun(url, startup.id, research.id, "PERMISSION");
    await waitFor(url, researchRun, finishedTurn);
    assert.match(agentText(await eventsOf(url, researchRun)), /permission-edit:no permission-read:yes/, "edit refused with the reject option, read allowed");

    const ask = await addFakeAgent(url, { policy: "ask" });
    const askRun = await startRun(url, startup.id, ask.id, "PERMISSION");
    const waiting = await waitFor(url, askRun, (body) => body.run.status === "waiting");
    assert.equal((await json(await browserFetch(`${url}api/agent-runs`))).counts.waiting, 1, "the badge counts it");
    const request = waiting.run.permissions.find((entry) => !entry.decision);
    assert.equal(request.kind, "edit");
    const wrong = await json(await sendJson(`${url}api/agent-runs/${askRun}/permissions/${request.id}`, "POST", { optionId: "made-up" }));
    assert.equal(wrong.status, 400);
    assert.equal((await json(await sendJson(`${url}api/agent-runs/${askRun}/permissions/${request.id}`, "POST", { optionId: "always" }))).status, 200);
    const second = await waitFor(url, askRun, (body) => body.run.status === "waiting" && body.run.permissions.length === 2);
    const read = second.run.permissions.find((entry) => !entry.decision);
    // Cancelling while a request waits answers it "cancelled", as ACP requires.
    assert.equal((await json(await sendJson(`${url}api/agent-runs/${askRun}/cancel`, "POST", {}))).status, 200);
    const cancelled = await waitFor(url, askRun, finishedTurn);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.permissions.find((entry) => entry.id === read.id).decision, "cancelled");
    assert.match(agentText(await eventsOf(url, askRun)), /permission-edit:always permission-read:cancelled/);
  } finally {
    await server.stop();
  }
});

test("a run without an effort takes the one picked for its model in Settings", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const patched = await json(await sendJson(`${url}api/agents/harnesses/${harness.id}`, "PATCH", { effortByModel: { "fake-large": "max", "fake-small": "", odd: 5 } }));
    assert.deepEqual(patched.harness.effortByModel, { "fake-large": "max" }, "empty and non-text levels are dropped");
    const created = await json(await sendJson(`${url}api/s/${startup.id}/agent-runs`, "POST", { harnessId: harness.id, model: "fake-large", template: "WAIT", values: {}, title: "Effort" }));
    assert.equal(created.status, 201, created.error);
    assert.equal(created.run.effort, "max");
    const chosen = await json(await sendJson(`${url}api/s/${startup.id}/agent-runs`, "POST", { harnessId: harness.id, model: "fake-large", effort: "", template: "WAIT", values: {}, title: "Own effort" }));
    assert.equal(chosen.run.effort, "", "an empty effort sent from the dialog keeps the model's own");
    // Stopped at once, while still starting: each ends cancelled, never
    // left "running" by a late step of its start.
    for (const run of [created.run, chosen.run]) {
      await sendJson(`${url}api/agent-runs/${run.id}/cancel`, "POST", {});
      await waitFor(url, run.id, finished);
    }
  } finally {
    await server.stop();
  }
});

test("the event stream resumes after a reconnect without repeating anything", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const runId = await startRun(url, startup.id, harness.id, "Hello WAIT");
    await waitFor(url, runId, (body) => body.run.status === "running");
    const first = await readStream(`${url}api/agent-runs/${runId}/events`, { count: 3 });
    const firstSeqs = first.filter((event) => event.seq).map((event) => event.seq);
    assert.deepEqual(firstSeqs.slice(0, 3), [1, 2, 3]);
    const last = firstSeqs[firstSeqs.length - 1];
    await sendJson(`${url}api/agent-runs/${runId}/cancel`, "POST", {});
    await waitFor(url, runId, finished);
    const rest = await readStream(`${url}api/agent-runs/${runId}/events`, { headers: { "Last-Event-ID": String(last) } });
    const restSeqs = rest.filter((event) => event.seq).map((event) => event.seq);
    assert.equal(restSeqs[0], last + 1, "picks up right after the last event seen");
    assert.equal(rest[rest.length - 1].type, "closed", "a finished run's stream ends");
    const all = await eventsOf(url, runId);
    assert.deepEqual([...firstSeqs, ...restSeqs], all.map((event) => event.seq), "nothing missing, nothing twice");
    assert.equal(all.find((event) => event.type === "status" && event.data.status === "cancelled").data.status, "cancelled");
  } finally {
    await server.stop();
  }
});

test("a run whose agent printed targets as JSON offers them to Import AI results", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const runId = await startRun(url, startup.id, harness.id, "JSON please");
    const done = await waitFor(url, runId, finishedTurn);
    assert.equal(done.run.changes.length, 0);
    assert.match(done.run.jsonFallback, /"targets"/);
  } finally {
    await server.stop();
  }
});

test("the run token reaches the tracker tools of its own run only; agents change only through /api/agents", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const one = await createStartup(url, "One");
    const two = await createStartup(url, "Two");
    const harness = await addFakeAgent(url);
    const runId = await startRun(url, one.id, harness.id, "WAIT");
    await waitFor(url, runId, (body) => body.run.status === "running");
    // The token is only in the agent's environment; read it as the agent would.
    const store = new TrackerSqliteStore(path.join(server.home, "data", "tracker.sqlite"), { readOnly: true });
    const record = require("../lib/agent-tokens").listTokens(store).find((token) => token.runId === runId);
    store.close();
    assert.equal(record.scope, "run");
    assert.equal(record.active, true);

    const page = await json(await sendJson(`${url}api/s/${one.id}/agent-tools/get_startup_context`, "POST", { arguments: {} }));
    assert.equal(page.status, 403, "the page itself cannot call the tools");
    const prompt = await json(await sendJson(`${url}api/s/${one.id}/agent-tokens`, "POST", { label: "Copied" }));
    const withPromptToken = await fetch(`${url}api/s/${one.id}/agent-tools/get_startup_context`, { method: "POST", headers: { Authorization: `Bearer ${prompt.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(withPromptToken.status, 403, "a copied prompt's token cannot either");

    const harnessWrite = await json(await sendJson(`${url}api/global/operations`, "PATCH", { protocolVersion: 3, operations: [{ type: "upsert", section: "agentHarnesses", id: "x", value: { id: "x", kind: "custom", command: "rm" } }] }));
    assert.equal(harnessWrite.status, 400);
    assert.equal(harnessWrite.code, "agentHarnessesSection");

    await sendJson(`${url}api/agent-runs/${runId}/cancel`, "POST", {});
    await waitFor(url, runId, finished);
    const tokens = (await json(await browserFetch(`${url}api/agent-tokens`))).tokens;
    assert.equal(tokens.find((token) => token.runId === runId).active, false, "revoked when the run ends");
    void two;
  } finally {
    await server.stop();
  }
});

test("Settings > AI agents: the registry offline, run settings, blocked agents", async () => {
  const server = await startServer();
  try {
    const url = server.url;
    const overview = await json(await browserFetch(`${url}api/agents`));
    assert.equal(overview.registry.network, false, "tests never reach the network");
    assert.equal(overview.registry.source, "snapshot");
    assert.ok(overview.registry.agents.length >= 20);
    assert.deepEqual(overview.settings, harnesses.DEFAULT_SETTINGS);
    const rescan = await json(await sendJson(`${url}api/agents/rescan`, "POST", {}));
    assert.equal(rescan.registry.source, "snapshot");
    const npxAgent = overview.registry.agents.find((agent) => agent.kind === "npx" && !agent.installed);
    const added = await json(await sendJson(`${url}api/agents/harnesses`, "POST", { registryId: npxAgent.id }));
    assert.equal(added.code, "confirmNeeded");
    assert.match(added.preview, /^npx --yes /);
    const saved = await json(await sendJson(`${url}api/agents/settings`, "PUT", { settings: { concurrency: 3, timeoutMinutes: 5 } }));
    assert.equal(saved.settings.concurrency, 3);
    assert.equal(saved.settings.timeoutMinutes, 5);

    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const broken = await json(await sendJson(`${url}api/agents/harnesses/${harness.id}`, "PATCH", { args: ["-e", "process.exit(2)"] }));
    assert.equal(broken.code, "confirmNeeded", "a custom agent's new command line is confirmed first");
    await sendJson(`${url}api/agents/harnesses/${harness.id}`, "PATCH", { args: ["-e", "process.exit(2)"], confirmed: true });
    const failed = await json(await sendJson(`${url}api/agents/harnesses/${harness.id}/check`, "POST", {}));
    assert.equal(failed.check.state, "failed");
    assert.equal(failed.harness.blocked, true);
    const refused = await json(await sendJson(`${url}api/s/${startup.id}/agent-runs`, "POST", { harnessId: harness.id, template: "Hi", values: {} }));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "blocked");
    await sendJson(`${url}api/agents/harnesses/${harness.id}`, "PATCH", { overrideBlock: true });
    const allowed = await json(await sendJson(`${url}api/s/${startup.id}/agent-runs`, "POST", { harnessId: harness.id, template: "Hi", values: {} }));
    assert.equal(allowed.status, 201, "the override lets it run");
    const ended = await waitFor(url, allowed.run.id, finished);
    assert.equal(ended.run.status, "failed");
    assert.match(ended.run.error, /exit code 2/);
  } finally {
    await server.stop();
  }
});

test("runs going when the tracker stops read interrupted afterwards", async () => {
  const server = await startServer();
  let restarted = null;
  try {
    const url = server.url;
    const startup = await createStartup(url, "Acme");
    const harness = await addFakeAgent(url);
    const runId = await startRun(url, startup.id, harness.id, "WAIT");
    await waitFor(url, runId, (body) => body.run.status === "running");
    await server.stop({ keepHome: true });
    restarted = await startServer({ home: server.home });
    const body = await json(await browserFetch(`${restarted.url}api/agent-runs/${runId}`));
    assert.equal(body.run.status, "interrupted", body.run.error);
    assert.equal(body.live, false);
    const tokens = (await json(await browserFetch(`${restarted.url}api/agent-tokens`))).tokens;
    assert.ok(tokens.filter((token) => token.scope === "run").every((token) => !token.active));
  } finally {
    if (restarted) await restarted.stop();
    else await server.stop();
  }
});

// In-process: the queue and the idle flag, with a "minute" of 40 ms.
function manager() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "st-runs-"));
  const store = new TrackerSqliteStore(path.join(home, "tracker.sqlite"));
  const startup = startups.createStartup(store, { name: "Acme" });
  const paths = { agentRunsDir: path.join(home, "agent-runs"), secretsDir: path.join(home, "secrets") };
  const runs = new RunManager({ store, paths, baseUrl: () => "http://127.0.0.1:9", mcpScript: path.join(__dirname, "..", "bin", "tracker-mcp.js"), minuteMs: 40, idleCheckMs: 10 });
  const harness = harnesses.addHarness(store, { custom: { command: process.execPath, args: [FIXTURE] }, confirmed: true });
  const waitStatus = async (runId, status) => {
    const until = Date.now() + 20000;
    while (runs.get(runId).status !== status) {
      if (Date.now() > until) throw new Error(`still ${runs.get(runId).status}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { store, startup, runs, harness, waitStatus, cleanup: async () => {
    await runs.shutdown();
    store.close();
    // Windows keeps a stopped agent's folder busy for a moment after it exits.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } };
}

test("a run stopped while it starts stays cancelled", async () => {
  const { startup, runs, harness, waitStatus, cleanup } = manager();
  try {
    // Stopped the moment its session exists, before the prompt goes out: the
    // rest of the start must neither send the prompt nor mark it running.
    let runId = "";
    let prompted = false;
    runs.spawnHook = (connection) => {
      const newSession = connection.newSession.bind(connection);
      connection.newSession = async (...args) => {
        const session = await newSession(...args);
        await runs.cancel(runId);
        return session;
      };
      const prompt = connection.prompt.bind(connection);
      connection.prompt = (...args) => {
        prompted = true;
        return prompt(...args);
      };
    };
    runId = runs.create({ startupId: startup.id, harnessId: harness.id, prompt: "WAIT" }).id;
    await waitStatus(runId, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(runs.get(runId).status, "cancelled");
    assert.equal(prompted, false);
  } finally {
    await cleanup();
  }
});

test("at the concurrency limit a run waits as Queued", async () => {
  const { store, startup, runs, harness, waitStatus, cleanup } = manager();
  try {
    harnesses.writeSettings(store, { concurrency: 1 });
    const first = runs.create({ startupId: startup.id, harnessId: harness.id, prompt: "WAIT" });
    const second = runs.create({ startupId: startup.id, harnessId: harness.id, prompt: "Hello" });
    await waitStatus(first.id, "running");
    assert.equal(runs.get(second.id).status, "queued");
    assert.deepEqual(runs.counts(), { running: 2, waiting: 0 });
    await runs.cancel(first.id);
    await waitStatus(first.id, "cancelled");
    await waitStatus(second.id, "done");
  } finally {
    await cleanup();
  }
});

test("a run with no update for the idle time is flagged idle, and the timeout stops it", async () => {
  const { store, startup, runs, harness, waitStatus, cleanup } = manager();
  try {
    // A "minute" lasts 40 ms here: idle after 40 ms, stopped after 2 s.
    harnesses.writeSettings(store, { idleMinutes: 1, timeoutMinutes: 50 });
    const run = runs.create({ startupId: startup.id, harnessId: harness.id, prompt: "WAIT" });
    const until = Date.now() + 10000;
    while (!runs.get(run.id).idle && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs.get(run.id).idle, true);
    assert.ok(runs.events(run.id).some((event) => event.type === "idle"));
    await waitStatus(run.id, "cancelled");
    assert.match(runs.get(run.id).error, /longer than 50 minutes/);
    // The stopped agent is still shutting down; shutdown() waits for it, or
    // Windows refuses to delete the run folder it holds.
    await runs.shutdown();
    assert.equal(runs.stopping.size, 0);
  } finally {
    await cleanup();
  }
});
