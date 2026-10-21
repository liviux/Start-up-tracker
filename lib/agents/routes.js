"use strict";

// The HTTP routes of Settings > AI agents and of agent runs.
//
//   GET    /api/agents                         agents you set up, the registry, run settings
//   POST   /api/agents/rescan                  fetch the registry again, look for installed agents
//   POST   /api/agents/harnesses               add an agent (needs "confirmed": true)
//   PATCH  /api/agents/harnesses/<id>          change one
//   DELETE /api/agents/harnesses/<id>          remove one
//   POST   /api/agents/harnesses/<id>/check    run the check ("consent", "testPrompt")
//   POST   /api/agents/harnesses/<id>/authenticate   log in with an agent-handled method
//   PUT    /api/agents/settings                concurrency, timeout, runs kept, idle minutes
//   POST   /api/s/<id>/agent-runs              start a run
//   GET    /api/s/<id>/agent-runs              the startup's runs
//   GET    /api/agent-runs                     every run, with the counts for the badge
//   GET    /api/agent-runs/<runId>             one run
//   GET    /api/agent-runs/<runId>/events      its events: Server-Sent Events, or JSON with ?format=json
//   POST   /api/agent-runs/<runId>/cancel | message | undo | permissions/<requestId>
//   GET    /api/agent-runs/<runId>/log         the redacted protocol log
//   POST   /api/agent-runs/stop-all
//   POST   /api/s/<id>/agent-tools/<tool>      the tracker tools, for a run token only

const os = require("os");
const harnesses = require("./harnesses");
const registry = require("./registry");
const { runCheck } = require("./check");
const { RunError } = require("./runs");
const { ToolError } = require("./tools");
const PromptRender = require("../../public/js/prompt-render.js");
const PromptsPage = require("../../public/js/prompts-page.js");

const SSE_PING_MS = 15000;

