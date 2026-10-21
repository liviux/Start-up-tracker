"use strict";

// Writes databases in the layouts used before startups existed, with raw SQL,
// so the store's upgrade path can be tested against the real old shapes.

const { DatabaseSync } = require("node:sqlite");

const V3_SQL = `
  CREATE TABLE tracker_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE state_sections (
    section_name TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('collection', 'value')),
    value_json TEXT,
    section_revision INTEGER NOT NULL DEFAULT 0 CHECK (section_revision >= 0)
  ) STRICT;
  CREATE TABLE state_records (
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    value_json TEXT NOT NULL,
    record_revision INTEGER NOT NULL DEFAULT 0 CHECK (record_revision >= 0),
    PRIMARY KEY (section_name, record_id),
    UNIQUE (section_name, ordinal),
    FOREIGN KEY (section_name) REFERENCES state_sections(section_name) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX state_records_order_idx ON state_records(section_name, ordinal);
  CREATE TABLE deleted_records (
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    deleted_revision INTEGER NOT NULL CHECK (deleted_revision >= 0),
    PRIMARY KEY (section_name, record_id)
  ) STRICT;
  CREATE INDEX deleted_records_revision_idx ON deleted_records(deleted_revision);
  CREATE TABLE applied_mutations (
    mutation_id TEXT PRIMARY KEY,
    operation_hash TEXT NOT NULL,
    result_revision INTEGER NOT NULL,
    result_state_hash TEXT NOT NULL,
    result_unchanged INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX applied_mutations_created_idx ON applied_mutations(created_at);
  CREATE TABLE record_history (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    event TEXT NOT NULL,
    revision INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    session_started_at TEXT NOT NULL,
    origin TEXT NOT NULL,
    actor TEXT,
    label TEXT,
    approximate INTEGER NOT NULL DEFAULT 0,
    fields_json TEXT NOT NULL,
    snapshot_json TEXT
  ) STRICT;
  CREATE INDEX record_history_record_idx ON record_history(section_name, record_id, changed_at);
  CREATE INDEX record_history_changed_idx ON record_history(changed_at);
`;

const V1_SQL = `
  CREATE TABLE tracker_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE state_sections (
    section_name TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('collection', 'value')),
    value_json TEXT
  ) STRICT;
  CREATE TABLE state_records (
    section_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    value_json TEXT NOT NULL,
    PRIMARY KEY (section_name, record_id),
    UNIQUE (section_name, ordinal),
    FOREIGN KEY (section_name) REFERENCES state_sections(section_name) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE applied_mutations (
    mutation_id TEXT PRIMARY KEY,
    operation_hash TEXT NOT NULL,
    result_revision INTEGER NOT NULL,
    result_state_hash TEXT NOT NULL,
    result_unchanged INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`;

// state: { sectionName: array of records | value }. Returns the raw rows written.
function writeLegacyDatabase(databasePath, state, { version = 3, revision = 7, history = [] } = {}) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(version === 1 ? V1_SQL : V3_SQL);
    db.prepare("INSERT INTO tracker_metadata(key, value) VALUES ('schema_version', ?), ('revision', ?), ('changes_complete_since_revision', '0')")
      .run(String(version), String(revision));
    Object.entries(state).forEach(([section, value], ordinal) => {
      if (Array.isArray(value)) {
        if (version === 1) db.prepare("INSERT INTO state_sections VALUES (?, ?, 'collection', NULL)").run(section, ordinal);
        else db.prepare("INSERT INTO state_sections VALUES (?, ?, 'collection', NULL, ?)").run(section, ordinal, revision);
        value.forEach((record, index) => {
          if (version === 1) db.prepare("INSERT INTO state_records VALUES (?, ?, ?, ?)").run(section, String(record.id), index, JSON.stringify(record));
          else db.prepare("INSERT INTO state_records VALUES (?, ?, ?, ?, ?)").run(section, String(record.id), index, JSON.stringify(record), revision);
        });
      } else if (version === 1) {
        db.prepare("INSERT INTO state_sections VALUES (?, ?, 'value', ?)").run(section, ordinal, JSON.stringify(value));
      } else {
        db.prepare("INSERT INTO state_sections VALUES (?, ?, 'value', ?, ?)").run(section, ordinal, JSON.stringify(value), revision);
      }
    });
    if (version === 3) {
      for (const entry of history) {
        db.prepare(`INSERT INTO record_history(section_name, record_id, event, revision, changed_at, session_started_at, origin, actor, label, approximate, fields_json, snapshot_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, '[]', NULL)`).run(entry.section, entry.id, entry.event, revision, entry.at, entry.at, entry.origin || "ui");
      }
    }
    db.exec(`PRAGMA user_version = ${version}`);
    return {
      records: db.prepare("SELECT section_name, record_id, value_json FROM state_records ORDER BY section_name, ordinal").all(),
      sections: db.prepare("SELECT section_name, kind, value_json FROM state_sections ORDER BY ordinal").all(),
    };
  } finally {
    db.close();
  }
}

module.exports = { writeLegacyDatabase };
