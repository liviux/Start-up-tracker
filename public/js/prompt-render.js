// Fills a prompt's {{VARIABLES}}. The same file runs in the browser
// (window.StartupTrackerPromptRender) and on the server (require), so a
// prompt copied from the page and one sent to an AI agent read the same.
//
// Only double braces are variables: "{section}" in a URL stays as written.
// Names are matched without regard to case and spaces inside the braces.
// A variable whose value is empty takes its line with it when nothing useful
// would be left on that line ("- Type: {{TYPE}}") and otherwise leaves no
// dangling comma or empty brackets behind; a block variable
// standing on its own line also takes the heading line above it, so an empty
// {{CONSTRAINTS}} leaves no orphaned heading. Names with no value at all are
// left in place and reported, so a run can be held until they are filled.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerPromptRender = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  // The same pattern without the global flag, for yes-or-no checks: .test on
  // a global pattern keeps its position between calls.
  const HAS_VARIABLE = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/;
  const ALIASES = { TODAY_DATE: "TODAY", DATE: "TODAY" };
  // Variables that hold a paragraph of their own under a heading line.
  const BLOCK_VARIABLES = new Set(["CONSTRAINTS", "SEARCH_FOCUS", "VERIFIED_ACTIVITY", "AVOID", "SPECIAL_SCHEDULE", "SCOPE_DETAILS", "STARTUP_LINKS", "TRACKER_ACCESS"]);
  const MAX_DEPTH = 3;

  function canonical(name) {
    const upper = String(name).toUpperCase();
    return ALIASES[upper] || upper;
  }

  function variablesIn(text) {
    const names = new Set();
    for (const match of String(text || "").matchAll(VARIABLE)) names.add(canonical(match[1]));
    return [...names];
  }

  function hasValue(values, name) {
    return Object.prototype.hasOwnProperty.call(values, name) && values[name] !== undefined && values[name] !== null;
  }

  // Values may hold variables themselves (an example text that mentions
  // {{SECTOR}}); those are filled first, a few levels deep.
  function resolveValues(values) {
    const resolved = {};
    for (const [key, value] of Object.entries(values || {})) resolved[canonical(key)] = value === null || value === undefined ? value : String(value);
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      let changed = false;
      for (const [key, value] of Object.entries(resolved)) {
        if (typeof value !== "string" || !value.includes("{{")) continue;
        const next = value.replace(VARIABLE, (match, name) => {
          const target = canonical(name);
          return target !== key && hasValue(resolved, target) ? resolved[target] : match;
        });
        if (next !== value) {
          resolved[key] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return resolved;
  }

  // A line is worth keeping when something other than a label, a list marker
  // or punctuation remains on it.
  function lineIsEmptyShell(line) {
    const stripped = line.replace(/^[\s>*\-+#\d.)]*/, "").replace(/[\s*_`]+$/, "");
    return stripped === "" || /^[^:]{0,80}:$/.test(stripped);
  }

  // What an empty value leaves behind: "Name, " at the end of a line, a
  // comma before a full stop, or empty brackets.
  function tidyEmptied(line) {
    return line
      .replace(/\s*\(\s*\)/g, "")
      .replace(/\s*[,;]\s*([.!?])/g, "$1")
      .replace(/[,;]\s*$/, "");
  }

  function render(template, values = {}) {
    const resolved = resolveValues(values);
    const unresolved = new Set();
    const used = new Set();
    const lines = String(template || "").split("\n");
    const output = [];

    for (const line of lines) {
      const names = [...line.matchAll(VARIABLE)].map((match) => canonical(match[1]));
      if (!names.length) {
        output.push(line);
        continue;
      }
      let emptied = false;
      const filled = line.replace(VARIABLE, (match, name) => {
        const key = canonical(name);
        if (!hasValue(resolved, key)) {
          unresolved.add(key);
          return match;
        }
        used.add(key);
        if (resolved[key].trim() === "") emptied = true;
        return resolved[key];
      });
      if (!emptied) {
        output.push(filled);
        continue;
      }
      const alone = line.trim().replace(VARIABLE, "").trim() === "" && names.length === 1;
      if (alone && BLOCK_VARIABLES.has(names[0])) {
        // Drop the heading this block sat under, and the blank line between.
        while (output.length && output[output.length - 1].trim() === "") output.pop();
        if (output.length && !HAS_VARIABLE.test(output[output.length - 1])) output.pop();
        continue;
      }
      if (lineIsEmptyShell(filled)) continue;
      output.push(tidyEmptied(filled));
    }

    // Removed lines can leave runs of blank lines behind.
    const text = output.join("\n").replace(/\n{3,}/g, "\n\n");
    return { text, unresolved: [...unresolved], used: [...used] };
  }

  return { render, variablesIn, canonical, BLOCK_VARIABLES };
});
