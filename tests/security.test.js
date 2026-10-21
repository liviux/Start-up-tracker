"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { startServer, makeTempHome, rootDir } = require("./helpers/server");
const security = require("../lib/http/security");
const { resolveDataRoot, dataPaths } = require("../lib/data-root");
const { createStartup } = require("./helpers/api");

// Sends a raw request so the path reaches the server exactly as written
// (fetch would normalise "%2e%2e").
function rawRequest(url, rawPath, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.hostname, port: target.port, path: rawPath, method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("only public/ and content/ are reachable over HTTP", async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.url}`)).status, 200);
    assert.equal((await fetch(`${server.url}app.js`)).status, 200);
    for (const blocked of ["server.js", "package.json", "lib/tracker-sqlite-store.js", "data/tracker.sqlite", ".git/config", "plan/x.md", "tests/security.test.js", "AGENTS.md", "public/app.js"]) {
      const res = await fetch(`${server.url}${blocked}`);
      assert.equal(res.status, 404, `${blocked} must not be served`);
    }
    for (const traversal of ["/%2e%2e/server.js", "/..%2fserver.js", "/media/%2e%2e/secrets/api-token", "/a/..%5cserver.js"]) {
      const res = await rawRequest(server.url, traversal);
      assert.equal(res.status, 400, `${traversal} must be refused`);
    }
  } finally {
    await server.stop();
  }
});

test("the app page sends a strict content security policy and no referrer", async () => {
  const server = await startServer();
  try {
    const res = await fetch(server.url);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const html = await res.text();
    assert.doesNotMatch(html, /<script>/, "no inline scripts");
    assert.match(html, /src="\/app\.js\?v=[0-9a-f]{12}"/, "scripts are versioned by content");

    // The page of one startup is the same page with the same headers.
    const startup = await createStartup(server.url, "Policy");
    const startupPage = await fetch(`${server.url}s/${startup.id}/`);
    assert.equal(startupPage.status, 200);
    assert.equal(startupPage.headers.get("content-security-policy"), csp);
    assert.equal(startupPage.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await server.stop();
  }
});

test("writes need the tracker page or the API token", async () => {
  const server = await startServer();
  const backupsUrl = `${server.url}api/backups`;
  try {
    assert.equal((await fetch(backupsUrl, { method: "POST" })).status, 403, "no origin, no token");
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403, "foreign origin");
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } })).status, 403, "another port on localhost is same-site, not same-origin");
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 403);
    assert.equal((await fetch(`${server.url}api/backups`)).status, 200, "listing backups is a read");
    assert.deepEqual((await (await fetch(backupsUrl)).json()).backups, [], "no refused request took a backup");
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } })).status, 201);
    const origin = server.url.replace(/\/$/, "");
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { Origin: origin } })).status, 201);
    assert.equal((await fetch(backupsUrl, { method: "POST", headers: { Authorization: `Bearer ${server.token}` } })).status, 201);
    const backups = (await (await fetch(backupsUrl)).json()).backups;
    assert.equal(backups.length, 3);
    // Every write route is behind the same check, not only taking a backup.
    const startups = `${server.url}api/startups`;
    const json = { "Content-Type": "application/json" };
    assert.equal((await fetch(startups, { method: "POST", headers: json, body: "{\"name\":\"X\"}" })).status, 403);
    const startup = await createStartup(server.url, "Guarded");
    const settingsBefore = (await (await fetch(`${server.url}api/settings`)).json()).settings;
    const backupId = backups[0].id;
    const importToken = "0123456789abcdef0123456789abcdef"; // gitleaks:allow (a made-up token)
    const writes = [
      ["PATCH", `api/startups/${startup.id}`, { name: "Renamed" }],
      ["DELETE", `api/startups/${startup.id}`, undefined],
      ["PATCH", `api/s/${startup.id}/state/operations`, { protocolVersion: 2, operations: [] }],
      ["PUT", `api/s/${startup.id}/media/document`, { sourceType: "upload", storedName: "x.md", content: "" }],
      ["POST", `api/s/${startup.id}/media/upload`, {}],
      ["PATCH", "api/global/operations", { operations: [] }],
      ["PATCH", "api/settings", { settings: { appName: "Hijacked" } }],
      ["POST", "api/backups", { label: "sneaky" }],
      ["POST", `api/backups/${backupId}/verify`, undefined],
      ["POST", `api/backups/${backupId}/restore`, { scope: "database" }],
      ["DELETE", `api/backups/${backupId}`, undefined],
      ["POST", "api/import", { manifest: {} }],
      ["POST", `api/import/${importToken}/apply`, { mode: "new" }],
      ["POST", "api/about/verify", undefined],
      ["POST", "api/all/search", {}],
    ];
    for (const [method, route, body] of writes) {
      const res = await fetch(`${server.url}${route}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(res.status, 403, `${method} /${route} without origin or token`);
    }
    const listed = (await (await fetch(`${server.url}api/startups`)).json()).startups;
    assert.deepEqual(listed.map(({ id, name }) => ({ id, name })), [{ id: startup.id, name: "Guarded" }], "nothing above changed or deleted the startup");
    assert.deepEqual((await (await fetch(`${server.url}api/settings`)).json()).settings, settingsBefore, "the settings did not change");
    assert.deepEqual((await (await fetch(backupsUrl)).json()).backups.map((backup) => backup.id), backups.map((backup) => backup.id), "no backup was taken or deleted");

    // Reads stay open to the page.
    assert.equal((await fetch(`${server.url}api/s/${startup.id}/state`)).status, 200);
    assert.equal((await fetch(`${server.url}api/startups`)).status, 200);
    assert.equal((await fetch(`${server.url}api/global`)).status, 200);
    assert.equal((await fetch(`${server.url}api/about`)).status, 200);
  } finally {
    await server.stop();
  }
});

