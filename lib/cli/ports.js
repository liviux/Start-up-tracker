"use strict";

// Port checks for the CLI. The server never moves to another port by itself;
// the CLI only reports a taken port and, when asked, saves a different one.

const net = require("net");
const { fetchHealth, sameFile } = require("./run-state");

const HOST = "127.0.0.1";

function isPortFree(port, host = HOST) {
  if (port === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// The first free port after `start`, for the "save another port" offer.
async function findFreePort(start, { attempts = 50, host = HOST } = {}) {
  for (let port = start + 1; port <= Math.min(65535, start + attempts); port += 1) {
    if (await isPortFree(port, host)) return port;
  }
  return null;
}

// What holds a taken port:
//   ours     a Startup Tracker serving this data folder
//   tracker  a Startup Tracker serving another data folder
//   other    something else
async function identifyPortOwner(port, paths, { fetchImpl } = {}) {
  const health = await fetchHealth(`http://${HOST}:${port}/`, { fetchImpl });
  if (!health) return { owner: "other", health: null };
  return { owner: sameFile(health.filePath, paths.databaseFile) ? "ours" : "tracker", health };
}

module.exports = { HOST, isPortFree, findFreePort, identifyPortOwner };
