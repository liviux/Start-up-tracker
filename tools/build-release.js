#!/usr/bin/env node
"use strict";

// Builds the release archive the installers and "startup-tracker update"
// download: dist/startup-tracker.tar.gz, with one top folder
// startup-tracker-<version>/ holding the files git tracks and the production
// dependencies, plus dist/SHA256SUMS.
//
//   node tools/build-release.js [--out <folder>] [--allow-dirty]
//
// The dependencies are copied from node_modules/ (run `npm ci` first): only
// the packages package-lock.json does not mark as dev, so the archive needs
// nothing from the npm registry when it is installed. Tests, CI files and
// scratch folders are left out. A tracked file with uncommitted changes stops
// the build unless --allow-dirty is given, so a release is what the tag holds;
// a --allow-dirty build also takes new files git does not ignore.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createTarGz } = require("../lib/cli/tar");
const { RELEASE_ARCHIVE, CHECKSUM_FILE } = require("../lib/cli/update");

const ROOT = path.resolve(__dirname, "..");
// Left out of the archive: development-only folders.
const EXCLUDED = [/^tests\//, /^\.github\//, /^plan\//, /^temp\//, /^\.husky\//, /^eslint\.config\.js$/];

// What git tracks; with `untracked`, also new files git does not ignore.
function gitFiles(root, { untracked = false } = {}) {
  const output = execFileSync("git", ["ls-files", "-z", ...(untracked ? ["--cached", "--others", "--exclude-standard"] : []), "--", "."], { cwd: root, encoding: "utf8" });
  return [...new Set(output.split("\0").filter(Boolean))];
}

function gitDirtyFiles(root) {
  const output = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=no", "--", "."], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter(Boolean).map((line) => line.slice(3));
}

// The production packages: package-lock.json entries under node_modules/ that
// are not dev-only. Nested packages travel with their parent folder.
function productionPackages(lock) {
  return Object.entries(lock.packages || {})
    .filter(([key, entry]) => key.startsWith("node_modules/") && !entry.dev && !key.slice("node_modules/".length).includes("/node_modules/"))
    .map(([key]) => key);
}

function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.posix.join(base, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isExcluded(file) {
  return EXCLUDED.some((pattern) => pattern.test(file));
}

// options: root, outDir, files (relative paths, "/" separated; default: what
// git tracks), nodeModulesDir (default: root/node_modules).
function buildRelease({ root = ROOT, outDir = path.join(root, "dist"), files, nodeModulesDir = path.join(root, "node_modules"), mtime = Date.now() } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const top = `startup-tracker-${pkg.version}`;
  // Regular files only: no folders, links or files deleted since git saw them.
  const sources = (files || gitFiles(root)).filter((file) => !isExcluded(file) && isRegularFile(path.join(root, file)));

  const dependencies = [];
  for (const key of productionPackages(lock)) {
    const folder = path.join(nodeModulesDir, key.slice("node_modules/".length));
    if (!fs.existsSync(folder)) throw new Error(`${key} is missing from ${nodeModulesDir}. Run "npm ci" first.`);
    dependencies.push(...walk(folder, key).map((file) => ({ file, from: path.join(nodeModulesDir, file.slice("node_modules/".length)) })));
  }

  const entries = [
    ...sources.map((file) => ({ file, from: path.join(root, file) })),
    ...dependencies,
  ].sort((a, b) => a.file.localeCompare(b.file)).map(({ file, from }) => ({
    name: `${top}/${file}`,
    data: fs.readFileSync(from),
    mode: fs.statSync(from).mode & 0o111 ? 0o755 : 0o644,
  }));

  fs.mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, RELEASE_ARCHIVE);
  const data = createTarGz(entries, { mtime });
  fs.writeFileSync(archive, data);
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  fs.writeFileSync(path.join(outDir, CHECKSUM_FILE), `${hash}  ${RELEASE_ARCHIVE}\n`);
  return { archive, checksumFile: path.join(outDir, CHECKSUM_FILE), sha256: hash, version: pkg.version, files: entries.length, sources: sources.length, dependencies: dependencies.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex === -1 ? undefined : path.resolve(args[outIndex + 1] || "");
  try {
    if (!args.includes("--allow-dirty")) {
      const dirty = gitDirtyFiles(ROOT);
      if (dirty.length) throw new Error(`Tracked files have uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Commit them, or pass --allow-dirty for a local test build.`);
    }
    // A local test build also takes new files that are not committed yet.
    const result = buildRelease({ outDir, files: args.includes("--allow-dirty") ? gitFiles(ROOT, { untracked: true }) : undefined });
    console.log(`${result.archive}: version ${result.version}, ${result.sources} app files and ${result.dependencies} dependency files.`);
    console.log(`SHA-256 ${result.sha256} (${result.checksumFile})`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { EXCLUDED, productionPackages, buildRelease };
