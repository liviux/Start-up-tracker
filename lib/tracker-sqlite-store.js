"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { DEFAULT_IGNORED_PATHS, isPlainObject, valuesEqual } = require("../public/scripts/record-conflict-merge.js");

// Every row carries a startup_id, and revisions, tombstones, applied mutations
// and history are counted per startup.
const SCHEMA_VERSION = 4;
// Data shared by every startup (settings, the startup list, the category
// library, prompts) lives under this reserved id.
const GLOBAL_STARTUP_ID = "_global";
// A short slug plus a random suffix, for example "acme-7f3k". It never changes
// when the startup is renamed.
const STARTUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STARTUPS_SECTION = "startups";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_RECORDED_MUTATIONS = 1_000;
// Tombstones let readChangesSince report deletions. They are pruned to the
// most recent window, per startup; a client older than that window falls back
// to a full load.
const MAX_RECORDED_TOMBSTONES = 5_000;

// Inline edits autosave on a 250ms debounce, so one history entry per write
// would be an unreadable list of near-identical rows. Consecutive edits to the
// same record collapse into a single entry that keeps the first before-value and
// the latest after-value, the way a document editor groups a typing session.
const HISTORY_SESSION_GAP_MS = 10 * 60 * 1_000;
// A rolling gap alone would let one entry swallow an entire day of edits, which
// hides the shape of the work. An entry stops absorbing edits once it spans this
// long no matter how continuous the typing was.
const HISTORY_SESSION_MAX_SPAN_MS = 60 * 60 * 1_000;
// Runaway backstop, not a retention policy, counted per startup so a busy
// startup never evicts another one's history.
const MAX_RECORDED_HISTORY_ENTRIES = 50_000;
// Truncating long values keeps one pasted log file from turning a history
// entry into a megabyte.
const HISTORY_MAX_VALUE_CHARS = 40_000;
const HISTORY_ORIGINS = new Set(["ui", "api", "tool", "backfill", "restore", "import", "agent"]);
const HISTORY_EVENTS = new Set(["created", "updated", "deleted"]);

// Raised when the specific records a client touched moved on the server. Unlike
// RevisionConflictError this says nothing about the rest of the database, so a
// client can keep editing everything it did not collide on.
class RecordConflictError extends Error {
  constructor(conflicts) {
    const summary = conflicts
      .map((conflict) => (conflict.id ? `${conflict.section}/${conflict.id}` : conflict.section))
      .join(", ");
    super(`These records changed on the server since you loaded them: ${summary}.`);
    this.name = "RecordConflictError";
    this.code = "SQLITE_TRACKER_RECORD_CONFLICT";
    this.conflicts = conflicts;
  }
}

class RevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Tracker data changed since revision ${expectedRevision}; current revision is ${actualRevision}.`);
    this.name = "RevisionConflictError";
    this.code = "SQLITE_TRACKER_REVISION_CONFLICT";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

// Every store call names the startup it reads or writes; there is no default,
// so a forgotten id fails loudly instead of touching the wrong startup.
function normalizeStartupId(startupId) {
  if (startupId === GLOBAL_STARTUP_ID) return startupId;
  if (typeof startupId !== "string" || !STARTUP_ID_PATTERN.test(startupId)) {
    throw new TypeError(`A valid startup id is required (got ${JSON.stringify(startupId)}).`);
  }
  return startupId;
}

// A new startup id: the slug of the name plus four random characters.
function makeStartupId(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "startup";
  const suffix = crypto.randomBytes(3).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(4, "0").slice(0, 4);
  return `${slug}-${suffix}`;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tracker_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS startup_revisions (
    startup_id TEXT PRIMARY KEY CHECK (length(startup_id) > 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    changes_complete_since_revision INTEGER NOT NULL DEFAULT 0 CHECK (changes_complete_since_revision >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS state_sections (
    startup_id TEXT NOT NULL CHECK (length(startup_id) > 0),
    section_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('collection', 'value')),
    value_json TEXT,
    section_revision INTEGER NOT NULL DEFAULT 0 CHECK (section_revision >= 0),
    PRIMARY KEY (startup_id, section_name),
    UNIQUE (startup_id, ordinal),
    CHECK (
      (kind = 'collection' AND value_json IS NULL) OR
      (kind = 'value' AND value_json IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS state_records (
    startup_id TEXT NOT NULL,
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    value_json TEXT NOT NULL,
    record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
    PRIMARY KEY (startup_id, section_name, record_id),
    UNIQUE (startup_id, section_name, ordinal),
    FOREIGN KEY (startup_id, section_name) REFERENCES state_sections(startup_id, section_name) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS state_records_order_idx
    ON state_records(startup_id, section_name, ordinal);

  CREATE INDEX IF NOT EXISTS state_records_revision_idx
    ON state_records(startup_id, record_revision);

  CREATE TABLE IF NOT EXISTS deleted_records (
    startup_id TEXT NOT NULL CHECK (length(startup_id) > 0),
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    deleted_revision INTEGER NOT NULL CHECK (deleted_revision >= 0),
    PRIMARY KEY (startup_id, section_name, record_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS deleted_records_revision_idx
    ON deleted_records(startup_id, deleted_revision);

  CREATE TABLE IF NOT EXISTS applied_mutations (
    startup_id TEXT NOT NULL CHECK (length(startup_id) > 0),
    mutation_id TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
    result_state_hash TEXT NOT NULL,
    result_unchanged INTEGER NOT NULL CHECK (result_unchanged IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (startup_id, mutation_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS applied_mutations_created_idx
    ON applied_mutations(startup_id, created_at);

  -- Deliberately not tied to state_records by a foreign key. A record's
  -- history has to outlive the record: replaceState drops every section of a
  -- startup (which would cascade this table away), and the whole point of
  -- keeping history for deleted records is that the rows survive the delete.
  CREATE TABLE IF NOT EXISTS record_history (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    startup_id TEXT NOT NULL CHECK (length(startup_id) > 0),
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('created', 'updated', 'deleted')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    changed_at TEXT NOT NULL,
    session_started_at TEXT NOT NULL,
    origin TEXT NOT NULL,
    actor TEXT,
    label TEXT,
    -- 1 for entries reconstructed rather than observed as they happened, so
    -- the UI can say the time and grouping are approximate.
    approximate INTEGER NOT NULL DEFAULT 0 CHECK (approximate IN (0, 1)),
    fields_json TEXT NOT NULL,
    -- Only set on 'deleted', where the record is about to stop existing.
    snapshot_json TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS record_history_record_idx
    ON record_history(startup_id, section_name, record_id, changed_at);

  CREATE INDEX IF NOT EXISTS record_history_changed_idx
    ON record_history(startup_id, changed_at);
`;

class TrackerSqliteStore {
  // The startup the current call works on. Set by #inScope for the length of
  // one public call and cleared afterwards, so private helpers never need the
  // id threaded through every signature.
  #scope = null;

