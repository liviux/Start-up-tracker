"use strict";

// Daily exchange rates from Frankfurter (https://frankfurter.dev), a free
// public API that needs no key. The AI page asks for the USD to RON rate; the
// result is kept in the data folder's cache for a day, so every tab and every
// startup shares one request.
//
// The AI page stores the rate it uses in the shared settings. This module only
// fetches and caches; the page decides when to ask.

const fs = require("fs");
const path = require("path");

const SOURCE = "Frankfurter";
const SOURCE_URL = "https://api.frankfurter.dev/v2/rate";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`"${value}" is not a three-letter currency code.`);
  return code;
}

function normalizePair(from, to) {
  const base = normalizeCode(from || "USD");
  const quote = normalizeCode(to || "RON");
  if (base === quote) throw new Error("Pick two different currencies.");
  return { base, quote };
}

function readCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cacheFile, values) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, cacheFile);
}

function isFresh(entry, now, maxAgeMs) {
  const fetched = Date.parse(entry?.fetchedAt || "");
  return Number.isFinite(fetched) && now - fetched >= 0 && now - fetched < maxAgeMs;
}

async function fetchRate({ from, to, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
  const { base, quote } = normalizePair(from, to);
  if (typeof fetchImpl !== "function") throw new Error("This Node.js version has no fetch.");
  const url = `${SOURCE_URL}/${base}/${quote}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The exchange rate service answered ${response.status}.`);
    const body = await response.json();
    const rate = Number(body?.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("The exchange rate service sent no usable rate.");
    return {
      from: base,
      to: quote,
      rate,
      date: String(body?.date || ""),
      source: SOURCE,
      sourceUrl: `https://frankfurter.dev/`,
      fetchedAt: new Date(now()).toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Returns the cached rate when it is less than a day old (or when the network
// may not be used), otherwise asks Frankfurter. A failed request falls back to
// the newest cached value and says why through `error`.
async function getRate({
  from = "USD",
  to = "RON",
  cacheFile,
  fetchImpl = globalThis.fetch,
  force = false,
  allowNetwork = true,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const { base, quote } = normalizePair(from, to);
  const key = `${base}:${quote}`;
  const cache = cacheFile ? readCache(cacheFile) : {};
  const cached = cache[key];
  const currentTime = now();
  if (!force && isFresh(cached, currentTime, maxAgeMs)) return { ...cached, cached: true };

  if (!allowNetwork) {
    if (cached) return { ...cached, cached: true, stale: true, error: "networkOff" };
    throw new Error("The network switch is off, so no exchange rate could be fetched.");
  }

  try {
    const fresh = await fetchRate({ from: base, to: quote, fetchImpl, timeoutMs, now });
    if (cacheFile) {
      cache[key] = fresh;
      writeCache(cacheFile, cache);
    }
    return { ...fresh, cached: false };
  } catch (error) {
    if (cached) return { ...cached, cached: true, stale: true, error: error.message };
    throw error;
  }
}

module.exports = {
  SOURCE,
  DEFAULT_MAX_AGE_MS,
  fetchRate,
  getRate,
  normalizePair,
};
