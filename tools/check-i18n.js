#!/usr/bin/env node
"use strict";

// Flags UI text that does not come from content/i18n/en.json:
//   - public/index.html: text, and placeholder, title, aria-label and
//     data-tooltip values, on elements without the matching data-i18n*
//     attribute;
//   - browser scripts (public/app.js, public/js/): text between tags and those
//     attribute values when written into an HTML template, and literal
//     messages given to confirm(), alert() or prompt().
// Text that is data (a record's name, a user's value) always comes from an
// expression, so it never trips this. A line that must keep fixed text ends
// with the comment `i18n-ignore`.
//
//   node tools/check-i18n.js            check the files above
//   node tools/check-i18n.js <files>    check only these

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TEXT_ATTRIBUTES = ["placeholder", "title", "aria-label", "data-tooltip"];
// Words, but not codes such as EUR or MK.
const HAS_WORDS = { test: (text) => /[A-Za-z]{2,}/.test(String(text).replace(/\b[A-Z]{2,5}\b/g, "")) };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DIALOGS = new Set(["confirm", "alert", "prompt"]);

function decode(text) {
  return text.replace(/&[a-z#0-9]+;/gi, " ");
}

// ---- index.html ----

function checkMarkup(html, file = "index.html") {
  const problems = [];
  const stack = [];
  const lineAt = (index) => html.slice(0, index).split("\n").length;
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      index = html.indexOf("-->", index) + 3;
      continue;
    }
    if (html.startsWith("<!", index)) {
      index = html.indexOf(">", index) + 1;
      continue;
    }
    if (html[index] === "<" && html[index + 1] === "/") {
      const end = html.indexOf(">", index);
      const tag = html.slice(index + 2, end).trim().toLowerCase();
      while (stack.length && stack.pop().tag !== tag);
      index = end + 1;
      continue;
    }
    if (html[index] === "<" && /[a-zA-Z]/.test(html[index + 1])) {
      let end = index + 1;
      let quote = null;
      for (; end < html.length; end += 1) {
        const ch = html[end];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      const inner = html.slice(index + 1, end);
      const tag = inner.match(/^[a-zA-Z0-9-]+/)[0].toLowerCase();
      const attrs = {};
      for (const match of inner.slice(tag.length).matchAll(/([^\s=/>]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[match[1]] = match[2] ?? "";
      const inSvg = tag === "svg" || stack.some((entry) => entry.tag === "svg");
      if (!inSvg) {
        for (const attribute of TEXT_ATTRIBUTES) {
          if (attrs[attribute] !== undefined && HAS_WORDS.test(attrs[attribute]) && attrs[`data-i18n-${attribute === "data-tooltip" ? "tooltip" : attribute}`] === undefined) {
            problems.push({ file, line: lineAt(index), text: `${attribute}="${attrs[attribute]}"` });
          }
        }
      }
      const translated = attrs["data-i18n"] !== undefined || attrs["data-i18n-html"] !== undefined || attrs["data-app-name"] !== undefined;
      index = end + 1;
      if (tag === "script" || tag === "style") {
        index = html.indexOf(`</${tag}`, index);
        continue;
      }
      if (!VOID.has(tag) && !inner.endsWith("/")) stack.push({ tag, translated, inSvg });
      continue;
    }
    const next = html.indexOf("<", index);
    const end = next === -1 ? html.length : next;
    const text = html.slice(index, end);
    const parent = stack[stack.length - 1];
    if (parent && !parent.inSvg && parent.tag !== "title" && HAS_WORDS.test(decode(text)) && !stack.some((entry) => entry.translated)) {
      problems.push({ file, line: lineAt(index), text: text.trim().replace(/\s+/g, " ").slice(0, 80) });
    }
    index = end;
  }
  return problems;
}

// ---- scripts ----

function checkScript(source, file) {
  let espree;
  try {
    espree = require("espree");
  } catch {
    throw new Error("espree is missing: run npm install");
  }
  const ast = espree.parse(source, { ecmaVersion: 2023, range: true, loc: true });
  const lines = source.split("\n");
  const ignored = (line) => /i18n-ignore/.test(lines[line - 1] || "");
  const problems = [];
  const report = (line, text) => {
    if (!ignored(line)) problems.push({ file, line, text: text.trim().replace(/\s+/g, " ").slice(0, 80) });
  };
  (function walk(node, parent) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "TemplateElement") {
      const raw = node.value.raw;
      // Text between two tags inside one piece of a template.
      for (const match of raw.matchAll(/>([^<>]*)</g)) {
        if (HAS_WORDS.test(decode(match[1]))) report(node.loc.start.line + raw.slice(0, match.index).split("\n").length - 1, match[1]);
      }
      for (const match of raw.matchAll(/\s(placeholder|title|aria-label|data-tooltip)="([^"$]*)"/g)) {
        if (HAS_WORDS.test(match[2])) report(node.loc.start.line + raw.slice(0, match.index).split("\n").length - 1, match[0]);
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee.type === "Identifier" ? node.callee.name : node.callee.property?.name;
      const object = node.callee.object?.name;
      const first = node.arguments[0];
      const isDialog = DIALOGS.has(callee) && (node.callee.type === "Identifier" || ["window", "root"].includes(object));
      if (isDialog && first && ((first.type === "Literal" && typeof first.value === "string" && HAS_WORDS.test(first.value)) || (first.type === "TemplateLiteral" && first.quasis.some((quasi) => HAS_WORDS.test(quasi.value.cooked || ""))))) {
        report(node.loc.start.line, source.slice(...first.range));
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "range" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value === "object" && value.type) walk(value, node);
    }
    void parent;
  })(ast, null);
  return problems;
}

function defaultFiles() {
  const js = path.join(ROOT, "public", "js");
  const list = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? list(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []));
  return [path.join(ROOT, "public", "index.html"), path.join(ROOT, "public", "app.js"), ...list(js)];
}

function checkFiles(files) {
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const name = path.relative(ROOT, file);
    problems.push(...(file.endsWith(".html") ? checkMarkup(text, name) : checkScript(text, name)));
  }
  return problems;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const problems = checkFiles(args.length ? args.map((file) => path.resolve(file)) : defaultFiles());
  for (const problem of problems) console.log(`${problem.file}:${problem.line} ${problem.text}`);
  console.log(`check-i18n: ${problems.length} hard-coded string(s)`);
  process.exitCode = problems.length ? 1 : 0;
}

module.exports = { checkMarkup, checkScript, checkFiles, defaultFiles };
