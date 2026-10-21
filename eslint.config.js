"use strict";

// A deliberately small rule set: it catches real mistakes (undefined names,
// unused code) and leaves formatting alone.
const globals = require("globals");

const rules = {
  "no-undef": "warn",
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
};

module.exports = [
  {
    ignores: ["node_modules/**", "public/assets/**", "docs/vendor/**", "temp/**", "coverage/**"],
  },
  {
    files: ["server.js", "eslint.config.js", "lib/**/*.js", "tools/**/*.js", "tests/**/*.js", "bin/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules,
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser, marked: "readonly", module: "readonly", globalThis: "readonly" },
    },
    rules,
  },
];
