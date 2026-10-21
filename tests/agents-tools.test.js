"use strict";

// The tracker tools an agent run gets (lib/agents/tools.js) and the MCP
// server that carries them to the agent (bin/tracker-mcp.js).
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const startups = require("../lib/startups");
const statuses = require("../lib/statuses");
const taxonomy = require("../lib/taxonomy");
const { callTool, ToolError } = require("../lib/agents/tools");
const mcp = require("../bin/tracker-mcp");
const { TOOLS, NAMES } = require("../lib/agents/tool-definitions");

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  statuses.seedStatuses(store);
  taxonomy.seedTaxonomy(store);
  const startup = startups.createStartup(store, { name: "Acme" });
  store.replaceSection(startup.id, "profile", { oneLiner: "Invoices for florists", maxNewTargetsPerDay: 4 });
  store.replaceSection(startup.id, "companySecrets", { fields: { taxId: "ID-TEST-0001" }, people: {}, bankAccounts: [] });
  const changes = [];
  const ctx = { store, startupId: startup.id, run: { id: "run-test01", harness: "Fake", model: "fake-large" }, timeZone: "Europe/Bucharest", results: new Map(), onChange: (change) => changes.push(change) };
  const call = (name, input, mutationId = "") => callTool(name, input, { ...ctx, mutationId });
  return { store, startup, call, changes };
}

test("the startup context never holds sensitive company values", () => {
  const { call } = setup();
  const context = call("get_startup_context", {});
  assert.equal(context.name, "Acme");
  assert.equal(context.oneLiner, "Invoices for florists");
  assert.equal(context.maxNewTargetsPerDay, 4);
  assert.match(context.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(context).includes("ID-TEST-0001"));
  const categories = call("get_taxonomy", { section: "po" }).categories;
  assert.ok(categories.some((node) => node.id === "po.grants" && node.description));
  assert.ok(categories.every((node) => node.section === "po"));
});

test("create_target takes several categories, records the run and refuses duplicates", () => {
  const { store, startup, call, changes } = setup();
  const created = call("create_target", { section: "po", fields: { name: "City grant", link: "https://example.com/city-grant" }, categories: ["po.grants.government", "po.support.accelerators", "mk.launches"], notes: "Checked on the official page." }, "m1");
  const record = store.readSection(startup.id, "programs").find((entry) => entry.id === created.id);
  assert.ok(record.taxonomy.includes("po.grants.government") && record.taxonomy.includes("po.support.accelerators"), "both PO categories");
  assert.ok(record.taxonomy.every((id) => id.startsWith("po.")), "the MK one is not for this section");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].event, "created");
  const history = store.readRecordHistory(startup.id, "programs", created.id).entries[0];
  assert.equal(history.origin, "agent");
  assert.equal(history.actor, "Fake · fake-large");
  assert.equal(history.label, "Run run-test01");
  assert.throws(() => call("create_target", { section: "po", fields: { name: "Another name", link: "https://example.com/city-grant/" } }, "m2"), (error) => error instanceof ToolError && error.statusCode === 409 && /City grant/.test(error.message));
  assert.throws(() => call("create_target", { section: "zz", fields: { name: "x" } }), /section must be/);
  const found = call("search_targets", { query: "https://example.com/city-grant" });
  assert.equal(found.results[0].id, created.id);
  assert.equal(found.results[0].match, "link");
});

test("a retried write with the same mutation id is applied once", () => {
  const { store, startup, call, changes } = setup();
  const first = call("create_target", { section: "mk", fields: { name: "Directory", link: "https://example.com/dir" } }, "same");
  const again = call("create_target", { section: "mk", fields: { name: "Directory", link: "https://example.com/dir" } }, "same");
  assert.equal(again.id, first.id);
  assert.equal(again.replayed, true);
  assert.equal(store.readSection(startup.id, "items").length, 1);
  assert.equal(changes.length, 1);
});

