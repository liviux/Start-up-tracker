// The changelog dialog: the version at the bottom of the sidebar opens the
// releases from CHANGELOG.md, newest first, with a link to the full file on
// GitHub. Releases are read from the server, so the page always shows the
// changelog shipped with the running version.
//
// UMD: browsers get window.StartupTrackerChangelog, Node gets module.exports.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerChangelog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const REPO_URL = "https://github.com/liviux/Start-up-tracker";
  const PAGE_SIZE = 5;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }

  // Bold and inline code are the only markup in changelog bullets. Everything
  // else is text and is escaped first.
  function renderInline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  // Reads the release sections of a Keep a Changelog file. Headings below a
  // release become groups (Added, Changed, Fixed...) with their bullet lines.
  function parseReleases(text) {
    const releases = [];
    let release = null;
    let group = null;
    for (const line of String(text || "").split(/\r?\n/)) {
      const heading = line.match(/^## \[(.+?)\](?:\s*-\s*(.+?))?\s*$/);
      if (heading) {
        release = { version: heading[1].trim(), date: String(heading[2] || "").trim(), groups: [] };
        releases.push(release);
        group = null;
        continue;
      }
      if (!release) continue;
      const groupHeading = line.match(/^###\s+(.+?)\s*$/);
      if (groupHeading) {
        group = { title: groupHeading[1].trim(), items: [] };
        release.groups.push(group);
        continue;
      }
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item && group) group.items.push(item[1]);
    }
    return releases.filter((entry) => entry.version && entry.groups.length);
  }

  function renderRelease(entry) {
    const date = entry.date ? `<small>${escapeHtml(entry.date)}</small>` : "";
    const groups = entry.groups.map((group) => `
      <h4>${escapeHtml(group.title)}</h4>
      ${group.items.map((item) => `<p class="release-bullet">${renderInline(item)}</p>`).join("")}
    `).join("");
    return `
      <section class="release-entry">
        <h3><span>v${escapeHtml(entry.version)}</span>${date}</h3>
        ${groups}
      </section>
    `;
  }

  function renderReleases(releases) {
    return `<div class="release-list">${releases.map(renderRelease).join("")}</div>`;
  }

  function mount() {
    const button = document.querySelector("#appVersionButton");
    const dialog = document.querySelector("#changelogDialog");
    const body = document.querySelector("#changelogBody");
    const closeButton = document.querySelector("#changelogClose");
    const moreButton = document.querySelector("#changelogMore");
    const moreRow = document.querySelector("#changelogMoreRow");
    if (!button || !dialog || !body || !closeButton || !moreButton || !moreRow) return;

    const t = (key) => (root.StartupTrackerI18n ? root.StartupTrackerI18n.t(key) : key);
    let releases = [];
    let shown = 0;

    function render() {
      const visible = releases.slice(0, shown);
      body.innerHTML = renderReleases(visible);
      moreRow.hidden = shown >= releases.length;
    }

    async function open() {
      if (root.StartupTrackerI18n?.ready?.then) await root.StartupTrackerI18n.ready;
      if (!dialog.open) dialog.showModal();
      body.innerHTML = `<p class="changelog-message" role="status">${escapeHtml(t("changelog.loading"))}</p>`;
      moreRow.hidden = true;
      try {
        const response = await fetch("/api/changelog", { cache: "no-store", headers: { Accept: "text/markdown" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        releases = parseReleases(await response.text());
        if (!releases.length) throw new Error("No releases");
        shown = Math.min(PAGE_SIZE, releases.length);
        render();
      } catch {
        body.innerHTML = `<p class="changelog-message" role="alert">${escapeHtml(t("changelog.failed"))}</p>`;
      }
      closeButton.focus();
    }

    button.addEventListener("click", open);
    closeButton.addEventListener("click", () => dialog.close());
    moreButton.addEventListener("click", () => {
      shown = Math.min(shown + PAGE_SIZE, releases.length);
      render();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  }

  return Object.freeze({ REPO_URL, parseReleases, renderReleases });
});
