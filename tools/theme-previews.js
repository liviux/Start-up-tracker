#!/usr/bin/env node
"use strict";

// Screenshots for the theme picker in Settings and the first-run setup.
//
//   node tools/theme-previews.js [--only ledger,quiet] [--out <folder>]
//                               [--width 1440] [--height 1000] [--keep]
//
// Every preview is the Calendar view of the fictional demo startup, captured
// with Chrome's DevTools protocol. The tool starts its own server on a random
// port with a throwaway data folder unless --data-dir names one, so it never
// reads or writes a real tracker. The output is one JPEG per theme, named by
// theme id, in public/assets/theme-previews by default. A theme's dark-first
// look is captured in dark mode (THEME_PREVIEW_MODES in
// public/scripts/taste-switcher.js).
//
// Chrome is found with STARTUP_TRACKER_CHROME, then in PATH, then in the
// Playwright browser cache. No npm package is needed: the tool speaks the
// DevTools protocol over Node's built-in WebSocket.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { once } = require("events");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "public", "assets", "theme-previews");
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 1000;
const WAIT_MS = 20000;

const Appearance = require(path.join(ROOT, "public", "scripts", "taste-switcher.js"));

function chromeCandidates(env = process.env, home = os.homedir()) {
  const candidates = [env.STARTUP_TRACKER_CHROME, env.CHROME_PATH].filter(Boolean);
  candidates.push(
    path.join(ROOT, "node_modules", ".cache", "chrome", "chrome"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  const cache = path.join(home, ".cache", "ms-playwright");
  try {
    for (const entry of fs.readdirSync(cache).sort().reverse()) {
      if (!entry.startsWith("chromium-")) continue;
      candidates.push(
        path.join(cache, entry, "chrome-linux64", "chrome"),
        path.join(cache, entry, "chrome-linux", "chrome"),
        path.join(cache, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      );
    }
  } catch {
    // No Playwright cache; the fixed paths above still apply.
  }
  return candidates;
}

function findChrome(env = process.env) {
  for (const candidate of chromeCandidates(env)) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

function parseServerUrl(text) {
  return String(text).match(/Startup Tracker:\s+(https?:\/\/[^\s]+)/)?.[1] || null;
}

function previewJobs(themes = Appearance.THEMES, modes = Appearance.THEME_PREVIEW_MODES) {
  return themes.map((id) => ({ id, mode: modes[id] === "dark" ? "dark" : "light" }));
}

async function waitFor(check, timeoutMs = WAIT_MS, stepMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function startServer(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", NO_OPEN: "1", STARTUP_TRACKER_HOME: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const found = await waitFor(() => Boolean(parseServerUrl(output)) || child.exitCode !== null, WAIT_MS);
  if (!found || child.exitCode !== null) {
    child.kill("SIGKILL");
    throw new Error(`The preview server did not start.${errors ? `\n${errors.trim()}` : ""}`);
  }
  return { child, url: parseServerUrl(output) };
}

async function launchChrome(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "startup-tracker-chrome-"));
  const child = spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  const portFile = path.join(profile, "DevToolsActivePort");
  const ready = await waitFor(() => fs.existsSync(portFile));
  if (!ready) {
    child.kill("SIGKILL");
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a file */ }
    throw new Error("Chrome did not open its DevTools port.");
  }
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
  return {
    child,
    port,
    close() {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a file */ }
    },
  };
}

async function openPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("Chrome has no page target.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    send,
    async close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "The page threw while rendering.");
  return result.result?.value;
}

async function capture({ page, url, width, height, id, mode, out }) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url });
  if (!await waitFor(() => evaluate(page, "document.readyState === 'complete'"))) {
    throw new Error(`The first load did not finish for ${id}.`);
  }
  await evaluate(page, `localStorage.setItem("startup-tracker-taste", ${JSON.stringify(id)}); localStorage.setItem("startup-tracker-theme", ${JSON.stringify(mode)}); location.reload();`);
  const rendered = await waitFor(() => evaluate(page, `(() => {
    const strip = document.querySelector("#calendarDaysStrip");
    const title = document.querySelector("#calendarDetailTitle");
    if (!strip || strip.children.length === 0 || !title || !title.textContent.trim()) return false;
    return !document.querySelector(".skeleton, [aria-busy='true']");
  })()`));
  if (!rendered) throw new Error(`The Calendar view did not render for ${id}.`);
  await evaluate(page, "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
  await new Promise((resolve) => setTimeout(resolve, 350));
  await evaluate(page, "window.scrollTo(0, 0)");
  const shot = await page.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 84,
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const file = path.join(out, `${id}.jpg`);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = "") => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  const only = flag("--only").split(",").map((value) => value.trim()).filter(Boolean);
  const themes = only.length ? only : Appearance.THEMES;
  const unknown = themes.filter((id) => !Appearance.THEMES.includes(id));
  if (unknown.length) throw new Error(`Unknown theme(s): ${unknown.join(", ")}`);
  const modeOverride = flag("--mode");
  if (modeOverride && !["light", "dark"].includes(modeOverride)) throw new Error("--mode takes light or dark.");
  const out = path.resolve(flag("--out", DEFAULT_OUT));
  const width = Number(flag("--width", DEFAULT_WIDTH));
  const height = Number(flag("--height", DEFAULT_HEIGHT));
  const keep = argv.includes("--keep");
  const givenDataDir = flag("--data-dir");
  const chromePath = findChrome();
  if (!chromePath) throw new Error("Chrome or Chromium was not found. Set STARTUP_TRACKER_CHROME to its path.");

  fs.mkdirSync(out, { recursive: true });
  const dataDir = givenDataDir ? path.resolve(givenDataDir) : fs.mkdtempSync(path.join(os.tmpdir(), "startup-tracker-previews-"));
  let server = null;
  let chrome = null;
  let page = null;
  try {
    const { writeDemoData } = require("./demo-data");
    const demo = writeDemoData({ dataDir, force: true });
    server = await startServer(dataDir);
    const url = new URL(demo.urlPath, server.url).toString();
    chrome = await launchChrome(chromePath);
    page = await openPage(chrome.port);
    const jobs = previewJobs(themes).map((job) => (modeOverride ? { ...job, mode: modeOverride } : job));
    for (const job of jobs) {
      const file = await capture({ page, url, width, height, ...job, out });
      console.log(`${job.id} (${job.mode}) -> ${path.relative(ROOT, file)}`);
    }
  } finally {
    await page?.close().catch(() => {});
    chrome?.close();
    if (server) {
      server.child.kill("SIGTERM");
      await Promise.race([once(server.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      server.child.kill("SIGKILL");
    }
    if (!givenDataDir && !keep) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* the server may still hold a file */ }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`theme-previews: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { chromeCandidates, findChrome, parseServerUrl, previewJobs };
