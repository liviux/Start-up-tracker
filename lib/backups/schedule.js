"use strict";

// When an automatic backup is due: when the server starts and the data
// changed since the newest backup, and every interval (six hours by default,
// set in Settings > Backups) while edits are being made. Nothing is due while
// nobody edits, so an idle tracker does not fill the backup folder.

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// newest: the newest complete backup ({ databaseRevision, createdAt }) or null.
// revision: the database revision now. lastWriteAt: time of the newest write
// this server saw (ms), or 0. hasStartups: false while the tracker holds only
// the built-in lists it seeds on first start, which need no backup.
function automaticBackupDue({ newest, revision, now, lastWriteAt = 0, atStart = false, hasStartups = true, intervalMs = DEFAULT_INTERVAL_MS }) {
  if (!newest) return revision > 0 && hasStartups ? "first" : "";
  if (newest.databaseRevision === revision) return "";
  if (atStart) return "start";
  const newestAt = Date.parse(newest.createdAt || "") || 0;
  if (lastWriteAt > newestAt && now - newestAt >= intervalMs) return "interval";
  return "";
}

module.exports = { DEFAULT_INTERVAL_MS, automaticBackupDue };
