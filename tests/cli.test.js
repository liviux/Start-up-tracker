"use strict";

// The startup-tracker command (bin/startup-tracker.js and lib/cli/), the
// release archive (tools/build-release.js) and install.sh. Nothing here goes
// online: GitHub answers come from a fake fetch, and every server runs on a
// temporary data folder and a free port.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { parseArgs, dataFolderArgs, UsageError } = require("../lib/cli/args");
const config = require("../lib/cli/config");
const runState = require("../lib/cli/run-state");
const update = require("../lib/cli/update");
const autostart = require("../lib/cli/autostart");
const browser = require("../lib/cli/browser");
const doctor = require("../lib/cli/doctor");
const uninstall = require("../lib/cli/uninstall");
const { installLayout } = require("../lib/cli/layout");
const { createTarGz, readTarGz } = require("../lib/cli/tar");
const { dataPaths } = require("../lib/data-root");
const { TrackerSqliteStore } = require("../lib/tracker-sqlite-store");
const { buildRelease, productionPackages } = require("../tools/build-release");
const cli = require("../bin/startup-tracker");
const { startServer } = require("./helpers/server");

const ROOT = path.resolve(__dirname, "..");

function tempDir(prefix = "st-cli-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// main() with its output collected and no terminal.
async function run(argv, { env = {}, interactive = false, answers = [], fetchImpl } = {}) {
  const out = [];
  const err = [];
  const asked = [];
  const code = await cli.main(argv, {
    out: (line = "") => out.push(String(line)),
    err: (line = "") => err.push(String(line)),
    env: { PATH: process.env.PATH, STARTUP_TRACKER_OFFLINE: "1", ...env },
    interactive,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    openBrowser: () => false,
    // The tracker's own address only; nothing else is reachable.
    fetchImpl: fetchImpl || (async (url, options) => {
      if (new URL(url).hostname !== "127.0.0.1") throw new Error("no network in tests");
      return fetch(url, options);
    }),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
}

function fileResponse(buffer) {
  return { ok: true, status: 200, arrayBuffer: async () => buffer };
}

// ---- arguments -------------------------------------------------------------------

test("commands, flags and aliases parse, and anything unknown is a usage error", () => {
  assert.deepEqual(parseArgs([]), { command: "", flags: {}, positionals: [], rest: [] });
  assert.deepEqual(parseArgs(["start", "--port", "4000", "--no-open"]).flags, { port: "4000", "no-open": true });
  assert.deepEqual(parseArgs(["start", "--port=4000"]).flags, { port: "4000" });
  assert.deepEqual(parseArgs(["logs", "-f", "-n", "20"]).flags, { follow: true, lines: "20" });
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.deepEqual(parseArgs(["autostart", "on"]).positionals, ["on"]);
  const backup = parseArgs(["backup", "--label", "before-import", "--data-dir", "/tmp/x"]);
  assert.deepEqual(backup.rest, ["--label", "before-import"], "backup hands its options to the tool");
  assert.deepEqual(dataFolderArgs(backup.flags), ["--data-dir", "/tmp/x"]);
  for (const argv of [["frobnicate"], ["start", "--colour"], ["stop", "now"], ["autostart", "maybe"], ["start", "--port"], ["logs", "-n", "many"], ["status", "--json=yes"]]) {
    assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && error.exitCode === 2, argv.join(" "));
  }
});

test("help and version need no data folder; a bad command exits with 2", async () => {
  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: startup-tracker/);
  assert.match(help.out, /autostart/);
  const version = await run(["version"]);
  assert.equal(version.out, require("../package.json").version);
  const bad = await run(["frobnicate"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown command/);
});

test("a test run never reaches the default data folder through the command", async () => {
  const result = await run(["status"], { env: { STARTUP_TRACKER_TEST_RUN: "1" } });
  assert.equal(result.code, 2);
  assert.match(result.err, /never uses the real data folder/);
});

test("Node older than 22.16 is turned away before anything loads", () => {
  assert.equal(cli.nodeIsRecentEnough("22.16.0"), true);
  assert.equal(cli.nodeIsRecentEnough("24.1.0"), true);
  assert.equal(cli.nodeIsRecentEnough("22.15.9"), false);
  assert.equal(cli.nodeIsRecentEnough("20.19.0"), false);
  assert.equal(doctor.nodeCheck("22.15.0").level, "fail");
  assert.equal(doctor.nodeCheck("22.16.0").level, "ok");
});

// ---- the port --------------------------------------------------------------------

test("the default port 57322 is saved in config.json at the first start and reused", () => {
  const home = tempDir();
  const file = path.join(home, "config.json");
  assert.deepEqual(config.readConfig(file), {});
  assert.deepEqual(config.ensureConfig(file), { port: 57322 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).port, 57322);
  config.writeConfig(file, { port: 58000 });
  assert.deepEqual(config.ensureConfig(file), { port: 58000 }, "a saved port is kept");
  assert.deepEqual(config.resolvePort({ config: config.readConfig(file), env: {} }), { port: 58000, source: "config" });
  assert.deepEqual(config.resolvePort({ flagPort: "4100", config: { port: 58000 }, env: { PORT: "4200" } }), { port: 4100, source: "flag" });
  assert.deepEqual(config.resolvePort({ config: { port: 58000 }, env: { PORT: "4200" } }), { port: 4200, source: "env" });
  assert.deepEqual(config.resolvePort({ config: { port: 58000 }, env: {}, dev: true }), { port: 57323, source: "dev" }, "--dev ignores config.json");
  assert.deepEqual(config.resolvePort({ env: {} }), { port: 57322, source: "default" });
  const devHome = tempDir();
  assert.deepEqual(config.ensureConfig(path.join(devHome, "config.json"), { dev: true }), {}, "a development run saves nothing");
  assert.equal(fs.existsSync(path.join(devHome, "config.json")), false);
  fs.writeFileSync(file, '{"port": "lots"}');
  assert.throws(() => config.readConfig(file), config.ConfigError);
  fs.writeFileSync(file, "{not json");
  assert.throws(() => config.readConfig(file), /not valid JSON/);
});

test("a taken port is reported, and on a terminal another one is saved only when you say yes", async (t) => {
  const blocker = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  t.after(() => blocker.close());
  const taken = blocker.address().port;
  const home = tempDir();
  const env = { STARTUP_TRACKER_HOME: home };
  config.writeConfig(path.join(home, "config.json"), { port: taken });

  const script = await run(["start", "--no-open"], { env });
  assert.equal(script.code, 1);
  assert.match(script.err, new RegExp(`Port ${taken} is used by another program`));
  assert.match(script.err, /--save-port/, "a script is told how to pick another port");

  const declined = await run(["start", "--no-open"], { env, interactive: true, answers: ["n"] });
  assert.equal(declined.code, 1);
  assert.match(declined.out, /edits not yet saved stay with the old address/);
  assert.equal(config.readConfig(path.join(home, "config.json")).port, taken, "nothing saved without a yes");

  const accepted = await run(["start", "--no-open"], { env, interactive: true, answers: ["y"] });
  t.after(() => run(["stop", "--force"], { env }));
  assert.equal(accepted.code, 0, accepted.err);
  const saved = config.readConfig(path.join(home, "config.json")).port;
  assert.notEqual(saved, taken);
  assert.match(accepted.out, new RegExp(`running at http://127\\.0\\.0\\.1:${saved}/`));
});

// ---- start, status, stop ------------------------------------------------------------

test("start runs the server in the background, status finds it, a second start reuses it, stop ends it", async (t) => {
  const home = tempDir();
  const env = { STARTUP_TRACKER_HOME: home };
  const port = await freePort();
  t.after(() => run(["stop", "--force"], { env }));

  assert.equal((await run(["status"], { env })).code, 3, "status exits with 3 while stopped");
  const started = await run(["start", "--no-open", "--port", String(port)], { env });
  assert.equal(started.code, 0, started.err);
  assert.equal(config.readConfig(path.join(home, "config.json")).port, 57322, "--port without --save-port leaves the saved port alone");
  const run1 = runState.readRunState(path.join(home, "run"));
  assert.equal(run1.port, port);

  const status = await run(["status", "--json"], { env });
  assert.equal(status.code, 0);
  const parsed = JSON.parse(status.out);
  assert.equal(parsed.state, "running");
  assert.equal(parsed.url, `http://127.0.0.1:${port}/`);

  const again = await run(["start", "--no-open", "--port", String(port)], { env });
  assert.match(again.out, /already running/);
  assert.equal(runState.readRunState(path.join(home, "run")).pid, run1.pid, "no second server");

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.filePath, path.join(home, "data", "tracker.sqlite"));

  const logs = await run(["logs", "-n", "5"], { env });
  assert.match(logs.out, /Startup Tracker: http:\/\/127\.0\.0\.1/);

  const stopped = await run(["stop"], { env });
  assert.equal(stopped.code, 0);
  assert.match(stopped.out, /stopped/);
  assert.equal(runState.readRunState(path.join(home, "run")), null, "run/server.json is gone");
  assert.match((await run(["stop"], { env })).out, /not running/);
});

test("run/server.json is removed only by the process it names, and a dead pid reads as stale", async () => {
  const runDir = path.join(tempDir(), "run");
  runState.writeRunState(runDir, { pid: 4242, port: 1, url: "http://127.0.0.1:1/" });
  assert.equal(runState.removeRunState(runDir, 999), false);
  assert.equal(runState.readRunState(runDir).pid, 4242);
  const paths = { runDir, databaseFile: "/nowhere" };
  assert.equal((await runState.getServerStatus(paths, { isAlive: () => false })).state, "stale");
  assert.equal((await runState.getServerStatus(paths, { isAlive: () => true, fetchImpl: async () => jsonResponse({ ok: true, version: "1", filePath: "/elsewhere" }) })).state, "unresponsive", "a tracker for another data folder is not ours");
  assert.equal(runState.removeRunState(runDir, 4242), true);
  assert.equal((await runState.getServerStatus(paths)).state, "stopped");
});

// ---- update -------------------------------------------------------------------------

function fakeApp(version, { broken = false } = {}) {
  const top = `startup-tracker-${version}`;
  const files = {
    "package.json": JSON.stringify({ name: "startup-tracker", version }),
    "server.js": "// server\n",
    "CHANGELOG.md": `# Changelog\n\n## [${version}] - 2026-10-21\n\n### Added\n- Something new in ${version}.\n\n## [0.0.1]\n- Old.\n`,
  };
  if (!broken) files["bin/startup-tracker.js"] = "// cli\n";
  return createTarGz(Object.entries(files).map(([name, data]) => ({ name: `${top}/${name}`, data })));
}

function sums(buffer, name = update.RELEASE_ARCHIVE) {
  return `${crypto.createHash("sha256").update(buffer).digest("hex")}  ${name}\n`;
}

function installedCopy(version = "0.1.0") {
  const installRoot = tempDir("st-install-");
  const appDir = path.join(installRoot, "app");
  fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "startup-tracker", version }));
  fs.writeFileSync(path.join(appDir, "server.js"), "");
  fs.writeFileSync(path.join(appDir, "bin", "startup-tracker.js"), "");
  return { installRoot, layout: installLayout(appDir, { exists: () => false }), paths: dataPaths(installRoot, {}) };
}

