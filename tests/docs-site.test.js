"use strict";

// The documentation site in docs/ is served as static files (GitHub Pages or any
// file server). It must load only files from docs/ itself, and every page the
// sidebar lists must exist.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.resolve(__dirname, "..", "docs");
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), "utf8");

function htmlReferences(html) {
  return [...html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

function sidebarLinks(markdown) {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

test("docs/index.html loads only local files, and each of them exists", () => {
  const html = read("index.html");
  const refs = htmlReferences(html);
  assert.ok(refs.includes("vendor/docsify.min.js"), "loads Docsify");
  assert.ok(refs.includes("vendor/search.min.js"), "loads the search plugin");
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `${ref} must be a relative path, not another host`);
    assert.ok(fs.existsSync(path.join(DOCS, ref)), `${ref} exists in docs/`);
  }
  assert.doesNotMatch(html, /https?:\/\//i, "no addresses on other hosts in the page");
});

test("vendored styles import nothing from other hosts", () => {
  for (const name of fs.readdirSync(path.join(DOCS, "vendor")).filter((file) => file.endsWith(".css"))) {
    assert.doesNotMatch(read(path.join("vendor", name)), /@import|url\(\s*["']?(?:https?:)?\/\//i, name);
  }
});

test("every page in docs/_sidebar.md exists, and .nojekyll and the home page are there", () => {
  const links = sidebarLinks(read("_sidebar.md"));
  assert.ok(links.length > 0, "the sidebar lists pages");
  for (const link of links) {
    assert.match(link, /^[\w./-]+\.md$/, `${link} is a local Markdown page`);
    assert.ok(fs.existsSync(path.join(DOCS, link)), `${link} exists in docs/`);
  }
  assert.ok(fs.existsSync(path.join(DOCS, ".nojekyll")));
  assert.ok(fs.existsSync(path.join(DOCS, "README.md")));
});

test("the install scripts published with the docs are the same as the ones in the repository root", () => {
  // GitHub Pages serves docs/, so the short install URLs need copies there.
  const root = path.resolve(__dirname, "..");
  for (const name of ["install.sh", "install.ps1"]) {
    const normalise = (text) => text.replace(/\r\n/g, "\n");
    assert.equal(normalise(read(name)), normalise(fs.readFileSync(path.join(root, name), "utf8")), `docs/${name} differs from ${name}: copy it again (cp ${name} docs/${name})`);
  }
});
