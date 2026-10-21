#!/usr/bin/env node
"use strict";

// Refreshes the agent lists that ship with the app:
//   content/acp-registry-snapshot.json  the official ACP registry as fetched,
//                                       with only the fields the app reads
//                                       (authors and their addresses are left
//                                       out)
//   content/acp-catalog.json            up to 20 well-known agents, with the
//                                       launch commands copied from it
// The release workflow runs it; nothing here is typed by hand except which
// agents the catalog keeps and the name of the program each installs.
//
//   node tools/update-acp-registry.js            fetch and write both files
//   node tools/update-acp-registry.js --from f   use a registry file (or an
//                                                earlier snapshot) instead
//   node tools/update-acp-registry.js --check    fail if a catalog agent is
//                                                missing from the registry
//   node tools/update-acp-registry.js --resolve  also check that each catalog
//                                                agent's launch command still
//                                                resolves: the npm or PyPI
//                                                package version exists, and
//                                                every binary archive answers

const fs = require("fs");
const path = require("path");
const { REGISTRY_URL, SNAPSHOT_FILE, CATALOG_FILE, parseRegistry, fetchRegistry } = require("../lib/agents/registry");

// The catalog: registry ids and the program their package installs (used to
// tell whether an agent is already on the computer). At most 20.
const CATALOG = [
  ["claude-acp", "claude-agent-acp"],
  ["codex-acp", "codex-acp"],
  ["gemini", "gemini"],
  ["github-copilot-cli", "copilot"],
  ["opencode", "opencode"],
  ["qwen-code", "qwen"],
  ["auggie", "auggie"],
  ["cline", "cline"],
  ["factory-droid", "droid"],
  ["pi-acp", "pi-acp"],
  ["goose", "goose"],
  ["kimi", "kimi"],
  ["mistral-vibe", ""],
  ["junie", ""],
  ["cursor", ""],
  ["kilo", ""],
];

// Fields of an agent entry the app uses (lib/agents/registry.js).
const KEPT_FIELDS = ["id", "name", "version", "description", "website", "repository", "license", "icon", "distribution"];

function slimRegistry(registry) {
  return {
    version: registry.version,
    agents: (registry.agents || []).map((agent) => Object.fromEntries(KEPT_FIELDS.filter((key) => agent[key] !== undefined).map((key) => [key, agent[key]]))),
  };
}

function buildCatalog(registry, checkedOn) {
  const parsed = parseRegistry(registry);
  const byId = new Map(parsed.agents.map((agent) => [agent.id, agent]));
  const missing = [];
  const agents = [];
  for (const [id, bin] of CATALOG.slice(0, 20)) {
    const agent = byId.get(id);
    if (!agent) {
      missing.push(id);
      continue;
    }
    agents.push({ id, name: agent.name, version: agent.version, description: agent.description, website: agent.website, bin, distribution: agent.distribution, checkedOn });
  }
  return { catalog: { source: REGISTRY_URL, checkedOn, agents }, missing };
}

// "@scope/name@1.2.3" -> { name: "@scope/name", version: "1.2.3" }.
function splitPackage(spec) {
  const text = String(spec || "");
  const at = text.lastIndexOf("@");
  if (at <= 0) return { name: text, version: "" };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

// What has to exist for each catalog agent to start: the URLs to ask.
function launchTargets(agent) {
  const dist = agent.distribution || {};
  if (dist.npx?.package) {
    const { name, version } = splitPackage(dist.npx.package);
    return [{ kind: "npx", label: dist.npx.package, url: `https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(version || "latest")}` }];
  }
  if (dist.uvx?.package) {
    const [name, version = ""] = String(dist.uvx.package).split(/==|@/);
    return [{ kind: "uvx", label: dist.uvx.package, url: version ? `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json` : `https://pypi.org/pypi/${encodeURIComponent(name)}/json` }];
  }
  return Object.entries(dist.binary || {})
    .filter(([, entry]) => entry && /^https:\/\//.test(entry.archive || ""))
    .map(([platform, entry]) => ({ kind: "binary", label: `${platform} archive`, url: entry.archive }));
}

// Asks for each URL (HEAD, then a one-byte GET where HEAD is refused).
// Returns one line per agent: { id, ok, problems }.
async function resolveLaunchCommands(catalog, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const results = [];
  for (const agent of catalog.agents || []) {
    const problems = [];
    const targets = launchTargets(agent);
    if (!targets.length) problems.push("no launch command");
    for (const target of targets) {
      let status = 0;
      try {
        let response = await fetchImpl(target.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 405 || response.status === 403) {
          response = await fetchImpl(target.url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        }
        status = response.status;
      } catch (error) {
        problems.push(`${target.label}: ${error.message}`);
        continue;
      }
      if (status < 200 || status >= 400) problems.push(`${target.label}: HTTP ${status}`);
    }
    results.push({ id: agent.id, ok: problems.length === 0, problems });
  }
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const fromIndex = argv.indexOf("--from");
  const source = fromIndex >= 0 ? JSON.parse(fs.readFileSync(argv[fromIndex + 1], "utf8")) : await fetchRegistry();
  // An earlier snapshot keeps the date it was fetched on.
  const registry = source.registry || source;
  const fetchedAt = source.registry && source.fetchedAt ? source.fetchedAt : new Date().toISOString();
  const today = fetchedAt.slice(0, 10);
  const { catalog, missing } = buildCatalog(registry, today);
  if (argv.includes("--check") || argv.includes("--resolve")) {
    if (missing.length) {
      console.error(`Missing from the registry: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else console.log(`All ${catalog.agents.length} catalog agents are in the registry.`);
    if (argv.includes("--resolve")) {
      const results = await resolveLaunchCommands(catalog);
      for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.id}${result.problems.length ? `: ${result.problems.join("; ")}` : ""}`);
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify({ source: REGISTRY_URL, fetchedAt, registry: slimRegistry(registry) }, null, 2)}\n`);
  fs.writeFileSync(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), SNAPSHOT_FILE)} (${parseRegistry(registry).agents.length} agents) and ${path.relative(process.cwd(), CATALOG_FILE)} (${catalog.agents.length} agents).`);
  if (missing.length) console.log(`Not in the registry, left out of the catalog: ${missing.join(", ")}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { CATALOG, KEPT_FIELDS, slimRegistry, buildCatalog, splitPackage, launchTargets, resolveLaunchCommands };
