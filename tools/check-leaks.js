#!/usr/bin/env node
"use strict";

// Scans the project for things that must never be published: personal data,
// secrets, local paths, tracker data files and unexpected binaries.
//
// Usage:
//   node tools/check-leaks.js            scan the working tree (files git would commit)
//   node tools/check-leaks.js --staged   scan the staged versions of staged files (pre-commit)
//   node tools/check-leaks.js --history  scan every commit: contents, messages, author and committer
//   node tools/check-leaks.js <paths...> scan only these files
//   node tools/check-leaks.js --write-asset-allowlist   record the hashes of the current binaries
//
// Private patterns: set LEAK_PATTERNS_FILE to a file outside the repository with one
// pattern per line (case-insensitive substring; lines starting with "re:" are regular
// expressions; "#" starts a comment). Hits report only the file, the line and the rule,
// never the matched text, so the output is safe to paste or keep in CI logs.
//
// Exit code: 1 when any error-level hit is found, 0 otherwise. Warnings are printed
// but do not fail the run unless --strict is given.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ALLOWLIST_FILE = path.join(__dirname, "leak-allowlist.json");
const MAX_FILE_BYTES = 1024 * 1024;

const ALLOWED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.invalid"]);
// Strings like "icon@2x.png" or "pkg@1.2.3" look like addresses to a naive pattern.
const FILE_EXTENSION_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "js", "mjs", "cjs", "css", "json", "md", "html", "ts",
]);

// Words that must never appear, stored as SHA-256 hashes of the lowercase word so the
// word itself never appears in the repository either.
const BANNED_WORD_HASHES = new Set([
  "96bdb9fd19fd3bb611c9a3a4e5315172092a94c983302b898af569a2eb42c42c",
]);

const LOCAL_PART_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;

// Finds e-mail addresses by expanding around each "@". A single regular expression
// backtracks quadratically on long runs of letters, which minified files have.
function findEmails(text) {
  const found = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && at - start < 64 && LOCAL_PART_CHAR.test(text[start - 1])) start -= 1;
    let end = at + 1;
    while (end < text.length && end - at < 255 && DOMAIN_CHAR.test(text[end])) end += 1;
    const local = text.slice(start, at);
    const domain = text.slice(at + 1, end).replace(/[.-]+$/, "");
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    if (!local || !domain.includes(".") || !/^[A-Za-z]{2,}$/.test(tld)) continue;
    found.push({ index: start, local: local.toLowerCase(), domain: domain.toLowerCase(), tld: tld.toLowerCase() });
  }
  return found;
}

function isAllowedEmail({ local, domain, tld }) {
  return ALLOWED_EMAIL_DOMAINS.has(domain)
    || domain.endsWith(".example.com")
    || domain === "users.noreply.github.com"
    || local === "noreply" || local === "no-reply"
    || FILE_EXTENSION_TLDS.has(tld);
}

