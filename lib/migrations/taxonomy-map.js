"use strict";

// Where the older category ids land in the category library, for an import
// of data from before the library (appendix A4.4 of the plan). The page keeps
// an unmapped id as it is and marks it "not in the library"; nothing here runs
// on its own. Where the old category split, the first id is the usual home.

const MK = {
  launches: ["mk.launches.launch-platforms"],
  directories: ["mk.launches.directories", "mk.launches.review-sites"],
  communities: ["mk.communities.forums", "mk.communities.interest-communities"],
  chat: ["mk.communities.chat-communities"],
  content: ["mk.content"],
  social: ["mk.social"],
  ops: ["mk.brand"],
  outreach: ["mk.pr", "mk.outreach"],
  mentions: ["mk.brand.mentions"],
};

const PO = {
  "public-funding": ["po.grants"],
  "startup-programs": ["po.support"],
  "oss-support": ["po.partners.open-source"],
  "credits-in-kind": ["po.perks"],
  "market-access": ["po.market"],
  "partnerships-ecosystem": ["po.partners"],
  "visibility-recognition": ["po.visibility"],
  "ai-developer-platforms": ["po.partners.platforms"],
  "standards-ip-foundations": ["po.legal", "po.partners.open-source"],
};

const FU = {
  "founder-network": ["fu.founders"],
  "equity-investment": ["fu.angels", "fu.vc"],
  "convertible-hybrid": ["fu.hybrid"],
  "sponsorship-donations": ["fu.crowd.donations"],
  "customer-funded": ["fu.revenue"],
  "non-dilutive-awards": ["fu.grants"],
  "debt-financing": ["fu.debt"],
  "oss-sustainability": ["fu.grants.private", "fu.crowd.donations"],
  "community-platform-fundraising": ["fu.crowd"],
};

const MAPS = { mk: MK, po: PO, fu: FU };

// The library ids for an older category id, or [] when it has none.
function mapCategory(section, oldId) {
  const map = MAPS[section];
  if (!map) throw new RangeError(`Unknown section for category mapping: ${section}`);
  return Object.prototype.hasOwnProperty.call(map, oldId) ? [...map[oldId]] : [];
}

module.exports = { MAPS, mapCategory };
