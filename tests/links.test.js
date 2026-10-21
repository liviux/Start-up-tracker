"use strict";

// Links between records: the shared model (public/js/links-model.js) and what
// the server adds (lib/links.js).
const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const Links = require("../lib/links");
const { purgeExpired } = require("../lib/recycle-bin");

const { validateLink, linksOf, removeLinksTo, kindOfSection, makeLink, setOthers, othersOf, fromLegacy, mergeLinks, linkKey, linkIdFor } = Links;

test("a link is checked and shows on both ends with each end's name", () => {
  const link = validateLink({ id: "l1", a: { kind: "po", id: "p1" }, b: { kind: "media", id: "m1" }, relation: "uses", context: "Pitch deck" });
  assert.equal(link.relation, "uses");
  assert.equal(link.context, "Pitch deck");
  assert.deepEqual(linksOf([link], "po", "p1").map((entry) => [entry.other.id, entry.label, entry.side]), [["m1", "Uses", "a"]]);
  assert.deepEqual(linksOf([link], "media", "m1").map((entry) => [entry.other.id, entry.label, entry.side]), [["p1", "Used in", "b"]]);
  assert.deepEqual(linksOf([link], "mk", "p1"), []);
  assert.equal(validateLink({ id: "l2", a: { kind: "mk", id: "a" }, b: { kind: "fu", id: "b" } }).relation, "related");
});

test("bad links are refused", () => {
  assert.throws(() => validateLink({ id: "x", a: { kind: "mk", id: "a" }, b: { kind: "mk", id: "a" } }), { code: "selfLink" });
  assert.throws(() => validateLink({ id: "x", a: { kind: "planet", id: "a" }, b: { kind: "mk", id: "b" } }), { code: "badLink" });
  assert.throws(() => validateLink({ id: "x", a: { kind: "mk", id: "a" }, b: { kind: "po", id: "b" }, relation: "loves" }), { code: "badRelation" });
  assert.throws(() => validateLink({ a: { kind: "mk", id: "a" }, b: { kind: "po", id: "b" } }), { code: "badLink" });
});

test("the same pair and relation always gets the same id; 'related' reads the same both ways", () => {
  const mk = { kind: "mk", id: "t1" };
  const po = { kind: "po", id: "p1" };
  assert.equal(linkKey(mk, po), linkKey(po, mk));
  assert.notEqual(linkKey(mk, po, "blocks"), linkKey(po, mk, "blocks"));
  assert.equal(makeLink(mk, po).id, makeLink(po, mk).id);
  assert.equal(linkIdFor("a|related|b"), linkIdFor("a|related|b"));
  assert.match(makeLink(mk, po).id, /^link-[0-9a-z]+-[0-9a-z]+$/);
});

test("setOthers replaces one record's links of a relation and keeps the rest with their notes", () => {
  const t1 = { kind: "mk", id: "t1" };
  const kept = makeLink(t1, { kind: "po", id: "p1" }, "related", { note: "keep me" });
  const dropped = makeLink({ kind: "fu", id: "f1" }, t1);
  const otherRelation = makeLink(t1, { kind: "mk", id: "t2" }, "blocks");
  const unrelated = makeLink({ kind: "mk", id: "t9" }, { kind: "po", id: "p9" });
  const next = setOthers([kept, dropped, otherRelation, unrelated], t1, "related", "a", [{ kind: "po", id: "p1" }, { kind: "po", id: "p2" }, t1]);
  assert.deepEqual(next.map((link) => link.id).sort(), [kept.id, otherRelation.id, unrelated.id, makeLink(t1, { kind: "po", id: "p2" }).id].sort());
  assert.equal(next.find((link) => link.id === kept.id).note, "keep me");
  assert.deepEqual(othersOf(next, "mk", "t1", "related").map((ref) => ref.id).sort(), ["p1", "p2"]);
  // From the other side: t2 is blocked by t1.
  assert.deepEqual(othersOf(next, "mk", "t2", "blocks", "b"), [t1]);
});

test("links to a record in the recycle bin are hidden and come back with it", () => {
  const links = [makeLink({ kind: "mk", id: "t1" }, { kind: "po", id: "p1" }), makeLink({ kind: "mk", id: "t1" }, { kind: "fu", id: "f1" })];
  let live = new Set(["mk:t1", "po:p1", "fu:f1"]);
  const visible = () => linksOf(links, "mk", "t1", { isVisible: (end) => live.has(`${end.kind}:${end.id}`) }).map((entry) => entry.other.id);
  assert.deepEqual(visible(), ["p1", "f1"]);
  live = new Set(["mk:t1", "fu:f1"]);
  assert.deepEqual(visible(), ["f1"]);
  live = new Set(["mk:t1", "po:p1", "fu:f1"]);
  assert.deepEqual(visible(), ["p1", "f1"]);
});