test("versions compare with pre-releases first, and a changelog section is found by version", () => {
  assert.equal(update.compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(update.compareVersions("0.1.0", "0.1.0-dev"), 1);
  assert.equal(update.compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(update.compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.deepEqual(update.parseRepository("github:liviux/Start-up-tracker"), { owner: "liviux", repo: "Start-up-tracker" });
  assert.deepEqual(update.parseRepository({ url: "git+https://github.com/liviux/Start-up-tracker.git" }), { owner: "liviux", repo: "Start-up-tracker" });
  assert.equal(update.parseRepository("https://example.com/x/y"), null);
  const text = "# Changelog\n\n## [0.2.0] - 2026-11-01\n- B\n\n## [0.1.0]\n- A\n";
  assert.equal(update.changelogSection(text, "0.2.0"), "## [0.2.0] - 2026-11-01\n- B");
  assert.equal(update.changelogSection(text, "9.9.9"), "");
});

test("an archive that does not match SHA256SUMS changes nothing", () => {
  const dir = tempDir();
  const file = path.join(dir, update.RELEASE_ARCHIVE);
  fs.writeFileSync(file, fakeApp("0.2.0"));
  assert.throws(() => update.verifyChecksum(file, sums(Buffer.from("something else"))), (error) => error.code === "checksumMismatch");
  assert.throws(() => update.verifyChecksum(file, "abc  other.tar.gz\n"), (error) => error.code === "checksumMissing");
  assert.equal(update.verifyChecksum(file, sums(fs.readFileSync(file))).length, 64);
});

test("an update takes a safety backup, swaps app.new in, keeps app.prev and shows the changelog", async () => {
  const { installRoot, layout, paths } = installedCopy("0.1.0");
  fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true });
  const store = new TrackerSqliteStore(paths.databaseFile);
  require("../lib/startups").createStartup(store, { name: "Acme" });
  store.close();

  const archive = path.join(installRoot, "download.tar.gz");
  const data = fakeApp("0.2.0");
  fs.writeFileSync(archive, data);
  const lines = [];
  const events = [];
  await update.installArchive({
    layout,
    paths,
    out: (line) => lines.push(line),
    archive,
    checksumsText: sums(data),
    getStatus: async () => ({ state: "running" }),
    stopServer: async () => { events.push("stop"); return true; },
    startServer: async () => { events.push("start"); return true; },
    versionCheck: () => ({ ok: true, output: "0.2.0" }),
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appPrev, "package.json"), "utf8")).version, "0.1.0");
  assert.deepEqual(events, ["stop", "start"]);
  const backups = fs.readdirSync(paths.backupDir).filter((name) => name.includes("before-update"));
  assert.equal(backups.length, 1, "a safety backup before the swap");
  assert.match(lines.join("\n"), /Something new in 0\.2\.0/);

  // Rollback puts 0.1.0 back, and a second one goes forward again.
  update.rollbackApp(layout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.1.0");
  update.rollbackApp(layout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.2.0");
});

test("a new version that does not load is rolled back and the old one restarted", async () => {
  const { installRoot, layout, paths } = installedCopy("0.1.0");
  const archive = path.join(installRoot, "download.tar.gz");
  const data = fakeApp("0.3.0");
  fs.writeFileSync(archive, data);
  const events = [];
  await assert.rejects(update.installArchive({
    layout,
    paths,
    out: () => {},
    archive,
    checksumsText: sums(data),
    getStatus: async () => ({ state: "running" }),
    stopServer: async () => true,
    startServer: async () => { events.push("start"); return true; },
    versionCheck: () => ({ ok: false, output: "SyntaxError" }),
  }), (error) => error.code === "newVersionFailed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.1.0");
  assert.deepEqual(events, ["start"], "the old version runs again");

  const broken = fakeApp("0.4.0", { broken: true });
  fs.writeFileSync(archive, broken);
  assert.throws(() => update.unpackRelease(archive, layout.appNew), (error) => error.code === "badArchive");
});

test("update downloads the newest release from GitHub, and says so when there is nothing newer", async () => {
  const { layout, paths } = installedCopy("0.1.0");
  const data = fakeApp("0.2.0");
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/releases/latest")) {
      return jsonResponse({ tag_name: "v0.2.0", body: "Notes", assets: [{ name: update.RELEASE_ARCHIVE, browser_download_url: "https://example.com/a.tar.gz" }, { name: update.CHECKSUM_FILE, browser_download_url: "https://example.com/SHA256SUMS" }] });
    }
    return fileResponse(String(url).endsWith("SHA256SUMS") ? Buffer.from(sums(data)) : data);
  };
  const pkg = { version: "0.1.0", repository: "github:example/startup-tracker" };
  const lines = [];
  await update.runUpdate({ layout, paths, pkg, out: (line) => lines.push(line), check: true, fetchImpl });
  assert.match(lines.join("\n"), /0\.2\.0 is available/);
  assert.ok(fs.existsSync(path.join(layout.appDir, "package.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.1.0", "--check installs nothing");

  await update.runUpdate({ layout, paths, pkg, out: (line) => lines.push(line), fetchImpl, versionCheck: () => ({ ok: true }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.appDir, "package.json"), "utf8")).version, "0.2.0");
  assert.ok(requested.includes("https://api.github.com/repos/example/startup-tracker/releases/latest"));

  const same = [];
  await update.runUpdate({ layout, paths, pkg: { ...pkg, version: "0.2.0" }, out: (line) => same.push(line), fetchImpl });
  assert.match(same.join("\n"), /is the latest version/);

  const clone = [];
  await update.runUpdate({ layout: { ...layout, installed: false, appRoot: "/src/startup-tracker" }, paths, pkg, out: (line) => clone.push(line), fetchImpl });
  assert.match(clone.join("\n"), /git pull/, "a git clone is updated with git");
});

