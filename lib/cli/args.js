"use strict";

// Command-line parsing for bin/startup-tracker.js. Every command declares its
// flags; an unknown command or flag is an error with exit code 2, so a typo
// never runs something else.

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

// "value" flags take an argument (--port 4000 or --port=4000); "boolean"
// flags take none. Aliases map short names to long ones.
const GLOBAL_FLAGS = { "data-dir": "value", dev: "boolean", help: "boolean" };
const START_FLAGS = { port: "value", "no-open": "boolean", foreground: "boolean", "save-port": "boolean" };

const COMMANDS = {
  "": { flags: { ...START_FLAGS }, summary: "Start the tracker if it is not running and open it in the browser." },
  start: { flags: { ...START_FLAGS }, summary: "Start the tracker in the background (logs in logs/server.log) and open it, unless --no-open." },
  stop: { flags: { force: "boolean" }, summary: "Stop the running tracker." },
  status: { flags: { json: "boolean" }, summary: "Say whether the tracker runs, on which address, and for which data folder." },
  open: { flags: {}, summary: "Open the running tracker in the browser." },
  logs: { flags: { follow: "boolean", lines: "value" }, aliases: { f: "follow", n: "lines" }, summary: "Print the server log; -f keeps following it." },
  backup: { passthrough: true, summary: "Take a backup (tools/backup-sqlite.js): --label <what> pins it." },
  restore: { passthrough: true, summary: "Restore from a backup (tools/restore-sqlite.js): --list, --snapshot <id> [--startup <id>] [--record ...]." },
  update: { flags: { check: "boolean", rollback: "boolean" }, summary: "Install the latest release, after a safety backup; --check only looks, --rollback goes back one version." },
  autostart: { flags: {}, positionals: ["on", "off", "status"], summary: "Start the tracker when you log in: on, off or status." },
  doctor: { flags: { json: "boolean", port: "value" }, summary: "Check Node, the port, folder permissions and the database." },
  uninstall: { flags: { "purge-data": "boolean", yes: "boolean" }, aliases: { y: "yes" }, summary: "Remove the installed app and the command. Data stays unless you type DELETE." },
  version: { flags: {}, summary: "Print the version." },
  help: { flags: {}, summary: "Show this help." },
};

const ALIASES = { "-v": "version", "--version": "version", "-h": "help" };

function parseArgs(argv) {
  const args = [...argv];
  let command = "";
  if (args.length && !args[0].startsWith("-")) command = args.shift();
  else if (args.length && ALIASES[args[0]]) command = ALIASES[args.shift()];
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`Unknown command: ${command}. Run "startup-tracker help" for the list.`);

  const flags = {};
  const positionals = [];
  const rest = [];
  const known = { ...GLOBAL_FLAGS, ...(spec.flags || {}) };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (spec.passthrough) {
      // backup and restore hand everything to their tool; --data-dir and
      // --dev are read here too, so the tool gets the same data folder.
      if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
        if (!value) throw new UsageError("--data-dir needs a folder path.");
        flags["data-dir"] = value;
        if (!arg.includes("=")) index += 1;
        continue;
      }
      if (arg === "--dev") {
        flags.dev = true;
        continue;
      }
      if (arg === "--help" || arg === "-h") {
        flags.help = true;
        continue;
      }
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const isLong = arg.startsWith("--");
      const raw = isLong ? arg.slice(2) : arg.slice(1);
      const [rawName, inlineValue] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
      const shortNames = { h: "help", ...(spec.aliases || {}) };
      const name = isLong ? rawName : shortNames[rawName];
      const kind = name ? known[name] : undefined;
      if (!kind) throw new UsageError(`Unknown option for "${command || "startup-tracker"}": ${arg}`);
      if (kind === "boolean") {
        if (inlineValue !== undefined) throw new UsageError(`${arg} takes no value.`);
        flags[name] = true;
      } else {
        const value = inlineValue !== undefined ? inlineValue : args[index + 1];
        if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
        flags[name] = value;
        if (inlineValue === undefined) index += 1;
      }
      continue;
    }
    positionals.push(arg);
  }

  if (spec.positionals) {
    if (positionals.length > 1 || (positionals.length === 1 && !spec.positionals.includes(positionals[0]))) {
      throw new UsageError(`"${command}" takes one of: ${spec.positionals.join(", ")}.`);
    }
  } else if (positionals.length) {
    throw new UsageError(`Unexpected argument for "${command || "startup-tracker"}": ${positionals[0]}`);
  }
  if (flags.lines !== undefined && !/^\d+$/.test(flags.lines)) throw new UsageError("--lines needs a whole number.");
  return { command, flags, positionals, rest };
}

// The arguments that pick the data folder, for handing to the server or a tool.
function dataFolderArgs(flags) {
  const out = [];
  if (flags["data-dir"]) out.push("--data-dir", flags["data-dir"]);
  if (flags.dev) out.push("--dev");
  return out;
}

function helpText() {
  const names = Object.keys(COMMANDS).filter(Boolean);
  const width = Math.max(...names.map((name) => name.length));
  const lines = [
    "Usage: startup-tracker [command] [options]",
    "",
    `  ${"(none)".padEnd(width)}  ${COMMANDS[""].summary}`,
    ...names.map((name) => `  ${name.padEnd(width)}  ${COMMANDS[name].summary}`),
    "",
    "Options for start and no command: --port <n>, --save-port, --no-open, --foreground.",
    "Every command: --data-dir <folder> (else STARTUP_TRACKER_HOME, else the default folder), --dev.",
    "Details: docs/cli.md",
  ];
  return `${lines.join("\n")}\n`;
}

module.exports = { UsageError, COMMANDS, parseArgs, dataFolderArgs, helpText };
