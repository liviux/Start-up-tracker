#!/usr/bin/env node
"use strict";

// A stand-in ACP agent for the tests. FAKE_ACP_MODE picks its behaviour:
//   (empty)       models as a config option
//   legacy        models in the older `models` field (session/set_model)
//   login         asks for a terminal login before a session
//   incompatible  answers with protocol version 2
// What a prompt does depends on words in it:
//   USE_TOOLS     starts the MCP server it was given and calls the tracker tools
//   PERMISSION    asks for permission to edit, then to read
//   WAIT          waits until cancelled
//   JSON          ends with a ```json block of targets
//   FS            calls fs/read_text_file on the client (expects -32601)

const { spawn } = require("child_process");
const path = require("path");
const { JsonRpcPeer } = require(path.join(__dirname, "..", "..", "lib", "agents", "jsonrpc.js"));

const mode = process.env.FAKE_ACP_MODE || "";
let loggedIn = false;
let model = "fake-small";
let cancelled = null;
const sessions = new Map();

const peer = new JsonRpcPeer(process.stdin, process.stdout, {
  onRequest: (method, params) => handle(method, params),
  onNotification: (method, params) => {
    if (method === "session/cancel" && cancelled) cancelled(params.sessionId);
  },
});
peer.on("close", () => process.exit(0));
process.stderr.write("fake agent started\n");
// For the redaction test: a configured secret that ends up in the log.
if (process.env.FAKE_SECRET) process.stderr.write(`using secret ${process.env.FAKE_SECRET}\n`);

const update = (sessionId, body) => peer.notify("session/update", { sessionId, update: body });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: mode === "incompatible" ? 2 : 1,
        agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
        authMethods: mode === "login" ? [{ id: "fake-login", name: "Log in with the fake CLI", type: "terminal", args: ["login"] }, { id: "fake-oauth", name: "Log in in the browser" }] : [],
        agentInfo: { name: "fake-agent", title: "Fake agent", version: "0.1.0" },
      };
    case "authenticate":
      loggedIn = true;
      return {};
    case "session/new": {
      if (mode === "login" && !loggedIn) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      const sessionId = `sess-${sessions.size + 1}`;
      sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers || [] });
      if (mode === "legacy") return { sessionId, models: { currentModelId: model, availableModels: [{ modelId: "fake-small", name: "Fake small" }, { modelId: "fake-large", name: "Fake large" }] } };
      return {
        sessionId,
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ value: "fake-small", name: "Fake small" }, { value: "fake-large", name: "Fake large" }] },
          { id: "effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        ],
      };
    }
    case "session/set_config_option":
      if (params.configId === "model") model = params.value;
      return { configOptions: [] };
    case "session/set_model":
      model = params.modelId;
      return {};
    case "session/close":
      sessions.delete(params.sessionId);
      return {};
    case "session/prompt":
      return prompt(params);
    default: {
      const error = new Error(`Method not found: ${method}`);
      error.code = -32601;
      throw Object.assign(error, { name: "RpcError" });
    }
  }
}

async function prompt({ sessionId, prompt: blocks }) {
  const text = (blocks || []).map((block) => block.text || "").join("\n");
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it." } });
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Find targets", priority: "high", status: "in_progress" }] });
  say(sessionId, `Working with ${model}.`);
  if (text.includes("FS")) {
    try {
      await peer.request("fs/read_text_file", { sessionId, path: "/etc/hostname" }, { timeoutMs: 5000 });
      say(sessionId, " fs-ok");
    } catch (error) {
      say(sessionId, ` fs-error:${error.code}`);
    }
  }
  if (text.includes("USE_TOOLS")) await useTools(sessionId);
  if (text.includes("PERMISSION")) {
    for (const [kind, title] of [["edit", "Edit notes.md"], ["read", "Read notes.md"]]) {
      const toolCallId = `perm-${kind}`;
      const answer = await peer.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title, kind, status: "pending" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      say(sessionId, ` permission-${kind}:${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
    }
  }
  if (text.includes("WAIT")) {
    const reason = await new Promise((resolve) => {
      cancelled = () => resolve("cancelled");
    });
    cancelled = null;
    return { stopReason: reason };
  }
  if (text.includes("JSON")) say(sessionId, "\n\n```json\n{\"targets\":[{\"section\":\"mk\",\"name\":\"Fake directory\",\"link\":\"https://example.com/directory\"}]}\n```\n");
  update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0.01, currency: "USD" } });
  return { stopReason: "end_turn" };
}

// Starts the session's first MCP server and creates a target through it.
async function useTools(sessionId) {
  const server = sessions.get(sessionId)?.mcpServers?.[0];
  if (!server) {
    say(sessionId, " no-mcp");
    return;
  }
  const env = { ...process.env };
  for (const entry of server.env || []) env[entry.name] = entry.value;
  const child = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const mcp = new JsonRpcPeer(child.stdout, child.stdin);
  try {
    const discovered = await mcp.request("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }, { timeoutMs: 10000 });
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const tools = await mcp.request("tools/list", meta, { timeoutMs: 10000 });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Create a target", kind: "other", status: "in_progress", rawInput: { name: "Fake grant" } });
    const created = await mcp.request("tools/call", { ...meta, name: "create_target", arguments: { section: "po", fields: { name: "Fake grant", link: "https://example.com/fake-grant" }, categories: ["po.grants"], notes: "Found by the fake agent." } }, { timeoutMs: 20000 });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: created.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: created.content[0].text } }] });
    say(sessionId, ` versions:${discovered.supportedVersions.join(",")} tools:${tools.tools.length} created:${created.isError ? "error" : created.structuredContent.id}`);
  } finally {
    mcp.close();
    child.kill();
  }
}
