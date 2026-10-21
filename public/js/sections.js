// The four target sections, described once: Marketing (MK), Programs and
// opportunities (PO), Funding (FU) and Company (COMP). The sidebar, search
// badges, the calendar, the recycle bin and history read their code, name
// and colour from here.
//
// Each section has a colour. From one base colour per section this file
// derives a soft tint (-bg), a text colour on that tint (-fg, at least 4.5:1)
// and a border, for light and for dark pages. styles/sections.css holds the
// standard palette so the first paint is right; a different palette or a
// colour picked in Settings > Appearance is written into a <style> element.
//
// UMD: browsers get window.StartupTrackerSections, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerSections = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // tab: the app tab that lists the section. group: its key in the
  // calendar's event groups.
  const SECTIONS = Object.freeze([
    { id: "mk", code: "M", short: "MK", tab: "pipeline", group: "marketing", calendarType: "pipeline" },
    { id: "po", code: "P", short: "PO", tab: "programs", group: "programs", calendarType: "program" },
    { id: "fu", code: "F", short: "FU", tab: "funding", group: "funding", calendarType: "funding" },
    { id: "comp", code: "C", short: "COMP", tab: "company", group: "company", calendarType: "company" },
  ].map((section) => Object.freeze(section)));

  const IDS = SECTIONS.map((section) => section.id);

  // Okabe and Ito's palette for the colour-blind preset: the four hues stay
  // apart for the common colour-vision deficiencies.
  const PALETTES = Object.freeze({
    standard: Object.freeze({ mk: "#2563eb", po: "#ea580c", fu: "#15803d", comp: "#7c3aed" }),
    colorblind: Object.freeze({ mk: "#0072b2", po: "#e69f00", fu: "#009e73", comp: "#cc79a7" }),
  });
  const PALETTE_IDS = Object.keys(PALETTES);
  const MIN_CONTRAST = 4.5;
  const MODES = ["light", "dark"];
  // The page colours the tints are mixed with.
  const PAGE = Object.freeze({ light: "#ffffff", dark: "#0f172a" });

  function byId(id) {
    return SECTIONS.find((section) => section.id === id) || null;
  }

  function byTab(tab) {
    return SECTIONS.find((section) => section.tab === tab) || null;
  }

  function byGroup(group) {
    return SECTIONS.find((section) => section.group === group) || null;
  }

  function byCalendarType(type) {
    return SECTIONS.find((section) => section.calendarType === type) || null;
  }

  // ---- colour math ---------------------------------------------------------

  function isHex(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function toRgb(hex) {
    const value = String(hex).replace("#", "");
    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  }

  function toHex(rgb) {
    return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
  }

  // weight is the share of `a` in the result.
  function mix(a, b, weight) {
    const left = toRgb(a);
    const right = toRgb(b);
    return toHex(left.map((channel, index) => channel * weight + right[index] * (1 - weight)));
  }

  function luminance(hex) {
    const [r, g, b] = toRgb(hex).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // WCAG contrast ratio, 1 to 21.
  function contrast(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }

  // The tint, the text on it and the border for one base colour. The text
  // starts as the base colour and moves towards black (light pages) or white
  // (dark pages) until it reads at 4.5:1 on the tint.
  function derive(base, mode) {
    const page = PAGE[mode];
    const bg = mix(base, page, mode === "dark" ? 0.24 : 0.12);
    const border = mix(base, page, mode === "dark" ? 0.55 : 0.4);
    const toward = mode === "dark" ? "#ffffff" : "#000000";
    let fg = base;
    for (let step = 1; contrast(fg, bg) < MIN_CONTRAST && step <= 20; step += 1) fg = mix(toward, base, step / 20);
    return { base, bg, fg, border, rgb: toRgb(base).join(", "), adjusted: fg !== base };
  }

  // ---- palettes and settings ----------------------------------------------

  // The base colour per section: the palette's, unless Settings picked one.
  function colorsFor(sectionColors) {
    const choice = sectionColors && typeof sectionColors === "object" ? sectionColors : {};
    const palette = PALETTES[choice.palette] || PALETTES.standard;
    return Object.fromEntries(IDS.map((id) => [id, isHex(choice[id]) ? choice[id].toLowerCase() : palette[id]]));
  }

  function isStandard(sectionColors) {
    const colors = colorsFor(sectionColors);
    return IDS.every((id) => colors[id] === PALETTES.standard[id]);
  }

  function declarations(colors, mode) {
    return IDS.map((id) => {
      const tokens = derive(colors[id], mode);
      return [
        `  --section-${id}: ${tokens.base};`,
        `  --section-${id}-rgb: ${tokens.rgb};`,
        `  --section-${id}-bg: ${tokens.bg};`,
        `  --section-${id}-fg: ${tokens.fg};`,
        `  --section-${id}-border: ${tokens.border};`,
      ].join("\n");
    }).join("\n");
  }

  // The CSS for a set of base colours, light first and dark under the
  // theme's attribute.
  function cssText(colors) {
    return `:root {\n${declarations(colors, "light")}\n}\n\n:root[data-theme="dark"] {\n${declarations(colors, "dark")}\n}\n`;
  }

  // How readable the picked colour is as text on its own tint, per mode.
  // Below 4.5:1 the page uses a darker or lighter text colour instead.
  function readability(base) {
    return Object.fromEntries(MODES.map((mode) => {
      const tokens = derive(base, mode);
      return [mode, { ratio: contrast(base, tokens.bg), adjusted: tokens.adjusted, fg: tokens.fg, bg: tokens.bg }];
    }));
  }

  const api = {
    SECTIONS,
    IDS,
    PALETTES,
    PALETTE_IDS,
    MIN_CONTRAST,
    MODES,
    byId,
    byTab,
    byGroup,
    byCalendarType,
    isHex,
    mix,
    contrast,
    derive,
    colorsFor,
    isStandard,
    cssText,
    readability,
  };

  // ---- browser ------------------------------------------------------------

  const STYLE_ID = "section-colors";

  function apply(settings) {
    const doc = root.document;
    if (!doc) return;
    const choice = settings?.sectionColors;
    let style = doc.getElementById(STYLE_ID);
    if (isStandard(choice)) {
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.head.appendChild(style);
    }
    style.textContent = cssText(colorsFor(choice));
  }

  api.apply = apply;

  if (root.document && root.StartupTrackerSettings) {
    apply(root.StartupTrackerSettings.get());
    root.StartupTrackerSettings.subscribe((settings) => apply(settings));
  }

  return Object.freeze(api);
});
