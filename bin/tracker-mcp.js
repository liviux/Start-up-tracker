#!/usr/bin/env node
"use strict";

// The tracker tools for an agent run, as an MCP server over stdio. The
// tracker starts it for each run (through the agent, as the run's MCP
// server) with:
//   TRACKER_URL         the tracker's address, e.g. http://127.0.0.1:57322
//   TRACKER_RUN_TOKEN   the run's own token: it can create, update and link
//                       records of one startup while the run lasts
//   TRACKER_STARTUP_ID  that startup
//   TRACKER_RUN_ID      the run
// Each tool call becomes one request to the tracker, which does the work and
// writes the history. A request that fails on the network is retried with the
// same mutation id, so the tracker applies it once.
//
// Protocol: the stateless MCP revision 2026-07-28 (server/discover, the
// version in each request's _meta) and the handshake revisions 2025-11-25
// and 2025-06-18 (initialize first). No dependencies.

const crypto = require("crypto");
const path = require("path");
const { JsonRpcPeer, RpcError, ERRORS } = require(path.join(__dirname, "..", "lib", "agents", "jsonrpc.js"));
const { TOOLS } = require(path.join(__dirname, "..", "lib", "agents", "tool-definitions.js"));

const SERVER_INFO = { name: "startup-tracker", title: "Startup Tracker", version: "1.0.0" };
const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18"];
const UNSUPPORTED_VERSION = -32022;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const INSTRUCTIONS = "Tools of the Startup Tracker for this run's startup. Check for duplicates with search_targets before create_target. Nothing can be deleted.";

function toolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: false, openWorldHint: false },
  }));
}

// Calls the tracker; retries a network failure up to three times with the
// same mutation id.
async function callTracker(name, args, env = process.env, fetchImpl = fetch) {
  const base = String(env.TRACKER_URL || "").replace(/\/+$/, "");
  const url = `${base}/api/s/${encodeURIComponent(env.TRACKER_STARTUP_ID || "")}/agent-tools/${encodeURIComponent(name)}`;
  const body = JSON.stringify({ arguments: args || {}, mutationId: `${env.TRACKER_RUN_ID || "run"}:${crypto.randomUUID()}`, runId: env.TRACKER_RUN_ID || "" });
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TRACKER_RUN_TOKEN || ""}` }, body });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok || answer.ok === false) return { error: answer.error || `The tracker answered ${response.status}.` };
      return { result: answer.result };
    } catch (error) {
      lastError = error;
    }
  }
  return { error: `The tracker could not be reached: ${lastError?.message || "unknown error"}` };
}

function createServer({ env = process.env, fetchImpl = fetch } = {}) {
  let era = "";
  let legacyVersion = "";

  function checkModern(params) {
    const requested = params?._meta?.[META_VERSION];
    if (!requested) return;
    if (!MODERN_VERSIONS.includes(requested)) {
      throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested });
    }
    era = era || "modern";
  }

  async function onRequest(method, params) {
    switch (method) {
      case "server/discover":
        checkModern(params);
        return {
          supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        };
      case "initialize": {
        const requested = String(params?.protocolVersion || "");
        legacyVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        era = "legacy";
        return { protocolVersion: legacyVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case "ping":
        return {};
      case "tools/list": {
        if (era !== "legacy") checkModern(params);
        const out = { tools: toolList() };
        if (era === "modern") Object.assign(out, { ttlMs: 3600000, cacheScope: "session" });
        return out;
      }
      case "tools/call": {
        if (era !== "legacy") checkModern(params);
        const tool = TOOLS.find((entry) => entry.name === params?.name);
        if (!tool) throw new RpcError(ERRORS.INVALID_PARAMS, `Unknown tool: ${params?.name}`);
        const answer = await callTracker(tool.name, params.arguments || {}, env, fetchImpl);
        if (answer.error) return { content: [{ type: "text", text: answer.error }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(answer.result, null, 2) }], structuredContent: answer.result, isError: false };
      }
      default:
        throw new RpcError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return { onRequest, state: () => ({ era, legacyVersion }) };
}

if (require.main === module) {
  const server = createServer();
  const peer = new JsonRpcPeer(process.stdin, process.stdout, { onRequest: server.onRequest, onNotification: () => {} });
  peer.on("close", () => process.exit(0));
}

module.exports = { SERVER_INFO, MODERN_VERSIONS, LEGACY_VERSIONS, UNSUPPORTED_VERSION, META_VERSION, createServer, callTracker, toolList };
