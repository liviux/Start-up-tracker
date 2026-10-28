"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { automaticBackupDue, DEFAULT_INTERVAL_MS } = require("../lib/backups/schedule");

const now = Date.parse("2026-10-17T12:00:00.000Z");
const hoursAgo = (hours) => new Date(now - hours * 60 * 60 * 1000).toISOString();

test("a first backup is due once there is data", () => {
  assert.equal(automaticBackupDue({ newest: null, revision: 0, now }), "");
  assert.equal(automaticBackupDue({ newest: null, revision: 3, now }), "first");
  assert.equal(automaticBackupDue({ newest: null, revision: 1, now, hasStartups: false }), "", "only the seeded built-in lists");
});

test("at start, a backup is due only when the data changed", () => {
  const newest = { databaseRevision: 5, createdAt: hoursAgo(1) };
  assert.equal(automaticBackupDue({ newest, revision: 5, now, atStart: true }), "");
  assert.equal(automaticBackupDue({ newest, revision: 6, now, atStart: true }), "start");
});

test("while editing, a backup is due every six hours", () => {
  const recent = { databaseRevision: 5, createdAt: hoursAgo(2) };
  const old = { databaseRevision: 5, createdAt: hoursAgo(7) };
  assert.equal(automaticBackupDue({ newest: recent, revision: 9, now, lastWriteAt: now - 1000 }), "");
  assert.equal(automaticBackupDue({ newest: old, revision: 9, now, lastWriteAt: now - 1000 }), "interval");
  assert.equal(automaticBackupDue({ newest: old, revision: 9, now, lastWriteAt: Date.parse(hoursAgo(8)) }), "", "no edits since the backup, nothing due");
  assert.equal(automaticBackupDue({ newest: old, revision: 5, now, lastWriteAt: now }), "", "same revision, nothing due");
  assert.equal(DEFAULT_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("the interval can be set to another number of hours", () => {
  const newest = { databaseRevision: 5, createdAt: hoursAgo(8) };
  assert.equal(automaticBackupDue({ newest, revision: 9, now, lastWriteAt: now - 1000, intervalMs: 12 * 60 * 60 * 1000 }), "", "not due after eight of twelve hours");
  assert.equal(automaticBackupDue({ newest, revision: 9, now: now + 5 * 60 * 60 * 1000, lastWriteAt: now + 5 * 60 * 60 * 1000 - 1000, intervalMs: 12 * 60 * 60 * 1000 }), "interval");
});