function createAgentRoutes({ store, paths, runs, appVersion, readJsonBody, sendJson, HttpError, safeDecode, readSettings, startupName, offline = false }) {
  const checking = new Set();
  const streams = new Set();

  function networkAllowed() {
    return !offline && readSettings().network !== false;
  }

  async function overview({ force = false } = {}) {
    const loaded = await registry.loadRegistry({ cacheDir: paths.cacheDir, network: networkAllowed(), force });
    const list = harnesses.listHarnesses(store);
    const added = new Set(list.map((harness) => harness.registryId).filter(Boolean));
    return {
      registry: {
        source: loaded.source,
        fetchedAt: loaded.fetchedAt,
        version: loaded.version,
        problem: loaded.problem,
        network: networkAllowed(),
        agents: registry.describeAgents(loaded).map((agent) => ({ ...agent, added: added.has(agent.id) })),
      },
      harnesses: list.map(harnesses.publicHarness),
      settings: harnesses.readSettings(store),
      policies: harnesses.POLICIES,
      platform: registry.platformKey(),
      homeDir: os.homedir(),
    };
  }

  function sendError(res, error) {
    const status = error.statusCode || 400;
    sendJson(res, { ok: false, error: error.message, code: error.code || "", ...(error.preview ? { preview: error.preview } : {}) }, status);
  }

  // Runs a check and keeps its result on the harness. "consent-needed" is
  // only reported: nothing failed yet.
  async function check(id, { consent = false, testPrompt = false, authenticateWith = "" } = {}) {
    if (checking.has(id)) throw new HttpError(409, "This agent is being checked already.", "checking");
    let harness = harnesses.getHarness(store, id);
    if (consent && (harness.kind === "npx" || harness.kind === "uvx")) harness = harnesses.updateHarness(store, paths.secretsDir, id, { downloadConsent: true });
    checking.add(id);
    try {
      const result = await runCheck(harness, { secretsDir: paths.secretsDir, clientVersion: appVersion, testPrompt: Boolean(testPrompt), authenticateWith: String(authenticateWith || "") });
      if (result.state === "consent-needed") return { check: result, harness: harnesses.publicHarness(harness) };
      const current = harnesses.getHarness(store, id);
      const next = { ...current, lastCheck: result };
      // A pass lifts the block, so the override is no longer needed.
      if (result.state === "ready") Object.assign(next, { models: result.models, overrideBlock: false });
      const saved = harnesses.saveHarness(store, next, { label: `AI agent checked: ${current.name}` });
      return { check: result, harness: harnesses.publicHarness(saved) };
    } finally {
      checking.delete(id);
    }
  }

  // The prompt a run sends: the page's template and values, rendered here
  // with the same renderer, and the run's own {{TRACKER_ACCESS}}.
  function renderRunPrompt(startupId, parsed) {
    const template = String(parsed.template || "");
    if (!template.trim()) throw new HttpError(400, "The prompt is empty.", "emptyPrompt");
    const values = parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? { ...parsed.values } : {};
    values.TRACKER_ACCESS = PromptsPage.trackerAccess("run", { startupId, startupName: startupName(startupId) });
    const result = PromptRender.render(template, values);
    if (result.unresolved.length) {
      throw new HttpError(400, `Fill these variables first: ${result.unresolved.map((name) => `{{${name}}}`).join(", ")}.`, "unresolved");
    }
    return result.text;
  }

  function openStream(req, res, runId, after) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let last = after;
    const send = (event) => {
      if (event.seq && event.seq <= last) return;
      if (event.seq) last = event.seq;
      res.write(`${event.seq ? `id: ${event.seq}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Listening starts before the stored events are read, and both happen in
    // one synchronous step, so nothing falls between them; `last` drops what
    // would come twice.
    const stop = runs.subscribe(runId, (event) => {
      send(event);
      if (event.type === "closed") finish();
    });
    for (const event of runs.events(runId, after)) send(event);
    const entry = { res, finish: () => finish() };
    streams.add(entry);
    const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_MS);
    ping.unref?.();
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearInterval(ping);
      stop();
      streams.delete(entry);
      res.end();
    }
    if (!runs.isLive(runId)) {
      send({ seq: 0, type: "closed", data: {} });
      finish();
      return;
    }
    req.on("close", finish);
  }

  // Global routes. Returns true when it answered.
  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (!pathname.startsWith("/api/agents") && !pathname.startsWith("/api/agent-runs")) return false;
    try {
      if (pathname === "/api/agents" && method === "GET") {
        sendJson(res, { ok: true, ...(await overview()) });
        return true;
      }
      if (pathname === "/api/agents/rescan" && method === "POST") {
        sendJson(res, { ok: true, ...(await overview({ force: true })) });
        return true;
      }
      if (pathname === "/api/agents/settings" && method === "PUT") {
        const parsed = await readJsonBody(req);
        sendJson(res, { ok: true, settings: harnesses.writeSettings(store, parsed.settings || parsed) });
        return true;
      }
      if (pathname === "/api/agents/harnesses" && method === "POST") {
        const parsed = await readJsonBody(req);
        let agent = null;
        if (parsed.registryId) {
          const loaded = await registry.loadRegistry({ cacheDir: paths.cacheDir, network: false });
          agent = registry.describeAgents(loaded).find((entry) => entry.id === parsed.registryId);
          if (!agent) throw new HttpError(404, "This agent is not in the registry.", "unknownAgent");
        }
        const custom = parsed.custom && typeof parsed.custom === "object" ? parsed.custom : null;
        // "preview": the exact command, for the page to show before you confirm.
        if (parsed.preview === true) {
          try {
            harnesses.addHarness(store, { agent, custom, confirmed: false, name: parsed.name });
          } catch (error) {
            if (error.code !== "confirmNeeded") throw error;
            sendJson(res, { ok: true, preview: error.preview });
            return true;
          }
        }
        const harness = harnesses.addHarness(store, { agent, custom, confirmed: parsed.confirmed === true, name: parsed.name });
        sendJson(res, { ok: true, harness: harnesses.publicHarness(harness) }, 201);
        return true;
      }
      const harnessMatch = pathname.match(/^\/api\/agents\/harnesses\/([0-9a-f-]{36})(?:\/(check|authenticate))?$/);
      if (harnessMatch) {
        const id = harnessMatch[1];
        if (!harnessMatch[2] && method === "PATCH") {
          const parsed = await readJsonBody(req);
          sendJson(res, { ok: true, harness: harnesses.publicHarness(harnesses.updateHarness(store, paths.secretsDir, id, parsed)) });
          return true;
        }
        if (!harnessMatch[2] && method === "DELETE") {
          if (runs.list().some((run) => run.harnessId === id && ["queued", "starting", "running", "waiting"].includes(run.status))) {
            throw new HttpError(409, "This agent has a run going. Cancel it first.", "busy");
          }
          sendJson(res, { ok: true, removed: harnesses.publicHarness(harnesses.removeHarness(store, paths.secretsDir, id)) });
          return true;
        }
        if (harnessMatch[2] === "check" && method === "POST") {
          const parsed = await readJsonBody(req);
          sendJson(res, { ok: true, ...(await check(id, { consent: parsed.consent === true, testPrompt: parsed.testPrompt === true })) });
          return true;
        }
        if (harnessMatch[2] === "authenticate" && method === "POST") {
          const parsed = await readJsonBody(req);
          if (!parsed.methodId) throw new HttpError(400, "Pick a login method.", "badRequest");
          sendJson(res, { ok: true, ...(await check(id, { authenticateWith: parsed.methodId })) });
          return true;
        }
      }

      if (pathname === "/api/agent-runs" && method === "GET") {
        sendJson(res, { ok: true, runs: runs.list({ startupId: url.searchParams.get("startupId") || "" }), counts: runs.counts() });
        return true;
      }
      if (pathname === "/api/agent-runs/stop-all" && method === "POST") {
        sendJson(res, { ok: true, stopped: await runs.stopAll() });
        return true;
      }
      const runMatch = pathname.match(/^\/api\/agent-runs\/(run-[a-z0-9]{6,40})(?:\/(events|cancel|message|undo|log|permissions\/[0-9a-f-]{36}))?$/);
      if (runMatch) {
        const runId = runMatch[1];
        const action = runMatch[2] || "";
        if (!action && method === "GET") {
          const run = runs.get(runId);
          sendJson(res, { ok: true, run, live: runs.isLive(runId), canMessage: runs.canMessage(runId) });
          return true;
        }
        if (action === "events" && method === "GET") {
          runs.get(runId);
          const header = Number(req.headers["last-event-id"]);
          const query = Number(url.searchParams.get("after"));
          const after = Number.isInteger(header) && header > 0 ? header : Number.isInteger(query) && query > 0 ? query : 0;
          if (url.searchParams.get("format") === "json") {
            sendJson(res, { ok: true, events: runs.events(runId, after), live: runs.isLive(runId) });
            return true;
          }
          openStream(req, res, runId, after);
          return true;
        }
        if (action === "log" && method === "GET") {
          const text = runs.logText(runId);
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            ...(url.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename="${runId}-log.jsonl"` } : {}),
          });
          res.end(text);
          return true;
        }
        if (method === "POST") {
          const parsed = await readJsonBody(req);
          if (action === "cancel") {
            const run = await runs.cancel(runId);
            sendJson(res, { ok: true, run: runs.summary(run) });
            return true;
          }
          if (action === "message") {
            const run = await runs.sendMessage(runId, parsed.text);
            sendJson(res, { ok: true, run: runs.summary(run) });
            return true;
          }
          if (action === "undo") {
            sendJson(res, { ok: true, ...runs.undo(runId) });
            return true;
          }
          if (action.startsWith("permissions/")) {
            sendJson(res, { ok: true, permission: runs.answerPermission(runId, action.slice("permissions/".length), String(parsed.optionId || "")) });
            return true;
          }
        }
      }
      sendJson(res, { ok: false, error: "notFound", message: "Unknown API route." }, 404);
      return true;
    } catch (error) {
      if (error instanceof HttpError || error.statusCode) {
        if (res.headersSent) res.destroy();
        else sendError(res, error);
        return true;
      }
      throw error;
    }
  }

  // Routes under /api/s/<startupId>. Returns true when it answered.
  async function handleStartup(req, res, url, startupId, subPath) {
    if (subPath === "/agent-runs") {
      if (req.method === "GET") {
        sendJson(res, { ok: true, runs: runs.list({ startupId }), counts: runs.counts() });
        return true;
      }
      if (req.method === "POST") {
        const parsed = await readJsonBody(req);
        try {
          const prompt = renderRunPrompt(startupId, parsed);
          const run = runs.create({ startupId, harnessId: String(parsed.harnessId || ""), model: parsed.model, prompt, title: parsed.title, presetId: parsed.presetId });
          sendJson(res, { ok: true, run: runs.summary(run) }, 201);
        } catch (error) {
          if (error instanceof RunError || error instanceof harnesses.HarnessError || error instanceof HttpError) sendError(res, error);
          else throw error;
        }
        return true;
      }
    }
    const toolMatch = subPath.match(/^\/agent-tools\/([a-z_]+)$/);
    if (toolMatch && req.method === "POST") {
      if (!req.agentToken || req.agentToken.scope !== "run") throw new HttpError(403, "The tracker tools are for agent runs only.", "runTokenOnly");
      const parsed = await readJsonBody(req);
      try {
        const result = runs.toolCall(req.agentToken, toolMatch[1], parsed.arguments, parsed.mutationId);
        sendJson(res, { ok: true, result });
      } catch (error) {
        if (error instanceof ToolError || error instanceof RunError || error.statusCode) sendJson(res, { ok: false, error: error.message, code: error.code || "" }, error.statusCode || 400);
        else sendJson(res, { ok: false, error: error.message, code: "toolFailed" }, 500);
      }
      return true;
    }
    return false;
  }

  // Ends the open event streams, so the server can close.
  function closeStreams() {
    for (const entry of [...streams]) entry.finish();
  }

  return { handle, handleStartup, closeStreams, overview, renderRunPrompt };
}

module.exports = { createAgentRoutes };