const GENERIC_RULES = [
  { id: "email", level: "error", find: (text) => findEmails(text).filter((email) => !isAllowedEmail(email)) },
  { id: "iban", level: "error", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  // A 13-digit number glued to an identifier with "_" (as in an official
  // site's document id) is not a personal number.
  { id: "national-id-like", level: "warning", pattern: /(?<![\d.])[1-8]\d{12}(?![\d.])/g,
    allow: (match) => match.input[match.index - 1] === "_" },
  { id: "phone", level: "warning", pattern: /\+\d[\d ().-]{8,24}\d/g,
    allow: (match) => match[0].replace(/\D/g, "").length < 9 },
  { id: "api-key", level: "error", pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})/g },
  { id: "private-key", level: "error", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "jwt", level: "error", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "token-in-url", level: "error", pattern: /[?&](?:token|key|secret|sig|si|access_token|api_key|apikey)=([^&\s"'<>`]{6,})/gi,
    allow: (match) => /^[{$<%]/.test(match[1]) || match[1].includes("${") },
  { id: "personal-path", level: "error", pattern: /\/mnt\/[a-z]\/|\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z][A-Za-z0-9._-]*\/|[A-Za-z]:\\Users\\|\b[D-Z]:\\/g },
  { id: "private-host", level: "error", pattern: /\.ts\.net\b/gi },
];

const FORBIDDEN_PATH_RULES = [
  { id: "database-file", test: (rel) => /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i.test(rel) || /\.sqlite[^/]*$/i.test(rel) },
  { id: "data-folder", test: (rel) => /^(data|media|plan|\.plan|\.dev-data|secrets)\//.test(rel) },
  { id: "env-file", test: (rel) => /(^|\/)\.env(\.[^/]*)?$/.test(rel) && !/(^|\/)\.env\.example$/.test(rel) },
];

function readAllowlist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
    return {
      largeFiles: parsed.largeFiles || {},
      binaries: parsed.binaries || {},
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { largeFiles: {}, binaries: {}, allow: [] };
    throw new Error(`Cannot read ${path.relative(ROOT, ALLOWLIST_FILE)}: ${error.message}`);
  }
}

function loadPrivatePatterns(file) {
  if (!file) return [];
  const text = fs.readFileSync(file, "utf8");
  const patterns = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("re:")) {
      patterns.push({ number: index + 1, regex: new RegExp(line.slice(3), "gi") });
    } else if (line.startsWith("sha256:")) {
      patterns.push({ number: index + 1, wordHash: line.slice(7).trim().toLowerCase() });
    } else {
      patterns.push({ number: index + 1, needle: line.toLowerCase() });
    }
  });
  return patterns;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Returns a function mapping a character index to its 1-based line number.
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// Returns [{ line, rule, level }] for one text. `allowRules` lists rule ids switched off
// for this file by the allowlist.
function scanText(text, { privatePatterns = [], allowRules = new Set() } = {}) {
  const hits = [];
  const lineOf = lineIndex(text);
  for (const rule of GENERIC_RULES) {
    if (allowRules.has(rule.id)) continue;
    if (rule.find) {
      for (const match of rule.find(text)) hits.push({ line: lineOf(match.index), rule: rule.id, level: rule.level });
      continue;
    }
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.allow && rule.allow(match)) continue;
      hits.push({ line: lineOf(match.index), rule: rule.id, level: rule.level });
    }
  }
  if (!allowRules.has("banned-word")) {
    for (const match of text.matchAll(/[A-Za-z0-9]+/g)) {
      if (match[0].length < 4) continue;
      if (BANNED_WORD_HASHES.has(sha256(match[0].toLowerCase()))) {
        hits.push({ line: lineOf(match.index), rule: "banned-word", level: "error" });
      }
    }
  }
  if (privatePatterns.length) {
    const lower = text.toLowerCase();
    let tokens = null;
    for (const pattern of privatePatterns) {
      const rule = `private-pattern-${pattern.number}`;
      if (pattern.needle) {
        let from = 0;
        for (;;) {
          const index = lower.indexOf(pattern.needle, from);
          if (index < 0) break;
          hits.push({ line: lineOf(index), rule, level: "error" });
          from = index + pattern.needle.length;
        }
      } else if (pattern.regex) {
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
          hits.push({ line: lineOf(match.index), rule, level: "error" });
          if (match[0].length === 0) break;
        }
      } else if (pattern.wordHash) {
        if (!tokens) tokens = [...text.matchAll(/[A-Za-z0-9]+/g)].map((m) => [m.index, sha256(m[0].toLowerCase())]);
        for (const [index, hash] of tokens) {
          if (hash === pattern.wordHash) hits.push({ line: lineOf(index), rule, level: "error" });
        }
      }
    }
  }
  return hits;
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function checkPath(rel) {
  return FORBIDDEN_PATH_RULES.filter((rule) => rule.test(rel)).map((rule) => ({ line: 0, rule: rule.id, level: "error" }));
}

// Scans one file given its path relative to the project root and its content.
function scanFile(rel, buffer, context) {
  const { allowlist, privatePatterns } = context;
  const hits = checkPath(rel);
  const allowRules = new Set();
  for (const entry of allowlist.allow) {
    if (entry.path === rel || (entry.path.endsWith("/") && rel.startsWith(entry.path))) {
      for (const rule of entry.rules || []) allowRules.add(rule);
    }
  }
  if (buffer.length > MAX_FILE_BYTES && !allowlist.largeFiles[rel]) {
    hits.push({ line: 0, rule: "large-file", level: "error" });
  }
  if (isBinary(buffer)) {
    const expected = allowlist.binaries[rel];
    if (!expected) hits.push({ line: 0, rule: "unexpected-binary", level: "error" });
    else if (expected !== sha256(buffer)) hits.push({ line: 0, rule: "changed-binary", level: "error" });
    return hits;
  }
  return hits.concat(scanText(buffer.toString("utf8"), { privatePatterns, allowRules }));
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...options });
}

