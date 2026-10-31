"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const exchangeRates = require("../lib/exchange-rates");

function makeCacheFile() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "exchange-rates-"));
  return path.join(folder, "cache", "exchange-rates.json");
}

function fakeAnswer(rate, date = "2026-10-30") {
  return async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ date, base: "USD", quote: "RON", rate, url }),
  });
}

test("getRate asks Frankfurter once and then answers from the day's cache", async () => {
  const cacheFile = makeCacheFile();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ date: "2026-10-30", base: "USD", quote: "RON", rate: 4.7843 }) };
  };
  const now = () => Date.parse("2026-10-31T09:00:00.000Z");
  const first = await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl, now });
  const second = await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl, now });
  assert.equal(first.rate, 4.7843);
  assert.equal(first.date, "2026-10-30");
  assert.equal(first.source, "Frankfurter");
  assert.equal(first.cached, false);
  assert.equal(second.rate, 4.7843);
  assert.equal(second.cached, true);
  assert.deepEqual(calls, ["https://api.frankfurter.dev/v2/rate/USD/RON"]);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8"))["USD:RON"].rate, 4.7843);
});

test("a day-old rate is fetched again; refresh does it at once", async () => {
  const cacheFile = makeCacheFile();
  let rate = 4.5;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ date: "2026-10-31", rate }) };
  };
  const now = () => Date.parse("2026-10-31T09:00:00.000Z");
  await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl, now });
  rate = 4.6;
  const later = await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl, now: () => Date.parse("2026-11-01T09:00:01.000Z") });
  assert.equal(later.rate, 4.6);
  rate = 4.7;
  const refreshed = await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl, now, force: true });
  assert.equal(refreshed.rate, 4.7);
  assert.equal(calls, 3);
});

test("a failed fetch keeps the newest cached rate and says why", async () => {
  const cacheFile = makeCacheFile();
  const now = () => Date.parse("2026-10-31T09:00:00.000Z");
  await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl: fakeAnswer(4.78), now });
  const fallen = await exchangeRates.getRate({
    from: "USD",
    to: "RON",
    cacheFile,
    fetchImpl: async () => { throw new Error("offline"); },
    now: () => Date.parse("2026-11-02T09:00:00.000Z"),
  });
  assert.equal(fallen.rate, 4.78);
  assert.equal(fallen.stale, true);
  assert.equal(fallen.error, "offline");
});

test("with the network switch off a cached rate is still readable, but nothing is fetched", async () => {
  const cacheFile = makeCacheFile();
  const now = () => Date.parse("2026-10-31T09:00:00.000Z");
  await exchangeRates.getRate({ from: "USD", to: "RON", cacheFile, fetchImpl: fakeAnswer(4.78), now });
  let calls = 0;
  const cached = await exchangeRates.getRate({
    from: "USD",
    to: "RON",
    cacheFile,
    fetchImpl: async () => { calls += 1; return fakeAnswer(9)(); },
    allowNetwork: false,
    now: () => Date.parse("2026-12-01T09:00:00.000Z"),
  });
  assert.equal(cached.rate, 4.78);
  assert.equal(cached.stale, true);
  assert.equal(cached.error, "networkOff");
  assert.equal(calls, 0);
  await assert.rejects(
    exchangeRates.getRate({ from: "EUR", to: "RON", cacheFile, fetchImpl: async () => { calls += 1; }, allowNetwork: false, now }),
    /network switch is off/,
  );
  assert.equal(calls, 0);
});

test("currency codes must be three letters and the pair must differ", () => {
  assert.deepEqual(exchangeRates.normalizePair("usd", "ron"), { base: "USD", quote: "RON" });
  assert.throws(() => exchangeRates.normalizePair("US", "RON"), /three-letter/);
  assert.throws(() => exchangeRates.normalizePair("USD", "USD"), /different/);
});
