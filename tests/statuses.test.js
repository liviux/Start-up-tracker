"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TrackerSqliteStore, GLOBAL_STARTUP_ID } = require("../lib/tracker-sqlite-store");
const statuses = require("../lib/statuses");

function setup() {
  const store = new TrackerSqliteStore(":memory:");
  statuses.seedStatuses(store);
  return store;
}

function withCustom(store, custom = { id: "waiting_list", group: "in_progress", label: "Waiting list", description: "" }) {
  const current = statuses.readStatuses(store);
  return statuses.writeStatuses(store, { ...current, statuses: [...current.statuses, custom] });
}

test("the built-in list is seeded into the global scope once", () => {
  const store = setup();
  const seeded = store.readSection(GLOBAL_STARTUP_ID, "statuses");
  assert.equal(seeded.statuses.length, 22);
  assert.deepEqual(seeded.groups.map((group) => group.id), ["planned", "in_progress", "done", "closed"]);
  assert.equal(seeded.defaultStatus, "new");
  assert.equal(statuses.seedStatuses(store), false, "a second start does not seed again");
});

test("labels, descriptions and order can change; built-in ids and groups cannot", () => {
  const store = setup();
  const current = statuses.readStatuses(store);
  const renamed = current.statuses.map((status) => (status.id === "new" ? { ...status, label: "Fresh" } : status)).reverse();
  statuses.writeStatuses(store, { ...current, statuses: renamed });
  const saved = statuses.readStatuses(store);
  assert.equal(saved.statuses.find((status) => status.id === "new").label, "Fresh");
  assert.equal(saved.statuses[0].id, "no_response", "order follows the list");

  const moved = current.statuses.map((status) => (status.id === "won" ? { ...status, group: "done" } : status));
  assert.throws(() => statuses.writeStatuses(store, { ...current, statuses: moved }), { code: "builtInGroup" });
  assert.throws(() => statuses.writeStatuses(store, { ...current, statuses: current.statuses.filter((status) => status.id !== "won") }), { code: "builtInRemoved" });
  assert.throws(() => statuses.writeStatuses(store, { ...current, groups: current.groups.slice(1) }), { code: "fixedGroups" });
  assert.throws(() => statuses.writeStatuses(store, { ...current, statuses: [...current.statuses, { ...current.statuses[0] }] }), { code: "duplicateId" });
});

test("a custom subtype is added to a group and deleted after its records move, in every startup", () => {
  const store = setup();
  withCustom(store);
  store.replaceState("one-0001", { items: [{ id: "a", status: "waiting_list" }, { id: "b", status: "new" }], deletedPrograms: [{ id: "p", status: "waiting_list" }] });
  store.replaceState("two-0002", { funding: [{ id: "f", status: "waiting_list" }] });
  assert.equal(statuses.readStatuses(store).statuses.find((status) => status.id === "waiting_list").custom, true);

  assert.throws(() => statuses.deleteStatus(store, "waiting_list", "nope"), { code: "badMoveTo" });
  assert.throws(() => statuses.deleteStatus(store, "new", "researching"), { code: "builtIn" });
  const result = statuses.deleteStatus(store, "waiting_list", "on_hold");
  assert.equal(result.moved, 3);
  assert.equal(store.readSection("one-0001", "items")[0].status, "on_hold");
  assert.equal(store.readSection("one-0001", "items")[1].status, "new");
  assert.equal(store.readSection("one-0001", "deletedPrograms")[0].status, "on_hold");
  assert.equal(store.readSection("two-0002", "funding")[0].status, "on_hold");
  assert.equal(statuses.readStatuses(store).statuses.some((status) => status.id === "waiting_list"), false);
  assert.equal(store.readRecordHistory("two-0002", "funding", "f").entries[0].label, "Status Waiting list deleted; its records moved to On hold");
});

test("campaign statuses can all change, and leave only after their campaigns move", () => {
  const store = setup();
  store.replaceState("one-0001", { campaigns: [{ id: "c", status: "paused" }] });
  const result = statuses.deleteCampaignStatus(store, "paused", "active");
  assert.equal(result.moved, 1);
  assert.equal(store.readSection("one-0001", "campaigns")[0].status, "active");
  assert.deepEqual(statuses.readStatuses(store).campaignStatuses.map((status) => status.id), ["planned", "active", "done", "archived"]);
});

test("the shipped content file is a valid configuration", () => {
  assert.doesNotThrow(() => statuses.validateStatusConfig(statuses.builtIn()));
});