function insideGitRepo() {
  try {
    git(["rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function splitNul(output) {
  return output.toString("utf8").split("\0").filter(Boolean);
}

function listWorkingTreeFiles() {
  if (insideGitRepo()) {
    return splitNul(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]))
      .filter((rel) => fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile());
  }
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  })(ROOT);
  return files;
}

function report(results, { strict }) {
  let errors = 0;
  let warnings = 0;
  for (const { where, hits } of results) {
    for (const hit of hits) {
      if (hit.level === "error") errors += 1;
      else warnings += 1;
      const location = hit.line ? `${where}:${hit.line}` : where;
      console.log(`${hit.level === "error" ? "ERROR" : "warn "} ${location} [${hit.rule}]`);
    }
  }
  console.log(`check-leaks: ${errors} error(s), ${warnings} warning(s)`);
  return errors > 0 || (strict && warnings > 0) ? 1 : 0;
}

function scanWorkingTree(context, only) {
  const files = only && only.length ? only : listWorkingTreeFiles();
  return files.map((rel) => {
    const normalized = rel.split(path.sep).join("/");
    return { where: normalized, hits: scanFile(normalized, fs.readFileSync(path.join(ROOT, normalized)), context) };
  });
}

function scanStaged(context) {
  const files = splitNul(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--relative", "-z", "--", "."]));
  return files.map((rel) => ({ where: rel, hits: scanFile(rel, git(["show", `:./${rel}`]), context) }));
}

function scanHistory(context) {
  const results = [];
  const commits = git(["rev-list", "--all", "--", "."]).toString("utf8").split("\n").filter(Boolean);
  for (const commit of commits) {
    const short = commit.slice(0, 12);
    const meta = git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", commit]).toString("utf8");
    const [authorName, authorEmail, committerName, committerEmail, message] = meta.split("\0");
    const identity = `${authorName}\n${authorEmail}\n${committerName}\n${committerEmail}`;
    results.push({ where: `${short} (author/committer)`, hits: scanText(identity, context) });
    results.push({ where: `${short} (message)`, hits: scanText(message || "", context) });
    const changed = splitNul(git(["diff-tree", "--root", "--no-commit-id", "-r", "--relative", "--name-only", "--diff-filter=ACMR", "-z", commit, "--", "."]));
    for (const rel of changed) {
      results.push({ where: `${short}:${rel}`, hits: scanFile(rel, git(["show", `${commit}:./${rel}`]), context) });
    }
  }
  return results;
}

function writeAssetAllowlist() {
  const current = fs.existsSync(ALLOWLIST_FILE) ? JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")) : {};
  const binaries = {};
  for (const rel of listWorkingTreeFiles()) {
    const buffer = fs.readFileSync(path.join(ROOT, rel));
    if (isBinary(buffer)) binaries[rel] = sha256(buffer);
  }
  const next = { ...current, binaries };
  fs.writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Recorded ${Object.keys(binaries).length} binary file(s) in ${path.relative(ROOT, ALLOWLIST_FILE)}.`);
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const only = argv.filter((arg) => !arg.startsWith("--"));
  if (flags.has("--write-asset-allowlist")) {
    writeAssetAllowlist();
    return 0;
  }
  const context = {
    allowlist: readAllowlist(),
    privatePatterns: loadPrivatePatterns(process.env.LEAK_PATTERNS_FILE),
  };
  if (process.env.LEAK_PATTERNS_FILE) {
    console.log(`check-leaks: using ${context.privatePatterns.length} private pattern(s)`);
  }
  let results;
  if (flags.has("--history")) results = scanHistory(context);
  else if (flags.has("--staged")) results = scanStaged(context);
  else results = scanWorkingTree(context, only);
  return report(results, { strict: flags.has("--strict") });
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-leaks: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { scanText, scanFile, checkPath, loadPrivatePatterns, GENERIC_RULES, sha256 };