  constructor(databasePath, options = {}) {
    if (!databasePath || typeof databasePath !== "string") {
      throw new TypeError("databasePath must be a non-empty string.");
    }

    this.databasePath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
    this.busyTimeoutMs = readPositiveInteger(options.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS);
    // Per-startup caps; tests lower them to exercise pruning.
    this.maxTombstones = readPositiveInteger(options.limits?.tombstones, MAX_RECORDED_TOMBSTONES);
    this.maxHistoryEntries = readPositiveInteger(options.limits?.historyEntries, MAX_RECORDED_HISTORY_ENTRIES);
    // Inspecting a snapshot must not modify it. A read-only open also leaves no
    // -wal/-shm files beside the backup.
    this.readOnly = options.readOnly === true;
    this.closed = false;
    // Revision that in-flight writes stamp onto the rows they touch. Set for the
    // duration of a write transaction and cleared when it ends.
    this.pendingRevision = 0;
    // Hashing a whole state is slow on a big database, so the hash is cached per
    // startup against the revision that produced it.
    this.hashCache = new Map();
    // Provenance stamped onto history entries written by the current write.
    this.historyContext = null;
    this.historyTableExists = null;

    if (this.databasePath !== ":memory:" && !this.readOnly) {
      fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(this.databasePath, {
      timeout: this.busyTimeoutMs,
      readOnly: this.readOnly,
    });
    try {
      // Checked before anything is configured, so a file this code refuses is
      // left exactly as it was.
      const userVersion = this.#checkSchemaVersion();
      this.#configureDatabase();
      if (!this.readOnly) this.#initializeSchema(userVersion);
    } catch (error) {
      // A file that is not a tracker database must not stay open: Windows
      // would keep it locked, and every platform would leak the handle.
      try {
        this.db.close();
      } catch {
        // Closing a handle that failed to configure can fail too.
      }
      this.closed = true;
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    if (this.databasePath !== ":memory:" && !this.readOnly) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    this.db.close();
    this.closed = true;
  }

  // Facts about the whole database. `revision` counts writes across every
  // startup; it is for snapshot verification, never for conflict checks.
  getInfo() {
    this.#assertOpen();
    const metadata = Object.fromEntries(
      this.db.prepare("SELECT key, value FROM tracker_metadata ORDER BY key").all()
        .map((row) => [row.key, row.value]),
    );
    return {
      databasePath: this.databasePath,
      schemaVersion: Number(metadata.schema_version || SCHEMA_VERSION),
      revision: Number(metadata.database_revision || 0),
      importedAt: metadata.imported_at || "",
      sourceHash: metadata.source_hash || "",
      historyEntryCount: this.#hasHistoryTable()
        ? Number(this.db.prepare("SELECT COUNT(*) AS count FROM record_history").get().count)
        : 0,
    };
  }

  // The revision of one startup: its ETag, sync token and changes-feed cursor.
  getRevision(startupId) {
    this.#assertOpen();
    return this.#inScope(startupId, () => this.#getRevision());
  }

  // The revision at which this startup's data was last replaced as a whole (a
  // restore or an import), or 0. A page that loaded before it holds edits
  // against data that no longer exists, so the server refuses them.
  getLineageStart(startupId) {
    this.#assertOpen();
    const id = normalizeStartupId(startupId);
    return Number(this.#getMetadata(`lineage_start:${id}`) || 0);
  }

  // Ids that hold any data, in id order. The global scope is listed only when
  // asked for.
  listStartupIds({ includeGlobal = false } = {}) {
    this.#assertOpen();
    const ids = new Set();
    for (const row of this.db.prepare("SELECT DISTINCT startup_id FROM state_sections").all()) ids.add(row.startup_id);
    if (!includeGlobal) ids.delete(GLOBAL_STARTUP_ID);
    return [...ids].sort();
  }

  // Removes every row that belongs to one startup: records, sections,
  // tombstones, applied mutations and history. The revision counter stays, so
  // if the id comes back (a restore) its revisions keep rising and no browser
  // holding an old revision can mistake new content for what it has. Its
  // changes feed starts over: nothing before this point can be replayed.
  deleteStartupData(startupId) {
    const id = normalizeStartupId(startupId);
    if (id === GLOBAL_STARTUP_ID) throw new Error("The global scope cannot be deleted.");
    if (this.readOnly) throw new Error("Cannot delete from a read-only store.");
    return this.#withTransaction(() => {
      let removed = 0;
      for (const table of ["state_records", "state_sections", "deleted_records", "applied_mutations", "record_history"]) {
        removed += Number(this.db.prepare(`DELETE FROM ${table} WHERE startup_id = ?`).run(id).changes);
      }
      this.db.prepare(`
        UPDATE startup_revisions SET revision = revision + 1, changes_complete_since_revision = revision + 1 WHERE startup_id = ?
      `).run(id);
      const row = this.db.prepare("SELECT revision FROM startup_revisions WHERE startup_id = ?").get(id);
      if (row) this.#setMetadata(`lineage_start:${id}`, String(row.revision));
      this.#bumpDatabaseRevision();
      this.hashCache.delete(id);
      return { removed };
    });
  }

  // Revision and hash of the whole database (every startup and the global
  // scope), used to prove a snapshot holds exactly what it was copied from.
  readDatabaseFingerprint() {
    this.#assertOpen();
    const states = {};
    for (const id of this.listStartupIds({ includeGlobal: true })) {
      states[id] = this.#inScope(id, () => this.#readStateInScope());
    }
    return {
      revision: Number(this.#getMetadata("database_revision") || 0),
      stateHash: sha256(stableSerialize(states)),
      startupCount: Object.keys(states).filter((id) => id !== GLOBAL_STARTUP_ID).length,
    };
  }

  // A view bound to one startup, with the methods of a single-startup store.
  scope(startupId) {
    const id = normalizeStartupId(startupId);
    const store = this;
    const bind = (name) => (...args) => store[name](id, ...args);
    return Object.freeze({
      startupId: id,
      getRevision: bind("getRevision"),
      readState: bind("readState"),
      readStateHash: bind("readStateHash"),
      readRevisionMap: bind("readRevisionMap"),
      readChangesSince: bind("readChangesSince"),
      readSection: bind("readSection"),
      readRecordHistory: bind("readRecordHistory"),
      appendRecordHistory: bind("appendRecordHistory"),
      importRecordHistory: bind("importRecordHistory"),
      getRecord: bind("getRecord"),
      getRecordWithRevision: bind("getRecordWithRevision"),
      listRecords: bind("listRecords"),
      replaceState: bind("replaceState"),
      replaceSection: bind("replaceSection"),
      upsertRecord: bind("upsertRecord"),
      deleteRecord: bind("deleteRecord"),
      reorderRecords: bind("reorderRecords"),
      applyOperations: bind("applyOperations"),
    });
  }

  // Scratch space for maintenance tools that have to remember where they got to
  // between runs. Keys are namespaced, which keeps a tool from overwriting the
  // store's own metadata by picking the same name.
  readToolMetadata(key) {
    this.#assertOpen();
    const value = this.#getMetadata(toolMetadataKey(key));
    return value === undefined ? null : value;
  }

  writeToolMetadata(key, value) {
    this.#assertOpen();
    if (this.readOnly) throw new Error("Cannot write metadata to a read-only store.");
    const namespaced = toolMetadataKey(key);
    return this.#withTransaction(() => {
      this.#setMetadata(namespaced, value === null || value === undefined ? "" : String(value));
      return this.#getMetadata(namespaced);
    });
  }

