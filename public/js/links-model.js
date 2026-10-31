// Links between any two records of one startup, kept in its "links"
// collection: { id, a: { kind, id }, b: { kind, id }, relation, note,
// context, resultLink, createdAt }. A link shows on both ends, each with its
// own name ("Uses" on one side, "Used in" on the other). The page, the server
// (lib/links.js) and the tests share this file.
//
// Links to a record in the recycle bin are kept and hidden, so they come back
// when the record is restored; deleting a record for good removes its links.
//
// UMD: browsers get window.StartupTrackerLinks, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerLinks = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Record kinds, with the section that holds them and its recycle bin.
  const KINDS = Object.freeze({
    mk: { section: "items", bin: "deletedItems" },
    po: { section: "programs", bin: "deletedPrograms" },
    fu: { section: "funding", bin: "deletedFunding" },
    comp: { section: "companySteps", bin: "deletedCompanySteps" },
    expense: { section: "companyExpenses", bin: "deletedCompanyExpenses" },
    media: { section: "mediaItems", bin: "deletedMediaItems" },
    feedback: { section: "feedbackItems", bin: "deletedFeedbackItems" },
    campaign: { section: "campaigns", bin: "deletedCampaigns" },
    research: { section: "dailyLinks", bin: "deletedDailyLinks" },
  });

  // Each relation and the name each end shows. "related" reads the same from
  // both sides.
  const RELATIONS = Object.freeze({
    related: { from: "Related", to: "Related" },
    uses: { from: "Uses", to: "Used in" },
    "feedback-about": { from: "Feedback about", to: "Feedback" },
    blocks: { from: "Blocks", to: "Blocked by" },
    "follow-up-of": { from: "Follow-up of", to: "Followed up by" },
    funds: { from: "Funds", to: "Funded by" },
  });

  const LINKS_SECTION = "links";

  class LinkError extends Error {
    constructor(message, code = "badLink") {
      super(message);
      this.name = "LinkError";
      this.code = code;
      this.statusCode = 400;
    }
  }

  function kindOfSection(section) {
    for (const [kind, entry] of Object.entries(KINDS)) {
      if (entry.section === section || entry.bin === section) return kind;
    }
    return null;
  }

  function cleanEnd(end, label) {
    if (!end || typeof end !== "object" || !KINDS[end.kind] || typeof end.id !== "string" || !end.id) {
      throw new LinkError(`${label} must name a record: { kind, id } with kind one of ${Object.keys(KINDS).join(", ")}.`);
    }
    return { kind: end.kind, id: end.id };
  }

  function text(value, max) {
    return String(value ?? "").trim().slice(0, max);
  }

  function validateLink(link) {
    if (!link || typeof link !== "object") throw new LinkError("A link must be an object.");
    if (typeof link.id !== "string" || !link.id) throw new LinkError("A link needs an id.");
    const a = cleanEnd(link.a, "a");
    const b = cleanEnd(link.b, "b");
    if (a.kind === b.kind && a.id === b.id) throw new LinkError("A record cannot be linked to itself.", "selfLink");
    const relation = link.relation || "related";
    if (!RELATIONS[relation]) throw new LinkError(`relation must be one of ${Object.keys(RELATIONS).join(", ")}.`, "badRelation");
    return {
      id: link.id,
      a,
      b,
      relation,
      note: text(link.note, 2000),
      context: text(link.context, 500),
      resultLink: text(link.resultLink, 2000),
      createdAt: link.createdAt || new Date().toISOString(),
    };
  }

  function sameEnd(end, kind, id) {
    return end?.kind === kind && end?.id === id;
  }

  // The same pair and relation always gets the same key; a "related" link
  // reads the same from both sides, so its ends are sorted.
  function linkKey(a, b, relation = "related") {
    let first = `${a.kind}:${a.id}`;
    let second = `${b.kind}:${b.id}`;
    if (relation === "related" && second < first) [first, second] = [second, first];
    return `${first}|${relation}|${second}`;
  }

  // A short, stable id for a key (FNV-1a), so the same pair and relation
  // always make the same link, whoever adds it.
  function linkIdFor(key) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `link-${hash.toString(36)}-${key.length.toString(36)}`;
  }

  function makeLink(a, b, relation = "related", extra = {}) {
    return validateLink({ id: linkIdFor(linkKey(a, b, relation)), a, b, relation, ...extra });
  }

  // The links of one record, each with the other end and the name this end
  // shows. `isVisible(end)` hides links whose other end is in the bin.
  function linksOf(links, kind, id, { isVisible = null } = {}) {
    const found = [];
    for (const link of links || []) {
      let entry = null;
      if (sameEnd(link.a, kind, id)) entry = { link, other: link.b, side: "a", label: RELATIONS[link.relation]?.from || link.relation };
      else if (sameEnd(link.b, kind, id)) entry = { link, other: link.a, side: "b", label: RELATIONS[link.relation]?.to || link.relation };
      if (entry && (!isVisible || isVisible(entry.other))) found.push(entry);
    }
    return found;
  }

  // The other ends of one record's links of a relation, from one side
  // ("a": this record is the first end).
  function othersOf(links, kind, id, relation, side) {
    return linksOf(links, kind, id)
      .filter((entry) => entry.link.relation === relation && (!side || entry.side === side))
      .map((entry) => entry.other);
  }

  // Replaces one record's links of a relation (from one side) with links to
  // `others`, keeping the ones that stay (with their notes). Returns the new
  // list of links.
  function setOthers(links, end, relation, side, others) {
    const wanted = new Map((others || []).map((other) => [`${other.kind}:${other.id}`, other]));
    const next = [];
    for (const link of links || []) {
      const mine = side === "b" ? link.b : link.a;
      const theirs = side === "b" ? link.a : link.b;
      const matches = link.relation === relation && sameEnd(mine, end.kind, end.id);
      const symmetric = relation === "related" && link.relation === relation && sameEnd(theirs, end.kind, end.id);
      if (!matches && !symmetric) {
        next.push(link);
        continue;
      }
      const other = matches ? theirs : mine;
      const key = `${other.kind}:${other.id}`;
      if (wanted.has(key)) {
        next.push(link);
        wanted.delete(key);
      }
    }
    for (const other of wanted.values()) {
      if (other.kind === end.kind && other.id === end.id) continue;
      next.push(side === "b" ? makeLink(other, end, relation) : makeLink(end, other, relation));
    }
    return next;
  }

  // Merges links, keeping the first of each id.
  function mergeLinks(...lists) {
    const out = new Map();
    for (const list of lists) for (const link of list || []) if (link?.id && !out.has(link.id)) out.set(link.id, link);
    return [...out.values()];
  }

  return {
    KINDS,
    RELATIONS,
    LINKS_SECTION,
    LinkError,
    kindOfSection,
    validateLink,
    linkKey,
    linkIdFor,
    makeLink,
    linksOf,
    othersOf,
    setOthers,
    mergeLinks,
  };
});
