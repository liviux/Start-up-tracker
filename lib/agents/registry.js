"use strict";

// The list of ACP agents to choose from in Settings > AI agents.
//
// Sources, in order:
//   1. the official ACP registry, fetched at most once a day and cached in the
//      data folder (cache/acp-registry.json), unless the network switch in
//      Settings > General is off;
//   2. the snapshot that ships with the app (content/acp-registry-snapshot.json,
//      refreshed by tools/update-acp-registry.js);
//   3. the curated catalog (content/acp-catalog.json), whose launch commands
//      were copied from the registry and are checked at every release.
// Launch commands always come from this data, never from code.

const fs = require("fs");
const path = require("path");
const { findOnPath } = require("./process");

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_HOURS = 24;
const CONTENT_DIR = path.join(__dirname, "..", "..", "content");
const SNAPSHOT_FILE = path.join(CONTENT_DIR, "acp-registry-snapshot.json");
const CATALOG_FILE = path.join(CONTENT_DIR, "acp-catalog.json");
const LOCAL_FILE = path.join(CONTENT_DIR, "acp-local.json");
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

// The registry's name for this computer: darwin-aarch64, linux-x86_64,
// windows-x86_64 and so on.
function platformKey(platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform] || platform;
  const cpu = { arm64: "aarch64", x64: "x86_64" }[arch] || arch;
  return `${os}-${cpu}`;
}

// Checks the registry's shape and keeps what the app uses.
function parseRegistry(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.agents)) throw new RegistryError("The registry has no agents list.");
  const agents = [];
  for (const entry of raw.agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) continue;
    const distribution = entry.distribution && typeof entry.distribution === "object" ? entry.distribution : {};
    if (!distribution.npx && !distribution.uvx && !distribution.binary) continue;
    agents.push({
      id: entry.id,
      name: String(entry.name || entry.id).slice(0, 80),
      version: String(entry.version || ""),
      description: String(entry.description || "").slice(0, 400),
      website: /^https:\/\//.test(entry.website || "") ? entry.website : "",
      repository: /^https:\/\//.test(entry.repository || "") ? entry.repository : "",
      license: String(entry.license || ""),
      icon: /^https:\/\//.test(entry.icon || "") ? entry.icon : "",
      distribution,
    });
  }
  return { version: String(raw.version || ""), agents };
}

function cleanArgs(args) {
  return Array.isArray(args) ? args.filter((arg) => typeof arg === "string").slice(0, 40) : [];
}

