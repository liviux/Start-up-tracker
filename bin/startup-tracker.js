#!/usr/bin/env node
"use strict";

// The startup-tracker command (docs/cli.md). With no command it starts the
// tracker when it is not running and opens it in the browser; the other
// commands stop it, report on it, take and restore backups, update, set up
// autostart, check the install and remove it.
//
// The work lives in lib/cli/; this file reads the arguments, finds the data
// folder and calls the right piece. main() takes its outputs, prompts and
// network as arguments, so tests run every command without a terminal.

const MIN_NODE = [22, 16];

// Checked before anything else loads: older Node has no built-in SQLite and
// would fail with an error that names neither the problem nor the fix.
function nodeIsRecentEnough(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

if (require.main === module && !nodeIsRecentEnough()) {
  console.error(`Startup Tracker needs Node.js ${MIN_NODE.join(".")} or newer; this is ${process.versions.node}. See https://nodejs.org/ or docs/install.md.`);
  process.exit(1);
}

// Node 22 calls its built-in SQLite experimental and warns on first use; the
// warning means nothing to someone running the tracker.
const emitWarning = process.emitWarning;
process.emitWarning = function quietSqlite(warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type || warning?.name;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning?.message || warning))) return;
  emitWarning.call(process, warning, ...rest);
};

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { UsageError, parseArgs, dataFolderArgs, helpText } = require("../lib/cli/args");
const { resolveDataRoot, dataPaths } = require("../lib/data-root");
const { APP_ROOT, installLayout, readPackage } = require("../lib/cli/layout");
const config = require("../lib/cli/config");
const runState = require("../lib/cli/run-state");
const serverProcess = require("../lib/cli/server-process");
const ports = require("../lib/cli/ports");
const browser = require("../lib/cli/browser");
const prompt = require("../lib/cli/prompt");

const CLI_PATH = path.join(APP_ROOT, "bin", "startup-tracker.js");

function defaults(deps = {}) {
  return {
    out: (line = "") => process.stdout.write(`${line}\n`),
    err: (line = "") => process.stderr.write(`${line}\n`),
    env: process.env,
    fetchImpl: globalThis.fetch,
    interactive: prompt.isInteractive(),
    ask: (question) => prompt.ask(question),
    openBrowser: (url) => browser.openBrowser(url),
    appRoot: APP_ROOT,
    ...deps,
  };
}

function yes(answer) {
  return /^y(es)?$/i.test(String(answer).trim());
}

// ---- start, stop, status ----------------------------------------------------

function serverUrl(run) {
  return run.url || `http://127.0.0.1:${run.port}/`;
}

// What a taken port means, and on a terminal the offer to save another one.
// Returns the port to start on, or null to give up.
async function handleTakenPort(port, ctx) {
  const { paths, deps } = ctx;
  const { owner } = await ports.identifyPortOwner(port, paths, { fetchImpl: deps.fetchImpl });
  if (owner === "ours") return { already: true };
  deps.err(owner === "tracker"
    ? `Port ${port} is used by another Startup Tracker, with a different data folder.`
    : `Port ${port} is used by another program.`);
  const free = await ports.findFreePort(port);
  if (!free) {
    deps.err("No free port was found near it. Stop the other program, or pick one with --port <n> --save-port.");
    return null;
  }
  if (!deps.interactive) {
    deps.err(`Start on another port and keep it with: startup-tracker start --port ${free} --save-port`);
    return null;
  }
  deps.out(`Port ${free} is free. The browser keeps edits it has not sent yet per address, so edits not yet saved stay with the old address until you open it again.`);
  const answer = await deps.ask(`Save port ${free} for every start and use it now? [y/N] `);
  if (!yes(answer)) return null;
  config.writeConfig(paths.configFile, { port: free });
  deps.out(`Saved port ${free} in ${paths.configFile}.`);
  return { port: free };
}