test("update_target needs the current revision; append_note and link_records", () => {
  const { store, startup, call } = setup();
  const program = call("create_target", { section: "po", fields: { name: "Accelerator", link: "https://example.com/acc" } }, "a");
  const target = call("create_target", { section: "mk", fields: { name: "Blog", link: "https://example.com/blog" } }, "b");
  const read = call("get_target", { section: "po", id: program.id });
  assert.throws(() => call("update_target", { section: "po", id: program.id, baseRevision: read.revision - 1, fields: { notes: "x" } }), (error) => error.statusCode === 409);
  const updated = call("update_target", { section: "po", id: program.id, baseRevision: read.revision, fields: { name: "Accelerator 2027", nope: "x" }, categories: ["po.support.accelerators"] }, "c");
  assert.ok(updated.warnings.some((warning) => warning.includes("nope")));
  const after = store.readSection(startup.id, "programs").find((entry) => entry.id === program.id);
  assert.equal(after.name, "Accelerator 2027");
  assert.ok(after.taxonomy.includes("po.support.accelerators"));
  assert.ok(!after.taxonomy.some((id) => id.startsWith("po.grants")), "the categories are replaced");
  call("append_note", { section: "po", id: program.id, text: "Deadline confirmed on the official page." }, "d");
  assert.match(store.readSection(startup.id, "programs").find((entry) => entry.id === program.id).notes, /\d{4}-\d{2}-\d{2}: Deadline confirmed/);
  const link = call("link_records", { from: { kind: "mk", id: target.id }, to: { kind: "po", id: program.id }, relation: "related" }, "e");
  assert.equal(link.created, true);
  assert.equal(call("link_records", { from: { kind: "mk", id: target.id }, to: { kind: "po", id: program.id } }, "f").created, false);
  assert.throws(() => call("link_records", { from: { kind: "mk", id: "missing" }, to: { kind: "po", id: program.id } }), /No mk record/);
  assert.throws(() => call("update_target", { section: "po", id: "missing", baseRevision: 1 }), /cannot restore or delete/);
  assert.throws(() => call("delete_target", {}), /Unknown tool/);
  const load = call("get_calendar_load", { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(load.maxNewTargetsPerDay, 4);
});

test("MCP: the stateless 2026-07-28 revision, the handshake revisions, and -32022 for others", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: "agent-1", revision: 1 } }) };
  };
  const env = { TRACKER_URL: "http://127.0.0.1:1/", TRACKER_RUN_TOKEN: "sta_run", TRACKER_STARTUP_ID: "acme-0001", TRACKER_RUN_ID: "run-abc123" };
  const meta = { _meta: { [mcp.META_VERSION]: "2026-07-28" } };

  const modern = mcp.createServer({ env, fetchImpl });
  const discovered = await modern.onRequest("server/discover", meta);
  assert.deepEqual(discovered.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18"]);
  assert.equal(discovered._meta["io.modelcontextprotocol/serverInfo"].name, "startup-tracker");
  const listed = await modern.onRequest("tools/list", meta);
  assert.deepEqual(listed.tools.map((tool) => tool.name), NAMES);
  assert.equal(listed.ttlMs > 0, true);
  assert.equal(listed.tools.find((tool) => tool.name === "search_targets").annotations.readOnlyHint, true);
  const called = await modern.onRequest("tools/call", { ...meta, name: "create_target", arguments: { section: "mk", fields: { name: "x" } } });
  assert.equal(called.isError, false);
  assert.deepEqual(called.structuredContent, { id: "agent-1", revision: 1 });
  assert.equal(calls[0].url, "http://127.0.0.1:1/api/s/acme-0001/agent-tools/create_target");
  assert.equal(calls[0].auth, "Bearer sta_run");
  assert.equal(calls[0].body.runId, "run-abc123");
  assert.match(calls[0].body.mutationId, /^run-abc123:/);
  await assert.rejects(modern.onRequest("tools/list", { _meta: { [mcp.META_VERSION]: "2024-11-05" } }), (error) => error.code === -32022 && error.data.requested === "2024-11-05" && error.data.supported.includes("2026-07-28"));
  await assert.rejects(modern.onRequest("tools/call", { ...meta, name: "nope" }), (error) => error.code === -32602);
  await assert.rejects(modern.onRequest("resources/list", meta), (error) => error.code === -32601);

  for (const version of ["2025-11-25", "2025-06-18"]) {
    const legacy = mcp.createServer({ env, fetchImpl });
    const hello = await legacy.onRequest("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "agent", version: "1" } });
    assert.equal(hello.protocolVersion, version);
    assert.equal(hello.serverInfo.name, "startup-tracker");
    assert.equal((await legacy.onRequest("tools/list", {})).tools.length, TOOLS.length);
  }
  const unknown = mcp.createServer({ env, fetchImpl });
  assert.equal((await unknown.onRequest("initialize", { protocolVersion: "2024-11-05" })).protocolVersion, "2025-11-25", "an older client is offered the newest handshake revision");
});

test("MCP: a failed request is retried with the same mutation id; tracker errors come back as tool errors", async () => {
  const seen = [];
  let attempt = 0;
  const flaky = async (url, init) => {
    seen.push(JSON.parse(init.body).mutationId);
    attempt += 1;
    if (attempt < 3) throw new Error("ECONNRESET");
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { done: true } }) };
  };
  const env = { TRACKER_URL: "http://127.0.0.1:1", TRACKER_RUN_TOKEN: "t", TRACKER_STARTUP_ID: "s", TRACKER_RUN_ID: "run-x" };
  const answer = await mcp.callTracker("append_note", {}, env, flaky);
  assert.deepEqual(answer, { result: { done: true } });
  assert.equal(new Set(seen).size, 1, "every attempt carries the same mutation id");
  const refused = await mcp.createServer({ env, fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: "A target with the same link exists." }) }) })
    .onRequest("tools/call", { name: "create_target", arguments: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /same link/);
});