// How to launch an agent on this computer, from its registry entry: an npx or
// uvx package, or a binary that has to be on PATH (the app does not download
// archives; it tells you where they are). Null when nothing fits.
function launchSpec(agent, { platform = process.platform, arch = process.arch } = {}) {
  const dist = agent?.distribution || {};
  if (dist.npx && typeof dist.npx.package === "string") return { kind: "npx", package: dist.npx.package, args: cleanArgs(dist.npx.args) };
  if (dist.uvx && typeof dist.uvx.package === "string") return { kind: "uvx", package: dist.uvx.package, args: cleanArgs(dist.uvx.args) };
  const binary = dist.binary && dist.binary[platformKey(platform, arch)];
  if (binary && typeof binary.cmd === "string") {
    const command = path.basename(binary.cmd.replace(/\\/g, "/")).replace(/\.exe$/i, "");
    return { kind: "binary", command, args: cleanArgs(binary.args), archive: /^https:\/\//.test(binary.archive || "") ? binary.archive : "" };
  }
  return null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readCatalog(file = CATALOG_FILE) {
  try {
    const raw = readJson(file);
    return Array.isArray(raw.agents) ? raw.agents.filter((entry) => entry && ID_PATTERN.test(entry.id || "")).slice(0, 20) : [];
  } catch {
    return [];
  }
}

// Agents that are not in the registry but run on this computer, plus the
// native programs that show a registered agent is already installed. Kept in
// content so launch commands stay data, not code.
function readLocal(file = LOCAL_FILE) {
  const empty = { agents: [], aliases: {}, checkedOn: "" };
  try {
    const raw = readJson(file);
    const agents = (Array.isArray(raw.agents) ? raw.agents : [])
      .filter((entry) => entry && ID_PATTERN.test(entry.id || "") && entry.distribution && typeof entry.distribution === "object")
      .map((entry) => ({
        id: entry.id,
        name: String(entry.name || entry.id).slice(0, 80),
        version: String(entry.version || ""),
        description: String(entry.description || "").slice(0, 400),
        website: /^https:\/\//.test(entry.website || "") ? entry.website : "",
        repository: /^https:\/\//.test(entry.repository || "") ? entry.repository : "",
        license: String(entry.license || ""),
        icon: /^https:\/\//.test(entry.icon || "") ? entry.icon : "",
        bin: String(entry.bin || ""),
        requires: (Array.isArray(entry.requires) ? entry.requires : []).map(String).filter(Boolean).slice(0, 8),
        distribution: entry.distribution,
      }));
    const aliases = {};
    for (const [id, names] of Object.entries(raw.aliases && typeof raw.aliases === "object" ? raw.aliases : {})) {
      if (!ID_PATTERN.test(id) || !Array.isArray(names)) continue;
      aliases[id] = names.map(String).filter(Boolean).slice(0, 8);
    }
    return { agents, aliases, checkedOn: String(raw.checkedOn || "") };
  } catch {
    return empty;
  }
}

// Local entries replace a registry agent with the same id (so an installed
// native program can get the adapter that works with it), and otherwise join
// the list. The catalog grows the same way, which is where installed detection
// reads the program names from.
function withLocal(agents, catalog, local) {
  const localById = new Map(local.agents.map((entry) => [entry.id, entry]));
  const merged = [];
  const seen = new Set();
  for (const agent of agents) {
    const replacement = localById.get(agent.id);
    merged.push(replacement ? { ...agent, ...replacement, icon: replacement.icon || agent.icon } : agent);
    seen.add(agent.id);
  }
  for (const entry of local.agents) if (!seen.has(entry.id)) merged.push(entry);
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  for (const entry of local.agents) catalogById.set(entry.id, { ...entry, checkedOn: local.checkedOn });
  return { agents: merged, catalog: [...catalogById.values()], local: { aliases: local.aliases, checkedOn: local.checkedOn } };
}

function readCache(cacheDir) {
  if (!cacheDir) return null;
  try {
    const cached = readJson(path.join(cacheDir, "acp-registry.json"));
    return cached && cached.fetchedAt && cached.registry ? cached : null;
  } catch {
    return null;
  }
}

function writeCache(cacheDir, registry, fetchedAt) {
  if (!cacheDir) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, "acp-registry.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ fetchedAt, registry }));
  fs.renameSync(`${file}.tmp`, file);
}

async function fetchRegistry(fetchImpl = fetch, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new RegistryError(`The registry answered ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// The agent list with where it came from. `force` fetches again even when the
// cache is fresh ("Rescan now"); `network: false` never fetches.
async function loadRegistry({ cacheDir = null, network = true, force = false, fetchImpl = fetch, now = Date.now(), snapshotFile = SNAPSHOT_FILE, catalogFile = CATALOG_FILE, localFile = LOCAL_FILE } = {}) {
  const catalog = readCatalog(catalogFile);
  const local = readLocal(localFile);
  const cached = readCache(cacheDir);
  const fresh = cached && now - Date.parse(cached.fetchedAt) < CACHE_HOURS * 3600 * 1000;
  let problem = "";
  if (network && (force || !fresh)) {
    try {
      const raw = await fetchRegistry(fetchImpl);
      const parsed = parseRegistry(raw);
      const fetchedAt = new Date(now).toISOString();
      writeCache(cacheDir, raw, fetchedAt);
      const merged = withLocal(parsed.agents, catalog, local);
      return { source: "live", fetchedAt, version: parsed.version, agents: merged.agents, catalog: merged.catalog, local: merged.local, problem };
    } catch (error) {
      problem = `The agent registry could not be fetched: ${error.message}`;
    }
  }
  if (cached) {
    try {
      const parsed = parseRegistry(cached.registry);
      const merged = withLocal(parsed.agents, catalog, local);
      return { source: "cache", fetchedAt: cached.fetchedAt, version: parsed.version, agents: merged.agents, catalog: merged.catalog, local: merged.local, problem };
    } catch {
      // Fall through to the snapshot.
    }
  }
  try {
    const snapshot = readJson(snapshotFile);
    const parsed = parseRegistry(snapshot.registry || snapshot);
    const merged = withLocal(parsed.agents, catalog, local);
    return { source: "snapshot", fetchedAt: snapshot.fetchedAt || "", version: parsed.version, agents: merged.agents, catalog: merged.catalog, local: merged.local, problem };
  } catch {
    // Fall through to the catalog.
  }
  const agents = catalog.filter((entry) => entry.distribution).map((entry) => ({ ...entry, description: entry.description || "", icon: "" }));
  const merged = withLocal(agents, catalog, local);
  return { source: "catalog", fetchedAt: "", version: "", agents: merged.agents, catalog: merged.catalog, local: merged.local, problem: problem || "Neither the registry nor its snapshot could be read; using the built-in catalog." };
}

// Whether the agent is on this computer. Two ways count: its own program (the
// binary, or the npm package's command) and a native CLI it needs, such as
// `codex` for the Codex adapter or `claude` for the Claude adapter. Only the
// first lets an npx agent run without a download; `own` says which was found.
function detectInstalled(agent, catalog = [], { env = process.env, platform, arch, aliases = {} } = {}) {
  const spec = launchSpec(agent, { platform, arch });
  const entry = catalog.find((item) => item.id === agent.id);
  const own = [...new Set([spec?.kind === "binary" ? spec.command : "", entry?.bin || ""].filter(Boolean))];
  for (const name of own) {
    const found = findOnPath(name, env);
    if (found) return { installed: true, path: found, command: name, own: true };
  }
  const required = [...new Set([...(entry?.requires || []), ...(aliases[agent.id] || [])].filter((name) => name && !own.includes(name)))];
  for (const name of required) {
    const found = findOnPath(name, env);
    if (found) return { installed: true, path: found, command: name, own: false };
  }
  return { installed: false, path: "", command: "", own: false };
}

// The list Settings shows: each agent with its launch spec for this computer
// and whether it was found.
function describeAgents(result, options = {}) {
  const aliases = options.aliases || result.local?.aliases || {};
  return result.agents.map((agent) => {
    const spec = launchSpec(agent, options);
    const entry = result.catalog.find((item) => item.id === agent.id);
    const found = detectInstalled(agent, result.catalog, { ...options, aliases });
    const bin = entry?.bin || "";
    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description,
      website: agent.website,
      repository: agent.repository,
      icon: agent.icon,
      kind: spec?.kind || "",
      launch: spec,
      available: Boolean(spec),
      installed: found.installed,
      installedPath: found.path,
      // The package's own command, when that is what was found: then the
      // agent can run from there without downloading the package.
      installedBin: found.own && bin === found.command ? bin : "",
      bin,
    };
  });
}

module.exports = { REGISTRY_URL, CACHE_HOURS, SNAPSHOT_FILE, CATALOG_FILE, LOCAL_FILE, RegistryError, platformKey, parseRegistry, launchSpec, readCatalog, readLocal, loadRegistry, detectInstalled, describeAgents, fetchRegistry };
