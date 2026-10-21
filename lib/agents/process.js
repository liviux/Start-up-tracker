"use strict";

// Starting and stopping agent processes.
//
// An agent gets a clean environment: PATH, the home and temp folders, the
// locale and what you configured for it, never the tracker's own variables or
// tokens. Nothing runs through a shell. On Windows, Node refuses to spawn .cmd
// and .bat files without one, so npm-installed agents are run as
// `node <their JS entry point>` instead, and npx itself as `node npx-cli.js`.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const IS_WINDOWS = process.platform === "win32";
// Variables an agent needs to find its tools, its login and a temp folder.
const PASSED_THROUGH = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME", "TERM",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "WINDIR", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];
// Never handed on, even when listed above by mistake.
const NEVER = /^(STARTUP_TRACKER_|TRACKER_|NPM_TOKEN$|GITHUB_TOKEN$)/;

function cleanEnv(configured = {}, base = process.env) {
  const env = {};
  for (const name of PASSED_THROUGH) if (base[name] !== undefined && !NEVER.test(name)) env[name] = base[name];
  for (const [name, value] of Object.entries(configured || {})) {
    if (typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== undefined && value !== null) env[name] = String(value);
  }
  return env;
}

// The absolute path of a command found on PATH, or null. A path that already
// names a file is returned when it exists.
function findOnPath(command, env = process.env) {
  if (!command) return null;
  if (command.includes("/") || command.includes("\\")) return fs.existsSync(command) ? path.resolve(command) : null;
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.toLowerCase())] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (IS_WINDOWS || (stat.mode & 0o111))) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

// npm's npx script, next to the Node that runs the tracker.
function npxCli(execPath = process.execPath) {
  const dir = path.dirname(execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// A Windows npm shim (`foo.cmd`) runs `node <dir>\node_modules\...\bin.js`;
// this finds that script so it can be started without a shell.
function shimTarget(cmdFile) {
  try {
    const text = fs.readFileSync(cmdFile, "utf8");
    const match = text.match(/"%(?:~)?dp0%\\?([^"]+?\.(?:c|m)?js)"/i);
    if (!match) return null;
    const target = path.join(path.dirname(cmdFile), match[1].replace(/\\/g, path.sep));
    return fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

// How to start a harness: { command, args } for spawn without a shell, or
// { error } when it cannot be started here. `spec` is a harness's launch
// settings: { kind: "npx" | "uvx" | "binary" | "custom", package, command,
// args }.
function resolveLaunch(spec, { env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const args = Array.isArray(spec?.args) ? spec.args.map(String) : [];
  if (spec?.kind === "npx") {
    const cli = npxCli(execPath);
    if (cli) return { command: execPath, args: [cli, "--yes", spec.package, ...args], display: ["npx", "--yes", spec.package, ...args].join(" ") };
    const npx = findOnPath("npx", env);
    if (npx && !/\.(cmd|bat)$/i.test(npx)) return { command: npx, args: ["--yes", spec.package, ...args], display: ["npx", "--yes", spec.package, ...args].join(" ") };
    return { error: "npx was not found next to Node. Install Node.js with npm." };
  }
  if (spec?.kind === "uvx") {
    const uvx = findOnPath("uvx", env);
    if (!uvx) return { error: "uvx was not found. Install uv (https://docs.astral.sh/uv/) to run this agent." };
    return { command: uvx, args: [spec.package, ...args], display: ["uvx", spec.package, ...args].join(" ") };
  }
  const name = String(spec?.command || "").trim();
  if (!name) return { error: "No command is set." };
  const found = findOnPath(name, env);
  if (!found) return { error: `${name} was not found on this computer.` };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    const script = shimTarget(found);
    if (!script) return { error: `${path.basename(found)} needs a shell to run. Point the command at the program's .exe or its JS file instead.` };
    return { command: execPath, args: [script, ...args], display: [name, ...args].join(" ") };
  }
  return { command: found, args, display: [name, ...args].join(" ") };
}

// Starts a process without a shell. On Unix it leads its own process group,
// so stopping it stops everything it started.
function spawnProcess({ command, args, cwd, env }) {
  return childProcess.spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: !IS_WINDOWS,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Stops a process and everything it started: taskkill /T on Windows, the
// process group elsewhere (TERM, then KILL after `graceMs`).
function killTree(child, { graceMs = 3000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    if (IS_WINDOWS) {
      const killer = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("exit", () => setTimeout(finish, 200));
      killer.on("error", () => {
        child.kill();
        setTimeout(finish, 200);
      });
      return;
    }
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {
          // Already gone.
        }
      }
    };
    signal("SIGTERM");
    setTimeout(() => {
      if (!done) signal("SIGKILL");
      setTimeout(finish, 200);
    }, graceMs).unref?.();
  });
}

module.exports = { IS_WINDOWS, cleanEnv, findOnPath, npxCli, shimTarget, resolveLaunch, spawnProcess, killTree };
