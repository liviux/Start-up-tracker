"use strict";

// Agents that take the effort only as a launch flag, not as an ACP config
// option. Cline: `--thinking <level>`; over ACP it ignores its saved settings
// and runs without thinking unless the flag is given
// (github.com/cline/cline apps/cli/src/commands/program.ts, src/main.ts).
// Every other agent the tracker knows sets its effort over ACP
// (lib/agents/acp-client.js).

const path = require("path");

const LAUNCH_EFFORT = Object.freeze({
  cline: Object.freeze({ flag: "--thinking", levels: Object.freeze(["none", "low", "medium", "high", "xhigh"]) }),
});

// The entry for a harness: by registry id, or by the program a custom
// command runs.
function launchEffort(harness) {
  const id = harness?.registryId || (harness?.kind === "custom" ? path.basename(String(harness.command || "")).replace(/\.(exe|cmd)$/i, "") : "");
  return Object.prototype.hasOwnProperty.call(LAUNCH_EFFORT, id) ? LAUNCH_EFFORT[id] : null;
}

// The levels to offer, the same for every model of the agent.
function launchEffortLevels(harness) {
  const entry = launchEffort(harness);
  return entry ? entry.levels.map((value) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })) : [];
}

// The harness to launch for `level`: its arguments with the flag set, and an
// earlier copy of the flag (typed into Arguments) taken out.
function withLaunchEffort(harness, level) {
  const entry = launchEffort(harness);
  if (!entry || !entry.levels.includes(level)) return harness;
  const args = [];
  const given = Array.isArray(harness.args) ? harness.args : [];
  for (let index = 0; index < given.length; index += 1) {
    const arg = String(given[index]);
    if (arg.startsWith(`${entry.flag}=`)) continue;
    if (arg === entry.flag) {
      if (given[index + 1] !== undefined && !String(given[index + 1]).startsWith("-")) index += 1;
      continue;
    }
    args.push(arg);
  }
  return { ...harness, args: [...args, entry.flag, level] };
}

module.exports = { LAUNCH_EFFORT, launchEffort, launchEffortLevels, withLaunchEffort };
