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
  // The first variants were saved as letters: A Linear Precision, B Studio,
  // C Stark Minimalist (the same table as LEGACY_TASTES in taste-switcher.js).
  var legacy = { a: "linear", b: "studio", c: "minimal" };
  if (taste && Object.prototype.hasOwnProperty.call(legacy, taste)) taste = legacy[taste];
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-taste", taste || "studio");
  // Without /s/<startupId>/ in the address there is no tracker to show, only
  // the screen that creates the first startup (js/startups.js). Hiding the
  // tracker now avoids a flash of an empty one.
  var path = window.location && window.location.pathname;
  if (typeof path === "string" && !/^\/s\/[^/]+\//.test(path)) {
    document.documentElement.setAttribute("data-no-startup", "");
  }
})();
