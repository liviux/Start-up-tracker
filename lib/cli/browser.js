"use strict";

// Opens the tracker in the default browser, or says that it cannot, so the
// CLI prints the address instead (for example over SSH).

const fs = require("fs");
const { spawn } = require("child_process");

function isWsl({ platform = process.platform, env = process.env, readFile = fs.readFileSync } = {}) {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFile("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

// The command that opens a URL, or null when there is no desktop to open it on.
function browserCommand(url, { platform = process.platform, env = process.env, wsl = isWsl({ platform, env }) } = {}) {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return env.SSH_CONNECTION && !env.DISPLAY ? null : { command: "open", args: [url] };
  if (wsl) return { command: "cmd.exe", args: ["/c", "start", "", url.replaceAll("&", "^&")] };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { command: "xdg-open", args: [url] };
}

// Returns true when a browser was asked to open the URL.
function openBrowser(url, { platform, env, spawnImpl = spawn } = {}) {
  const command = browserCommand(url, { platform, env });
  if (!command) return false;
  try {
    const child = spawnImpl(command.command, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { isWsl, browserCommand, openBrowser };
