"use strict";

// How far the setup in the browser got (js/setup-wizard.js), kept in the
// global "setupState" section so it continues where it stopped, in any tab.
//
//   step       the step shown last
//   startupId  the startup the setup works on (made at "Your startup")
//   skipped    steps passed over with Skip
//   open       true while the setup is on screen; it opens again on reload
//   completed  true once "Done" was reached; the sidebar badge goes away
//
// A database that already holds startups but no setup state (made by a tool,
// an import or a restore) counts as set up, so nobody is sent through it again.

const { GLOBAL_STARTUP_ID } = require("./tracker-sqlite-store");
const { listStartups } = require("./startups");

const SECTION = "setupState";
const STEPS = Object.freeze(["welcome", "basics", "startup", "links", "context", "track-mk", "track-po", "track-fu", "agents", "backups", "done"]);

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupError";
    this.code = "badSetup";
    this.statusCode = 400;
  }
}

function readSetup(store) {
  const stored = store.readSection(GLOBAL_STARTUP_ID, SECTION);
  const startups = listStartups(store).filter((startup) => !startup.archived);
  if (!stored || typeof stored !== "object") {
    const completed = startups.length > 0;
    return { step: "welcome", startupId: "", skipped: [], open: !completed, completed, needsSetup: !completed };
  }
  const state = {
    step: STEPS.includes(stored.step) ? stored.step : "welcome",
    startupId: typeof stored.startupId === "string" ? stored.startupId : "",
    skipped: Array.isArray(stored.skipped) ? stored.skipped.filter((step) => STEPS.includes(step)) : [],
    open: stored.open === true,
    completed: stored.completed === true,
    completedAt: typeof stored.completedAt === "string" ? stored.completedAt : "",
  };
  // Nothing to show without a startup: the setup starts again.
  if (!startups.length) Object.assign(state, { completed: false, open: true, startupId: "" });
  return { ...state, needsSetup: !state.completed };
}

function writeSetup(store, patch, { origin = "ui", now = new Date() } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SetupError("Send the setup state as an object.");
  const current = readSetup(store);
  const next = {
    step: current.step,
    startupId: current.startupId,
    skipped: current.skipped,
    open: current.open,
    completed: current.completed,
    completedAt: current.completedAt || "",
  };
  if (patch.step !== undefined) {
    if (!STEPS.includes(patch.step)) throw new SetupError(`step must be one of ${STEPS.join(", ")}.`);
    next.step = patch.step;
  }
  if (patch.startupId !== undefined) {
    const id = String(patch.startupId || "");
    if (id && !listStartups(store).some((startup) => startup.id === id)) throw new SetupError("No such startup.");
    next.startupId = id;
  }
  if (patch.skipped !== undefined) {
    if (!Array.isArray(patch.skipped)) throw new SetupError("skipped must be a list of steps.");
    next.skipped = [...new Set(patch.skipped.filter((step) => STEPS.includes(step)))];
  }
  if (patch.open !== undefined) next.open = Boolean(patch.open);
  if (patch.completed !== undefined) {
    next.completed = Boolean(patch.completed);
    next.completedAt = next.completed ? (current.completedAt || now.toISOString()) : "";
  }
  store.replaceSection(GLOBAL_STARTUP_ID, SECTION, next, { origin, label: "Setup" });
  return readSetup(store);
}

module.exports = { SECTION, STEPS, SetupError, readSetup, writeSetup };
