"use strict";

// "Start Startup Tracker when you log in": a systemd user unit on Linux (and
// WSL with systemd), a launchd LaunchAgent on macOS, a Task Scheduler logon
// task on Windows. The plan is built first and only then applied, so tests
// check the generated files and commands without installing anything.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const UNIT_NAME = "startup-tracker.service";
const LAUNCHD_LABEL = "startup-tracker";
const TASK_NAME = "Startup Tracker";
// schtasks refuses a /TR value longer than this.
const SCHTASKS_TR_LIMIT = 261;

// systemd splits ExecStart like a shell, expands % specifiers and $ variables.
function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function windowsQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// The command a login runs. Services keep the server in the foreground so
// their stop signal reaches it; Task Scheduler starts it in the background
// and the task ends.
function launchArgs({ cliPath, dataRoot, foreground }) {
  return [cliPath, "start", ...(foreground ? ["--foreground"] : []), "--no-open", "--data-dir", dataRoot];
}

function systemdUnit({ nodePath, cliPath, dataRoot }) {
  const command = [nodePath, ...launchArgs({ cliPath, dataRoot, foreground: true })].map(systemdQuote).join(" ");
  return [
    "[Unit]",
    "Description=Startup Tracker",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command}`,
    "Environment=NO_OPEN=1",
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function launchdPlist({ nodePath, cliPath, dataRoot, logFile }) {
  const args = [nodePath, ...launchArgs({ cliPath, dataRoot, foreground: true })];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>NO_OPEN</key>",
    "    <string>1</string>",
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function schtasksCreateArgs({ nodePath, cliPath, dataRoot }) {
  // Paths are quoted (they often hold spaces); the flags never need it.
  const quotedPaths = new Set([nodePath, cliPath, dataRoot]);
  const tr = [nodePath, ...launchArgs({ cliPath, dataRoot, foreground: false })]
    .map((arg) => (quotedPaths.has(arg) ? windowsQuote(arg) : arg))
    .join(" ");
  if (tr.length > SCHTASKS_TR_LIMIT) {
    throw new Error(`The autostart command is ${tr.length} characters long; Task Scheduler takes at most ${SCHTASKS_TR_LIMIT}. Install to a shorter folder with --dir.`);
  }
  return ["/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", tr, "/F"];
}

function hasSystemd({ exists = fs.existsSync } = {}) {
  return exists("/run/systemd/system");
}

// options: platform, homedir, nodePath, cliPath, dataRoot, logFile, uid, wsl, systemd
function autostartPlan(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const base = { nodePath: options.nodePath || process.execPath, cliPath: options.cliPath, dataRoot: options.dataRoot };
  if (platform === "linux") {
    if (!(options.systemd ?? hasSystemd())) {
      return {
        kind: "unsupported",
        note: options.wsl
          ? "systemd is not enabled in this WSL distribution, so there is nothing to start the tracker at login. Add \"[boot]\" and \"systemd=true\" to /etc/wsl.conf and restart WSL, or run startup-tracker yourself."
          : "This system does not run systemd, so autostart is not available. Start the tracker with startup-tracker after you log in.",
      };
    }
    const file = path.posix.join(homedir, ".config", "systemd", "user", UNIT_NAME);
    return {
      kind: "systemd",
      file,
      content: systemdUnit(base),
      on: [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", UNIT_NAME]]],
      off: [["systemctl", ["--user", "disable", UNIT_NAME]]],
      afterOff: [["systemctl", ["--user", "daemon-reload"]]],
      status: ["systemctl", ["--user", "is-enabled", UNIT_NAME]],
    };
  }
  if (platform === "darwin") {
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const file = path.posix.join(homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return {
      kind: "launchd",
      file,
      content: launchdPlist({ ...base, logFile: options.logFile || path.posix.join(base.dataRoot, "logs", "server.log") }),
      // bootout first, so turning it on twice does not fail.
      before: [["launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]]],
      on: [["launchctl", ["bootstrap", `gui/${uid}`, file]]],
      off: [["launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]]],
      afterOff: [],
      status: ["launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]],
    };
  }
  if (platform === "win32") {
    return {
      kind: "schtasks",
      file: null,
      content: null,
      on: [["schtasks", schtasksCreateArgs(base)]],
      off: [["schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]]],
      afterOff: [],
      status: ["schtasks", ["/Query", "/TN", TASK_NAME]],
    };
  }
  return { kind: "unsupported", note: `Autostart is not available on ${platform}.` };
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return { status: result.error ? null : result.status, stdout: result.stdout || "", stderr: result.error ? result.error.message : result.stderr || "" };
}

function runAll(commands, run, { ignoreErrors = false } = {}) {
  for (const [command, args] of commands || []) {
    const result = run(command, args);
    if (result.status !== 0 && !ignoreErrors) {
      throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || `exit code ${result.status}`).trim()}`);
    }
  }
}

function enableAutostart(plan, { run = defaultRun } = {}) {
  if (plan.kind === "unsupported") return { ok: false, message: plan.note };
  if (plan.file) {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    fs.writeFileSync(plan.file, plan.content, { mode: 0o644 });
  }
  runAll(plan.before, run, { ignoreErrors: true });
  runAll(plan.on, run);
  return { ok: true, message: plan.file ? `Autostart is on (${plan.file}).` : `Autostart is on (Task Scheduler task "${TASK_NAME}").` };
}

function disableAutostart(plan, { run = defaultRun } = {}) {
  if (plan.kind === "unsupported") return { ok: false, message: plan.note };
  const present = plan.file ? fs.existsSync(plan.file) : run(...plan.status).status === 0;
  if (!present) return { ok: true, message: "Autostart is already off." };
  runAll(plan.off, run, { ignoreErrors: Boolean(plan.file) });
  if (plan.file) fs.rmSync(plan.file, { force: true });
  runAll(plan.afterOff, run, { ignoreErrors: true });
  return { ok: true, message: "Autostart is off." };
}

function autostartStatus(plan, { run = defaultRun } = {}) {
  if (plan.kind === "unsupported") return { enabled: false, message: plan.note };
  if (plan.file && !fs.existsSync(plan.file)) return { enabled: false, message: "Autostart is off." };
  const result = run(...plan.status);
  const enabled = result.status === 0 && (plan.kind !== "systemd" || /^enabled/m.test(result.stdout));
  const where = plan.file || `Task Scheduler task "${TASK_NAME}"`;
  return { enabled, message: enabled ? `Autostart is on (${where}).` : `Autostart is off (${where} exists but is not active).` };
}

module.exports = {
  UNIT_NAME,
  LAUNCHD_LABEL,
  TASK_NAME,
  systemdQuote,
  systemdUnit,
  launchdPlist,
  schtasksCreateArgs,
  autostartPlan,
  enableAutostart,
  disableAutostart,
  autostartStatus,
};
