"use strict";

// The pieces under an agent run: JSON-RPC framing, the ACP client, starting a
// process without a shell, the agent registry and its catalog, and the five
// states of "Check" (lib/agents/).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const { JsonRpcPeer, RpcError, ERRORS } = require("../lib/agents/jsonrpc");
const { sessionChoices, selectValues } = require("../lib/agents/acp-client");
const processes = require("../lib/agents/process");
const registry = require("../lib/agents/registry");
const { runCheck, needsDownloadConsent, terminalLogin } = require("../lib/agents/check");
const harnesses = require("../lib/agents/harnesses");
const { buildCatalog, slimRegistry, CATALOG } = require("../tools/update-acp-registry");

const FIXTURE = path.join(__dirname, "fixtures", "fake-acp-agent.js");

function pair(handlers = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcPeer(bToA, aToB, handlers.a || {});
  const b = new JsonRpcPeer(aToB, bToA, handlers.b || {});
  return { a, b };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("JSON-RPC: requests, errors with their codes, and -32601 for unknown methods", async () => {
  const { a, b } = pair({
    b: {
      onRequest: (method, params) => {
        if (method === "add") return params.x + params.y;
        if (method === "login") throw new RpcError(-32000, "Authentication required");
        throw new RpcError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
      },
    },
  });
  assert.equal(await a.request("add", { x: 2, y: 3 }), 5);
  await assert.rejects(a.request("login"), (error) => error.code === -32000);
  await assert.rejects(a.request("fs/read_text_file"), (error) => error.code === -32601);
  // A peer without a request handler answers -32601 too.
  await assert.rejects(b.request("anything"), (error) => error.code === -32601);
  a.close();
  b.close();
});

test("JSON-RPC: a closed connection rejects what is waiting", async () => {
  const { a, b } = pair({ b: { onRequest: () => new Promise(() => {}) } });
  const waiting = a.request("slow");
  a.close(new Error("gone"));
  await assert.rejects(waiting, /gone/);
  b.close();
});

test("ACP: models from configOptions (grouped or not) or from the older models field", () => {
  const config = sessionChoices({
    sessionId: "s",
    configOptions: [
      { id: "model", category: "model", type: "select", currentValue: "b", options: [{ group: "Fast", name: "Fast", options: [{ value: "a", name: "A" }] }, { value: "b", name: "B" }] },
      { id: "effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] },
    ],
  });
  assert.deepEqual(config.models, [{ value: "a", name: "A" }, { value: "b", name: "B" }]);
  assert.equal(config.modelVia, "config");
  assert.equal(config.modelConfigId, "model");
  assert.deepEqual(config.thoughtLevels, [{ value: "low", name: "Low" }]);
  const legacy = sessionChoices({ sessionId: "s", models: { currentModelId: "x", availableModels: [{ modelId: "x", name: "X" }] } });
  assert.equal(legacy.modelVia, "legacy");
  assert.equal(legacy.currentModel, "x");
  assert.deepEqual(selectValues([{ value: "only" }]), [{ value: "only", name: "only" }]);
  // Effort the way each agent names it: the spec's category, Mistral Vibe's
  // "thinking" category, goose and Droid ids, Cursor's ids under a custom
  // category, Kimi's on/off switch. A mode or model option is never effort.
  const effortOf = (option) => sessionChoices({ configOptions: [{ type: "select", options: [{ value: "low", name: "Low" }], ...option }] });
  assert.equal(effortOf({ id: "x", category: "thought_level" }).thoughtConfigId, "x");
  assert.equal(effortOf({ id: "thinking", category: "thinking" }).thoughtConfigId, "thinking");
  assert.equal(effortOf({ id: "thinking_effort", name: "Thinking effort" }).thoughtConfigId, "thinking_effort");
  assert.equal(effortOf({ id: "reasoning_effort", category: "_cursor" }).thoughtConfigId, "reasoning_effort");
  assert.equal(effortOf({ id: "effort", category: "mode" }).thoughtConfigId, "");
  assert.equal(effortOf({ id: "amp-mode", category: "model" }).thoughtConfigId, "");
  const onOff = sessionChoices({ configOptions: [{ id: "thinking", type: "boolean", currentValue: true }] });
  assert.deepEqual([onOff.thoughtConfigId, onOff.thoughtType, onOff.thoughtLevels.map((level) => level.value)], ["thinking", "boolean", ["on", "off"]]);
  assert.equal(sessionChoices({ sessionId: "s" }).modelVia, "");
});

test("an agent gets a clean environment, never the tracker's own variables", () => {
  const env = processes.cleanEnv({ API_KEY: "k", "bad name": "x" }, { PATH: "/bin", HOME: "/home/a", STARTUP_TRACKER_HOME: "/data", TRACKER_RUN_TOKEN: "sta_x", SECRET_THING: "s" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/a", API_KEY: "k" });
});

test("launching without a shell: npx through npm's script, custom commands on PATH, Windows npm shims through node", () => {
  const dir = tempDir("st-launch-");
  try {
    const npx = processes.resolveLaunch({ kind: "npx", package: "@scope/agent@1.2.3", args: ["--acp"] });
    if (processes.npxCli()) {
      assert.equal(npx.command, process.execPath);
      assert.deepEqual(npx.args.slice(1), ["--yes", "@scope/agent@1.2.3", "--acp"]);
    }
    assert.equal(npx.display, "npx --yes @scope/agent@1.2.3 --acp");

    const bin = path.join(dir, "my-agent");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    const custom = processes.resolveLaunch({ kind: "custom", command: "my-agent", args: ["acp"] }, { env: { PATH: dir } });
    assert.deepEqual([custom.command, custom.args], [bin, ["acp"]]);
    assert.match(processes.resolveLaunch({ kind: "binary", command: "missing-agent" }, { env: { PATH: dir } }).error, /not found/);
    assert.match(processes.resolveLaunch({ kind: "uvx", package: "x" }, { env: { PATH: dir } }).error, /uvx was not found/);

    // An npm shim as npm writes it on Windows.
    fs.mkdirSync(path.join(dir, "node_modules", "agent", "bin"), { recursive: true });
    const script = path.join(dir, "node_modules", "agent", "bin", "cli.js");
    fs.writeFileSync(script, "");
    const shim = path.join(dir, "agent.cmd");
    fs.writeFileSync(shim, "@ECHO off\r\nGOTO start\r\n:start\r\n\"%_prog%\"  \"%dp0%\\node_modules\\agent\\bin\\cli.js\" %*\r\n");
    assert.equal(processes.shimTarget(shim), script);
    const windows = processes.resolveLaunch({ kind: "custom", command: shim, args: ["--acp"] }, { platform: "win32" });
    assert.deepEqual([windows.command, windows.args], [process.execPath, [script, "--acp"]], "node runs the shim's script; no shell");
    fs.writeFileSync(shim, "@ECHO off\r\necho hi\r\n");
    assert.match(processes.resolveLaunch({ kind: "custom", command: shim }, { platform: "win32" }).error, /needs a shell/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE = {
  version: "1.0.0",
  agents: [
    { id: "npx-agent", name: "Npx agent", version: "1.0.0", description: "d", authors: ["A <a@example.com>"], distribution: { npx: { package: "npx-agent@1.0.0", args: ["--acp"] } } },
    { id: "bin-agent", name: "Binary agent", version: "2.0.0", distribution: { binary: { "linux-x86_64": { archive: "https://example.com/a.tar.gz", cmd: "./bin-agent", args: ["acp"] }, "windows-x86_64": { archive: "https://example.com/a.zip", cmd: "bin-agent.exe" } } } },
    { id: "uvx-agent", name: "Uvx agent", distribution: { uvx: { package: "uvx-agent==1.0", args: [] } } },
    { id: "bad id!", name: "Bad", distribution: { npx: { package: "x" } } },
    { id: "no-dist", name: "None", distribution: {} },
  ],
};

test("registry: parsing keeps valid agents; launch specs per platform", () => {
  const parsed = registry.parseRegistry(SAMPLE);
  assert.deepEqual(parsed.agents.map((agent) => agent.id), ["npx-agent", "bin-agent", "uvx-agent"]);
  assert.throws(() => registry.parseRegistry({}), /no agents/);
  assert.equal(registry.platformKey("win32", "x64"), "windows-x86_64");
  assert.equal(registry.platformKey("darwin", "arm64"), "darwin-aarch64");
  assert.deepEqual(registry.launchSpec(parsed.agents[0]), { kind: "npx", package: "npx-agent@1.0.0", args: ["--acp"] });
  assert.deepEqual(registry.launchSpec(parsed.agents[1], { platform: "linux", arch: "x64" }), { kind: "binary", command: "bin-agent", args: ["acp"], archive: "https://example.com/a.tar.gz" });
  assert.equal(registry.launchSpec(parsed.agents[1], { platform: "win32", arch: "x64" }).command, "bin-agent");
  assert.equal(registry.launchSpec(parsed.agents[1], { platform: "darwin", arch: "arm64" }), null, "no build for this computer");
  assert.equal(registry.launchSpec(parsed.agents[2]).kind, "uvx");
});

test("registry: live, then the cache, then the snapshot, then the catalog; the network switch and Rescan", async () => {
  const dir = tempDir("st-registry-");
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => SAMPLE };
    };
    const now = Date.parse("2026-10-20T10:00:00Z");
    const live = await registry.loadRegistry({ cacheDir: dir, fetchImpl, now });
    assert.equal(live.source, "live");
    assert.equal(calls, 1);
    const cached = await registry.loadRegistry({ cacheDir: dir, fetchImpl, now: now + 3600 * 1000 });
    assert.equal(cached.source, "cache", "fresh for 24 hours");
    assert.equal(calls, 1);
    const rescan = await registry.loadRegistry({ cacheDir: dir, fetchImpl, now: now + 3600 * 1000, force: true });
    assert.equal(rescan.source, "live", "Rescan now fetches again");
    assert.equal(calls, 2);
    const offline = await registry.loadRegistry({ cacheDir: dir, fetchImpl, network: false, now: now + 48 * 3600 * 1000 });
    assert.equal(offline.source, "cache");
    assert.equal(calls, 2, "no fetch with the network switch off");
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const fallback = await registry.loadRegistry({ cacheDir: path.join(dir, "empty"), fetchImpl: failing, now });
    assert.equal(fallback.source, "snapshot");
    assert.match(fallback.problem, /503/);
    const catalogOnly = await registry.loadRegistry({ cacheDir: null, network: false, snapshotFile: path.join(dir, "missing.json") });
    assert.equal(catalogOnly.source, "catalog");
    assert.ok(catalogOnly.agents.length >= 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: agents found on this computer, including native CLIs an adapter needs", () => {
  const dir = tempDir("st-found-");
  try {
    fs.writeFileSync(path.join(dir, "bin-agent"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "npx-agent-cli"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "codex"), "", { mode: 0o755 });
    const result = {
      agents: registry.parseRegistry(SAMPLE).agents,
      catalog: [{ id: "npx-agent", bin: "npx-agent-cli" }, { id: "adapter-agent", bin: "adapter-agent-acp", requires: ["codex"] }],
      local: { aliases: { "npx-agent": ["codex"] } },
    };
    const described = registry.describeAgents(result, { env: { PATH: dir }, platform: "linux", arch: "x64" });
    const byId = Object.fromEntries(described.map((agent) => [agent.id, agent]));
    assert.equal(byId["bin-agent"].installed, true);
    assert.equal(byId["npx-agent"].installed, true, "the package's program is on PATH");
    assert.equal(byId["npx-agent"].bin, "npx-agent-cli");
    assert.equal(byId["npx-agent"].installedBin, "npx-agent-cli", "a found package command can run without a download");
    assert.equal(byId["uvx-agent"].installed, false);
    assert.equal(byId["adapter-agent"], undefined, "only agents the registry knows are described");
    const adapter = registry.describeAgents({ agents: [{ id: "adapter-agent", name: "Adapter", distribution: { npx: { package: "adapter-agent" } } }], catalog: result.catalog }, { env: { PATH: dir }, platform: "linux", arch: "x64" })[0];
    assert.equal(adapter.installed, true, "a needed native CLI marks the adapter found");
    assert.equal(adapter.installedBin, "", "but the adapter itself still has to be downloaded");
    assert.equal(adapter.adapter, true, "needing another program makes it an adapter");
    assert.equal(byId["npx-agent"].adapter, true, "so does an alias for a native CLI");
    assert.equal(byId["bin-agent"].adapter, false);
    assert.equal(registry.isAdapter({ id: "native", description: "" }, { bin: "grok", requires: ["grok"] }), false, "its own program is not an adapter's target");
    assert.equal(registry.isAdapter({ id: "x", description: "ACP wrapper for Amp" }, null), true, "the registry calls it a wrapper");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the local agent list adds agents and native detection, and replaces a registry entry with the same id", async () => {
  const dir = tempDir("st-local-");
  try {
    const localFile = path.join(dir, "local.json");
    fs.writeFileSync(localFile, JSON.stringify({
      aliases: { "npx-agent": ["codex"] },
      agents: [
        { id: "local-agent", name: "Local agent", bin: "local-agent", requires: ["native-cli"], distribution: { npx: { package: "local-agent@1.0.0", args: ["acp"] } } },
        { id: "bin-agent", name: "Shared id", bin: "shared", distribution: { npx: { package: "shared@2.0.0" } } },
      ],
    }));
    fs.writeFileSync(path.join(dir, "native-cli"), "", { mode: 0o755 });
    const loaded = await registry.loadRegistry({ cacheDir: null, network: false, snapshotFile: path.join(dir, "missing.json"), catalogFile: path.join(dir, "missing-catalog.json"), localFile });
    const byId = Object.fromEntries(loaded.agents.map((agent) => [agent.id, agent]));
    assert.equal(byId["local-agent"].name, "Local agent");
    assert.equal(byId["bin-agent"].name, "Shared id", "a local entry replaces the registry one");
    assert.deepEqual(loaded.local.aliases, { "npx-agent": ["codex"] });
    assert.equal(registry.describeAgents(loaded, { env: { PATH: dir } }).find((agent) => agent.id === "local-agent").installed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped local agent list names a launch command and the program it needs", () => {
  const local = registry.readLocal();
  const byId = Object.fromEntries(local.agents.map((agent) => [agent.id, agent]));
  assert.ok(byId["command-code"], "Command Code is listed even though the registry lacks it");
  assert.equal(byId["antigravity-acp"].bin, "agy-acp");
  assert.deepEqual(byId["antigravity-acp"].requires, ["agy"]);
  assert.equal(local.aliases["codex-acp"][0], "codex");
  assert.equal(local.aliases["claude-acp"][0], "claude");
  for (const agent of local.agents) assert.ok(agent.distribution && Object.keys(agent.distribution).length, `${agent.id} can start`);
});

test("adding an agent runs its own command without a download, but not a native CLI the adapter only needs", () => {
  let saved = null;
  const store = { applyOperations: (startupId, operations) => { saved = operations[0].value; } };
  const base = { id: "codex-acp", name: "Codex", version: "1.0.0", launch: { kind: "npx", package: "@agentclientprotocol/codex-acp", args: [] }, installed: true, installedPath: "/usr/local/bin/codex", bin: "codex-acp" };
  const adapter = harnesses.addHarness(store, { agent: { ...base, installedBin: "" }, confirmed: true });
  assert.equal(adapter.kind, "npx", "codex itself is not the adapter");
  const own = harnesses.addHarness(store, { agent: { ...base, id: "command-code", bin: "command-code", installedBin: "command-code" }, confirmed: true });
  assert.equal(own.kind, "binary");
  assert.equal(own.command, "command-code");
  assert.equal(saved.kind, "binary");
});

test("the shipped snapshot and catalog agree: every catalog launch command is the registry's", () => {
  const snapshot = JSON.parse(fs.readFileSync(registry.SNAPSHOT_FILE, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(registry.CATALOG_FILE, "utf8"));
  const parsed = registry.parseRegistry(snapshot.registry);
  assert.ok(parsed.agents.length >= 20);
  assert.ok(catalog.agents.length > 0 && catalog.agents.length <= 20);
  const byId = new Map(parsed.agents.map((agent) => [agent.id, agent]));
  for (const entry of catalog.agents) {
    assert.ok(byId.has(entry.id), `${entry.id} is in the snapshot`);
    assert.deepEqual(entry.distribution, byId.get(entry.id).distribution, `${entry.id} launches as the registry says`);
  }
  // Rebuilding the catalog from the snapshot gives the same file.
  assert.deepEqual(buildCatalog(snapshot.registry, catalog.checkedOn).catalog.agents, catalog.agents);
  assert.ok(CATALOG.length <= 20);
  // The snapshot keeps only what the app reads (no authors or addresses).
  assert.deepEqual(slimRegistry(SAMPLE).agents[0], { id: "npx-agent", name: "Npx agent", version: "1.0.0", description: "d", distribution: SAMPLE.agents[0].distribution });
  assert.ok(!JSON.stringify(snapshot).includes("authors"));
});

function fakeHarness(extra = {}) {
  return { id: "h1", kind: "custom", command: process.execPath, args: [FIXTURE], ...extra };
}

test("Check: ready with models, needs login, incompatible, not installed, failed", async () => {
  const secretsDir = tempDir("st-check-");
  const env = (mode) => {
    fs.writeFileSync(path.join(secretsDir, "agent-env.json"), JSON.stringify({ h1: { FAKE_ACP_MODE: mode } }));
  };
  try {
    env("");
    const ready = await runCheck(fakeHarness(), { secretsDir, testPrompt: true });
    assert.equal(ready.state, "ready", ready.message);
    assert.deepEqual(ready.models.map((model) => model.value), ["fake-small", "fake-large"]);
    assert.equal(ready.agentInfo.name, "fake-agent");
    assert.match(ready.testReply, /Working with/);
    assert.deepEqual(ready.thoughtLevels.map((level) => level.value), ["low", "high"]);
    assert.deepEqual(Object.keys(ready.modelEfforts), ["", "fake-small"], "the session's own model");
    const effort = await runCheck(fakeHarness({ defaultModel: "fake-large", preferredModels: ["fake-small", "gone"], effortByModel: { "fake-large": "max" } }), { secretsDir, testPrompt: true });
    assert.deepEqual(effort.modelEfforts["fake-large"].map((level) => level.value), ["low", "high", "max"], "levels are read per model");
    assert.deepEqual(effort.modelEfforts["fake-small"].map((level) => level.value), ["low", "high"]);
    assert.equal(effort.modelEfforts.gone, undefined, "a model the agent does not offer has no levels");
    assert.match(effort.testReply, /Working with fake-large at max/, "the test prompt uses the default model and its effort");

    env("notify");
    const notified = await runCheck(fakeHarness({ defaultModel: "fake-large", effortByModel: { "fake-large": "max" } }), { secretsDir, testPrompt: true });
    assert.deepEqual(notified.modelEfforts["fake-large"].map((level) => level.value), ["low", "high", "max"], "levels from a config_option_update notification");
    assert.match(notified.testReply, /at max/);

    env("cline");
    const cline = await runCheck(fakeHarness({ registryId: "cline", defaultModel: "fake-large", effortByModel: { "fake-large": "xhigh" } }), { secretsDir, testPrompt: true });
    assert.deepEqual(cline.modelEfforts["fake-large"].map((level) => level.value), ["none", "low", "medium", "high", "xhigh"], "Cline's levels come from its launch flag");
    assert.match(cline.testReply, /at xhigh/, "started with --thinking xhigh");

    env("legacy");
    const legacy = await runCheck(fakeHarness(), { secretsDir });
    assert.equal(legacy.state, "ready");
    assert.equal(legacy.currentModel, "fake-small");

    env("login");
    const login = await runCheck(fakeHarness(), { secretsDir });
    assert.equal(login.state, "needs-login");
    const terminal = login.authMethods.find((method) => method.type === "terminal");
    assert.match(terminal.command, /fake-acp-agent\.js login$/, "the exact command to run");
    assert.equal(login.authMethods.find((method) => method.type === "agent").id, "fake-oauth");
    const loggedIn = await runCheck(fakeHarness(), { secretsDir, authenticateWith: "fake-oauth" });
    assert.equal(loggedIn.state, "ready", "Authenticate, then the session opens");

    env("incompatible");
    assert.equal((await runCheck(fakeHarness(), { secretsDir })).state, "incompatible");

    assert.equal((await runCheck(fakeHarness({ command: "no-such-agent-program" }), { secretsDir })).state, "not-installed");

    const broken = await runCheck(fakeHarness({ args: ["-e", "process.stderr.write('boom\\n'); process.exit(3)"] }), { secretsDir });
    assert.equal(broken.state, "failed");
    assert.match(broken.message, /exit code 3/);
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
});

test("Check asks before the first npx or uvx download", async () => {
  const harness = { id: "h2", kind: "npx", package: "@example/agent@1.0.0", args: [], downloadConsent: "" };
  assert.equal(needsDownloadConsent(harness), true);
  const result = await runCheck(harness, { secretsDir: os.tmpdir() });
  assert.equal(result.state, "consent-needed");
  assert.equal(result.package, "@example/agent@1.0.0");
  assert.equal(needsDownloadConsent({ ...harness, downloadConsent: "@example/agent@1.0.0" }), false);
  assert.equal(needsDownloadConsent({ ...harness, downloadConsent: "@example/agent@0.9.0" }), true, "a new version asks again");
  assert.equal(terminalLogin({ ...harness, args: ["--acp"] }, { args: ["login"], env: { MODE: "x" } }), "MODE=x npx --yes @example/agent@1.0.0 --acp login");
});

test("the release checks that each catalog agent's launch command still resolves", async () => {
  const { splitPackage, launchTargets, resolveLaunchCommands } = require("../tools/update-acp-registry");
  assert.deepEqual(splitPackage("@google/gemini-cli@0.64.0"), { name: "@google/gemini-cli", version: "0.64.0" });
  assert.deepEqual(splitPackage("cline@3.0.73"), { name: "cline", version: "3.0.73" });
  assert.deepEqual(launchTargets({ distribution: { npx: { package: "@scope/agent@1.2.3" } } }).map((target) => target.url), ["https://registry.npmjs.org/@scope%2Fagent/1.2.3"]);
  assert.deepEqual(launchTargets({ distribution: { uvx: { package: "fast-agent-acp==0.3.1" } } }).map((target) => target.url), ["https://pypi.org/pypi/fast-agent-acp/0.3.1/json"]);
  const catalog = {
    agents: [
      { id: "good", distribution: { npx: { package: "good@1.0.0" } } },
      { id: "gone", distribution: { npx: { package: "gone@9.9.9" } } },
      { id: "bin", distribution: { binary: { "linux-x86_64": { archive: "https://example.com/bin.tar.gz", cmd: "./bin" }, "darwin-aarch64": { archive: "https://example.com/refuses-head.zip", cmd: "./bin" } } } },
      { id: "nothing", distribution: {} },
    ],
  };
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push(`${options.method} ${url}`);
    if (url.includes("gone")) return { status: 404 };
    if (url.includes("refuses-head") && options.method === "HEAD") return { status: 405 };
    return { status: 200 };
  };
  const results = await resolveLaunchCommands(catalog, { fetchImpl });
  assert.deepEqual(results.map((result) => [result.id, result.ok]), [["good", true], ["gone", false], ["bin", true], ["nothing", false]]);
  assert.match(results[1].problems[0], /HTTP 404/);
  assert.ok(asked.includes("GET https://example.com/refuses-head.zip"), "a refused HEAD is retried with a small GET");
});