test("JSON routes refuse other content types and invalid JSON", async () => {
  const server = await startServer();
  const headers = { Authorization: `Bearer ${server.token}` };
  try {
    for (const route of ["api/backups", "api/startups", "api/import/0123456789abcdef0123456789abcdef/apply"]) {
      const textPlain = await fetch(`${server.url}${route}`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{\"name\":\"x\"}" });
      assert.equal(textPlain.status, 415, route);
      const broken = await fetch(`${server.url}${route}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{not json" });
      assert.equal(broken.status, 400, route);
    }
    // The settings take JSON too; an import takes the file itself, in one of its own types.
    assert.equal((await fetch(`${server.url}api/settings`, { method: "PATCH", headers: { ...headers, "Content-Type": "text/plain" }, body: "{\"settings\":{}}" })).status, 415);
    assert.equal((await fetch(`${server.url}api/import`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "PK" })).status, 415);
    const startup = await createStartup(server.url, "Json");
    const textOperations = await fetch(`${server.url}api/s/${startup.id}/state/operations`, { method: "PATCH", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(textOperations.status, 415);
    // The old whole-state replace is gone, and so are the routes without a startup.
    for (const route of ["api/state", `api/s/${startup.id}/state`]) {
      const legacy = await fetch(`${server.url}${route}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(legacy.status, 404, route);
    }
    assert.equal((await fetch(`${server.url}api/state`)).status, 404);
    assert.equal((await fetch(`${server.url}api/state/operations`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 404);
  } finally {
    await server.stop();
  }
});

test("uploaded files are served from /media/ only, active types as sandboxed downloads", async () => {
  const home = makeTempHome();
  fs.writeFileSync(path.join(home, "outside.txt"), "secret");
  const server = await startServer({ home });
  try {
    const startup = await createStartup(server.url, "Media");
    const mediaDir = path.join(home, "media", startup.id);
    fs.writeFileSync(path.join(mediaDir, "note.txt"), "hello");
    fs.writeFileSync(path.join(mediaDir, "page.html"), "<script>alert(1)</script>");
    fs.writeFileSync(path.join(mediaDir, "image.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    let symlinked = false;
    try {
      fs.symlinkSync(path.join(home, "outside.txt"), path.join(mediaDir, "link.txt"));
      symlinked = true;
    } catch {
      // Some systems do not allow symlinks for this user; the check is skipped there.
    }
    const base = `${server.url}media/${startup.id}/`;

    const text = await fetch(`${base}note.txt`);
    assert.equal(text.status, 200);
    assert.equal(await text.text(), "hello");
    for (const name of ["page.html", "image.svg"]) {
      const res = await fetch(`${base}${name}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-security-policy"), "sandbox");
      assert.match(res.headers.get("content-disposition"), /^attachment/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
    if (symlinked) {
      assert.equal((await fetch(`${base}link.txt`)).status, 404, "a symlink cannot lead outside the media folder");
      assert.equal((await fetch(`${server.url}media/link.txt`, { redirect: "manual" })).status, 404, "nor through the redirect for old links");
    }
    for (const traversal of [`/media/${startup.id}/%2e%2e/%2e%2e/outside.txt`, "/media/%2e%2e/outside.txt", `/media/${startup.id}/..%2f..%2foutside.txt`]) {
      assert.equal((await rawRequest(server.url, traversal)).status, 400, traversal);
    }
    assert.equal((await fetch(`${base}missing.txt`)).status, 404);
    assert.equal((await fetch(`${server.url}media/missing.txt`, { redirect: "manual" })).status, 404);
    // The secrets folder sits beside media/, and no media path reaches it.
    assert.equal((await rawRequest(server.url, "/media/../secrets/api-token")).status, 400);
    // Media is read-only over HTTP.
    assert.equal((await fetch(`${base}note.txt`, { method: "PUT", headers: { "Sec-Fetch-Site": "same-origin" }, body: "x" })).status, 405);
    assert.equal(fs.readFileSync(path.join(mediaDir, "note.txt"), "utf8"), "hello");
  } finally {
    await server.stop();
  }
});

test("the document editor writes only inside the media folder", async () => {
  const home = makeTempHome();
  const outside = path.join(home, "outside.md");
  fs.writeFileSync(outside, "# Untouched\n");
  const server = await startServer({ home });
  try {
    const startup = await createStartup(server.url, "Docs");
    const mediaDir = path.join(home, "media", startup.id);
    fs.writeFileSync(path.join(mediaDir, "doc.md"), "# Before\n");
    // A Markdown file loose in media/ belongs to no startup.
    fs.writeFileSync(path.join(home, "media", "loose.md"), "# Loose\n");
    const put = (body) => fetch(`${server.url}api/s/${startup.id}/media/document`, {
      method: "PUT",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal((await put({ sourceType: "local-path", externalPath: outside, content: "# Changed" })).status, 403);
    assert.equal((await put({ sourceType: "local-path", externalPath: path.join(rootDir, "AGENTS.md"), content: "x" })).status, 403);
    assert.equal((await put({ sourceType: "local-path", externalPath: "../loose.md", content: "x" })).status, 403);
    assert.equal((await put({ sourceType: "local-path", externalPath: path.join(home, "media", "loose.md"), content: "x" })).status, 403);
    assert.equal((await put({ sourceType: "local-path", externalPath: "C:\\Users\\x\\doc.md", content: "x" })).status, 403);
    assert.equal((await put({ sourceType: "unknown", content: "x" })).status, 400);
    assert.equal(fs.readFileSync(outside, "utf8"), "# Untouched\n");
    assert.equal(fs.readFileSync(path.join(home, "media", "loose.md"), "utf8"), "# Loose\n");
    assert.equal((await put({ sourceType: "local-path", externalPath: path.join(mediaDir, "doc.md"), content: "# After\n" })).status, 200);
    assert.equal(fs.readFileSync(path.join(mediaDir, "doc.md"), "utf8"), "# After\n");
  } finally {
    await server.stop();
  }
});

test("a taken port is reported and the server does not move to another one", async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const home = makeTempHome();
  try {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: rootDir,
      env: { ...process.env, PORT: String(port), NO_OPEN: "1", STARTUP_TRACKER_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    assert.match(output, new RegExp(`Port ${port} is already in use`));
    assert.doesNotMatch(output, /Startup Tracker: http/);
  } finally {
    blocker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the API token is created once, private to the user", async () => {
  const server = await startServer();
  try {
    const tokenFile = path.join(server.home, "secrets", "api-token");
    assert.ok(server.token.length >= 64);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(server.home, "secrets")).mode & 0o777, 0o700);
    }
  } finally {
    await server.stop({ keepHome: true });
  }
  const again = await startServer({ home: server.home });
  try {
    assert.equal(again.token, server.token, "a restart keeps the same token");
  } finally {
    await again.stop();
  }
});

test("host, origin and link checks", () => {
  assert.ok(security.isAllowedHost("127.0.0.1:57322"));
  assert.ok(security.isAllowedHost("localhost"));
  assert.ok(security.isAllowedHost("[::1]:57322"));
  assert.ok(!security.isAllowedHost("tracker.example.com"));
  assert.ok(security.isAllowedHost("tracker.example.com", security.parseAllowedHosts("tracker.example.com, other")));
  for (const ok of ["https://example.com", "http://example.com/x", "mailto:team@example.com", "tel:+100000000"]) {
    assert.ok(security.isSafeLink(ok), ok);
  }
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "", "not a url"]) {
    assert.ok(!security.isSafeLink(bad), bad);
  }
  const app = fs.readFileSync(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(app, /const SAFE_LINK_PROTOCOLS = new Set\(\["http:", "https:", "mailto:", "tel:"\]\);/);
  assert.match(app, /const DROPPED_LINK_SCHEMES = \/\^\\s\*\(\?:javascript\|vbscript\|data\|file\|blob\):\/i;/);
  assert.doesNotMatch(app, / on[a-z]+="/, "templates carry no inline event handlers");
});

test("the data folder comes from --data-dir, then STARTUP_TRACKER_HOME, then the default", () => {
  const home = "/home/example";
  assert.equal(resolveDataRoot({ argv: ["--data-dir", "/srv/tracker"], env: { STARTUP_TRACKER_HOME: "/x" }, homedir: home }).root, path.resolve("/srv/tracker"));
  assert.equal(resolveDataRoot({ argv: ["--data-dir=~/t"], env: {}, homedir: home }).root, path.resolve(home, "t"));
  assert.equal(resolveDataRoot({ argv: [], env: { STARTUP_TRACKER_HOME: "/x" }, homedir: home }).root, path.resolve("/x"));
  assert.equal(resolveDataRoot({ argv: ["--dev"], env: {}, homedir: home }).root, path.join(home, ".startup-tracker-dev"));
  assert.equal(resolveDataRoot({ argv: [], env: {}, homedir: home }).root, path.join(home, ".startup-tracker"));
  assert.equal(resolveDataRoot({ argv: [], env: {}, homedir: home }).source, "default");
  // A test run must name its folder; the real one is refused.
  for (const env of [{ NODE_TEST_CONTEXT: "child-v8" }, { STARTUP_TRACKER_TEST_RUN: "1" }]) {
    assert.throws(() => resolveDataRoot({ argv: [], env, homedir: home }), /never uses the real data folder/);
    assert.equal(resolveDataRoot({ argv: [], env: { ...env, STARTUP_TRACKER_HOME: "/x" }, homedir: home }).root, path.resolve("/x"));
    assert.equal(resolveDataRoot({ argv: ["--dev"], env, homedir: home }).source, "dev");
  }
  const paths = dataPaths("/data-root", {});
  assert.equal(paths.databaseFile, path.resolve("/data-root/data/tracker.sqlite"));
  assert.equal(paths.tokenFile, path.join("/data-root", "secrets", "api-token"));
});

test("in a test run the server and the tools refuse to use the real data folder", () => {
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env, NO_OPEN: "1", PORT: "0", STARTUP_TRACKER_TEST_RUN: "1" };
  delete env.STARTUP_TRACKER_HOME;
  for (const args of [["server.js"], ["tools/backup-sqlite.js"], ["tools/restore-sqlite.js", "--list"], ["tools/about.js"]]) {
    const result = spawnSync(process.execPath, args, { cwd: rootDir, env, encoding: "utf8", timeout: 20000 });
    assert.notEqual(result.status, 0, `${args[0]} stops`);
    assert.match(`${result.stdout}${result.stderr}`, /never uses the real data folder/, args[0]);
  }
});

