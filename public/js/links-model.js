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

  // A short, stable id for a key (FNV-1a), so the same legacy field read on
  // two devices makes the same link.
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

  // Links from the fields records used before links existed. The fields
  // themselves are dropped from the records by the page once read.
  function fromLegacy(state) {
    const out = new Map();
    const add = (a, b, relation, extra = {}) => {
      if (!a.id || !b.id || (a.kind === b.kind && a.id === b.id)) return;
      try {
        const link = makeLink({ kind: a.kind, id: String(a.id) }, { kind: b.kind, id: String(b.id) }, relation, extra);
        const known = out.get(link.id);
        if (!known) out.set(link.id, link);
        else {
          // The same pair named in two old fields: keep what either one said.
          for (const field of ["note", "context", "resultLink"]) if (!known[field] && link[field]) known[field] = link[field];
        }
      } catch {
        // A field that does not name a record is left out.
      }
    };
    const list = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
    const records = (section) => [...(Array.isArray(state?.[KINDS[section].section]) ? state[KINDS[section].section] : []), ...(Array.isArray(state?.[KINDS[section].bin]) ? state[KINDS[section].bin] : [])];
    const splitIds = (value) => String(value || "").split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

    for (const item of records("mk")) {
      for (const id of list(item.linkedProgramIds)) add({ kind: "mk", id: item.id }, { kind: "po", id }, "related");
      for (const id of list(item.linkedFundingIds)) add({ kind: "mk", id: item.id }, { kind: "fu", id }, "related");
      for (const id of list(item.linkedMediaIds)) add({ kind: "mk", id: item.id }, { kind: "media", id }, "uses");
      // An even older extra parameter that held media ids.
      for (const id of splitIds(item.extraParams?.linkedMedia)) add({ kind: "mk", id: item.id }, { kind: "media", id }, "uses");
      for (const id of splitIds(item.extraParams?.blockedBy)) add({ kind: "mk", id }, { kind: "mk", id: item.id }, "blocks");
      for (const id of splitIds(item.extraParams?.blocks)) add({ kind: "mk", id: item.id }, { kind: "mk", id }, "blocks");
    }
    for (const program of records("po")) {
      for (const id of list(program.linkedTargetIds)) add({ kind: "mk", id }, { kind: "po", id: program.id }, "related");
      for (const id of list(program.linkedMediaIds)) add({ kind: "po", id: program.id }, { kind: "media", id }, "uses");
    }
    for (const funding of records("fu")) {
      for (const id of list(funding.linkedTargetIds)) add({ kind: "mk", id }, { kind: "fu", id: funding.id }, "related");
      for (const id of list(funding.linkedMediaIds)) add({ kind: "fu", id: funding.id }, { kind: "media", id }, "uses");
      if (funding.linkedProgramId) add({ kind: "fu", id: funding.id }, { kind: "po", id: funding.linkedProgramId }, "funds");
    }
    for (const media of records("media")) {
      for (const usage of Array.isArray(media.usedIn) ? media.usedIn : []) {
        if (usage?.targetId) add({ kind: "mk", id: usage.targetId }, { kind: "media", id: media.id }, "uses", { context: usage.context, resultLink: usage.resultLink, createdAt: usage.usedAt });
      }
    }
    for (const feedback of records("feedback")) {
      if (feedback.targetId) add({ kind: "feedback", id: feedback.id }, { kind: "mk", id: feedback.targetId }, "feedback-about");
    }
    return [...out.values()];
  }

  // The records that still carry one of those old fields, as { section, id },
  // so the page can save them once without it.
  const LEGACY_FIELDS = Object.freeze({
    mk: ["linkedProgramIds", "linkedFundingIds", "linkedMediaIds"],
    po: ["linkedTargetIds", "linkedMediaIds"],
    fu: ["linkedTargetIds", "linkedMediaIds", "linkedProgramId"],
    media: ["usedIn"],
    feedback: ["targetId"],
  });
  const LEGACY_EXTRA_PARAMS = Object.freeze(["linkedMedia", "blockedBy", "blocks"]);

  function legacyRecords(state) {
    const found = [];
    for (const [kind, fields] of Object.entries(LEGACY_FIELDS)) {
      for (const section of [KINDS[kind].section, KINDS[kind].bin]) {
        for (const record of Array.isArray(state?.[section]) ? state[section] : []) {
          const hasField = fields.some((field) => record && Object.prototype.hasOwnProperty.call(record, field));
          const hasParam = kind === "mk" && LEGACY_EXTRA_PARAMS.some((param) => record?.extraParams && Object.prototype.hasOwnProperty.call(record.extraParams, param));
          if ((hasField || hasParam) && record.id) found.push({ section, id: String(record.id) });
        }
      }
    }
    return found;
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
    fromLegacy,
    legacyRecords,
    mergeLinks,
  };
});
