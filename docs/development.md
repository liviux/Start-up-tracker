# Development

Startup Tracker needs Node.js 22.16 or newer. There is no build step: the browser loads the files in `public/` as they are. How to propose changes, and how to contribute categories, company templates and translations with their sources, is in [CONTRIBUTING.md](https://github.com/liviux/Start-up-tracker/blob/main/CONTRIBUTING.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs the development tools (ESLint). The app itself needs nothing but Node.js. |
| `npm start` | Starts the tracker in the terminal on its saved port (57322 unless `config.json` says otherwise) with your data folder, `~/.startup-tracker`, and opens your browser. |
| `node bin/startup-tracker.js <command>` | The `startup-tracker` command from this folder: `start`, `stop`, `status`, `logs`, `doctor` and the rest ([cli.md](cli.md)). `./start.sh` and `start.bat` run it with no command. |
| `npm run dev` | Starts it on port 57323 with the development data folder `~/.startup-tracker-dev`, without opening a browser. |
| `npm test` | Runs the tests with a throwaway data folder and random ports. |
| `npm run check` | Syntax of every JavaScript file, the CSS bundle, the content JSON, ESLint, the leak scan, the banned-words check and the check that UI text comes from `en.json` (`tools/check-i18n.js`). |
| `node tools/demo-data.js --data-dir <folder>` | Adds a fictional startup, Northwind Robotics, to the folder's database and prints its address, `/s/<id>/`. Other startups are left alone. A second run refuses unless you add `--force`, which replaces the demo's data. Add `--size large` for about 1,100 records. |
| `node tools/theme-previews.js` | Rebuilds the theme picker screenshots from the demo data into `public/assets/theme-previews/`. `--only <id>` captures one theme, `--mode light\|dark` overrides its signature mode, and `--width`/`--height` capture another size. It uses a throwaway data folder and Chrome's DevTools protocol. |
| `node tools/backup-sqlite.js --label <what>` | Takes a pinned backup (never rotated away): a folder in `backups/` with the whole database and a media manifest, media files stored once in `backups/media-store/`. Without `--label` it takes a safety backup, skipped when nothing changed since the newest backup. `--limit <n>` caps safety backups for this run; otherwise the keep counts in the settings apply. Also `--database`, `--output-dir` (the backup folder) and `--media-dir`. A database from before startups is copied as it is to one file, without media, never upgraded. |
| `node tools/restore-sqlite.js --list` | Lists backup folders (id, kind, label, time, startups, media files) and older single-file snapshots, shown as kind `file`. `--verify <backup>` checks one: for a folder, the database and every media file. |
| `node tools/restore-sqlite.js --snapshot <backup> --startup <id>` | Replaces one startup's records and media files with the backup's. Other startups are not touched. Takes a safety backup first and stops if that fails. Safe while the server runs. |
| `node tools/restore-sqlite.js --snapshot <backup> --record <startupId>/<section>/<id>` | Puts one record back into one startup (or `--startup <id> --record <section>/<id>`). Safe while the server runs. |
| `node tools/restore-sqlite.js --snapshot <backup>` | Replaces the whole database with the backup's and puts its media files back; media files the backup does not list stay. Stop the server first; the old database is kept as `tracker.sqlite.replaced-<time>`. |
| `node tools/build-release.js` | Builds `dist/startup-tracker.tar.gz` (the files git tracks, without tests and CI files, plus any production packages from `node_modules/`; today there are none) and `dist/SHA256SUMS`. Stops on uncommitted changes unless `--allow-dirty`, which also takes new files git does not ignore; `bash install.sh --archive dist/startup-tracker.tar.gz --dir <folder>` then installs that build. |
| `node tools/about.js` | Prints the version, data folder, database, media and backup folders, configured port, schema version, database size, integrity, and startup and backup counts. Changes nothing; `--json` for JSON, `--data-dir` for another folder. |

`<backup>` is a backup folder's id from `--list`, or the file name of an older `tracker-*.sqlite` snapshot.

## Where data lives

Data never lives in the code folder. The server and the tools pick the data folder in this order:

1. `--data-dir <folder>` on the command line
2. the `STARTUP_TRACKER_HOME` environment variable
3. the default, `~/.startup-tracker` (`%USERPROFILE%\.startup-tracker` on Windows)

`--dev` (what `npm run dev` passes) uses `~/.startup-tracker-dev` instead, so development never touches your real data. A test run never falls back to the default: under `node --test`, or with `STARTUP_TRACKER_TEST_RUN=1` (set by `npm test`), the server and the tools stop unless a data folder is named.

The first start creates the folder, readable by your user account only (folders 0700, the API token 0600), and prints where it is. Inside it:

```text
config.json                 port and data options
data/tracker.sqlite         every startup and the shared settings, in one database
media/<startupId>/          uploads of one startup
agent-runs/<startupId>/     the working folders of agent runs
backups/                    backup folders and the shared media store
cache/                      the agent registry
secrets/                    the API token and agent environment variables
logs/                       the server log
run/server.json             port and process of the running server
```

Every variable the server reads is listed in `.env.example`.

## Ports

The server never moves to another port on its own. If the port is taken it says so and stops. It takes `--port <number>`, then `PORT=<number>`, then the port saved in `config.json` (the `startup-tracker` command saves 57322 at the first start), then 57322; `--dev` always uses 57323. The browser keeps unsent edits per address, so changing the port later strands them. The server writes `run/server.json` (process id, port, address) once it listens and removes it when it stops; the command reads it.

## Layout

- `server.js`: entry point. `lib/http/` holds the request checks, static files and media routes; `lib/data-root.js` finds the data folder.
- `bin/startup-tracker.js` and `lib/cli/`: the command (arguments, `config.json`, `run/server.json`, starting and stopping, update, autostart, doctor, uninstall). `install.sh` and `install.ps1`: the installers.
- `lib/tracker-sqlite-store.js`: the SQLite store.
- `public/`: everything the browser loads. The default theme is in `public/styles/taste-variants.css`; the eleven layout themes are one file each in `public/styles/themes/`, imported last, and their picker screenshots are in `public/assets/theme-previews/`. The floating live theme switcher is `public/scripts/live-themes.js` and `public/styles/live-themes.css`, loaded after every theme. `node tools/theme-previews.js --only <id>` rebuilds a picker screenshot from the demo data.
- `content/`: reviewable JSON: the interface strings (`i18n/en.json`), categories, fields, statuses, prompts, company templates and the agent registry.
- `tools/`: maintenance and check scripts. `tests/`: `node --test` suites.
- `docs/`: this documentation, served as it is by GitHub Pages (Docsify from `docs/vendor/`, no build). Screenshots in `docs/assets/` are taken from the demo data only; after replacing one, put its new SHA-256 in `tools/leak-allowlist.json`, which lists every binary file the leak check accepts. `docs/install.sh` and `docs/install.ps1` are copies of the root scripts for the short install URLs, and a test keeps them identical.

## Releases

1. Set the new version in `package.json` and `package-lock.json` (with `npm version <major|minor|patch> --no-git-tag-version`), `APP_VERSION` in `public/js/api.js`, and add the release notes under `## [x.y.z] - <date>` at the top of `CHANGELOG.md`. Commit to `main` and wait for CI to pass.
2. On GitHub, open **Actions > Release > Run workflow**, keep the branch `main` and type the version (`x.y.z`, without the `v`). Pushing a tag `vx.y.z` instead does the same.

The workflow checks that the version matches `package.json`, runs the tests on Linux, macOS and Windows, refreshes the ACP registry snapshot and checks the agent catalog, builds `startup-tracker.tar.gz` with its `SHA256SUMS`, scans everything for leaks, and publishes the release with the version's CHANGELOG section as its notes. A manual run creates the tag `vx.y.z` on the commit it ran for. The installers and `startup-tracker update` download from the latest release.

## Interface text

Every string the interface shows comes from `content/i18n/en.json`:

- In `index.html`, an element names its string with `data-i18n="key"` (or `data-i18n-html` for a sentence with `<code>` or `<strong>` in it), and its attributes with `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-tooltip` and `data-i18n-alt`. The English in the markup is only a fallback and must match `en.json`.
- In scripts, `t("key", { name })` returns the text with its `{name}` filled in, and `t("key", { count })` picks the plural form (`one`, `other`). Inside an HTML template, `escapeHtml(t("key"))` for plain text and `tHtml("key", { name: html })` when a parameter is HTML already.
- Keys group by where the text is used: `ui.<view>.*` for the page markup, `ui.common.*` for text used in more than one view, `app.<function>.*` for `app.js`, and one group per module (`recordWindow.*`, `sectionPage.*`, `fieldsEditor.*`...).

What is data stays out of `en.json`: names and values of records, statuses, categories, presets and other lists you can edit, and the content files under `content/`.

To find text that does not come from `en.json`, open the tracker with `?pseudo-locale=1` at the end of the address: every string then shows as `⟦its key⟧`, so plain English on screen is either data or a missed string. `npm run check` flags hard-coded text in `index.html` and in HTML templates; a line that must keep fixed text ends with the comment `i18n-ignore`.
