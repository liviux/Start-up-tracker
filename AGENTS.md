# AGENTS.md

Guidance for people and coding agents working on Startup Tracker. This file is public: it never contains personal data such as real names, host names, local paths or account ids.

## What this is

A local, single-user tracker for a startup's marketing (MK), programs and opportunities (PO), funding (FU) and company tasks. It runs on Node.js 22.16 or newer with the built-in SQLite module and has no build step.

- Server: `server.js` (entry point) and `lib/` (store, data folder, HTTP checks in `lib/http/`).
- Browser code: `public/` (`index.html`, `app.js`, `js/`, `scripts/`, `styles/`, `assets/`). Only `public/` and `content/` are served.
- Reviewable content: `content/` (JSON, checked by `npm run check`).
- Tests: `tests/`. Tools: `tools/`. User docs: `docs/` (Markdown).

## Commands

- `npm install` once, for the development tools.
- `npm start`: port 57322, data in `~/.startup-tracker`. `npm run dev`: data in `~/.startup-tracker-dev`, port 57323, no browser.
- `npm test`: every test, with a temporary data folder and random free ports. One file: `node tools/run-tests.js tests/<file>.test.js`.
- `npm run check`: syntax, CSS, content JSON, ESLint (no warnings allowed), leak scan (add your own patterns with `LEAK_PATTERNS_FILE=<file>`), banned words, and UI text from `content/i18n/en.json` (see docs/development.md, "Interface text").
- `node bin/startup-tracker.js <command>`: the `startup-tracker` command from the code folder (docs/cli.md). `node tools/build-release.js --allow-dirty` builds a release archive for `install.sh --archive`.
- `node tools/demo-data.js --data-dir ~/.startup-tracker-dev`: fictional demo data (the folder is always named).
- A throwaway server: `PORT=0 NO_OPEN=1 STARTUP_TRACKER_HOME=<tmp> node server.js`.
- Never run tests or development servers against a tracker you use for real work: keep to `npm run dev`, a throwaway data folder and a free port.

## How to work

- Ask when there are several valid ways forward.
- Consider the impact of a change on the other parts of the app.
- Keep stored data compatible: schema changes need an upgrade path in the store and a test.
- Fix failing tests, lint errors and warnings you find, even unrelated ones.
- No end-to-end or full lifecycle tests: the owner reviews the UI. For small changes, run only the related tests and checks.
- `tests/frontend-sync-contract.test.js` reads `app.js` as text. When code leaves `app.js`, rewrite the affected checks as behaviour tests on the new module in the same commit. Never skip or delete them to make a change pass.

## No invented data

Never invent metrics, dates, fees, eligibility or results. Use official pages for facts, or leave the field empty. Company templates need official sources with a "verified on" date. Example data is clearly fictional and uses `example.com`.

## Up-to-date documentation

Search online for current documentation of frameworks and protocols (ACP, MCP, Docsify) instead of relying on memory.

## Data

- The data folder lives outside the repository: `~/.startup-tracker`, or `~/.startup-tracker-dev` in development (docs/development.md, "Where data lives"). Never commit data, media, backups, logs or secrets. `.gitignore` blocks the usual files, and `tools/check-leaks.js` refuses them.
- Before bulk or destructive changes, take a pinned backup: `node tools/backup-sqlite.js --label <what>`.
- Recovery: `node tools/restore-sqlite.js --list`, then with `--snapshot <backup>` (a backup id, or an older `tracker-*.sqlite` file name): `--record <startupId>/<section>/<id>` for one record, `--startup <id>` for one startup and its media, or nothing more for a whole-database restore with the server stopped.
- `node tools/about.js` prints the data folder, database facts and integrity without changing anything.
- Write through the API or the store's transactional methods. To read outside the app, open the database read-only with `new TrackerSqliteStore(path, { readOnly: true })` and call `readState(startupId)` (`listStartupIds()` lists them; `_global` holds shared settings and the startup list). Never edit the database with ad hoc SQL.
- Tests and tools refuse the real data folder unless it is named: a test run stops when no data folder is given. Dev runs use port 57323, tests and checks a temporary data folder and a random free port (`PORT=0`), all with `NO_OPEN=1`, so they never reach a running tracker.

## Store contract

- One database holds every startup. Every read and write names its startup id first; there is no default, and a missing id throws. Revisions, tombstone caps and history caps count per startup.

- Locking is per record, not per database. Records carry `record_revision` and sections carry `section_revision`; an operation may include `baseRevision` and is rejected only when that record moved. Never reintroduce a whole-database revision check on the save path.
- `applyOperations` returns an empty `stateHash` on purpose; `revision` is the sync token. Use `store.readStateHash()` when a hash is really needed.
- A rejected edit waits in the outbox with `blockedByConflict` until the user picks "Keep mine" or "Use theirs". Never call `rebaseBlockedConflictBatches()` from `persist()` or any autosave path. Use `hasSendableOutboxBatch()` and `firstSendableOutboxIndex()`, never `pendingOutbox.length`, for the send queue.
- `SCHEMA_VERSION` in `lib/tracker-sqlite-store.js` changes only with an upgrade path in `#initializeSchema` (version 3 to 4 is `#upgradeLegacyDatabase`) and a test that opening an older database keeps every record unchanged.
- `record_history` is written only through the store (`appendRecordHistory()` or the normal save path), and every write carries an origin (`ui`, `api`, `tool`, `agent`, `restore`, `import`). The history route sends no ETag.
- Tool metadata lives under `tool:` keys (`readToolMetadata` / `writeToolMetadata`).
- The server verifies the database before opening it and refuses to start on a damaged one. Never skip that check.

## Running instance

If the tracker runs as a service (`startup-tracker autostart on`), keep it running after your changes: `startup-tracker status` says whether it runs and where, and `curl -I http://127.0.0.1:<port>/` should answer 200. When you stop it for maintenance, start it again with `startup-tracker start --no-open`. The commands are in docs/cli.md.

## Translations and content

- Every UI string comes from `content/i18n/en.json` through `t()` or a `data-i18n*` attribute (docs/development.md, "Interface text"). `npm run check` flags hard-coded text, and `?pseudo-locale=1` shows keys instead of text.
- Content (categories, fields, statuses, prompts, company templates, the agent registry) is JSON under `content/`, validated by `npm run check`.

## Static files

The server adds `?v=<content hash>` to the page's script and style URLs and caches those for a year. Reference scripts and styles in `index.html` by plain paths and let the server version them; a hand-written URL elsewhere needs the same `?v=`.

## Scripts

One-off scripts go in `temp/` (ignored by git) and are deleted afterwards. Permanent tools go in `tools/` with tests.

## Other people's work

Never delete uncommitted files or work you did not create.

## Commits

Clear messages, nothing over 40 MB, no data files ever. Commit with your GitHub noreply address. `node tools/install-git-hooks.js` installs a pre-commit hook that runs the leak check on staged files.

## Human writing

For the README, docs, release notes and UI copy, write plainly and specifically: no inflated claims, no filler, no generic conclusions. See the Humanizer guidance at https://github.com/blader/humanizer.