async function startServer(ctx, { open }) {
  const { flags, paths, deps } = ctx;
  const status = await runState.getServerStatus(paths, { fetchImpl: deps.fetchImpl });
  if (status.state === "running") {
    const url = serverUrl(status.run);
    deps.out(`Startup Tracker is already running at ${url}`);
    if (open) openOrPrint(url, deps);
    return 0;
  }
  if (status.state === "unresponsive") {
    deps.err(`A tracker process (pid ${status.run.pid}) is running but does not answer for ${paths.root}. Run "startup-tracker stop --force", then start again.`);
    return 1;
  }
  if (status.state === "stale") runState.removeRunState(paths.runDir);

  const saved = flags.dev ? {} : config.ensureConfig(paths.configFile);
  let { port } = config.resolvePort({ flagPort: flags.port ?? null, env: deps.env, config: saved, dev: Boolean(flags.dev) });
  if (flags["save-port"]) {
    if (flags.dev || !flags.port) throw new UsageError("--save-port needs --port <n> and is not for --dev.");
    config.writeConfig(paths.configFile, { port: config.parsePort(port, { allowZero: false }) });
    deps.out(`Saved port ${port} in ${paths.configFile}.`);
  }
  if (!(await ports.isPortFree(port))) {
    const outcome = await handleTakenPort(port, ctx);
    if (!outcome) return 1;
    if (outcome.already) {
      const url = `http://127.0.0.1:${port}/`;
      deps.out(`Startup Tracker is already running at ${url} (started without this command).`);
      if (open) openOrPrint(url, deps);
      return 0;
    }
    port = outcome.port;
  }

  if (flags.foreground) {
    deps.out(`Starting Startup Tracker on port ${port}; press Ctrl+C to stop it.`);
    serverProcess.runForeground({ appRoot: deps.appRoot, paths, port, dev: Boolean(flags.dev), open });
    return null;
  }
  let started;
  try {
    started = await serverProcess.startDetached({ appRoot: deps.appRoot, paths, port, dev: Boolean(flags.dev), env: deps.env });
  } catch (error) {
    deps.err(error.message);
    if (error.logTail) deps.err(`Last lines of ${serverProcess.logFile(paths)}:\n${error.logTail}`);
    return 1;
  }
  const url = serverUrl(started.run);
  deps.out(`Startup Tracker is running at ${url}`);
  deps.out(`Data folder: ${paths.root}`);
  if (open) openOrPrint(url, deps);
  return 0;
}

function openOrPrint(url, deps) {
  if (!deps.openBrowser(url)) deps.out(`Open ${url} in your browser.`);
}

async function stopServer(ctx, { quiet = false } = {}) {
  const { flags, paths, deps } = ctx;
  const status = await runState.getServerStatus(paths, { fetchImpl: deps.fetchImpl });
  if (status.state === "stopped" || status.state === "stale") {
    if (status.state === "stale") runState.removeRunState(paths.runDir);
    if (!quiet) deps.out("Startup Tracker is not running.");
    return true;
  }
  const result = await serverProcess.stopProcess(status.run.pid, { force: Boolean(flags.force) });
  if (!result.stopped) {
    deps.err(`The tracker (pid ${status.run.pid}) did not stop. Try "startup-tracker stop --force".`);
    return false;
  }
  runState.removeRunState(paths.runDir, status.run.pid);
  if (!quiet) deps.out(result.forced ? "Startup Tracker was stopped by force." : "Startup Tracker stopped.");
  return true;
}

async function statusCommand(ctx) {
  const { flags, paths, deps } = ctx;
  const status = await runState.getServerStatus(paths, { fetchImpl: deps.fetchImpl });
  if (flags.json) {
    deps.out(JSON.stringify({ state: status.state, url: status.run ? serverUrl(status.run) : null, pid: status.run?.pid ?? null, version: status.health?.version ?? null, dataFolder: paths.root }, null, 2));
    return status.state === "running" ? 0 : 3;
  }
  const lines = {
    running: () => `Running at ${serverUrl(status.run)} (pid ${status.run.pid}, version ${status.health.version}).`,
    unresponsive: () => `A tracker process (pid ${status.run.pid}) is running but does not answer for this data folder.`,
    stale: () => "Not running (it did not shut down cleanly last time).",
    stopped: () => "Not running.",
  };
  deps.out(lines[status.state]());
  deps.out(`Data folder: ${paths.root}`);
  return status.state === "running" ? 0 : 3;
}

