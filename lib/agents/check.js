"use strict";

// "Check" in Settings > AI agents: starts the agent, says hello over ACP,
// opens a session in an empty temporary folder to read its models, then
// closes everything. It ends in one of five states:
//   not-installed   the program cannot be found or started
//   needs-login     the agent wants you to log in first
//   incompatible    it does not speak ACP version 1
//   ready           it answered and listed what it offers
//   failed          anything else went wrong
// Before the first npx or uvx download the page asks for consent; without it
// the check stops at "consent-needed" and names the package.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { AcpConnection, AcpError } = require("./acp-client");
const { resolveLaunch, cleanEnv } = require("./process");
const { readEnv } = require("./harnesses");

const STATES = Object.freeze(["not-installed", "needs-login", "incompatible", "ready", "failed"]);
// ACP's error for a session that needs authentication first.
const AUTH_REQUIRED = -32000;

function needsDownloadConsent(harness) {
  return (harness.kind === "npx" || harness.kind === "uvx") && harness.downloadConsent !== harness.package;
}

// The command to run in a terminal for a terminal login method: the agent's
// own command line with the method's extra arguments and variables.
function terminalLogin(harness, method) {
  const extra = Array.isArray(method?.args) ? method.args : [];
  const env = method?.env && typeof method.env === "object" ? Object.entries(method.env).map(([name, value]) => `${name}=${value}`) : [];
  const base = harness.kind === "npx" ? ["npx", "--yes", harness.package] : harness.kind === "uvx" ? ["uvx", harness.package] : [harness.command];
  return [...env, ...base, ...(harness.args || []), ...extra].join(" ");
}

function describeAuth(harness, methods) {
  return (Array.isArray(methods) ? methods : []).map((method) => ({
    id: String(method.id),
    name: String(method.name || method.id),
    description: String(method.description || ""),
    type: method.type === "terminal" ? "terminal" : "agent",
    command: method.type === "terminal" ? terminalLogin(harness, method) : "",
  }));
}

// Runs the check. Options: secretsDir, clientVersion, testPrompt (asks for
// "OK"), authenticateWith (a method id to call first), timeoutMs.
async function runCheck(harness, { secretsDir, clientVersion = "", testPrompt = false, authenticateWith = "", timeoutMs = 180000, onProgress = () => {} } = {}) {
  const started = Date.now();
  const result = { state: "failed", message: "", at: new Date().toISOString(), agentInfo: null, models: [], thoughtLevels: [], modes: [], authMethods: [], testReply: "", durationMs: 0 };
  const done = (state, message) => Object.assign(result, { state, message, durationMs: Date.now() - started });
  if (needsDownloadConsent(harness)) return { ...done("consent-needed", `Starting this agent downloads ${harness.package} with ${harness.kind}.`), package: harness.package };
  const env = cleanEnv(readEnv(secretsDir, harness.id));
  const launch = resolveLaunch(harness, { env });
  if (launch.error) return done("not-installed", launch.error);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "st-agent-check-"));
  const connection = new AcpConnection({ launch, cwd: tmp, env, clientVersion });
  try {
    connection.start();
    onProgress("Starting the agent");
    const info = await connection.initialize({ timeoutMs });
    result.agentInfo = info.agentInfo;
    result.authMethods = describeAuth(harness, info.authMethods);
    if (authenticateWith) {
      onProgress("Logging in");
      await connection.authenticate(authenticateWith);
    }
    onProgress("Opening a session");
    let session;
    try {
      session = await connection.newSession({ cwd: tmp, mcpServers: [], timeoutMs: Math.min(timeoutMs, 120000) });
    } catch (error) {
      if (error.code === AUTH_REQUIRED || /auth|log ?in|sign ?in|api key/i.test(error.message || "")) return done("needs-login", error.message || "The agent asks you to log in.");
      throw error;
    }
    Object.assign(result, { models: session.choices.models, currentModel: session.choices.currentModel, thoughtLevels: session.choices.thoughtLevels, modes: session.choices.modes });
    if (testPrompt) {
      onProgress("Asking for OK");
      let reply = "";
      connection.hooks.onUpdate = (params) => {
        const update = params?.update;
        if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") reply += update.content.text;
      };
      if (harness.defaultModel) await connection.setModel(session.sessionId, harness.defaultModel).catch(() => {});
      await connection.prompt(session.sessionId, "Reply with the single word OK.");
      result.testReply = reply.trim().slice(0, 200);
    }
    await connection.closeSession(session.sessionId);
    return done("ready", "");
  } catch (error) {
    if (error instanceof AcpError && error.code === "notInstalled") return done("not-installed", error.message);
    if (error instanceof AcpError && error.code === "incompatible") return done("incompatible", error.message);
    if (error.code === AUTH_REQUIRED) return done("needs-login", error.message);
    const tail = connection.stderrTail();
    return done("failed", `${error.message}${tail && !error.message.includes(tail) ? ` (${tail})` : ""}`);
  } finally {
    await connection.stop({ graceMs: 1500 }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { STATES, AUTH_REQUIRED, needsDownloadConsent, terminalLogin, describeAuth, runCheck };
