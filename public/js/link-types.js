// Link types for the startup profile (plan appendix A7): where a link points,
// the icon it shows, and the addresses that identify it when a link is pasted.
//
// Icons are symbols of the sprite in index.html: brand logos from Tabler's
// filled set where it has them, otherwise from Simple Icons (see
// THIRD_PARTY_NOTICES.md). Types with no brand, and Slack, which neither set
// carries, use a generic symbol.
//
// UMD: browsers get window.StartupTrackerLinkTypes, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerLinkTypes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // hosts: a host or any subdomain of it. paths: the path must start with one.
  const GROUPS = Object.freeze([
    { id: "own", types: [
      { id: "website", icon: "globe" },
      { id: "blog", icon: "file" },
      { id: "docs", icon: "file" },
      { id: "newsletter", icon: "file" },
      { id: "careers", icon: "globe" },
      { id: "pressKit", icon: "folder" },
      { id: "pitchDeck", icon: "file" },
      { id: "statusPage", icon: "globe" },
    ] },
    { id: "contact", types: [
      { id: "email", icon: "link", schemes: ["mailto:"] },
      { id: "phone", icon: "link", schemes: ["tel:"] },
      { id: "booking", icon: "link", hosts: ["calendly.com", "cal.com", "savvycal.com", "tidycal.com"] },
    ] },
    { id: "code", types: [
      { id: "github", icon: "github", hosts: ["github.com"] },
      { id: "gitlab", icon: "brand-gitlab", hosts: ["gitlab.com"] },
      { id: "bitbucket", icon: "brand-bitbucket", hosts: ["bitbucket.org"] },
    ] },
    { id: "professional", types: [
      { id: "linkedinCompany", icon: "linkedin", hosts: ["linkedin.com"], paths: ["/company/", "/showcase/", "/school/"] },
      { id: "linkedinPerson", icon: "linkedin", hosts: ["linkedin.com"], paths: ["/in/"] },
      { id: "crunchbase", icon: "brand-crunchbase", hosts: ["crunchbase.com"] },
      { id: "wellfound", icon: "brand-wellfound", hosts: ["wellfound.com"] },
    ] },
    { id: "social", types: [
      { id: "x", icon: "x", hosts: ["x.com", "twitter.com"] },
      { id: "facebook", icon: "facebook", hosts: ["facebook.com", "fb.com"] },
      { id: "instagram", icon: "brand-instagram", hosts: ["instagram.com"] },
      { id: "threads", icon: "brand-threads", hosts: ["threads.net", "threads.com"] },
      { id: "bluesky", icon: "brand-bluesky", hosts: ["bsky.app"] },
      { id: "mastodon", icon: "brand-mastodon", mastodon: true },
      { id: "pinterest", icon: "brand-pinterest", hosts: ["pinterest.com"] },
    ] },
    { id: "video", types: [
      { id: "youtube", icon: "youtube", hosts: ["youtube.com", "youtu.be"] },
      { id: "tiktok", icon: "brand-tiktok", hosts: ["tiktok.com"] },
      { id: "twitch", icon: "brand-twitch", hosts: ["twitch.tv"] },
      { id: "podcast", icon: "link" },
    ] },
    { id: "communities", types: [
      { id: "reddit", icon: "reddit", hosts: ["reddit.com", "redd.it"] },
      { id: "discord", icon: "brand-discord", hosts: ["discord.gg", "discord.com"] },
      { id: "slack", icon: "link", hosts: ["slack.com"] },
      { id: "telegram", icon: "brand-telegram", hosts: ["t.me", "telegram.me"] },
      { id: "whatsapp", icon: "brand-whatsapp", hosts: ["wa.me", "whatsapp.com"] },
    ] },
    { id: "launch", types: [
      { id: "productHunt", icon: "brand-product-hunt", hosts: ["producthunt.com"] },
      { id: "hackerNews", icon: "brand-hacker-news", hosts: ["news.ycombinator.com"] },
      { id: "indieHackers", icon: "brand-indie-hackers", hosts: ["indiehackers.com"] },
    ] },
    { id: "writing", types: [
      { id: "medium", icon: "brand-medium", hosts: ["medium.com"] },
      { id: "substack", icon: "brand-substack", hosts: ["substack.com"] },
      { id: "dev", icon: "brand-dev", hosts: ["dev.to"] },
      { id: "hashnode", icon: "brand-hashnode", hosts: ["hashnode.com", "hashnode.dev"] },
    ] },
    { id: "design", types: [
      { id: "dribbble", icon: "brand-dribbble", hosts: ["dribbble.com"] },
      { id: "behance", icon: "brand-behance", hosts: ["behance.net"] },
    ] },
    { id: "stores", types: [
      { id: "appStore", icon: "brand-app-store", hosts: ["apps.apple.com"] },
      { id: "googlePlay", icon: "brand-google-play", hosts: ["play.google.com"] },
      { id: "chromeWebStore", icon: "brand-chrome-web-store", hosts: ["chromewebstore.google.com", "chrome.google.com"], chromePath: true },
    ] },
    { id: "other", types: [
      { id: "other", icon: "link" },
    ] },
  ].map((group) => Object.freeze({ ...group, types: Object.freeze(group.types.map((type) => Object.freeze({ ...type, group: group.id }))) })));

  const TYPES = Object.freeze(GROUPS.flatMap((group) => group.types));
  const BY_ID = new Map(TYPES.map((type) => [type.id, type]));

  function typeById(id) {
    return BY_ID.get(id) || BY_ID.get("other");
  }

  function parseUrl(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
  }

  function hostMatches(host, candidate) {
    return host === candidate || host.endsWith(`.${candidate}`);
  }

  // The type a pasted address points to, or "" when nothing matches (the
  // caller then keeps what the person picked, or "website" for a first link).
  function detectLinkType(value) {
    const url = parseUrl(value);
    if (!url) return "";
    const scheme = url.protocol.toLowerCase();
    for (const type of TYPES) {
      if (type.schemes?.includes(scheme)) return type.id;
    }
    if (scheme !== "http:" && scheme !== "https:") return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.toLowerCase();
    for (const type of TYPES) {
      if (!type.hosts?.some((candidate) => hostMatches(host, candidate))) continue;
      if (type.paths && !type.paths.some((prefix) => pathname.startsWith(prefix))) continue;
      if (type.chromePath && host === "chrome.google.com" && !pathname.startsWith("/webstore")) continue;
      return type.id;
    }
    // Mastodon runs on many hosts; profiles look like https://host/@user.
    if (/^\/@[a-z0-9_]+\/?$/i.test(url.pathname)) return "mastodon";
    return "";
  }

  // An address safe to put in an href: http(s), mailto or tel. A bare
  // "example.com" gets https://.
  function safeHref(value) {
    const url = parseUrl(value);
    if (!url) return "";
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
  }

  let linkSequence = 0;
  function makeLinkId() {
    linkSequence += 1;
    return `link-${Date.now().toString(36)}-${linkSequence.toString(36)}`;
  }

  // Cleans the profile's link list: known types only, an id on each link,
  // empty rows dropped.
  function normalizeLinks(links) {
    return (Array.isArray(links) ? links : [])
      .map((link) => ({
        id: String(link?.id || "") || makeLinkId(),
        type: BY_ID.has(link?.type) ? link.type : "other",
        url: String(link?.url || "").trim(),
        label: String(link?.label || "").trim(),
      }))
      .filter((link) => link.url);
  }

  return Object.freeze({
    GROUPS,
    TYPES,
    typeById,
    detectLinkType,
    safeHref,
    makeLinkId,
    normalizeLinks,
  });
});