test("the fields records used before links become links, once each", () => {
  const state = {
    items: [{ id: "t1", linkedProgramIds: ["p1"], linkedFundingIds: ["f1"], linkedMediaIds: ["m1"], extraParams: { linkedMedia: "m2", blockedBy: "t2", blocks: "t3, t2" } }],
    deletedItems: [{ id: "t4", linkedProgramIds: ["p1"] }],
    programs: [{ id: "p1", linkedTargetIds: ["t1"], linkedMediaIds: ["m1"] }],
    funding: [{ id: "f1", linkedTargetIds: ["t1"], linkedProgramId: "p1" }],
    mediaItems: [{ id: "m1", usedIn: [{ targetId: "t1", context: "Launch post", resultLink: "https://example.com/post", usedAt: "2026-01-02T00:00:00.000Z" }] }],
    feedbackItems: [{ id: "fb1", targetId: "t1" }, { id: "fb2", targetId: "" }],
  };
  const links = fromLegacy(state);
  const has = (a, b, relation) => links.some((link) => link.relation === relation && link.a.kind === a.split(":")[0] && link.a.id === a.split(":")[1] && link.b.kind === b.split(":")[0] && link.b.id === b.split(":")[1]);
  assert.ok(has("mk:t1", "po:p1", "related") || has("po:p1", "mk:t1", "related"));
  assert.ok(has("mk:t4", "po:p1", "related") || has("po:p1", "mk:t4", "related"), "records in the bin keep their links");
  assert.ok(has("mk:t1", "media:m1", "uses"));
  assert.ok(has("mk:t1", "media:m2", "uses"));
  assert.ok(has("mk:t2", "mk:t1", "blocks"));
  assert.ok(has("mk:t1", "mk:t3", "blocks"));
  assert.ok(has("mk:t1", "mk:t2", "blocks"));
  assert.ok(has("po:p1", "media:m1", "uses"));
  assert.ok(has("fu:f1", "po:p1", "funds"));
  assert.ok(has("feedback:fb1", "mk:t1", "feedback-about"));
  // The program's and the target's own copy of the same pair make one link.
  assert.equal(links.filter((link) => link.relation === "related" && [link.a.id, link.b.id].sort().join() === "p1,t1").length, 1);
  const usage = links.find((link) => link.relation === "uses" && link.a.id === "t1" && link.b.id === "m1");
  assert.equal(usage.context, "Launch post");
  assert.equal(usage.resultLink, "https://example.com/post");
  // Read twice (two devices), the same links with the same ids.
  assert.deepEqual(fromLegacy(state).map((link) => link.id), links.map((link) => link.id));
  // Stored links win over the ones read again from old fields.
  const edited = { ...links[0], note: "edited" };
  assert.equal(mergeLinks([edited], links).find((link) => link.id === edited.id).note, "edited");
  assert.equal(mergeLinks([edited], links).length, links.length);
});

test("records deleted for good lose their links; others keep theirs", () => {
  const store = new TrackerSqliteStore(":memory:");
  store.replaceState("one-0001", {
    links: [
      { id: "l1", a: { kind: "mk", id: "gone" }, b: { kind: "po", id: "p" }, relation: "related" },
      { id: "l2", a: { kind: "mk", id: "kept" }, b: { kind: "media", id: "m" }, relation: "uses" },
    ],
  });
  assert.equal(kindOfSection("deletedItems"), "mk");
  assert.equal(kindOfSection("prompts"), null);
  assert.equal(removeLinksTo(store, "one-0001", [{ section: "deletedItems", id: "gone" }]), 1);
  assert.deepEqual(store.readSection("one-0001", "links").map((link) => link.id), ["l2"]);
});

test("the recycle bin purge drops the links of what it deletes, a shared campaign's in every startup", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const store = new TrackerSqliteStore(":memory:");
  store.replaceState("one-0001", {
    deletedItems: [{ id: "old", deletedAt: old }],
    items: [{ id: "live" }],
    links: [
      { id: "l1", a: { kind: "mk", id: "old" }, b: { kind: "po", id: "p" }, relation: "related" },
      { id: "l2", a: { kind: "mk", id: "live" }, b: { kind: "campaign", id: "c-old" }, relation: "related" },
      { id: "l3", a: { kind: "mk", id: "live" }, b: { kind: "po", id: "p" }, relation: "related" },
    ],
  }, { origin: "tool" });
  store.replaceState("two-0002", {
    links: [{ id: "l4", a: { kind: "feedback", id: "fb" }, b: { kind: "campaign", id: "c-old" }, relation: "feedback-about" }],
  }, { origin: "tool" });
  store.replaceState(GLOBAL_STARTUP_ID, { deletedCampaigns: [{ id: "c-old", deletedAt: old }] }, { origin: "tool" });
  purgeExpired(store, { now });
  assert.deepEqual(store.readSection("one-0001", "links").map((link) => link.id), ["l3"]);
  assert.deepEqual(store.readSection("two-0002", "links").map((link) => link.id), []);
});

test("records still carrying an old link field are listed, so the page saves them once without it", () => {
  const state = {
    items: [{ id: "t1", linkedProgramIds: [] }, { id: "t2", extraParams: { blockedBy: "" } }, { id: "t3", extraParams: { budget: "1" } }],
    deletedFeedbackItems: [{ id: "fb1", targetId: "t1" }],
    funding: [{ id: "f1", linkedProgramId: "p1", extraParams: { blockedBy: "Waiting for the bank" } }],
    mediaItems: [{ id: "m1", usedIn: [] }, { id: "m2" }],
  };
  assert.deepEqual(Links.legacyRecords(state), [
    { section: "items", id: "t1" },
    { section: "items", id: "t2" },
    { section: "funding", id: "f1" },
    { section: "mediaItems", id: "m1" },
    { section: "deletedFeedbackItems", id: "fb1" },
  ]);
  assert.deepEqual(Links.legacyRecords({}), []);
});