test("the update check is cached for a day and follows the network switch unless asked now", async () => {
  const { paths } = installedCopy();
  const pkg = { version: "0.1.0", repository: "github:example/startup-tracker" };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ tag_name: "v0.2.0", assets: [] });
  };
  const now = Date.parse("2026-10-21T10:00:00Z");
  const off = await update.checkForUpdate({ paths, pkg, fetchImpl, now, networkAllowed: () => false });
  assert.equal(calls, 0, "the network switch is off");
  assert.equal(off.available, false);
  const forced = await update.checkForUpdate({ paths, pkg, fetchImpl, now, force: true, networkAllowed: () => false });
  assert.equal(calls, 1, "Check for updates now asks anyway");
  assert.deepEqual([forced.available, forced.latest], [true, "0.2.0"]);
  const cached = await update.checkForUpdate({ paths, pkg, fetchImpl, now: now + 3600_000, networkAllowed: () => true });
  assert.equal(calls, 1, "answered from the cache within a day");
  assert.equal(cached.available, true);
  assert.equal(await update.automaticUpdateCheck({ paths, pkg, fetchImpl, now: now + 3600_000, networkAllowed: () => true }), "", "the command says nothing twice a day");
  const line = await update.automaticUpdateCheck({ paths, pkg, fetchImpl, now: now + 2 * 86_400_000, networkAllowed: () => true });
  assert.match(line, /0\.2\.0 is available/);
  assert.equal(calls, 2);
  const unconfigured = await update.checkForUpdate({ paths, pkg: { version: "0.1.0" }, fetchImpl, force: true });
  assert.equal(unconfigured.configured, false);
  assert.equal(calls, 2);
});