// ---- logs ---------------------------------------------------------------------

async function logsCommand(ctx) {
  const { flags, paths, deps } = ctx;
  const file = serverProcess.logFile(paths);
  const lines = flags.lines ? Number(flags.lines) : 50;
  if (!fs.existsSync(file)) {
    deps.out(`No log yet (${file}).`);
    return 0;
  }
  const text = serverProcess.readLogTail(paths, lines);
  if (text) deps.out(text);
  if (!flags.follow) return 0;
  let offset = fs.statSync(file).size;
  await new Promise((resolve) => {
    const watcher = setInterval(() => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        process.stdout.write(buffer.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
    }, 500);
    process.once("SIGINT", () => {
      clearInterval(watcher);
      resolve();
    });
  });
  return 0;
}

// ---- backup, restore ------------------------------------------------------------

function runTool(ctx, tool) {
  const { flags, rest, deps } = ctx;
  const result = spawnSync(process.execPath, [serverProcess.QUIET_SQLITE, path.join(deps.appRoot, "tools", tool), ...dataFolderArgs(flags), ...rest], { stdio: "inherit", env: deps.env, windowsHide: true });
  if (result.error) {
    deps.err(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

// ---- update -----------------------------------------------------------------------

async function updateCommand(ctx) {
  const { flags, paths, deps } = ctx;
  const update = require("../lib/cli/update");
  const layout = installLayout(deps.appRoot);
  const pkg = readPackage(deps.appRoot);
  const getStatus = () => runState.getServerStatus(paths, { fetchImpl: deps.fetchImpl });
  const stop = () => stopServer(ctx, { quiet: true });
  // The new version starts from its own folder, with the port it ran on.
  const start = async (appDir) => {
    const saved = flags.dev ? {} : config.readConfig(paths.configFile);
    const { port } = config.resolvePort({ env: deps.env, config: saved, dev: Boolean(flags.dev) });
    await serverProcess.startDetached({ appRoot: appDir, paths, port, dev: Boolean(flags.dev), env: deps.env });
    return true;
  };
  if (flags.rollback) {
    if (!layout.installed) {
      deps.err(`This copy runs from ${layout.appRoot}, which the installer did not create, so there is no previous version to go back to.`);
      return 1;
    }
    const wasRunning = (await getStatus()).state === "running";
    if (wasRunning && !(await stop())) return 1;
    update.rollbackApp(layout);
    deps.out(`Back to the previous version (${readPackage(layout.appDir).version}).`);
    if (wasRunning) await start(layout.appDir);
    return 0;
  }
  try {
    return await update.runUpdate({ layout, paths, pkg, out: deps.out, check: Boolean(flags.check), fetchImpl: deps.fetchImpl, getStatus, stopServer: stop, startServer: start });
  } catch (error) {
    deps.err(error.message);
    return 1;
  }
}

// ---- autostart, doctor, uninstall -----------------------------------------------------

function autostartPlanFor(ctx) {
  const autostart = require("../lib/cli/autostart");
  return {
    autostart,
    plan: autostart.autostartPlan({ cliPath: path.join(ctx.deps.appRoot, "bin", "startup-tracker.js"), dataRoot: ctx.paths.root, wsl: browser.isWsl(), logFile: serverProcess.logFile(ctx.paths) }),
  };
}

function autostartCommand(ctx) {
  const { positionals, deps } = ctx;
  const { autostart, plan } = autostartPlanFor(ctx);
  const action = positionals[0] || "status";
  try {
    if (action === "status") {
      deps.out(autostart.autostartStatus(plan).message);
      return 0;
    }
    const result = action === "on" ? autostart.enableAutostart(plan) : autostart.disableAutostart(plan);
    (result.ok ? deps.out : deps.err)(result.message);
    return result.ok ? 0 : 1;
  } catch (error) {
    deps.err(error.message);
    return 1;
  }
}

async function doctorCommand(ctx) {
  const { flags, paths, deps } = ctx;
  const doctor = require("../lib/cli/doctor");
  const checks = await doctor.runDoctor({ paths, flags, env: deps.env, fetchImpl: deps.fetchImpl });
  if (flags.json) deps.out(JSON.stringify(checks, null, 2));
  else process.stdout.write(doctor.formatDoctor(checks));
  return checks.some((check) => check.level === "fail") ? 1 : 0;
}

async function uninstallCommand(ctx) {
  const { flags, paths, deps } = ctx;
  if (!flags.yes) {
    if (!deps.interactive) {
      deps.err("Uninstalling asks for confirmation on a terminal; add --yes to run it from a script.");
      return 1;
    }
    if (!yes(await deps.ask("Remove Startup Tracker from this computer? Your data stays unless you also type DELETE later. [y/N] "))) {
      deps.out("Nothing was removed.");
      return 0;
    }
  }
  const { runUninstall } = require("../lib/cli/uninstall");
  const { autostart, plan } = autostartPlanFor(ctx);
  await runUninstall({
    layout: installLayout(deps.appRoot),
    paths,
    purgeData: Boolean(flags["purge-data"]),
    out: deps.out,
    ask: deps.ask,
    interactive: deps.interactive,
    stopServer: () => stopServer(ctx, { quiet: true }),
    disableAutostart: () => autostart.disableAutostart(plan),
  });
  return 0;
}

// ---- main -----------------------------------------------------------------------------

async function main(argv, deps = {}) {
  deps = defaults(deps);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.err(error.message);
    return error.exitCode;
  }
  const { command, flags } = parsed;
  if (command === "help" || flags.help) {
    deps.out(helpText().trimEnd());
    return 0;
  }
  if (command === "version") {
    deps.out(readPackage(deps.appRoot).version);
    return 0;
  }

  let paths;
  try {
    paths = dataPaths(resolveDataRoot({ argv: dataFolderArgs(flags), env: deps.env }).root, deps.env);
  } catch (error) {
    deps.err(error.message);
    return 2;
  }
  const ctx = { ...parsed, paths, deps };
  try {
    switch (command) {
      case "": {
        const code = await startServer(ctx, { open: !flags["no-open"] });
        if (code === 0 && !flags.dev && deps.env.STARTUP_TRACKER_OFFLINE !== "1") {
          const { automaticUpdateCheck } = require("../lib/cli/update");
          const line = await automaticUpdateCheck({ paths, pkg: readPackage(deps.appRoot), fetchImpl: deps.fetchImpl });
          if (line) deps.out(line);
        }
        return code;
      }
      case "start":
        return await startServer(ctx, { open: !flags["no-open"] });
      case "stop":
        return (await stopServer(ctx)) ? 0 : 1;
      case "status":
        return await statusCommand(ctx);
      case "open": {
        const status = await runState.getServerStatus(paths, { fetchImpl: deps.fetchImpl });
        if (status.state !== "running") {
          deps.err('Startup Tracker is not running. Start it with "startup-tracker".');
          return 1;
        }
        openOrPrint(serverUrl(status.run), deps);
        return 0;
      }
      case "logs":
        return await logsCommand(ctx);
      case "backup":
        return runTool(ctx, "backup-sqlite.js");
      case "restore":
        return runTool(ctx, "restore-sqlite.js");
      case "update":
        return await updateCommand(ctx);
      case "autostart":
        return autostartCommand(ctx);
      case "doctor":
        return await doctorCommand(ctx);
      case "uninstall":
        return await uninstallCommand(ctx);
      default:
        deps.err(`Unknown command: ${command}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(error.message);
      return error.exitCode;
    }
    deps.err(error instanceof config.ConfigError ? error.message : error.stack || error.message);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // null: the server runs in this process (start --foreground) and keeps it alive.
    if (code !== null) process.exitCode = code;
  });
}

module.exports = { main, nodeIsRecentEnough, CLI_PATH };
