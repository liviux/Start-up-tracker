# AGENTS.md

Guidance for people and coding agents working on Startup Tracker. This file is public: it never contains personal data such as real names, host names, local paths or account ids.

## What this is

A local, single-user tracker for a startup's marketing (MK), programs and opportunities (PO), funding (FU) and company tasks. It runs on Node.js 22.16 or newer with the built-in SQLite module and has no build step.

- Server: `server.js` (entry point) and `lib/` (store, data folder, HTTP checks in `lib/http/`).
- Browser code: `public/` (`index.html`, `app.js`, `js/`, `scripts/`, `styles/`, `assets/`). Only `public/` and `content/` are served.
- Reviewable content: `content/` (JSON, checked by `npm run check`).
- Tests: `tests/`. Tools: `tools/`. User docs: `docs/` (Markdown).

## How to work

- Ask when there are several valid ways forward. Always ask questions when there is ambiguity.
- Use subagents whenever you consider.
- Consider the impact of a change on the other parts of the app.
- Keep stored data compatible: schema changes need an upgrade path in the store and a test.
- Fix failing tests, lint errors and warnings you find, even unrelated ones.
- `tests/frontend-sync-contract.test.js` reads `app.js` as text. When code leaves `app.js`, rewrite the affected checks as behaviour tests on the new module in the same commit. Never skip or delete them to make a change pass.

## No invented data

Never invent metrics, dates, fees, eligibility or results. Use official pages for facts, or leave the field empty. Company templates need official sources with a "verified on" date. Example data is clearly fictional and uses `example.com`.

## Up-to-date documentation

Search online for current documentation of frameworks and protocols instead of relying on memory.

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

Clear messages, no data files ever. Commit with your GitHub noreply address. `node tools/install-git-hooks.js` installs a pre-commit hook that runs the leak check on staged files.

Commit directly to `main`. Do not create a branch or a pull request unless the user explicitly asks for one.

"Push to main" means all of this, without asking. Every push is a release, following semantic versioning: MAJOR for a breaking change (data that older code can't read, a removed feature, a different way to install or run), MINOR for a new feature, PATCH for a fix, a copy or style tweak, or docs. Pick the bump from the largest change in the push.

1. Set the version with `npm version <major|minor|patch> --no-git-tag-version` (`package.json` and `package-lock.json`) and in `APP_VERSION` in `public/js/api.js`.
2. Add a `## [x.y.z] - <date>` section at the top of `CHANGELOG.md`, with only the headings needed (`Added`, `Changed`, `Fixed`, `Removed`). Say what changed for the user, in short lines.
3. Run `npm run check` and `npm test`, commit everything together and push to `main`.
4. Release it: `git tag vx.y.z && git push origin vx.y.z`. The Release workflow tests, builds the download the installers and `startup-tracker update` use, and publishes the release with that changelog section. Watch it with `gh run watch`; if it fails, fix it and release a new patch version.

## Human writing

For the README, docs, release notes and UI copy, write plainly and specifically: no inflated claims, no filler, no generic conclusions. See the Humanizer guidance at https://github.com/blader/humanizer.
There are some shortcuts used frequently - MK (marketing); PO (programs & opportunities); FU (funding); COMP (company).
