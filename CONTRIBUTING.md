# Contributing to Startup Tracker

Thanks for helping. This file covers the development setup, the rules for data and tests, and how to contribute categories, company templates and translations. [AGENTS.md](AGENTS.md) has the same rules in more detail and applies to people and coding agents alike.

## Development setup

You need Node.js 22.16 or newer and git. There is no build step: the browser loads the files in `public/` as they are.

```bash
git clone https://github.com/liviux/Start-up-tracker.git
cd Start-up-tracker
npm install
npm test
npm run check
```

- `npm install` installs the development tools (ESLint). The app itself needs nothing but Node.js; keep it that way unless a dependency clearly pays for itself.
- `npm run dev` starts a tracker on port 57323 with its data in `~/.startup-tracker-dev`, without opening a browser.
- `npm test` runs every test with a temporary data folder and random free ports. To run one file: `node tools/run-tests.js tests/<file>.test.js`.
- `npm run check` checks the syntax of every JavaScript file, the CSS bundle, the content JSON, ESLint (no warnings allowed), the leak scan, the banned-words check and the check that interface text comes from `content/i18n/en.json`. Run it before every commit.
- `node tools/demo-data.js --data-dir <folder>` adds a fictional startup to a data folder, so you can try the app with sample records.
- `node bin/startup-tracker.js <command>` runs the `startup-tracker` command from the clone ([docs/cli.md](docs/cli.md)).
- `node tools/install-git-hooks.js` installs a pre-commit hook that runs the leak scan on staged files.

[docs/development.md](docs/development.md) lists every command, how the data folder is chosen and how the code is laid out.

## Data

- The code folder never holds data. The app keeps its database, media, backups, logs and API token in a data folder in your home directory.
- Never commit data, media, backups, logs or secrets. `.gitignore` blocks the usual files and `tools/check-leaks.js` refuses them.
- No personal data in code, tests, docs or commit messages: no real names, e-mail addresses, host names, local paths or account ids. Use `example.com` and clearly fictional names. To scan for your own names and hosts as well, put them in a file outside the repository and run `LEAK_PATTERNS_FILE=<file> npm run check`.
- Write through the API or the store's transactional methods. Never edit a database with ad hoc SQL.
- Changes to the stored data need an upgrade path in the store and a test that opening an older database keeps every record unchanged.

## Tests

- Tests and checks use a temporary data folder and a random free port (`PORT=0`) with `NO_OPEN=1`, so they never reach a tracker you have running. Keep it that way in new tests.
- Add or update tests with every change in behaviour. Fix failing tests, lint errors and warnings you find, even ones your change did not cause.
- `tests/frontend-sync-contract.test.js` reads `public/app.js` as text. When you move code out of `app.js`, rewrite the affected checks as behaviour tests on the new module in the same pull request. Do not skip or delete them.
- Run the tests that cover your change and `npm run check` before you open a pull request. CI runs everything on Linux, macOS and Windows.

## No invented facts

Do not invent metrics, dates, fees, eligibility rules or results anywhere in the project. Use official pages for facts, or leave the field empty. Example data is clearly fictional.

## Categories (taxonomy)

The built-in category library lives in `content/taxonomy/`, one file per section: `mk.json` (marketing), `po.json` (programs and opportunities) and `fu.json` (funding). Each file has a `section`, a `libraryVersion` and a list of `nodes`. Nodes form three levels: category, subcategory and type.

- Every node needs a `description` (up to 400 characters). Write it as a definition: what belongs here and when to pick it. No marketing language, no claims about results.
- Ids are lowercase and dotted by level, for example `mk.launches.launch-platforms`. A subcategory's parent is a category and a type's parent is a subcategory, in the same section.
- Never rename or reuse an id. Trackers already store targets under these ids.
- When you add nodes, raise the file's `libraryVersion`. Existing trackers then offer the new nodes to the user instead of adding them silently.
- `npm run check` and `tests/taxonomy.test.js` validate the files.

## Company templates

Company templates describe one legal form in one country: profile fields, setup steps and recurring obligations. They live in `content/company-templates/`, one JSON file per template; `index.json` records the ranking the countries were chosen from. `npm run check` and `tests/company-template-schema.test.js` validate them. They are legal and tax information, so the bar is high:

- Use official government or registry sources only. Each source has a URL and a "verified on" date (`YYYY-MM-DD`), the day you checked it.
- Every setup step and obligation cites at least one source. Amounts and rates carry the date they apply from.
- When you are not sure, write "check locally" instead of guessing.
- No field is pre-filled with a real-looking identifier.
- Corrections are welcome. Include the official source that shows the change.

## Translations

Interface text lives in `content/i18n/`, one file per language, named with the language code (`en.json`, or a regional code such as `pt-BR.json`). `en.json` is the reference.

- Keep the keys and nesting of `en.json`. Translate only the values.
- Keep placeholders such as `{count}` and `{version}` as they are.
- Plural forms use the `Intl.PluralRules` categories (`zero`, `one`, `two`, `few`, `many`, `other`), and every plural needs an `other` form.
- New interface text in code goes through `t()` with a key in `en.json`.
- `npm run check` validates the files.

## Commits and pull requests

- One topic per pull request. Describe what changed and why, and how you tested it.
- Write clear commit messages in plain English: a short summary line, then details if they help.
- Describe changes people will notice; the maintainer adds them to `CHANGELOG.md` with the next version.
- Update the docs in `docs/` when behaviour or commands change. Write plainly and specifically: no inflated claims, no filler.
- No file over 40 MB, and no data files, ever.
- Screenshots come from the demo data only.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
