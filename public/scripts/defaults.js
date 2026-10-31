(() => {
  "use strict";

  // Static defaults and seed data live outside app.js so behavior code stays navigable.

  // The tags a new install starts with. They are added once and can be
  // renamed, merged or deleted in Extra > Tags like any other.
  const DEFAULT_TAG_DEFINITIONS = [
    { id: "quick-win", label: "quick-win", description: "Little effort, done in one sitting. Batch these together instead of letting them break up longer work." },
    { id: "warm-contact", label: "warm-contact", description: "You already know someone there, or someone can introduce you. Start with these before cold outreach." },
    { id: "follow-up", label: "follow-up", description: "Waiting for a reply or a second step from you. Give it a next action date so it does not go quiet." },
    { id: "high-impact", label: "high-impact", description: "One of the few things most likely to move your main goal. Give these your best time." },
    { id: "evergreen", label: "evergreen", description: "Keeps working long after you do it, such as a listing, a guide or a page that people keep finding." },
    { id: "needs-review", label: "needs-review", description: "Facts or details still to check against the official source before you rely on them." },
    { id: "partner", label: "partner", description: "Involves another organization you work with or want to work with." },
    { id: "local", label: "local", description: "Tied to your city, region or country." },
    { id: "online", label: "online", description: "Happens online, with no travel." },
    { id: "paid", label: "paid", description: "Costs money: a fee, a ticket, ads or a paid listing." },
    { id: "free", label: "free", description: "Costs nothing but time." },
  ];

  // Option lists people edit (media types, the feedback lists, research link
  // groups) live in content/options.json and js/options.js. These stay fixed.
  const dailyPriorities = ["High", "Medium", "Low"];
  const feedbackStatuses = ["new", "reviewing", "acted", "archived"];
  const mediaSources = ["upload", "url", "local-path"];
  const MANAGER_PAGE_SIZE = 10;

  const defaultsExport = Object.freeze({
    DEFAULT_TAG_DEFINITIONS,
    dailyPriorities,
    feedbackStatuses,
    mediaSources,
    MANAGER_PAGE_SIZE,
  });

  if (typeof window !== "undefined") {
    window.StartupTrackerDefaults = defaultsExport;
  }
  if (typeof module === "object" && module.exports) {
    module.exports = defaultsExport;
  }
})();