test("About asks for updates only through its own route, and never online in a test run", async () => {
  const server = await startServer();
  try {
    const answer = await (await fetch(`${server.url}api/about/update`)).json();
    assert.equal(answer.update.configured, true);
    assert.equal(answer.update.current, require("../package.json").version);
    assert.equal(answer.update.checkedAt, "");
    const forced = await (await fetch(`${server.url}api/about/update`, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.url.replace(/\/$/, "") }, body: "{}" })).json();
    assert.match(forced.update.error, /network is off/);
  } finally {
    await server.stop();
  }
});

// ---- autostart, browser, uninstall ---------------------------------------------------------

test("autostart writes a systemd unit, a LaunchAgent or a logon task that starts the tracker", () => {
  const options = { nodePath: "/usr/bin/node", cliPath: "/home/a b/.startup-tracker/app/bin/startup-tracker.js", dataRoot: "/home/a b/.startup-tracker", homedir: "/home/a b" };
  const linux = autostart.autostartPlan({ ...options, platform: "linux", systemd: true });
  assert.equal(linux.kind, "systemd");
  assert.equal(linux.file, "/home/a b/.config/systemd/user/startup-tracker.service");
  assert.match(linux.content, /^ExecStart="\/usr\/bin\/node" "\/home\/a b\/\.startup-tracker\/app\/bin\/startup-tracker\.js" "start" "--foreground" "--no-open" "--data-dir" "\/home\/a b\/\.startup-tracker"$/m);
  assert.match(linux.content, /Restart=on-failure/);
  assert.equal(autostart.autostartPlan({ ...options, platform: "linux", systemd: false, wsl: true }).kind, "unsupported");
  assert.match(autostart.autostartPlan({ ...options, platform: "linux", systemd: false, wsl: true }).note, /wsl\.conf/);

  const mac = autostart.autostartPlan({ ...options, platform: "darwin", uid: 501 });
  assert.equal(mac.file, "/home/a b/Library/LaunchAgents/startup-tracker.plist");
  assert.match(mac.content, /<string>--foreground<\/string>/);
  assert.deepEqual(mac.on, [["launchctl", ["bootstrap", "gui/501", mac.file]]]);

  const windows = autostart.autostartPlan({ ...options, platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\a\\.startup-tracker\\app\\bin\\startup-tracker.js", dataRoot: "C:\\Users\\a\\.startup-tracker" });
  const tr = windows.on[0][1][windows.on[0][1].indexOf("/TR") + 1];
  assert.equal(tr, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.startup-tracker\\app\\bin\\startup-tracker.js" start --no-open --data-dir "C:\\Users\\a\\.startup-tracker"');
  assert.throws(() => autostart.autostartPlan({ ...options, platform: "win32", dataRoot: `C:\\${"x".repeat(300)}` }), /at most 261/);

  const home = tempDir();
  const plan = autostart.autostartPlan({ ...options, homedir: home, platform: "linux", systemd: true });
  const calls = [];
  const fake = (command, args) => { calls.push([command, ...args].join(" ")); return { status: 0, stdout: "enabled\n", stderr: "" }; };
  assert.equal(autostart.enableAutostart(plan, { run: fake }).ok, true);
  assert.ok(fs.existsSync(plan.file));
  assert.equal(autostart.autostartStatus(plan, { run: fake }).enabled, true);
  autostart.disableAutostart(plan, { run: fake });
  assert.equal(fs.existsSync(plan.file), false);
  assert.ok(calls.includes("systemctl --user enable startup-tracker.service"));
});

test("the browser opens where there is a desktop, and the address is printed over SSH", () => {
  assert.equal(browser.browserCommand("http://x/", { platform: "linux", env: {}, wsl: false }), null);
  assert.deepEqual(browser.browserCommand("http://x/", { platform: "linux", env: { DISPLAY: ":0" }, wsl: false }), { command: "xdg-open", args: ["http://x/"] });
  assert.equal(browser.browserCommand("http://x/", { platform: "darwin", env: { SSH_CONNECTION: "1" } }), null);
  assert.equal(browser.browserCommand("http://x/", { platform: "win32", env: {} }).command, "cmd");
  assert.equal(browser.browserCommand("http://x/?a&b", { platform: "linux", env: {}, wsl: true }).args[3], "http://x/?a^&b");
});

test("uninstall removes the app and its own command, and keeps the data unless DELETE is typed", async () => {
  const { installRoot, layout, paths } = installedCopy();
  const home = tempDir();
  const launcher = path.join(home, ".local", "bin", "startup-tracker");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/sh\n# ${uninstall.LAUNCHER_MARKER}\n`);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, "keep.txt"), "x");
  const lines = [];
  await uninstall.runUninstall({ layout, paths, purgeData: true, out: (line) => lines.push(line), ask: async () => "delete", interactive: true, homedir: home, platform: "linux" });
  assert.equal(fs.existsSync(layout.appDir), false);
  assert.equal(fs.existsSync(launcher), false);
  assert.ok(fs.existsSync(path.join(paths.dataDir, "keep.txt")), "anything but DELETE keeps the data");
  await uninstall.runUninstall({ layout, paths, purgeData: true, out: () => {}, ask: async () => "DELETE", interactive: true, homedir: home, platform: "linux" });
  assert.equal(fs.existsSync(installRoot), false);

  const foreign = path.join(home, ".local", "bin", "startup-tracker");
  fs.writeFileSync(foreign, "#!/bin/sh\necho someone else\n");
  await uninstall.runUninstall({ layout: installedCopy().layout, paths: installedCopy().paths, out: () => {}, homedir: home, platform: "linux" });
  assert.ok(fs.existsSync(foreign), "a command someone else wrote stays");
  assert.equal(uninstall.isProtectedFolder(os.homedir(), os.homedir()), true);
  assert.equal(uninstall.isProtectedFolder("/", os.homedir()), true);
});

test("uninstall from the command asks first, and a script has to pass --yes", async () => {
  const env = { STARTUP_TRACKER_HOME: tempDir() };
  const script = await run(["uninstall"], { env });
  assert.equal(script.code, 1);
  assert.match(script.err, /--yes/);
  const declined = await run(["uninstall"], { env, interactive: true, answers: ["n"] });
  assert.match(declined.out, /Nothing was removed/);
});

test("doctor checks Node, the port, permissions, the database and the agents without changing anything", async () => {
  const home = tempDir();
  const result = await run(["doctor", "--json", "--port", "0"], { env: { STARTUP_TRACKER_HOME: home } });
  const checks = JSON.parse(result.out);
  assert.deepEqual(checks.map((check) => check.name), ["Node.js", "Port", "Permissions", "Database", "AI agents"]);
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(path.join(home, "data")), false, "doctor creates nothing");
});

// ---- the release archive and install.sh ------------------------------------------------------

function fixtureProject() {
  const root = tempDir("st-release-");
  const write = (file, data, mode) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data, mode ? { mode } : undefined);
  };
  write("package.json", JSON.stringify({ name: "startup-tracker", version: "9.8.7" }));
  write("package-lock.json", JSON.stringify({ packages: { "": {}, "node_modules/prod": { version: "1.0.0" }, "node_modules/devtool": { version: "1.0.0", dev: true }, "node_modules/prod/node_modules/inner": { version: "1.0.0" } } }));
  write("server.js", "// server\n");
  write("bin/startup-tracker.js", "#!/usr/bin/env node\n", 0o755);
  write("tests/a.test.js", "// test\n");
  write(".github/workflows/ci.yml", "on: push\n");
  write("node_modules/prod/index.js", "module.exports = 1;\n");
  write("node_modules/prod/node_modules/inner/index.js", "module.exports = 2;\n");
  write("node_modules/devtool/index.js", "module.exports = 3;\n");
  return root;
}