  // Seeds history that was reconstructed rather than observed. Each entry
  // carries its own timestamp and origin, and coalescing still applies.
  appendRecordHistory(startupId, entries) {
    if (!Array.isArray(entries)) throw new TypeError("entries must be an array.");
    if (this.readOnly) throw new Error("Cannot append history to a read-only store.");

    return this.#inScope(startupId, () => this.#withTransaction(() => {
      let written = 0;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        validateSectionName(entry.section);
        this.historyContext = normalizeHistoryContext(entry);
        const recorded = this.#logRecordHistory({
          sectionName: entry.section,
          recordId: normalizeRecordId(entry.id),
          event: entry.event,
          before: entry.before,
          after: entry.after,
          snapshot: entry.snapshot,
          revision: entry.revision,
        });
        if (recorded) written += 1;
      }
      this.#pruneHistory();
      return {
        written,
        total: Number(this.db.prepare("SELECT COUNT(*) AS count FROM record_history WHERE startup_id = ?").get(this.#sid()).count),
      };
    }));
  }

  // Copies already-recorded history from another tracker, keeping its field
  // changes, snapshot, timestamps and provenance. Entries are inserted as
  // they are; nothing is merged with the receiving session. A malformed entry
  // stops the whole import, so a partial timeline is not silently kept.
  importRecordHistory(startupId, entries) {
    if (!Array.isArray(entries)) throw new TypeError("entries must be an array.");
    if (this.readOnly) throw new Error("Cannot import history to a read-only store.");

    return this.#inScope(startupId, () => this.#withTransaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO record_history(
          startup_id, section_name, record_id, event, revision, changed_at, session_started_at,
          origin, actor, label, approximate, fields_json, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let written = 0;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") throw new TypeError("Each history entry must be an object.");
        validateSectionName(entry.section);
        if (!HISTORY_EVENTS.has(entry.event)) throw new TypeError(`Unknown history event: ${String(entry.event)}`);
        const revision = readNonNegativeInteger(entry.revision, 0);
        const context = normalizeHistoryContext({
          origin: HISTORY_ORIGINS.has(entry.origin) ? entry.origin : "import",
          actor: entry.actor,
          label: entry.label,
          approximate: entry.approximate === true,
          changedAt: entry.changedAt,
        });
        const sessionStartedAt = typeof entry.sessionStartedAt === "string" && Number.isFinite(Date.parse(entry.sessionStartedAt))
          ? new Date(Date.parse(entry.sessionStartedAt)).toISOString()
          : context.changedAt;
        const fields = readImportedHistoryJson(entry.fieldsJson ?? entry.fields_json ?? entry.fields, []);
        const snapshot = readImportedHistoryJson(entry.snapshotJson ?? entry.snapshot_json ?? entry.snapshot, null);
        insert.run(
          this.#sid(),
          entry.section,
          normalizeRecordId(entry.id),
          entry.event,
          revision,
          context.changedAt,
          sessionStartedAt,
          context.origin,
          context.actor,
          context.label,
          context.approximate ? 1 : 0,
          JSON.stringify(fields),
          snapshot === null ? null : JSON.stringify(snapshot),
        );
        written += 1;
      }
      this.#pruneHistory();
      return {
        written,
        total: Number(this.db.prepare("SELECT COUNT(*) AS count FROM record_history WHERE startup_id = ?").get(this.#sid()).count),
      };
    }));
  }

  readState(startupId) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      const state = this.#readStateInScope();
      const revision = this.#getRevision();
      return { state, revision, stateHash: this.#stateHashFor(revision, state) };
    });
  }

  #readStateInScope() {
    const state = {};
    const sections = this.db.prepare(`
      SELECT section_name, kind, value_json
      FROM state_sections
      WHERE startup_id = ?
      ORDER BY ordinal
    `).all(this.#sid());
    const recordsStatement = this.db.prepare(`
      SELECT value_json
      FROM state_records
      WHERE startup_id = ? AND section_name = ?
      ORDER BY ordinal
    `);
    for (const section of sections) {
      if (section.kind === "collection") {
        state[section.section_name] = recordsStatement
          .all(this.#sid(), section.section_name)
          .map((row) => JSON.parse(row.value_json));
      } else {
        state[section.section_name] = JSON.parse(section.value_json);
      }
    }
    return state;
  }

  // The hash of one startup's state, without materialising the state when a
  // cached hash for the current revision is already available.
  readStateHash(startupId) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      const revision = this.#getRevision();
      const cached = this.hashCache.get(this.#sid());
      if (cached && cached.revision === revision) return cached.hash;
      return this.#stateHashFor(revision, this.#readStateInScope());
    });
  }

  #stateHashFor(revision, state) {
    const cached = this.hashCache.get(this.#sid());
    if (cached && cached.revision === revision) return cached.hash;
    const hash = sha256(serializeState(state));
    this.hashCache.set(this.#sid(), { revision, hash });
    return hash;
  }

  // Per-record and per-section revisions, so a client can tell the server which
  // version of each individual record its edit was based on.
  readRevisionMap(startupId) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      const sections = {};
      for (const row of this.db.prepare(`
        SELECT section_name, section_revision FROM state_sections WHERE startup_id = ?
      `).all(this.#sid())) {
        sections[row.section_name] = Number(row.section_revision);
      }
      const records = {};
      for (const row of this.db.prepare(`
        SELECT section_name, record_id, record_revision FROM state_records WHERE startup_id = ?
      `).all(this.#sid())) {
        if (!records[row.section_name]) records[row.section_name] = {};
        records[row.section_name][row.record_id] = Number(row.record_revision);
      }
      return { revision: this.#getRevision(), sections, records };
    });
  }

  // Everything in one startup that changed after `sinceRevision`, so a client
  // that is only a few revisions behind can catch up without refetching. Returns
  // null when the gap is older than the retained tombstone window.
  readChangesSince(startupId, sinceRevision) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      const since = readNonNegativeInteger(sinceRevision, NaN);
      if (!Number.isSafeInteger(since)) {
        throw new TypeError("sinceRevision must be a non-negative safe integer.");
      }
      const sid = this.#sid();
      const revision = this.#getRevision();
      if (since > revision) return null;
      if (since === revision) {
        return { revision, upserts: [], deletes: [], sections: [], order: [], complete: true };
      }
      // This watermark advances whenever tombstones are discarded, so it stays
      // correct after IDs are recreated or more tombstones are removed later.
      if (since < this.#getCompleteSince()) return null;

      const upserts = this.db.prepare(`
        SELECT section_name, record_id, ordinal, value_json
        FROM state_records
        WHERE startup_id = ? AND record_revision > ?
        ORDER BY section_name, ordinal
      `).all(sid, since).map((row) => ({
        section: row.section_name,
        id: row.record_id,
        position: Number(row.ordinal),
        value: JSON.parse(row.value_json),
      }));

      const deletes = this.db.prepare(`
        SELECT section_name, record_id
        FROM deleted_records
        WHERE startup_id = ? AND deleted_revision > ?
      `).all(sid, since).map((row) => ({ section: row.section_name, id: row.record_id }));

      const changedSections = this.db.prepare(`
        SELECT section_name, kind, value_json
        FROM state_sections
        WHERE startup_id = ? AND section_revision > ?
        ORDER BY ordinal
      `).all(sid, since);

      const sections = [];
      const order = [];
      const readOrder = this.db.prepare(`
        SELECT record_id FROM state_records WHERE startup_id = ? AND section_name = ? ORDER BY ordinal
      `);
      for (const section of changedSections) {
        if (section.kind === "value") {
          sections.push({ section: section.section_name, value: JSON.parse(section.value_json) });
        } else {
          order.push({
            section: section.section_name,
            ids: readOrder.all(sid, section.section_name).map((row) => row.record_id),
          });
        }
      }
      return { revision, upserts, deletes, sections, order, complete: true };
    });
  }

  readSection(startupId, sectionName) {
    this.#assertOpen();
    return this.#inScope(startupId, () => this.#readSectionInScope(sectionName));
  }

  #readSectionInScope(sectionName) {
    validateSectionName(sectionName);
    const section = this.db.prepare(`
      SELECT kind, value_json
      FROM state_sections
      WHERE startup_id = ? AND section_name = ?
    `).get(this.#sid(), sectionName);
    if (!section) return undefined;
    if (section.kind === "value") return JSON.parse(section.value_json);
    return this.db.prepare(`
      SELECT value_json
      FROM state_records
      WHERE startup_id = ? AND section_name = ?
      ORDER BY ordinal
    `).all(this.#sid(), sectionName).map((row) => JSON.parse(row.value_json));
  }

  // Timeline for one record, newest first.
  readRecordHistory(startupId, sectionName, recordId, options = {}) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      validateSectionName(sectionName);
      const normalizedId = normalizeRecordId(recordId);
      if (!this.#hasHistoryTable()) return { entries: [], total: 0, available: false };

      const limit = readPositiveInteger(options.limit, 200);
      const offset = readNonNegativeInteger(options.offset, 0);
      const total = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM record_history
        WHERE startup_id = ? AND section_name = ? AND record_id = ?
      `).get(this.#sid(), sectionName, normalizedId).count);

      const entries = this.db.prepare(`
        SELECT entry_id, event, revision, changed_at, session_started_at,
               origin, actor, label, approximate, fields_json, snapshot_json
        FROM record_history
        WHERE startup_id = ? AND section_name = ? AND record_id = ?
        ORDER BY changed_at DESC, entry_id DESC
        LIMIT ? OFFSET ?
      `).all(this.#sid(), sectionName, normalizedId, limit, offset).map((row) => ({
        entryId: Number(row.entry_id),
        event: row.event,
        revision: Number(row.revision),
        changedAt: row.changed_at,
        sessionStartedAt: row.session_started_at,
        origin: row.origin,
        actor: row.actor ?? null,
        label: row.label ?? null,
        approximate: Number(row.approximate) === 1,
        fields: parseHistoryFields(row.fields_json),
        snapshot: row.snapshot_json === null ? undefined : JSON.parse(row.snapshot_json),
      }));
      return { entries, total, available: true };
    });
  }

  getRecord(startupId, sectionName, recordId) {
    return this.getRecordWithRevision(startupId, sectionName, recordId)?.record;
  }

  getRecordWithRevision(startupId, sectionName, recordId) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      validateSectionName(sectionName);
      const normalizedId = normalizeRecordId(recordId);
      const row = this.db.prepare(`
        SELECT value_json, record_revision
        FROM state_records
        WHERE startup_id = ? AND section_name = ? AND record_id = ?
      `).get(this.#sid(), sectionName, normalizedId);
      return row ? { record: JSON.parse(row.value_json), revision: Number(row.record_revision) } : undefined;
    });
  }

  listRecords(startupId, sectionName, options = {}) {
    this.#assertOpen();
    return this.#inScope(startupId, () => {
      validateSectionName(sectionName);
      this.#assertCollection(sectionName);
      const offset = readNonNegativeInteger(options.offset, 0);
      const limit = options.limit === undefined
        ? Number.MAX_SAFE_INTEGER
        : readPositiveInteger(options.limit, Number.MAX_SAFE_INTEGER);
      return this.db.prepare(`
        SELECT value_json
        FROM state_records
        WHERE startup_id = ? AND section_name = ?
        ORDER BY ordinal
        LIMIT ? OFFSET ?
      `).all(this.#sid(), sectionName, limit, offset).map((row) => JSON.parse(row.value_json));
    });
  }

  // Replaces one startup's whole state. Other startups are not touched.
  replaceState(startupId, state, options = {}) {
    validateState(state);
    const sourceHash = options.sourceHash === undefined ? undefined : String(options.sourceHash);
    const importedAt = options.importedAt === undefined ? undefined : String(options.importedAt);
    const mutationId = normalizeMutationId(options.mutationId);
    const operationHash = mutationId ? sha256(stableSerialize({
      type: "replaceState",
      state,
      sourceHash,
      importedAt,
    })) : "";

    return this.#inScope(startupId, () => this.#withTransaction(() => {
      const sid = this.#sid();
      const replay = this.#getMutationReplay(mutationId, operationHash);
      if (replay) return replay;
      this.#assertExpectedRevision(options.expectedRevision);
      const currentState = this.#readStateInScope();
      if (stableSerialize(currentState) === stableSerialize(state)) {
        if (sourceHash !== undefined) this.#setMetadata("source_hash", sourceHash);
        if (importedAt !== undefined) this.#setMetadata("imported_at", importedAt);
        const result = {
          revision: this.#getRevision(),
          stateHash: sha256(serializeState(currentState)),
          unchanged: true,
        };
        this.#recordMutation(mutationId, operationHash, result);
        return result;
      }

      // A full replacement establishes a new state lineage for this startup.
      // Old outbox IDs must not replay results from the state that is being
      // replaced, and no per-record base revision from the old lineage can be
      // trusted either. record_history is deliberately left alone: a restore
      // is the event a reader most needs explained.
      this.db.prepare("DELETE FROM applied_mutations WHERE startup_id = ?").run(sid);
      this.db.prepare("DELETE FROM deleted_records WHERE startup_id = ?").run(sid);
      this.db.prepare("DELETE FROM state_sections WHERE startup_id = ?").run(sid);
      const revision = this.#getRevision() + 1;
      this.#writeRevision(revision, revision);
      this.#setMetadata(`lineage_start:${sid}`, String(revision));
      this.#bumpDatabaseRevision();
      this.#insertEntireState(state, revision);
      this.historyContext = normalizeHistoryContext({ origin: "import", ...options });
      this.#logStateReplacementHistory(currentState, state, revision);
      this.#pruneHistory();
      if (sourceHash !== undefined) this.#setMetadata("source_hash", sourceHash);
      if (importedAt !== undefined) this.#setMetadata("imported_at", importedAt);
      const result = {
        revision,
        stateHash: this.#stateHashFor(revision, state),
        unchanged: false,
      };
      this.#recordMutation(mutationId, operationHash, result);
      return result;
    }));
  }

  replaceSection(startupId, sectionName, value, options = {}) {
    return this.applyOperations(startupId, [
      { type: "replaceSection", section: sectionName, value },
    ], options);
  }

  upsertRecord(startupId, sectionName, record, options = {}) {
    return this.applyOperations(startupId, [
      {
        type: "upsert",
        section: sectionName,
        id: record?.id,
        value: record,
        position: options.position,
      },
    ], options);
  }

  deleteRecord(startupId, sectionName, recordId, options = {}) {
    return this.applyOperations(startupId, [
      { type: "delete", section: sectionName, id: recordId },
    ], options);
  }

  reorderRecords(startupId, sectionName, recordIds, options = {}) {
    return this.applyOperations(startupId, [
      { type: "reorder", section: sectionName, ids: recordIds },
    ], options);
  }

  applyOperations(startupId, operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TypeError("operations must be a non-empty array.");
    }

    const mutationId = normalizeMutationId(options.mutationId);
    const operationHash = mutationId ? sha256(stableSerialize(operations)) : "";

    return this.#inScope(startupId, () => this.#withTransaction(() => {
      const replay = this.#getMutationReplay(mutationId, operationHash);
      if (replay) return replay;
      this.#assertExpectedRevision(options.expectedRevision);
      this.#assertOperationBaseRevisions(operations);
      this.pendingRevision = this.#getRevision() + 1;
      this.historyContext = normalizeHistoryContext(options);
      let changed = false;

      for (const operation of operations) {
        if (!operation || typeof operation !== "object") {
          throw new TypeError("Each operation must be an object.");
        }
        if (operation.type === "upsert") {
          const value = Object.prototype.hasOwnProperty.call(operation, "value")
            ? operation.value
            : operation.record;
          changed = this.#upsertRecord(operation.section, value, operation.id, operation.position) || changed;
        } else if (operation.type === "delete") {
          changed = this.#deleteRecord(operation.section, operation.id) || changed;
        } else if (operation.type === "replaceSection") {
          changed = this.#replaceSection(operation.section, operation.value) || changed;
        } else if (operation.type === "reorder") {
          changed = this.#reorderRecords(operation.section, operation.ids) || changed;
        } else {
          throw new TypeError(`Unsupported operation type: ${String(operation.type)}`);
        }
      }

      const revision = changed ? this.#incrementRevision() : this.#getRevision();
      this.pendingRevision = 0;
      if (changed) {
        this.#pruneTombstones();
        this.#pruneHistory();
      }
      const result = {
        revision,
        // Deliberately left empty. Hashing the whole state is slow and nothing
        // on the write path needs it: `revision` is the sync token. Readers get
        // the hash lazily via readStateHash().
        stateHash: "",
        unchanged: !changed,
      };
      this.#recordMutation(mutationId, operationHash, result);
      return result;
    }));
  }

  // A consistent, fully checkpointed copy of the whole database (every
  // startup). VACUUM INTO is safe on a live database with an active WAL, unlike
  // copying the file. The snapshot is built under a temporary name and only
  // moved into place after it verifies.
  createSnapshot(outputPath, options = {}) {
    this.#assertOpen();
    if (!outputPath || typeof outputPath !== "string") {
      throw new TypeError("outputPath must be a non-empty string.");
    }

    const resolvedOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    if (fs.existsSync(resolvedOutputPath)) {
      if (options.overwrite !== true) {
        const error = new Error(`Refusing to overwrite existing snapshot: ${resolvedOutputPath}`);
        error.code = "EEXIST";
        throw error;
      }
      removeTemporaryDatabaseFiles(resolvedOutputPath);
    }

    const source = this.readDatabaseFingerprint();
    const temporaryPath = path.join(
      path.dirname(resolvedOutputPath),
      `.${path.basename(resolvedOutputPath)}.snapshotting-${process.pid}-${Date.now()}`,
    );
    removeTemporaryDatabaseFiles(temporaryPath);

    try {
      this.db.prepare("VACUUM INTO ?").run(temporaryPath);
      const verification = verifyDatabaseFile(temporaryPath, {
        expectedRevision: source.revision,
        expectedStateHash: source.stateHash,
      });
      if (!verification.ok) {
        throw new Error(`The snapshot of ${this.databasePath} did not verify: ${verification.problems.join("; ")}`);
      }
      fs.renameSync(temporaryPath, resolvedOutputPath);
      return {
        outputPath: resolvedOutputPath,
        bytes: fs.statSync(resolvedOutputPath).size,
        revision: source.revision,
        stateHash: source.stateHash,
        verification,
      };
    } finally {
      removeTemporaryDatabaseFiles(temporaryPath);
    }
  }

  // Whether this database is structurally sound. Cheap enough to run on every start.
  checkIntegrity() {
    this.#assertOpen();
    return readIntegrityReport(this.db);
  }

  #inScope(startupId, action) {
    const id = normalizeStartupId(startupId);
    const previous = this.#scope;
    if (previous !== null && previous !== id) {
      throw new Error(`A store call for ${id} cannot run inside a call for ${previous}.`);
    }
    this.#scope = id;
    try {
      return action();
    } finally {
      this.#scope = previous;
    }
  }

  #sid() {
    if (this.#scope === null) throw new Error("Internal error: no startup scope for this store call.");
    return this.#scope;
  }

  #configureDatabase() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    if (this.databasePath !== ":memory:" && !this.readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    }
  }

  // The schema version the file was written with. Version 0 is a new, empty
  // file; any other version than SCHEMA_VERSION is refused.
  #checkSchemaVersion() {
    const userVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${userVersion} is newer than supported version ${SCHEMA_VERSION}.`);
    }
    if (userVersion > 0 && userVersion < SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${userVersion} is not supported; this version opens schema version ${SCHEMA_VERSION} only.`);
    }
    return userVersion;
  }

  #initializeSchema(userVersion) {
    this.db.exec(SCHEMA_SQL);
    this.#setMetadata("schema_version", String(SCHEMA_VERSION));
    if (this.#getMetadata("database_revision") === undefined) this.#setMetadata("database_revision", "0");
    if (userVersion !== SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  #insertEntireState(state, revision = 0) {
    const sid = this.#sid();
    const insertSection = this.db.prepare(`
      INSERT INTO state_sections(startup_id, section_name, ordinal, kind, value_json, section_revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertRecord = this.db.prepare(`
      INSERT INTO state_records(startup_id, section_name, record_id, ordinal, value_json, record_revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    Object.entries(state).forEach(([sectionName, value], sectionOrdinal) => {
      validateSectionName(sectionName);
      if (Array.isArray(value)) {
        const records = validateCollection(value, sectionName);
        insertSection.run(sid, sectionName, sectionOrdinal, "collection", null, revision);
        records.forEach(({ id, json }, recordOrdinal) => {
          insertRecord.run(sid, sectionName, id, recordOrdinal, json, revision);
        });
      } else {
        insertSection.run(sid, sectionName, sectionOrdinal, "value", stringifyJsonValue(value, sectionName), revision);
      }
    });
  }

  #replaceSection(sectionName, value) {
    validateSectionName(sectionName);
    const sid = this.#sid();
    const current = this.#readSectionInScope(sectionName);
    if (current !== undefined && stableSerialize(current) === stableSerialize(value)) return false;

    const existing = this.db.prepare(`
      SELECT ordinal FROM state_sections WHERE startup_id = ? AND section_name = ?
    `).get(sid, sectionName);
    const ordinal = existing
      ? existing.ordinal
      : this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM state_sections WHERE startup_id = ?").get(sid).ordinal;

    // Replacing a whole collection rewrites every row, but only the rows whose
    // content actually differs should get a new revision.
    const previousRecords = new Map();
    if (existing) {
      for (const row of this.db.prepare(`
        SELECT record_id, value_json, record_revision FROM state_records WHERE startup_id = ? AND section_name = ?
      `).all(sid, sectionName)) {
        previousRecords.set(row.record_id, { json: row.value_json, revision: Number(row.record_revision) });
      }
      this.db.prepare("DELETE FROM state_sections WHERE startup_id = ? AND section_name = ?").run(sid, sectionName);
    }

    if (Array.isArray(value)) {
      const records = validateCollection(value, sectionName);
      this.db.prepare(`
        INSERT INTO state_sections(startup_id, section_name, ordinal, kind, value_json, section_revision)
        VALUES (?, ?, ?, 'collection', NULL, ?)
      `).run(sid, sectionName, ordinal, this.pendingRevision);
      const insertRecord = this.db.prepare(`
        INSERT INTO state_records(startup_id, section_name, record_id, ordinal, value_json, record_revision)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      records.forEach(({ id, json }, recordOrdinal) => {
        const previous = previousRecords.get(id);
        const unchanged = previous && stableSerialize(JSON.parse(previous.json)) === stableSerialize(JSON.parse(json));
        insertRecord.run(sid, sectionName, id, recordOrdinal, json, unchanged ? previous.revision : this.pendingRevision);
        if (!unchanged) {
          this.#logRecordHistory({
            sectionName,
            recordId: id,
            event: previous ? "updated" : "created",
            before: previous ? JSON.parse(previous.json) : undefined,
            after: JSON.parse(json),
            revision: this.pendingRevision,
          });
        }
        previousRecords.delete(id);
        this.#clearTombstone(sectionName, id);
      });
      // Whatever the replacement dropped is a deletion as far as other clients
      // are concerned, so it needs a tombstone like any other delete.
      for (const [droppedId, dropped] of previousRecords) {
        this.#recordTombstone(sectionName, droppedId);
        this.#logRecordHistory({
          sectionName,
          recordId: droppedId,
          event: "deleted",
          revision: this.pendingRevision,
          snapshot: JSON.parse(dropped.json),
        });
      }
    } else {
      this.db.prepare(`
        INSERT INTO state_sections(startup_id, section_name, ordinal, kind, value_json, section_revision)
        VALUES (?, ?, ?, 'value', ?, ?)
      `).run(sid, sectionName, ordinal, stringifyJsonValue(value, sectionName), this.pendingRevision);
    }
    return true;
  }

  #upsertRecord(sectionName, record, requestedId, position) {
    validateSectionName(sectionName);
    const sid = this.#sid();
    // The first record of a collection creates it. A new startup holds no
    // sections, and its page saves record by record like any other.
    if (!this.#sectionKind(sectionName)) this.#createEmptyCollection(sectionName);
    this.#assertCollection(sectionName);
    const { id, json } = validateRecord(record, sectionName);
    if (requestedId !== undefined && requestedId !== null && normalizeRecordId(requestedId) !== id) {
      throw new Error(`Upsert ID ${String(requestedId)} does not match value.id ${id}.`);
    }
    const existing = this.db.prepare(`
      SELECT value_json FROM state_records
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `).get(sid, sectionName, id);

    let changed = !existing || stableSerialize(JSON.parse(existing.value_json)) !== stableSerialize(record);

    if (existing) {
      if (changed) {
        this.db.prepare(`
          UPDATE state_records SET value_json = ?, record_revision = ?
          WHERE startup_id = ? AND section_name = ? AND record_id = ?
        `).run(json, this.pendingRevision, sid, sectionName, id);
        this.#logRecordHistory({
          sectionName,
          recordId: id,
          event: "updated",
          before: JSON.parse(existing.value_json),
          after: JSON.parse(json),
          revision: this.pendingRevision,
        });
      }
    } else {
      const nextOrdinal = this.db.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM state_records WHERE startup_id = ? AND section_name = ?
      `).get(sid, sectionName).ordinal;
      this.db.prepare(`
        INSERT INTO state_records(startup_id, section_name, record_id, ordinal, value_json, record_revision)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sid, sectionName, id, nextOrdinal, json, this.pendingRevision);
      // Re-creating a deleted ID retires its tombstone so a catching-up client
      // is not told to delete the record it is about to receive.
      this.#clearTombstone(sectionName, id);
      this.#stampSectionRevision(sectionName);
      this.#logRecordHistory({
        sectionName,
        recordId: id,
        event: "created",
        revision: this.pendingRevision,
      });
    }

    // Position on an existing upsert is only a snapshot hint from older
    // clients. Existing rows move only through an explicit reorder.
    if (!existing && position !== undefined && position !== null) {
      const normalizedPosition = readNonNegativeInteger(position, NaN);
      const recordCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM state_records WHERE startup_id = ? AND section_name = ?
      `).get(sid, sectionName).count);
      if (!Number.isSafeInteger(normalizedPosition) || normalizedPosition >= recordCount) {
        throw new RangeError(`Upsert position for ${sectionName}/${id} must be between 0 and ${recordCount - 1}.`);
      }
      changed = this.#moveRecord(sectionName, id, normalizedPosition) || changed;
    }
    return changed;
  }

  #deleteRecord(sectionName, recordId) {
    validateSectionName(sectionName);
    const sid = this.#sid();
    // Nothing to delete from a collection that was never created.
    if (!this.#sectionKind(sectionName)) return false;
    this.#assertCollection(sectionName);
    const normalizedId = normalizeRecordId(recordId);
    const existing = this.db.prepare(`
      SELECT value_json FROM state_records
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `).get(sid, sectionName, normalizedId);
    const result = this.db.prepare(`
      DELETE FROM state_records
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `).run(sid, sectionName, normalizedId);
    if (Number(result.changes) === 0) return false;
    this.#recordTombstone(sectionName, normalizedId);
    this.#stampSectionRevision(sectionName);
    this.#logRecordHistory({
      sectionName,
      recordId: normalizedId,
      event: "deleted",
      revision: this.pendingRevision,
      snapshot: existing ? JSON.parse(existing.value_json) : undefined,
    });
    return true;
  }

  #reorderRecords(sectionName, recordIds) {
    validateSectionName(sectionName);
    this.#assertCollection(sectionName);
    if (!Array.isArray(recordIds)) throw new TypeError("reorder ids must be an array.");
    const normalizedIds = recordIds.map(normalizeRecordId);
    if (new Set(normalizedIds).size !== normalizedIds.length) {
      throw new Error(`Reorder operation contains duplicate IDs for state section ${sectionName}.`);
    }
    const currentIds = this.#readOrder(sectionName);
    if (currentIds.length !== normalizedIds.length || currentIds.some((id) => !normalizedIds.includes(id))) {
      throw new Error(`Reorder operation must include every ID in state section ${sectionName} exactly once.`);
    }
    if (currentIds.every((id, index) => id === normalizedIds[index])) return false;
    this.#writeRecordOrder(sectionName, normalizedIds);
    // Order lives on the section, so a reorder bumps the section revision and
    // conflicts only with another reorder.
    this.#stampSectionRevision(sectionName);
    return true;
  }

  #readOrder(sectionName) {
    return this.db.prepare(`
      SELECT record_id FROM state_records
      WHERE startup_id = ? AND section_name = ? ORDER BY ordinal
    `).all(this.#sid(), sectionName).map((row) => row.record_id);
  }

  #moveRecord(sectionName, recordId, position) {
    const currentIds = this.#readOrder(sectionName);
    const currentPosition = currentIds.indexOf(recordId);
    if (currentPosition < 0) throw new Error(`Unknown record ${sectionName}/${recordId}.`);
    if (currentPosition === position) return false;
    currentIds.splice(currentPosition, 1);
    currentIds.splice(position, 0, recordId);
    this.#writeRecordOrder(sectionName, currentIds);
    this.#stampSectionRevision(sectionName);
    this.#stampRecordRevision(sectionName, recordId);
    return true;
  }

  #writeRecordOrder(sectionName, orderedIds) {
    const sid = this.#sid();
    const temporaryOffset = orderedIds.length + Number(this.db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS maximum
      FROM state_records WHERE startup_id = ? AND section_name = ?
    `).get(sid, sectionName).maximum) + 1;
    this.db.prepare(`
      UPDATE state_records SET ordinal = ordinal + ? WHERE startup_id = ? AND section_name = ?
    `).run(temporaryOffset, sid, sectionName);
    const updateOrdinal = this.db.prepare(`
      UPDATE state_records SET ordinal = ?
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `);
    orderedIds.forEach((id, ordinal) => updateOrdinal.run(ordinal, sid, sectionName, id));
  }

  #sectionKind(sectionName) {
    return this.db.prepare(`
      SELECT kind FROM state_sections WHERE startup_id = ? AND section_name = ?
    `).get(this.#sid(), sectionName)?.kind || null;
  }

  #createEmptyCollection(sectionName) {
    const sid = this.#sid();
    const ordinal = this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM state_sections WHERE startup_id = ?").get(sid).ordinal;
    this.db.prepare(`
      INSERT INTO state_sections(startup_id, section_name, ordinal, kind, value_json, section_revision)
      VALUES (?, ?, ?, 'collection', NULL, ?)
    `).run(sid, sectionName, ordinal, this.pendingRevision);
  }

  #assertCollection(sectionName) {
    const section = this.db.prepare(`
      SELECT kind FROM state_sections WHERE startup_id = ? AND section_name = ?
    `).get(this.#sid(), sectionName);
    if (!section) throw new TypeError(`Unknown state section: ${sectionName}`);
    if (section.kind !== "collection") throw new TypeError(`State section is not a collection: ${sectionName}`);
  }

  #getMetadata(key) {
    return this.db.prepare("SELECT value FROM tracker_metadata WHERE key = ?").get(key)?.value;
  }

  #setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO tracker_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE tracker_metadata.value <> excluded.value
    `).run(key, String(value));
  }

  #getRevision() {
    return Number(this.db.prepare("SELECT revision FROM startup_revisions WHERE startup_id = ?").get(this.#sid())?.revision || 0);
  }

  #getCompleteSince() {
    return Number(this.db.prepare(`
      SELECT changes_complete_since_revision AS value FROM startup_revisions WHERE startup_id = ?
    `).get(this.#sid())?.value || 0);
  }

  // Sets this startup's revision, and its changes-complete watermark when given.
  #writeRevision(revision, completeSince = null) {
    this.db.prepare(`
      INSERT INTO startup_revisions(startup_id, revision, changes_complete_since_revision)
      VALUES (?, ?, ?)
      ON CONFLICT(startup_id) DO UPDATE SET
        revision = excluded.revision,
        changes_complete_since_revision = CASE WHEN ? IS NULL THEN startup_revisions.changes_complete_since_revision ELSE excluded.changes_complete_since_revision END
    `).run(this.#sid(), revision, completeSince ?? 0, completeSince);
  }

  #incrementRevision() {
    const revision = this.#getRevision() + 1;
    this.#writeRevision(revision);
    this.#bumpDatabaseRevision();
    return revision;
  }

  // Counts writes across the whole database, for snapshot verification only.
  #bumpDatabaseRevision() {
    this.#setMetadata("database_revision", String(Number(this.#getMetadata("database_revision") || 0) + 1));
  }

  // Optimistic locking at record granularity. An operation carrying a
  // baseRevision only conflicts when the row it names moved on after that
  // revision, so concurrent edits to different records never collide.
  #assertOperationBaseRevisions(operations) {
    const sid = this.#sid();
    const conflicts = [];
    const readRecordRevision = this.db.prepare(`
      SELECT record_revision FROM state_records WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `);
    const readSectionRevision = this.db.prepare(`
      SELECT section_revision FROM state_sections WHERE startup_id = ? AND section_name = ?
    `);

    for (const operation of operations) {
      if (!operation || typeof operation !== "object") continue;
      if (operation.baseRevision === undefined || operation.baseRevision === null) continue;

      const base = readNonNegativeInteger(operation.baseRevision, NaN);
      if (!Number.isSafeInteger(base)) {
        throw new TypeError("operation.baseRevision must be a non-negative safe integer.");
      }

      if (operation.type === "upsert" || operation.type === "delete") {
        const section = operation.section;
        validateSectionName(section);
        const id = normalizeRecordId(
          operation.id !== undefined && operation.id !== null ? operation.id : operation.value?.id,
        );
        const row = readRecordRevision.get(sid, section, id);
        if (!row) {
          // Creating it fresh (base 0) is fine; editing a record someone else
          // deleted is a genuine conflict.
          if (base > 0) conflicts.push({ section, id, reason: "deleted", currentRevision: null });
          continue;
        }
        const currentRevision = Number(row.record_revision);
        if (currentRevision > base) conflicts.push({ section, id, reason: "modified", currentRevision });
        continue;
      }

      if (operation.type === "reorder" || operation.type === "replaceSection") {
        const section = operation.section;
        validateSectionName(section);
        const row = readSectionRevision.get(sid, section);
        if (!row) continue;
        const currentRevision = Number(row.section_revision);
        if (currentRevision > base) conflicts.push({ section, id: null, reason: "modified", currentRevision });
      }
    }

    if (conflicts.length > 0) throw new RecordConflictError(conflicts);
  }

  #stampSectionRevision(sectionName) {
    if (!this.pendingRevision) return;
    this.db.prepare(`
      UPDATE state_sections SET section_revision = ? WHERE startup_id = ? AND section_name = ?
    `).run(this.pendingRevision, this.#sid(), sectionName);
  }

  #stampRecordRevision(sectionName, recordId) {
    if (!this.pendingRevision) return;
    this.db.prepare(`
      UPDATE state_records SET record_revision = ?
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `).run(this.pendingRevision, this.#sid(), sectionName, recordId);
  }

  #recordTombstone(sectionName, recordId) {
    if (!this.pendingRevision) return;
    this.db.prepare(`
      INSERT INTO deleted_records(startup_id, section_name, record_id, deleted_revision)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(startup_id, section_name, record_id) DO UPDATE SET deleted_revision = excluded.deleted_revision
    `).run(this.#sid(), sectionName, recordId, this.pendingRevision);
  }

  #clearTombstone(sectionName, recordId) {
    this.db.prepare(`
      DELETE FROM deleted_records WHERE startup_id = ? AND section_name = ? AND record_id = ?
    `).run(this.#sid(), sectionName, recordId);
  }

  #pruneTombstones() {
    const sid = this.#sid();
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM deleted_records WHERE startup_id = ?").get(sid).count);
    if (count <= this.maxTombstones) return;
    const removedThrough = Number(this.db.prepare(`
      SELECT MAX(deleted_revision) AS revision FROM (
        SELECT deleted_revision FROM deleted_records
        WHERE startup_id = ?
        ORDER BY deleted_revision ASC
        LIMIT ?
      )
    `).get(sid, count - this.maxTombstones).revision || 0);
    this.db.prepare(`
      DELETE FROM deleted_records WHERE rowid IN (
        SELECT rowid FROM deleted_records
        WHERE startup_id = ?
        ORDER BY deleted_revision ASC
        LIMIT ?
      )
    `).run(sid, count - this.maxTombstones);
    if (removedThrough > this.#getCompleteSince()) {
      this.db.prepare(`
        UPDATE startup_revisions SET changes_complete_since_revision = ? WHERE startup_id = ?
      `).run(removedThrough, sid);
    }
  }

  // History is written by every funnel that changes record content:
  // #upsertRecord, #deleteRecord, #replaceSection and the whole-state
  // replacement in replaceState. Deliberately never called from #reorderRecords
  // or #moveRecord, which change only the order.
  //
  // Returns true when an entry was written or folded into an existing one.
  #logRecordHistory(entry) {
    if (this.readOnly) return false;
    const context = this.historyContext || normalizeHistoryContext();
    const event = HISTORY_EVENTS.has(entry.event) ? entry.event : "updated";
    const fields = event === "updated"
      ? describeFieldChanges(entry.before, entry.after)
      : [];

    // A save that only moved updatedAt is not a change anyone wants to read about.
    if (event === "updated" && fields.length === 0) return false;

    const changedAt = context.changedAt;
    const revision = readNonNegativeInteger(entry.revision, 0);
    if (this.#coalesceHistoryEntry(entry, event, fields, context, revision)) return true;

    this.db.prepare(`
      INSERT INTO record_history(
        startup_id, section_name, record_id, event, revision, changed_at, session_started_at,
        origin, actor, label, approximate, fields_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.#sid(),
      entry.sectionName,
      entry.recordId,
      event,
      revision,
      changedAt,
      changedAt,
      context.origin,
      context.actor,
      context.label,
      context.approximate ? 1 : 0,
      JSON.stringify(fields),
      event === "deleted" && entry.snapshot !== undefined
        ? JSON.stringify(clampHistoryValue(entry.snapshot))
        : null,
    );
    return true;
  }

  // Folds an edit into the record's most recent entry when both belong to the
  // same editing session. Returns true when the edit was absorbed.
  #coalesceHistoryEntry(entry, event, fields, context, revision) {
    if (event !== "updated") return false;
    const previous = this.db.prepare(`
      SELECT entry_id, event, changed_at, session_started_at, origin, actor, approximate, fields_json
      FROM record_history
      WHERE startup_id = ? AND section_name = ? AND record_id = ?
      ORDER BY entry_id DESC
      LIMIT 1
    `).get(this.#sid(), entry.sectionName, entry.recordId);
    if (!previous) return false;
    // A delete ends the session. Anything after it belongs to a new record life.
    if (previous.event !== "updated" && previous.event !== "created") return false;
    if (previous.origin !== context.origin) return false;
    if ((previous.actor ?? null) !== context.actor) return false;
    if (Number(previous.approximate) !== (context.approximate ? 1 : 0)) return false;

    const now = Date.parse(context.changedAt);
    const previousAt = Date.parse(previous.changed_at);
    const sessionStart = Date.parse(previous.session_started_at);
    if (!Number.isFinite(now) || !Number.isFinite(previousAt) || !Number.isFinite(sessionStart)) return false;
    if (now < previousAt) return false;
    if (now - previousAt > HISTORY_SESSION_GAP_MS) return false;
    if (now - sessionStart > HISTORY_SESSION_MAX_SPAN_MS) return false;

    const merged = new Map();
    for (const field of parseHistoryFields(previous.fields_json)) merged.set(field.path, field);
    for (const field of fields) {
      const existing = merged.get(field.path);
      // The session's before-value is the one it started from, so only the
      // after-value moves.
      if (existing) existing.after = field.after;
      else merged.set(field.path, field);
    }

    // An edit typed and then undone within the session is not a change.
    const remaining = [...merged.values()].filter((field) => !valuesEqual(field.before, field.after));
    if (remaining.length === 0 && previous.event === "updated") {
      this.db.prepare("DELETE FROM record_history WHERE entry_id = ?").run(previous.entry_id);
      return true;
    }
    // Creating a record and refining it inside the session is one creation.
    if (previous.event === "created") {
      for (const field of remaining) delete field.before;
    }
    this.db.prepare(`
      UPDATE record_history
      SET fields_json = ?, changed_at = ?, revision = ?, label = COALESCE(?, label)
      WHERE entry_id = ?
    `).run(JSON.stringify(remaining), context.changedAt, revision, context.label, previous.entry_id);
    return true;
  }

  // Per-record history for a whole-state replacement, so restores and imports
  // explain themselves record by record.
  #logStateReplacementHistory(previousState, nextState, revision) {
    if (this.readOnly) return;
    const previousSections = collectionsOf(previousState);
    const nextSections = collectionsOf(nextState);

    for (const [sectionName, nextRecords] of nextSections) {
      const previousRecords = previousSections.get(sectionName) || new Map();
      for (const [recordId, record] of nextRecords) {
        const before = previousRecords.get(recordId);
        this.#logRecordHistory({
          sectionName,
          recordId,
          event: before === undefined ? "created" : "updated",
          before,
          after: record,
          revision,
        });
      }
    }

    for (const [sectionName, previousRecords] of previousSections) {
      const nextRecords = nextSections.get(sectionName);
      // A section missing from the replacement is a schema change, not mass deletion.
      if (!nextRecords) continue;
      for (const [recordId, record] of previousRecords) {
        if (nextRecords.has(recordId)) continue;
        this.#logRecordHistory({ sectionName, recordId, event: "deleted", revision, snapshot: record });
      }
    }
  }

  #pruneHistory() {
    const sid = this.#sid();
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM record_history WHERE startup_id = ?").get(sid).count);
    if (count <= this.maxHistoryEntries) return;
    this.db.prepare(`
      DELETE FROM record_history
      WHERE entry_id IN (
        SELECT entry_id FROM record_history
        WHERE startup_id = ?
        ORDER BY changed_at ASC, entry_id ASC
        LIMIT ?
      )
    `).run(sid, count - this.maxHistoryEntries);
  }

  #hasHistoryTable() {
    if (this.historyTableExists === null) {
      this.historyTableExists = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'record_history'
      `).get() !== undefined;
    }
    return this.historyTableExists;
  }

  #assertExpectedRevision(expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) return;
    const normalizedExpected = readNonNegativeInteger(expectedRevision, NaN);
    if (!Number.isSafeInteger(normalizedExpected)) {
      throw new TypeError("expectedRevision must be a non-negative safe integer.");
    }
    const actualRevision = this.#getRevision();
    if (actualRevision !== normalizedExpected) {
      throw new RevisionConflictError(normalizedExpected, actualRevision);
    }
  }

  #getMutationReplay(mutationId, operationHash) {
    if (!mutationId) return null;
    const row = this.db.prepare(`
      SELECT operation_hash, result_revision, result_state_hash, result_unchanged
      FROM applied_mutations WHERE startup_id = ? AND mutation_id = ?
    `).get(this.#sid(), mutationId);
    if (!row) return null;
    if (row.operation_hash !== operationHash) {
      const error = new Error(`Mutation ID ${mutationId} was already used for different operations.`);
      error.code = "SQLITE_TRACKER_MUTATION_ID_REUSED";
      throw error;
    }
    return {
      revision: Number(row.result_revision),
      stateHash: row.result_state_hash,
      unchanged: Boolean(row.result_unchanged),
      replayed: true,
    };
  }

  #recordMutation(mutationId, operationHash, result) {
    if (!mutationId) return;
    const sid = this.#sid();
    this.db.prepare(`
      INSERT INTO applied_mutations(
        startup_id, mutation_id, operation_hash, result_revision,
        result_state_hash, result_unchanged, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sid, mutationId, operationHash, result.revision, result.stateHash, result.unchanged ? 1 : 0, new Date().toISOString());
    this.db.prepare(`
      DELETE FROM applied_mutations
      WHERE startup_id = ? AND mutation_id IN (
        SELECT mutation_id FROM applied_mutations
        WHERE startup_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(sid, sid, MAX_RECORDED_MUTATIONS);
  }

  #withTransaction(action) {
    this.#assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      // A cached hash can outlive the rollback that undid the rows it was
      // computed from.
      if (this.#scope !== null) this.hashCache.delete(this.#scope);
      throw error;
    } finally {
      this.pendingRevision = 0;
      this.historyContext = null;
    }
  }

  #assertOpen() {
    if (this.closed) throw new Error("TrackerSqliteStore is closed.");
  }
}

function serializeState(state) {
  validateState(state);
  return `${JSON.stringify(state, null, 2)}\n`;
}

function stableSerialize(value) {
  return JSON.stringify(normalizeJson(value));
}

function readImportedHistoryJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new TypeError("Imported history JSON is not valid.");
    }
  }
  return value;
}

function normalizeHistoryContext(options = {}) {
  const origin = typeof options.origin === "string" && HISTORY_ORIGINS.has(options.origin)
    ? options.origin
    : "api";
  const actor = readHistoryText(options.actor, 200);
  const label = readHistoryText(options.label, 500);
  // Backfilled entries carry the commit timestamp they were reconstructed from,
  // so the caller has to be able to supply the time rather than getting "now".
  const supplied = typeof options.changedAt === "string" ? Date.parse(options.changedAt) : NaN;
  const changedAt = Number.isFinite(supplied)
    ? new Date(supplied).toISOString()
    : new Date().toISOString();
  return { origin, actor, label, approximate: options.approximate === true, changedAt };
}

function readHistoryText(value, maximumLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, maximumLength);
}

// The changed fields between two versions of a record, as
// [{ path, before, after }] with the value keys omitted where the field did not
// exist on that side.
//
// Mirrors listChangedPaths in public/scripts/record-conflict-merge.js -- plain objects
// recurse, arrays and scalars compare whole -- but carries the values along
// instead of returning paths alone. Resolving dotted paths afterwards would be
// ambiguous, because record keys written by tools or imports may themselves
// contain dots.
function describeFieldChanges(before, after) {
  const fields = [];
  walkFieldChanges(before, after, "", fields);
  return fields;
}

function walkFieldChanges(before, after, parentPath, fields) {
  const beforeObject = isPlainObject(before) ? before : null;
  const afterObject = isPlainObject(after) ? after : null;
  const keys = new Set([
    ...(beforeObject ? Object.keys(beforeObject) : []),
    ...(afterObject ? Object.keys(afterObject) : []),
  ]);

  for (const key of keys) {
    const fieldPath = parentPath ? `${parentPath}.${key}` : key;
    if (DEFAULT_IGNORED_PATHS.has(fieldPath)) continue;
    const beforeValue = beforeObject ? beforeObject[key] : undefined;
    const afterValue = afterObject ? afterObject[key] : undefined;
    if (valuesEqual(beforeValue, afterValue)) continue;

    // Nested objects recurse so that changing one key of programs.details reads
    // as that one key rather than as the whole object being replaced. Arrays stay
    // whole, which is what the added/removed renderer for tags and linked IDs
    // wants.
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      walkFieldChanges(beforeValue, afterValue, fieldPath, fields);
      continue;
    }

    const field = { path: fieldPath };
    if (beforeValue !== undefined) field.before = clampHistoryValue(beforeValue);
    if (afterValue !== undefined) field.after = clampHistoryValue(afterValue);
    fields.push(field);
  }
}

function parseHistoryFields(fieldsJson) {
  try {
    const parsed = JSON.parse(fieldsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((field) => field && typeof field.path === "string");
  } catch {
    return [];
  }
}

// Bounds a single stored value. Notes top out around 20k characters today, so
// this only fires if something pastes a log file into a record.
function clampHistoryValue(value) {
  if (typeof value === "string") {
    if (value.length <= HISTORY_MAX_VALUE_CHARS) return value;
    return { truncated: true, length: value.length, text: value.slice(0, HISTORY_MAX_VALUE_CHARS) };
  }
  if (value === null || typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= HISTORY_MAX_VALUE_CHARS) return value;
  return { truncated: true, length: serialized.length };
}

function collectionsOf(state) {
  const sections = new Map();
  if (!state || typeof state !== "object") return sections;
  for (const [sectionName, value] of Object.entries(state)) {
    if (!Array.isArray(value)) continue;
    const records = new Map();
    for (const record of value) {
      if (!record || record.id === undefined || record.id === null) continue;
      records.set(String(record.id), record);
    }
    sections.set(sectionName, records);
  }
  return sections;
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson(value[key]);
    }
    return normalized;
  }
  return value;
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Tracker state must be a JSON object.");
  }
  for (const [sectionName, value] of Object.entries(state)) {
    validateSectionName(sectionName);
    if (Array.isArray(value)) validateCollection(value, sectionName);
    else stringifyJsonValue(value, sectionName);
  }
}

function validateCollection(collection, sectionName) {
  const ids = new Set();
  return collection.map((record) => {
    const validated = validateRecord(record, sectionName);
    if (ids.has(validated.id)) {
      throw new Error(`Duplicate record ID ${validated.id} in state section ${sectionName}.`);
    }
    ids.add(validated.id);
    return validated;
  });
}

function validateRecord(record, sectionName) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`Every record in state section ${sectionName} must be an object.`);
  }
  const id = normalizeRecordId(record.id);
  return { id, json: stringifyJsonValue(record, `${sectionName}/${id}`) };
}

// Namespace prefix for readToolMetadata / writeToolMetadata, so a maintenance
// tool cannot land on `revision` or `schema_version` by choosing the same name.
function toolMetadataKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("Tool metadata keys must be non-empty strings.");
  }
  if (!/^[a-z0-9_.-]+$/i.test(key)) {
    throw new TypeError(`Tool metadata key has characters outside [A-Za-z0-9_.-]: ${key}`);
  }
  return `tool:${key}`;
}

function normalizeRecordId(recordId) {
  if ((typeof recordId !== "string" && typeof recordId !== "number") || String(recordId).length === 0) {
    throw new TypeError("Record IDs must be non-empty strings or numbers.");
  }
  return String(recordId);
}

function normalizeMutationId(mutationId) {
  if (mutationId === undefined || mutationId === null || mutationId === "") return "";
  if (typeof mutationId !== "string" || mutationId.length > 200) {
    throw new TypeError("mutationId must be a non-empty string of at most 200 characters.");
  }
  return mutationId;
}

function validateSectionName(sectionName) {
  if (typeof sectionName !== "string" || sectionName.length === 0) {
    throw new TypeError("State section names must be non-empty strings.");
  }
}

function stringifyJsonValue(value, label) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`State value ${label} is not valid JSON: ${error.message}`);
  }
  if (json === undefined) throw new TypeError(`State value ${label} is not valid JSON.`);
  return json;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// SQLite's own structural checks. `integrity_check` walks every page, index and
// row; `foreign_key_check` catches references the schema's constraints would
// have rejected. Together they are what distinguishes "this file exists" from
// "this file is a database we can restore from".
function readIntegrityReport(db) {
  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  const integrity = integrityRows.map((row) => Object.values(row)[0]);
  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  return {
    ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeyErrors.length === 0,
    integrity,
    foreignKeyErrors,
  };
}

// Open a database file and prove it is usable before anything depends on it.
// Used on every snapshot right after it is written, and again before a restore
// overwrites live data -- restoring from an unverified file is how one bad
// backup turns into no backup at all.
//
// Callers may pass the revision and state hash the file is supposed to contain.
// The hash is the strong check: it is computed from the fully deserialized
// state, so it catches content that decoded without error but is not what was
// snapshotted.
function verifyDatabaseFile(databasePath, expected = {}) {
  const resolvedPath = path.resolve(databasePath);
  const problems = [];

  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, problems: [`No such file: ${resolvedPath}`], databasePath: resolvedPath };
  }

  let db = null;
  let report = null;
  let revision = 0;
  let stateHash = "";
  let recordCount = 0;
  let sectionCount = 0;
  let initialized = false;
  let startupCount = 0;

  try {
    db = new DatabaseSync(resolvedPath, { readOnly: true });
    report = readIntegrityReport(db);
    if (!report.ok) {
      if (report.integrity.length !== 1 || report.integrity[0] !== "ok") {
        problems.push(`integrity_check reported: ${report.integrity.join(", ")}`);
      }
      if (report.foreignKeyErrors.length > 0) {
        problems.push(`foreign_key_check reported ${report.foreignKeyErrors.length} broken reference(s)`);
      }
    }

    // A file that opens cleanly but has no tracker tables is a database that was
    // never initialized, not a damaged one. Callers that need real content ask
    // for it with expectedStateHash or minimumRecordCount.
    initialized = db
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'state_records'")
      .get().count > 0;
    if (initialized) {
      recordCount = Number(db.prepare("SELECT count(*) AS count FROM state_records").get().count);
      sectionCount = Number(db.prepare("SELECT count(*) AS count FROM state_sections").get().count);
    }
  } catch (error) {
    problems.push(`Could not read the database: ${error.message}`);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // A database that cannot be closed cleanly has already failed above.
      }
    }
  }

  // Reading the state through the store proves every record still deserializes
  // and yields the same hash the source had, which the page-level checks cannot
  // tell us on their own. The store also refuses a schema version it does not
  // open.
  if (problems.length === 0 && initialized) {
    let store = null;
    try {
      store = new TrackerSqliteStore(resolvedPath, { readOnly: true });
      const fingerprint = store.readDatabaseFingerprint();
      revision = fingerprint.revision;
      stateHash = fingerprint.stateHash;
      startupCount = fingerprint.startupCount;
    } catch (error) {
      problems.push(`Could not load the tracker state: ${error.message}`);
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          // Already reported above if the database itself is unusable.
        }
      }
    }
  }

  if (expected.expectedRevision !== undefined && revision !== expected.expectedRevision) {
    problems.push(`Expected revision ${expected.expectedRevision} but the file holds ${revision}.`);
  }
  if (expected.expectedStateHash && stateHash !== expected.expectedStateHash) {
    problems.push("The state hash does not match the database this was copied from.");
  }
  if (expected.minimumRecordCount !== undefined && recordCount < expected.minimumRecordCount) {
    problems.push(`Expected at least ${expected.minimumRecordCount} records but found ${recordCount}.`);
  }

  return {
    ok: problems.length === 0,
    problems,
    databasePath: resolvedPath,
    bytes: fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0,
    initialized,
    startupCount,
    revision,
    stateHash,
    recordCount,
    sectionCount,
    integrity: report ? report.integrity : [],
    foreignKeyErrors: report ? report.foreignKeyErrors : [],
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function removeTemporaryDatabaseFiles(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${databasePath}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

module.exports = {
  GLOBAL_STARTUP_ID,
  RecordConflictError,
  RevisionConflictError,
  SCHEMA_VERSION,
  STARTUPS_SECTION,
  TrackerSqliteStore,
  makeStartupId,
  normalizeStartupId,
  serializeState,
  stableSerialize,
  verifyDatabaseFile,
};
