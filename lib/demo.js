"use strict";

// The fictional demo startup, "Northwind Robotics": everything is made up and
// every link points at example.com. tools/demo-data.js writes it into a data
// folder; the setup's "Add a demo startup to explore" adds it to the running
// tracker (addDemoStartup), and one click removes it again (removeDemoStartup).
//
// The demo startup's id is kept in the database's tool metadata, so it is
// found again even after a rename.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { createStartup, listStartups } = require("./startups");

const DEMO_KEY = "demo-startup";
const DEMO_CAMPAIGN_PREFIX = "demo-campaign-";

const DEMO_STARTUP_NAME = "Northwind Robotics";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(offsetDays, now = new Date()) {
  return new Date(now.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function link(slug) {
  return `https://example.com/${slug}`;
}

// A target's category list from its picks: each pick followed by its
// ancestors (library ids name their parent: "mk.content.blog" is under
// "mk.content"), plus the older single-value fields the page mirrors.
function taxonomyFields(picks) {
  const taxonomy = [];
  for (const pick of picks) {
    const parts = pick.split(".");
    for (let length = parts.length; length >= 2; length -= 1) {
      const id = parts.slice(0, length).join(".");
      if (!taxonomy.includes(id)) taxonomy.push(id);
    }
  }
  const primary = picks[0].split(".");
  const subcategories = [...new Set(picks.map((pick) => pick.split(".").slice(0, 3).join(".")).filter((id) => id.split(".").length === 3))];
  return {
    taxonomy,
    category: primary.slice(0, 2).join("."),
    subcategory: subcategories[0] || "",
    subcategories,
    type: primary.length === 4 ? primary.join(".") : "",
  };
}

// Campaigns are shared by every startup, so they go to the global scope
// (added next to any you have, never replacing them).
function buildDemoShared({ now = new Date() } = {}) {
  const stamp = now.toISOString();
  const d = (offset) => isoDate(offset, now);
  const meta = (id) => ({ id, createdAt: stamp, updatedAt: stamp });
  return {
    campaigns: [
      { ...meta("demo-campaign-launch"), name: "Spring launch", description: "Public launch of the warehouse picking arm.", goal: "First 50 pilot sign-ups", status: "active", startDate: d(-10), endDate: d(40), tags: ["high-impact"] },
      { ...meta("demo-campaign-funding"), name: "Seed round", description: "Raise the seed round for production tooling.", goal: "Close the round", status: "planned", startDate: d(20), endDate: d(120), tags: [] },
      { ...meta("demo-campaign-community"), name: "Maker community", description: "Regular presence in robotics communities.", goal: "Steady inbound interest", status: "active", startDate: d(-60), endDate: "", tags: ["online"] },
    ],
  };
}

function buildDemoState({ size = "normal", now = new Date() } = {}) {
  const stamp = now.toISOString();
  const d = (offset) => isoDate(offset, now);
  const meta = (id) => ({ id, createdAt: stamp, updatedAt: stamp });

  // Category picks per target, primary first; the ancestors are added the way
  // the page adds them (a type implies its subcategory and category).
  const mk = [
    [["mk.launches.launch-platforms.launch-day"], "Launch day on a product launch site", "scheduled", 5, "demo-campaign-launch"],
    [["mk.communities.interest-communities"], "Show-and-tell post on a maker forum", "scheduled", 7, "demo-campaign-launch"],
    [["mk.launches.directories"], "Robotics product directory listing", "published", -12, "demo-campaign-launch"],
    [["mk.launches.review-sites"], "Comparison page on a review site", "scheduled", 14, ""],
    [["mk.communities.forums"], "Answer questions in a warehouse operations forum", "scheduled", 2, "demo-campaign-community"],
    [["mk.content.blog", "mk.communities.forums"], "Write-up of the gripper design", "published", -30, "demo-campaign-community"],
    [["mk.communities.chat-communities"], "Introduce the team in a robotics chat server", "scheduled", 1, "demo-campaign-community"],
    [["mk.content.blog"], "Article: picking errors and how to measure them", "scheduled", 10, ""],
    [["mk.content.podcast-video.video-tutorial"], "Two-minute demo video of the arm", "published", -5, "demo-campaign-launch"],
    [["mk.social.professional-networks"], "Post about the first pilot customer", "scheduled", 3, "demo-campaign-launch"],
    [["mk.social.microblogging"], "Build update thread", "rejected", -20, ""],
    [["mk.pr.curators"], "Pitch to a logistics newsletter", "scheduled", 9, "demo-campaign-launch"],
    [["mk.pr.podcast-guest.guest-pitch"], "Guest pitch for a manufacturing podcast", "scheduled", 21, ""],
    [["mk.brand.mentions"], "Mention in a regional business paper", "published", -2, ""],
  ].map(([picks, platform, status, offset, campaignId], index) => ({
    ...meta(`demo-mk-${index + 1}`),
    ...taxonomyFields(picks),
    platform,
    link: link(`mk/${index + 1}`),
    status,
    date: d(offset),
    time: "10:00",
    priority: ["High", "Medium", "Low"][index % 3],
    campaignId,
    notes: `Fictional demo target for Northwind Robotics.\n\nNext step: check the posting rules first.`,
    tags: index % 4 === 0 ? ["quick-win"] : [],
  }));

  const po = [
    ["po.grants.government", "City innovation grant", "researching", 18],
    ["po.grants.vouchers", "Regional manufacturing voucher", "preparing", 25],
    ["po.support.accelerators", "Hardware accelerator, autumn cohort", "submitted", 6],
    ["po.support.incubators", "University incubator", "new", 40],
    ["po.perks.cloud", "Cloud credits for startups", "won", -15],
    ["po.perks.workspace", "Prototyping lab access", "scheduled", 12],
    ["po.market.retail", "Retailer pilot program", "interview_pitch", 4],
    ["po.visibility.exhibitions", "Trade fair startup area", "later", 50],
    ["po.partners.technology", "Robot arm maker partner program", "new", 30],
    ["po.visibility.awards", "Logistics innovation award", "preparing", 16],
    ["po.visibility.demo-pitch", "Demo night for hardware startups", "rejected", -8],
    ["po.legal.ip", "Patent pre-diagnosis service", "new", 60],
  ].map(([pick, name, status, offset], index) => ({
    ...meta(`demo-po-${index + 1}`),
    name,
    ...taxonomyFields([pick]),
    applicationName: "Main application",
    applicationLink: link(`po/${index + 1}`),
    status,
    priority: ["High", "Medium", "Low"][index % 3],
    recordKind: "opportunity",
    campaignId: "",
    nextActionDate: d(offset),
    nextActionTime: "09:30",
    notes: "Fictional demo opportunity. Check the official rules before applying.",
    tags: [],
    details: {},
  }));

  const fundingRounds = [
    { ...meta("demo-round-preseed"), name: "Pre-seed", targetAmount: 250000, minimumAmount: 100000, currency: "EUR", status: "active", targetCloseDate: d(90), notes: "" },
    { ...meta("demo-round-seed"), name: "Seed", targetAmount: 1500000, minimumAmount: 800000, currency: "EUR", status: "planned", targetCloseDate: d(240), notes: "" },
  ];

  const fu = [
    ["fu.founders.founder-capital", "Founders' own savings", "won", "demo-round-preseed", 0],
    ["fu.angels.groups", "Angel group for industrial tech", "in_contact", "demo-round-preseed", 8],
    ["fu.vc.seed", "Seed fund focused on automation", "new", "demo-round-seed", 35],
    ["fu.hybrid.convertible", "Convertible note from an operator angel", "negotiating", "demo-round-preseed", 3],
    ["fu.grants.prizes", "Innovation prize money", "submitted", "", 22],
    ["fu.debt.trade-asset", "Equipment leasing offer", "in_contact", "", 15],
    ["fu.revenue.pre-sales", "Paid pilot with a regional warehouse", "negotiating", "", 5],
    ["fu.crowd.rewards", "Pre-order campaign", "new", "", 70],
  ].map(([pick, funder, status, roundId, offset], index) => ({
    ...meta(`demo-fu-${index + 1}`),
    funder,
    funderLink: link(`fu/${index + 1}`),
    opportunity: funder,
    ...taxonomyFields([pick]),
    status,
    roundId,
    campaignId: roundId ? "demo-campaign-funding" : "",
    priority: ["High", "Medium", "Low"][index % 3],
    nextAction: "Send the one-pager",
    nextActionDate: d(offset),
    nextActionTime: "11:00",
    askAmount: [0, 50000, 300000, 75000, 20000, 40000, 30000, 25000][index],
    askCurrency: "EUR",
    notes: "Fictional demo funding source.",
    commitments: [],
    payments: [],
    tags: [],
  }));

  const feedbackItems = [
    { ...meta("demo-fb-1"), type: "feedback", status: "new", title: "Pilot site wants faster gripper swaps", description: "Shift lead at a fictional pilot site.", source: "interview", link: link("fb/1"), tags: [] },
    { ...meta("demo-fb-2"), type: "feature-request", status: "reviewing", title: "Export pick logs as CSV", description: "Asked for by two pilot sites.", source: "email", link: "", tags: [] },
    { ...meta("demo-fb-3"), type: "proof", status: "acted", title: "Error rate halved in week two", description: "From the pilot site's own report (fictional).", source: "other", link: "", tags: [] },
  ];

  const dailyLinks = [
    { ...meta("demo-link-1"), subcategory: "forums", title: "Warehouse operations forum", url: link("community"), description: "Daily check for questions we can answer.", active: true, priority: "High", lastOpenedAt: "" },
    { ...meta("demo-link-2"), subcategory: "newsletters", title: "Robotics news", url: link("news"), description: "", active: true, priority: "Medium", lastOpenedAt: "" },
    { ...meta("demo-link-3"), subcategory: "other", title: "Grant calendar", url: link("grants"), description: "Weekly look at new calls.", active: true, priority: "Medium", lastOpenedAt: "" },
  ];

  const mediaItems = [
    { ...meta("demo-media-1"), title: "Demo video", type: "video", sourceType: "url", externalPath: link("media/demo.mp4"), tags: [] },
    { ...meta("demo-media-2"), title: "Product one-pager", type: "document", sourceType: "url", externalPath: link("media/one-pager.pdf"), tags: [] },
  ];

  const state = {
    name: "Startup Tracker",
    version: 3,
    updatedAt: stamp,
    demo: { name: "Northwind Robotics", note: "Fictional demo data" },
    items: mk,
    deletedItems: [],
    programs: po,
    deletedPrograms: [],
    funding: fu,
    deletedFunding: [],
    fundingRounds,
    feedbackItems,
    dailyLinks,
    mediaItems,
    // Expenses and the monthly budget are in the startup's currency.
    profile: { currency: "EUR" },
    // The Company tab, on the Generic template so nothing looks like a real
    // registration (js/company-model.js).
    companyProfile: {
      templateId: "generic",
      legalForm: "Private limited company",
      countryName: "Example country",
      incorporated: true,
      incorporationDate: d(-200),
      fiscalYearEnd: "12-31",
      conditions: [],
      fields: { legalName: "Northwind Robotics Ltd", registeredOffice: "1 Example Street, Example City" },
      people: [
        { id: "demo-person-1", role: "director", name: "Alex Example", ownershipPercent: 60, appointedOn: d(-200) },
        { id: "demo-person-2", role: "shareholder", name: "Sam Example", ownershipPercent: 40, appointedOn: d(-200) },
      ],
      monthlyBudget: 1500,
      documentLanguage: "",
    },
    companySteps: [
      { ...meta("demo-company-step-1"), title: "Register the company", description: "File the registration with the company register.", authority: "Company register", status: "completed", dueDate: d(-210), doneOn: d(-200), notes: "" },
      { ...meta("demo-company-step-2"), title: "Open the business bank account", description: "", authority: "Bank", status: "completed", dueDate: d(-190), doneOn: d(-185), notes: "" },
      { ...meta("demo-company-step-3"), title: "Register for VAT", description: "Needed before invoicing the first pilot customer.", authority: "Tax office", status: "preparing", dueDate: d(12), doneOn: "", notes: "" },
    ],
    companyObligations: [
      { ...meta("demo-company-obligation-1"), title: "Annual accounts", description: "File the accounts with the company register.", authority: "Company register", frequency: "annual", due: { rule: "relative-to-fiscal-year-end", months: 6, day: "last" }, notes: "" },
      { ...meta("demo-company-obligation-2"), title: "Monthly bookkeeping", description: "Send receipts to the accountant.", authority: "Accountant", frequency: "monthly", due: { rule: "fixed-date", day: 10 }, notes: "" },
    ],
    companyDeadlines: [],
    companyExpenses: [
      { ...meta("demo-company-expense-1"), title: "Accounting service", date: d(-120), amount: 250, currency: "EUR", category: "accounting", recurring: "monthly", paid: true, notes: "" },
      { ...meta("demo-company-expense-2"), title: "Registration fee", date: d(-200), amount: 180, currency: "EUR", category: "government-fees", recurring: "", paid: true, notes: "" },
    ],
    deletedCompanySteps: [],
    deletedCompanyObligations: [],
    deletedCompanyExpenses: [],
  };

  if (size === "large") {
    for (let i = 0; i < 600; i += 1) {
      state.items.push({ ...mk[i % mk.length], ...meta(`demo-mk-large-${i}`), platform: `Generated marketing target ${i + 1}`, date: d((i % 120) - 30), link: link(`mk/large/${i}`) });
    }
    for (let i = 0; i < 300; i += 1) {
      state.programs.push({ ...po[i % po.length], ...meta(`demo-po-large-${i}`), name: `Generated program ${i + 1}`, nextActionDate: d((i % 150) - 20), applicationLink: link(`po/large/${i}`) });
    }
    for (let i = 0; i < 150; i += 1) {
      state.funding.push({ ...fu[i % fu.length], ...meta(`demo-fu-large-${i}`), funder: `Generated funder ${i + 1}`, nextActionDate: d((i % 200) - 10), funderLink: link(`fu/large/${i}`) });
    }
  }
  return state;
}

function countRecords(state) {
  return ["items", "programs", "funding", "fundingRounds", "campaigns", "feedbackItems", "dailyLinks", "mediaItems"]
    .reduce((sum, key) => sum + (Array.isArray(state[key]) ? state[key].length : 0), 0);
}


// The demo startup in this database, or null.
function findDemoStartup(store) {
  const id = store.readToolMetadata(DEMO_KEY);
  if (!id) return null;
  return listStartups(store).find((startup) => startup.id === id) || null;
}

// Adds the demo startup and its shared campaigns. Refuses a second one.
function addDemoStartup(store, { now = new Date(), origin = "ui" } = {}) {
  if (findDemoStartup(store)) throw Object.assign(new Error("The demo startup is already here."), { statusCode: 409, code: "demoExists" });
  const startup = createStartup(store, { name: DEMO_STARTUP_NAME }, { origin });
  store.replaceState(startup.id, buildDemoState({ now }), { origin, label: "Demo data" });
  const shared = buildDemoShared({ now });
  store.applyOperations(GLOBAL_STARTUP_ID, shared.campaigns.map((campaign) => ({ type: "upsert", section: "campaigns", id: campaign.id, value: campaign })), { origin, label: "Demo campaigns" });
  store.writeToolMetadata(DEMO_KEY, startup.id);
  return startup;
}

// Removes the demo's shared campaigns and forgets the demo startup. The
// caller deletes the startup itself (with its safety backup).
function forgetDemo(store, { origin = "ui" } = {}) {
  const campaigns = store.readSection(GLOBAL_STARTUP_ID, "campaigns");
  const operations = (Array.isArray(campaigns) ? campaigns : [])
    .filter((campaign) => String(campaign.id).startsWith(DEMO_CAMPAIGN_PREFIX))
    .map((campaign) => ({ type: "delete", section: "campaigns", id: String(campaign.id) }));
  if (operations.length) store.applyOperations(GLOBAL_STARTUP_ID, operations, { origin, label: "Demo campaigns removed" });
  store.writeToolMetadata(DEMO_KEY, "");
  return operations.length;
}

module.exports = { DEMO_STARTUP_NAME, DEMO_CAMPAIGN_PREFIX, buildDemoState, buildDemoShared, countRecords, findDemoStartup, addDemoStartup, forgetDemo };