test("the release archive holds the app and its production dependencies, and SHA256SUMS matches it", () => {
  const root = fixtureProject();
  const files = ["package.json", "package-lock.json", "server.js", "bin/startup-tracker.js", "tests/a.test.js", ".github/workflows/ci.yml"];
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(productionPackages(lock), ["node_modules/prod"]);
  const result = buildRelease({ root, outDir: path.join(root, "dist"), files });
  const names = readTarGz(fs.readFileSync(result.archive)).map((entry) => entry.name);
  assert.ok(names.every((name) => name.startsWith("startup-tracker-9.8.7/")));
  assert.ok(names.includes("startup-tracker-9.8.7/node_modules/prod/node_modules/inner/index.js"));
  assert.ok(!names.some((name) => name.includes("devtool") || name.includes("/tests/") || name.includes(".github")));
  const cliEntry = readTarGz(fs.readFileSync(result.archive)).find((entry) => entry.name.endsWith("bin/startup-tracker.js"));
  if (process.platform !== "win32") assert.ok(cliEntry.mode & 0o111, "the command stays executable");
  assert.doesNotThrow(() => update.verifyChecksum(result.archive, fs.readFileSync(result.checksumFile, "utf8")));
  fs.rmSync(path.join(root, "node_modules", "prod"), { recursive: true });
  assert.throws(() => buildRelease({ root, outDir: path.join(root, "dist2"), files }), /npm ci/);
});

