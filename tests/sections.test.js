"use strict";

// Section registry and colours (public/js/sections.js, styles/sections.css).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Sections = require("../public/js/sections.js");
const settingsLib = require("../lib/settings");

const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles", "sections.css"), "utf8");

test("one registry describes the four sections", () => {
  assert.deepEqual(Sections.IDS, ["mk", "po", "fu", "comp"]);
  assert.deepEqual(Sections.SECTIONS.map((section) => section.code), ["M", "P", "F", "C"]);
  assert.equal(Sections.byTab("programs").id, "po");
  assert.equal(Sections.byGroup("company").id, "comp");
  assert.equal(Sections.byTab("company").id, "comp");
  assert.equal(Sections.byCalendarType("pipeline").id, "mk");
  assert.equal(Sections.byId("nope"), null);
});

test("text on every section tint reads at 4.5:1 or more, in light and dark, in both palettes", () => {
  for (const palette of Sections.PALETTE_IDS) {
    for (const mode of Sections.MODES) {
      for (const id of Sections.IDS) {
        const tokens = Sections.derive(Sections.PALETTES[palette][id], mode);
        assert.ok(Sections.contrast(tokens.fg, tokens.bg) >= 4.5, `${palette} ${mode} ${id}: ${Sections.contrast(tokens.fg, tokens.bg).toFixed(2)}`);
      }
    }
  }
  // Any picked colour gets a readable text shade too.
  for (const picked of ["#ffff00", "#00ffff", "#000080", "#808080", "#ffffff", "#000000"]) {
    for (const mode of Sections.MODES) {
      const tokens = Sections.derive(picked, mode);
      assert.ok(Sections.contrast(tokens.fg, tokens.bg) >= 4.5, `${picked} ${mode}`);
    }
  }
});

test("the stylesheet holds the standard palette exactly as sections.js derives it", () => {
  const block = css.match(/\/\* tokens:start \*\/\n([\s\S]*?)\/\* tokens:end \*\//)?.[1];
  assert.ok(block, "the token markers are there");
  assert.equal(block, Sections.cssText(Sections.PALETTES.standard));
  for (const id of Sections.IDS) assert.match(css, new RegExp(`\\[data-section="${id}"\\] \\{`));
});

test("the colour-blind palette keeps the four hues apart and the code always shows", () => {
  const colors = Sections.colorsFor({ palette: "colorblind" });
  assert.notEqual(colors.po, Sections.PALETTES.standard.po);
  assert.equal(new Set(Object.values(colors)).size, 4);
  assert.equal(Sections.isStandard({ palette: "standard", mk: "" }), true);
  assert.equal(Sections.isStandard({ palette: "standard", mk: "#123456" }), false);
  assert.equal(Sections.colorsFor({ palette: "colorblind", fu: "#ABCDEF" }).fu, "#abcdef", "a picked colour wins over the palette");
  assert.equal(Sections.colorsFor({ mk: "red" }).mk, Sections.PALETTES.standard.mk, "only #rrggbb is taken");
  for (const section of Sections.SECTIONS) assert.ok(section.code && section.short, "a text badge besides the colour");
});

test("readability flags a picked colour that reads badly as text on its tint", () => {
  const yellow = Sections.readability("#ffff00");
  assert.ok(yellow.light.ratio < 4.5);
  assert.equal(yellow.light.adjusted, true);
  const ink = Sections.readability("#1e3a8a");
  assert.ok(ink.light.ratio >= 4.5);
});

test("section colours are a validated shared setting", () => {
  assert.deepEqual(settingsLib.defaults().sectionColors, { palette: "standard", mk: "", po: "", fu: "", comp: "" });
  const next = settingsLib.mergeSettings(settingsLib.defaults(), { sectionColors: { palette: "colorblind", po: "#FF8800" } });
  assert.deepEqual(next.sectionColors, { palette: "colorblind", mk: "", po: "#ff8800", fu: "", comp: "" });
  assert.throws(() => settingsLib.mergeSettings(settingsLib.defaults(), { sectionColors: { mk: "blue" } }), /sectionColors\.mk/);
  assert.throws(() => settingsLib.mergeSettings(settingsLib.defaults(), { sectionColors: { palette: "neon" } }), /sectionColors\.palette/);
  assert.throws(() => settingsLib.mergeSettings(settingsLib.defaults(), { sectionColors: { xx: "#000000" } }), /is not a setting/);
});
