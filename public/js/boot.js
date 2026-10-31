// Applies the saved theme and design style before the first paint, so the page
// never flashes the wrong colours. Loaded synchronously in <head>; a file
// rather than an inline script because the page's security policy allows
// only scripts served by the tracker itself.
//
// The values are a mirror of settings.appearance, written by
// scripts/taste-switcher.js. No theme key means "follow the system".
(function () {
  var theme = null;
  var taste = null;
  try {
    theme = localStorage.getItem("startup-tracker-theme");
    taste = localStorage.getItem("startup-tracker-taste");
  } catch (error) {
    // Storage can be blocked by the browser; fall back to the defaults.
  }
  if (theme !== "light" && theme !== "dark") theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  // The same list as THEMES in taste-switcher.js.
  var themes = ["studio", "ledger", "nightshift", "fieldnotes", "meridian", "lacquer", "shinjuku", "quiet", "tactile", "broadsheet", "signal", "coda"];
  if (themes.indexOf(taste) === -1) taste = "studio";
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-taste", taste);
  // The live theme switcher reserves a strip at the top. Reading its open
  // state here avoids the page shifting when scripts/live-themes.js restores
  // the bar after the first paint.
  var liveThemes = null;
  try {
    liveThemes = sessionStorage.getItem("startup-tracker-live-themes");
  } catch (error) {
    // Storage can be blocked by the browser; the bar still opens on demand.
  }
  if (liveThemes === "1" && document.documentElement.classList) {
    document.documentElement.classList.add("live-themes-on");
  }
  // Without /s/<startupId>/ in the address there is no tracker to show, only
  // the screen that creates the first startup (js/startups.js). Hiding the
  // tracker now avoids a flash of an empty one.
  var path = window.location && window.location.pathname;
  if (typeof path === "string" && !/^\/s\/[^/]+\//.test(path)) {
    document.documentElement.setAttribute("data-no-startup", "");
  }
})();