test("install.sh installs from a local archive, adds the command and keeps the old version on reinstall", { skip: process.platform === "win32" && "install.sh is for macOS and Linux" }, () => {
  const dist = tempDir("st-dist-");
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  buildRelease({ outDir: dist, files });
  const home = tempDir("st-home-");
  const env = { PATH: process.env.PATH, HOME: home, STARTUP_TRACKER_OFFLINE: "1" };
  const install = () => spawnSync("bash", [path.join(ROOT, "install.sh"), "--archive", path.join(dist, "startup-tracker.tar.gz"), "--no-start", "--no-autostart"], { env, encoding: "utf8" });
  const first = install();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Checksum verified/);
  const launcher = path.join(home, ".local", "bin", "startup-tracker");
  assert.match(fs.readFileSync(launcher, "utf8"), new RegExp(uninstall.LAUNCHER_MARKER));
  const version = spawnSync(launcher, ["version"], { env, encoding: "utf8" });
  assert.equal(version.stdout.trim(), require("../package.json").version);
  const second = install();
  assert.equal(second.status, 0, second.stderr);
  assert.ok(fs.existsSync(path.join(home, ".startup-tracker", "app.prev", "server.js")), "the previous version is kept");

  fs.appendFileSync(path.join(dist, "startup-tracker.tar.gz"), "tampered");
  const tampered = install();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /does not match its checksum/);
});
