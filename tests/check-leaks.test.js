const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { scanText, scanFile, checkPath, loadPrivatePatterns, sha256 } = require("../tools/check-leaks.js");
const { install, hookScript, MARKER } = require("../tools/install-git-hooks.js");

// Fixtures are assembled at run time so this file never contains a real-looking
// secret, path or address that the leak check would flag in the repository itself.
const join = (...parts) => parts.join("");

function rules(text, options) {
  return scanText(text, options).map((hit) => hit.rule);
}

const emptyContext = { allowlist: { largeFiles: {}, binaries: {}, allow: [] }, privatePatterns: [] };

test("email addresses are flagged except example domains, noreply and file names", () => {
  assert.deepEqual(rules(join("write to jane", "@", "corp-mail.com today")), ["email"]);
  assert.deepEqual(rules("contact@example.com, team@example.org, x@sub.example.com"), []);
  assert.deepEqual(rules(join("123+someone", "@", "users.noreply.github.com")), []);
  assert.deepEqual(rules("icon@2x.png and logo@3x.svg"), []);
});

test("secrets, IBANs, private hosts and personal paths are flagged", () => {
  assert.deepEqual(rules(join("RO49", "AAAA", "1B31007593840000")), ["iban"]);
  assert.deepEqual(rules(join("sk", "-", "a".repeat(24))), ["api-key"]);
  assert.deepEqual(rules(join("gh", "p_", "A".repeat(36))), ["api-key"]);
  assert.deepEqual(rules(join("-----BEGIN ", "RSA PRIVATE KEY-----")), ["private-key"]);
  assert.deepEqual(rules(join("ey", "J", "a".repeat(12), ".ey", "J", "b".repeat(12), ".", "c".repeat(12))), ["jwt"]);
  assert.deepEqual(rules(join("https://example.com/v?", "si=", "AbCdEf123456")), ["token-in-url"]);
  assert.deepEqual(rules(join("box", ".ts", ".net")), ["private-host"]);
  assert.deepEqual(rules(join("/ho", "me/alice/notes")), ["personal-path"]);
  assert.deepEqual(rules(join("/mn", "t/d/projects")), ["personal-path"]);
  assert.deepEqual(rules(join("C:", "\\Users\\bob")), ["personal-path"]);
});

test("template placeholders in query strings are not mistaken for tokens", () => {
  assert.deepEqual(rules("fetch(`/api?key=${encodeURIComponent(name)}`)"), []);
});

test("phone numbers and national-ID-like digit runs are warnings, not errors", () => {
  const hits = scanText(join("+40 7", "12 345 678 and 1", "880101123456"));
  assert.deepEqual(hits.map((hit) => hit.rule).sort(), ["national-id-like", "phone"]);
  assert.ok(hits.every((hit) => hit.level === "warning"));
  // A document id in an official URL, joined with "_", is not one.
  assert.deepEqual(scanText(join("show-data?actid=AC_CEN_22_15178", "07327856")), []);
});

test("banned words are matched by hash, so the word never appears in the code", () => {
  const word = join("loop", "troop");
  assert.deepEqual(rules(`Welcome to ${word[0].toUpperCase()}${word.slice(1)}`), ["banned-word"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "check-leaks.js"), "utf8");
  assert.ok(!source.toLowerCase().includes(word), "the checker must not contain the word itself");
  assert.ok(source.includes(sha256(word)), "the checker stores the hash");
});

test("private patterns support substrings, regular expressions and word hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaks-"));
  try {
    const file = path.join(dir, "patterns.txt");
    fs.writeFileSync(file, ["# comment", "Jane Doe", "re:\\bacme[-\\s]?ltd\\b", `sha256:${sha256("zebracorn")}`, ""].join("\n"));
    const privatePatterns = loadPrivatePatterns(file);
    assert.equal(privatePatterns.length, 3);
    const hits = scanText("Owner: JANE DOE\nAcme Ltd\nThe ZebraCorn project", { privatePatterns });
    assert.deepEqual(hits.map((hit) => [hit.line, hit.rule]), [
      [1, "private-pattern-2"],
      [2, "private-pattern-3"],
      [3, "private-pattern-4"],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tracker data, env files and secrets folders are refused by path", () => {
  assert.deepEqual(checkPath("data/tracker.sqlite").map((hit) => hit.rule).sort(), ["data-folder", "database-file"]);
  assert.deepEqual(checkPath("backup/tracker-20260101-000000.sqlite").map((hit) => hit.rule), ["database-file"]);
  assert.deepEqual(checkPath("notes.sqlite-wal").map((hit) => hit.rule), ["database-file"]);
  assert.deepEqual(checkPath("media/logo.png").map((hit) => hit.rule), ["data-folder"]);
  assert.deepEqual(checkPath("plan/draft.md").map((hit) => hit.rule), ["data-folder"]);
  assert.deepEqual(checkPath(".env").map((hit) => hit.rule), ["env-file"]);
  assert.deepEqual(checkPath(".env.example"), []);
  assert.deepEqual(checkPath("public/app.js"), []);
});

test("binaries must match the allowlist hash and large files must be listed", () => {
  const binary = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02]);
  assert.deepEqual(scanFile("assets/font.woff2", binary, emptyContext).map((hit) => hit.rule), ["unexpected-binary"]);
  const allowed = { ...emptyContext, allowlist: { ...emptyContext.allowlist, binaries: { "assets/font.woff2": sha256(binary) } } };
  assert.deepEqual(scanFile("assets/font.woff2", binary, allowed), []);
  const changed = { ...emptyContext, allowlist: { ...emptyContext.allowlist, binaries: { "assets/font.woff2": "0".repeat(64) } } };
  assert.deepEqual(scanFile("assets/font.woff2", binary, changed).map((hit) => hit.rule), ["changed-binary"]);

  const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
  assert.deepEqual(scanFile("big.js", big, emptyContext).map((hit) => hit.rule), ["large-file"]);
  const listed = { ...emptyContext, allowlist: { ...emptyContext.allowlist, largeFiles: { "big.js": "known" } } };
  assert.deepEqual(scanFile("big.js", big, listed), []);
});

test("the pre-commit hook runs the staged check for a project inside a larger repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const project = path.join(dir, "startup-tracker");
    fs.mkdirSync(project);
    const hookFile = install({ root: project });
    const hook = fs.readFileSync(hookFile, "utf8");
    assert.ok(hook.includes(MARKER));
    assert.match(hook, /node "startup-tracker\/tools\/check-leaks\.js" --staged/);
    // Windows has no executable bit; Git for Windows runs hooks regardless.
    if (process.platform !== "win32") assert.ok(fs.statSync(hookFile).mode & 0o100, "hook must be executable");
    // Reinstalling over our own hook is fine.
    install({ root: project });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing foreign hook is kept unless --force, and then backed up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const hooksDir = path.join(dir, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\necho mine\n");
    assert.throws(() => install({ root: dir }), /already exists/);
    install({ root: dir, force: true });
    const backups = fs.readdirSync(hooksDir).filter((name) => name.startsWith("pre-commit.backup-"));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8"), /node "tools\/check-leaks\.js" --staged/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook script for a standalone repository points at the local tool", () => {
  assert.match(hookScript(""), /node "tools\/check-leaks\.js" --staged/);
});
