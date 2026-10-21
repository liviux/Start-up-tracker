"use strict";

// Links between any two records of one startup. The model (kinds, relations,
// checks, both-ends lookup) is public/js/links-model.js, shared with the page;
// this file adds what only the server does: dropping the links of records
// deleted for good.

const Links = require("../public/js/links-model.js");

const { KINDS, RELATIONS, LINKS_SECTION, LinkError, kindOfSection, validateLink, linksOf } = Links;

// Removes the links of records that were deleted for good. `removed` lists
// { section, id } as the recycle bin reports them.
function removeLinksTo(store, startupId, removed, options = {}) {
  const links = store.readSection(startupId, LINKS_SECTION);
  if (!Array.isArray(links) || !links.length) return 0;
  const gone = new Set();
  for (const { section, id } of removed) {
    const kind = kindOfSection(section);
    if (kind) gone.add(`${kind}\0${id}`);
  }
  const operations = links
    .filter((link) => gone.has(`${link.a?.kind}\0${link.a?.id}`) || gone.has(`${link.b?.kind}\0${link.b?.id}`))
    .map((link) => ({ type: "delete", section: LINKS_SECTION, id: link.id }));
  if (operations.length) store.applyOperations(startupId, operations, { origin: "tool", label: "Links of records deleted for good", ...options });
  return operations.length;
}

module.exports = { ...Links, KINDS, RELATIONS, LINKS_SECTION, LinkError, kindOfSection, validateLink, linksOf, removeLinksTo };
