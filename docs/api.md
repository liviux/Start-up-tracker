# HTTP API

The tracker's browser page uses this API, and so can your own scripts. The server listens on 127.0.0.1 only.

Every write (`POST`, `PUT`, `PATCH`, `DELETE`) needs one of these:

- `Sec-Fetch-Site: same-origin`, which browsers send for the tracker's own page;
- an `Origin` header that matches the address you used;
- `Authorization: Bearer <token>`, where the token is in `secrets/api-token` in the data folder.

Request bodies are JSON with `Content-Type: application/json`. Answers are JSON with `ok: true` or `ok: false` and an `error`.

## Startups

One database holds several startups. Each has an id such as `acme-7f3k` (a slug of the first name plus four random characters) that never changes when you rename it.

| Route | What it does |
|---|---|
| `GET /api/startups` | The list, archived ones included: `{ startups: [{ id, name, icon, order, createdAt, lastOpenedAt, archived }], revision }`. With `?counts=1` each startup also has `recordCount` (records in its collections) and `mediaBytes`. |
| `POST /api/startups` | Create one. Body: `name`, optional `icon` (a `data:image/...;base64` URL), `copySettingsFrom` (a startup id), `copyProfileFields` (the profile fields to copy; all of them when left out) and `copyRecords` (`true` to copy its records too). Answers 201 with `{ startup }`. |
| `PATCH /api/startups/:id` | Change `name`, `icon`, `order` or `archived`. `opened: true` records that the startup was just opened; `/` sends you to the one opened last. |
| `DELETE /api/startups/:id` | Takes a safety backup first (it holds the database and the media files) and stops if that fails. Then removes the startup's records, history and media folder. Answers `{ deleted, safetyBackup }`. |

## One startup's data

Everything below lives under `/api/s/:startupId`. An unknown or archived id answers 404.

| Route | What it does |
|---|---|
| `GET …/state` | The startup's whole state with `revision` and `revisionMap`. Sends `ETag: W/"rev-<revision>"`; `If-None-Match` gets a 304 while nothing changed. `state` is `null` for a startup with no data yet. |
| `PATCH …/state/operations` | Writes. Body: `protocolVersion: 3`, `operations`, optional `mutationId`, `origin`, `label`, `updatedAt`. Every operation except `replaceSection` carries the `baseRevision` of the record it changes; `replaceSection` and `reorder` carry it too, except for the `updatedAt` section. A record that moved since its `baseRevision` answers 409 `recordConflict` with the `conflicts`. Send `knownRevision`, the startup revision the page last loaded: after a restore or import replaced the startup, a write from before it answers 409 `restored` and changes nothing. |
| `GET …/state/changes?since=<revision>` | Records changed after a revision, or `complete: false` when the gap is too old and the state must be loaded again. |
| `GET …/state/history?section=&id=&limit=&offset=` | One record's timeline, merged across the record's section and its recycle-bin section. Sends no ETag. |
| `GET …/state/records/:section/:id` | One record with its `recordRevision`. |
| `POST …/media/upload` | `multipart/form-data` with one file. Stored in `media/<startupId>/`; the answer's `path` is `/media/<startupId>/<file>`. |
| `PUT …/media/document` | Saves a Markdown file that sits in the startup's media folder. |

Operations: `{ type: "upsert", section, id, value, baseRevision, position? }`, `{ type: "delete", section, id, baseRevision }`, `{ type: "replaceSection", section, value, baseRevision? }`, `{ type: "reorder", section, ids, baseRevision }`.

Revisions count per startup. A write to one startup never changes another startup's revision, ETag or changes feed.

## Global data

Settings shared by every startup (appearance, statuses, categories and so on) are in the global scope. So are your prompts, presets and examples (`prompts`, `deletedPrompts`, `promptPresets`, `promptExamples`), campaigns (`campaigns`, `deletedCampaigns`), tag definitions (`tags`, `deletedTags`), the AI page (`aiAccounts`, `aiFlow`, `aiSettings`) and research links ticked "Shared" (`dailyLinks`, `deletedDailyLinks`). The page writes these with `PATCH /api/global/operations` a moment after each change, outside the startup's outbox; when a record it based an edit on has moved, it reloads the shared data instead of overwriting it.

| Route | What it does |
|---|---|
| `GET /api/global` | `{ state, revision, revisionMap }`, with the same ETag rules as a startup's state. The startup list is not part of it. |
| `PATCH /api/global/operations` | The same operation format. `protocolVersion` is not required, and `baseRevision` is checked only where given. Operations on the `startups` section are refused: use `/api/startups`. |
| `GET /api/global/tags/usage` | `{ usage: { <tag>: { total, inBin, startups: { <startupId>: { name, count, sections } } } } }`: every tag on any record of any startup (archived ones too) and on the shared campaigns. `_global` stands for the campaigns. |
| `POST /api/global/tags/rename` | Body: `{ from, to }`. Every record with `from`, in every startup and in the campaigns, gets `to` instead, and the definition follows. When `to` already exists this is a merge. |
| `POST /api/global/tags/merge` | Body: `{ from: [tags], to }`. Like rename for several tags; the kept definition takes the first description and colour it finds when its own are empty. Takes a safety backup first. |
| `POST /api/global/tags/delete` | Body: `{ tag }`. Takes the tag off every record and moves its definition to `deletedTags`. Takes a safety backup first. |

Tags are lowercase strings of 1 to 60 characters. These three answer `{ tag, recordsChanged, startupsChanged, safetyBackup? }`; each changed record gets its own history entry.

## Agent tokens

A prompt copied for an agent carries a limited token (`sta_...`), never the master token in `secrets/api-token`. It may only send `PATCH /api/s/<startupId>/state/operations` for its own startup, with `upsert` operations in `items`, `programs`, `funding` and `links`: adding and updating targets and linking records. Anything else answers 403. Its writes are recorded in the history with origin `api` and the actor "Agent: <label>". A token lasts 24 hours unless asked otherwise; only a hash of it is stored, in the global `agentTokens` section, which `GET /api/global` leaves out and `PATCH /api/global/operations` refuses.

| Route | What it does |
|---|---|
| `POST /api/s/<startupId>/agent-tokens` | Body: `{ label?, hours? }` (1 hour to 30 days). Answers 201 with `{ token, record }`; the token is shown only here. |
| `GET /api/agent-tokens?startupId=` | `{ tokens: [{ id, startupId, label, createdAt, expiresAt, revokedAt, lastUsedAt, active }] }`. |
| `POST /api/agent-tokens/<id>/revoke` | Ends a token at once. |

A run's token (`scope: "run"`) is made when a run starts and revoked when it ends. It may only call `POST /api/s/<startupId>/agent-tools/<tool>` of its own run.

## AI agents and runs

See [AI agents](agents.md) for what these do.

| Route | What it does |
|---|---|
| `GET /api/agents` | `{ registry: { source, fetchedAt, version, problem, network, agents }, harnesses, settings, policies, platform }`. `source` is `live`, `cache`, `snapshot` or `catalog`. Each registry agent has `kind` (`npx`, `uvx`, `binary`), `launch`, `installed`, `installedBin` (the agent's own command when it can run without a download) and `added`. Harnesses show environment variable names with `***` values and `blocked` when the last check failed without an override. |
| `POST /api/agents/rescan` | The same, after fetching the registry again (when the network setting allows it). |
| `POST /api/agents/harnesses` | Body: `{ registryId }` or `{ custom: { command, args } }`, optional `name`. With `preview: true` it answers `{ preview }`, the exact command line, and stores nothing. It stores the agent only with `confirmed: true`; otherwise 400 `confirmNeeded` with `preview`. |
| `PATCH /api/agents/harnesses/<id>` | `name`, `args`, `command` (custom agents), `policy` (`allow`, `research`, `ask`), `defaultModel`, `preferredModels`, `env` (an object; `"***"` keeps a stored value), `overrideBlock`, `downloadConsent`. A changed custom command line needs `confirmed: true`. |
| `DELETE /api/agents/harnesses/<id>` | Removes an agent and its stored variables. 409 while it has a run going. |
| `POST /api/agents/harnesses/<id>/check` | Body: `{ testPrompt?, consent? }`. Answers `{ check: { state, message, agentInfo, models, authMethods, testReply }, harness }`. `state` is `ready`, `needs-login`, `incompatible`, `not-installed`, `failed`, or `consent-needed` (with `package`) before a first npx or uvx download. |
| `POST /api/agents/harnesses/<id>/authenticate` | Body: `{ methodId }`. Logs in with a method the agent handles, then checks again. |
| `PUT /api/agents/settings` | Body: `{ settings: { concurrency, timeoutMinutes, keepRuns, idleMinutes } }`. |
| `POST /api/s/<startupId>/agent-runs` | Starts a run. Body: `{ harnessId, model?, template, values, title?, presetId? }`. The server fills the template with the values (and its own `{{TRACKER_ACCESS}}`) using the page's renderer; unfilled variables answer 400 `unresolved`. A blocked agent answers 409 `blocked`; an npm or Python agent not yet allowed to download answers 409 `consentNeeded`. Answers 201 with `{ run }`. |
| `GET /api/s/<startupId>/agent-runs`, `GET /api/agent-runs?startupId=` | `{ runs, counts: { running, waiting } }`, newest first, without the prompt. |
| `GET /api/agent-runs/<runId>` | `{ run, live, canMessage }`: the whole run with `prompt`, `changes`, `permissions`, `usage`, `status` (`queued`, `starting`, `running`, `waiting`, `done`, `failed`, `cancelled`, `interrupted`), `stopReason` and `jsonFallback`. |
| `GET /api/agent-runs/<runId>/events` | Server-Sent Events. Each event has `id: <seq>`; a reconnect with `Last-Event-ID` (or `?after=<seq>`) gets only what came after. The stream ends with a `closed` event when the run's agent stops. `?format=json` answers `{ events, live }` instead. |
| `POST /api/agent-runs/<runId>/cancel` | Cancels the turn; the process tree is stopped after 10 seconds. |
| `POST /api/agent-runs/<runId>/message` | Body: `{ text }`. A follow-up prompt in the same session, while the agent is still there. |
| `POST /api/agent-runs/<runId>/permissions/<requestId>` | Body: `{ optionId }`, one of the request's options. |
| `POST /api/agent-runs/<runId>/undo` | Undoes the run's changes. Answers `{ run, undone, skipped }`. |
| `GET /api/agent-runs/<runId>/log` | The redacted protocol log, one JSON object per line. `?download=1` sends it as a file. |
| `POST /api/agent-runs/stop-all` | Cancels every run. |
| `POST /api/s/<startupId>/agent-tools/<tool>` | The tracker tools, for a run token only. Body: `{ arguments, mutationId, runId }`. Answers `{ ok: true, result }` or `{ ok: false, error, code }`. |

## Option lists

The lists people edit in Extra: `mediaTypes`, `feedbackTypes` (each with a `block`: `person`, `journey`, `assumption` or empty), `feedbackSources`, `feedbackStages`, `feedbackAreas`, `feedbackEvidence`, `feedbackRelationships`, `feedbackJourneySteps`, `feedbackVerdicts` and `researchGroups` (each with a `linkType` for its icon). The shipped lists are in `content/options.json`; an edited list is kept whole in the global `optionLists` section.

| Route | What it does |
|---|---|
| `GET /api/options` | `{ lists, defaults, stored }`: the lists in use, the shipped ones and the edited ones. |
| `PUT /api/options` | Body: `{ lists: { <name>: [{ id?, label, description?, block?, linkType? }] \| null } }`. Saves the named lists after checking them all (unique ids of lowercase letters, digits and dashes; an id is made from the label when missing). `null` goes back to the shipped list. Records keep a value whose option was removed. |

## Every startup at once

Read-only views over every startup that is not archived. Each result names its startup (`startup: { id, name, icon }`), so the page can switch to that startup before opening the record. Writes answer 405.

| Route | What it does |
|---|---|
| `GET /api/all/search?q=&limit=` | Records in marketing, programs, funding, campaigns and media whose name or text contains every word of `q`: `{ results: [{ startup, section, kind, id, title, status }], truncated }`. Campaigns are shared, so they come once with `startup: null` and `shared: true`. |
| `GET /api/all/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | The dated moments the calendar shows, from `public/js/calendar-model.js`: `{ events: [{ startup, section, kind, id, status, date, time, label, detail }], records: [{ startupId, section, id, status }] }`. `section` is `mk`, `po`, `fu`, `comp` or `campaign`; `kind` is `next_action`, `deadline`, `milestone`, `payment`, `company` or `campaign`. Events are sorted by date. `records` lists every record with its status, dated or not, for the calendar's "all time" summary. Shared campaign dates come once, with `startup: null`. |
| `GET /api/all/campaign-targets?campaign=<id>` | The targets of one campaign in every open startup: `{ targets: [{ startup, section, id, title, status, date }] }`, `section` being `mk`, `po` or `fu`. |

## Settings

Shared settings live in one global object. `GET /api/settings` answers `{ settings, defaults, revision }`; `PATCH /api/settings` takes `{ settings: { ... } }` with only the keys to change (objects merge one level deep) and answers the full result. Unknown keys and bad values answer 400 with the field named.

| Key | Values | Default |
|---|---|---|
| `appName` | text, 1 to 60 characters | `"Startup Tracker"` |
| `language` | `"en"` | `"en"` |
| `timeZone` | an IANA zone, or `""` for the browser's zone | `""` |
| `dateFormat` | `"system"`, `"d MMM yyyy"` (15 Oct 2026), `"yyyy-MM-dd"` | `"system"` |
| `weekStart` | `"monday"`, `"sunday"` | `"monday"` |
| `pageSize` | 10 to 200 | `25` |
| `yourName` | text up to 80 characters; `""` shows "You" | `""` |
| `network` | `true` or `false`: fetch the agent registry and check for updates | `true` |
| `defaultScope` | `"startup"` or `"all"`, for search and the calendar | `"startup"` |
| `appearance` | `{ mode: "system" \| "light" \| "dark", theme: <theme id> }` | `{ mode: "system", theme: "studio" }` |
| `sectionColors` | `{ palette: "standard" \| "colorblind", mk, po, fu, comp }`; each section is `""` (the palette's colour) or `#rrggbb` | `{ palette: "standard", mk: "", po: "", fu: "", comp: "" }` |
| `backups` | `{ keepAutomatic: 1–1000, keepSafety: 1–1000 }` | `{ keepAutomatic: 20, keepSafety: 20 }` |
| `recycleBin` | `{ retentionDays: 7–365 or null }`; `null` keeps records until you empty the bin | `{ retentionDays: 30 }` |

`yourName` names you in record history for edits made in the browser. `TRACKER_UI_ACTOR` in the environment overrides it.

## Categories

The category library (see [Categories](categories.md)) lives in the global scope. Node ids look like `mk.content.blog`: section, category, subcategory, type. A target keeps its nodes in `taxonomy: [nodeId, ...]`, primary first, with each node's ancestors listed after it. Which nodes a startup has turned on is that startup's own `enabledTaxonomy` section, `{ enabled: [ids] }`, saved like any other section; without it every node is on.

| Route | What it does |
|---|---|
| `GET /api/taxonomy` | `{ nodes, usage, updates, versions }`. `usage` counts the targets, in every startup, that use each node. `updates` lists library nodes from a newer release that you have not added or skipped. |
| `POST /api/taxonomy/nodes` | Body: `{ section or parentId, name, shortName, description }`. Adds a category (no parent), subcategory or type. |
| `PATCH /api/taxonomy/nodes/:id` | Name, short name, description, order, or a new parent of the right level. |
| `POST /api/taxonomy/nodes/:id/delete` | Body: `{ moveTo }`. Deletes the node and everything under it after moving the targets that use them to `moveTo`, in every startup. Without `moveTo`, a node in use answers 409 `inUse`. |
| `POST /api/taxonomy/nodes/:id/merge` | Body: `{ into }`, a node of the same section and level. Its children move under `into` and every target that used it uses `into` instead. |
| `POST /api/taxonomy/nodes/:id/reset` | Puts a built-in node's name and description back to the library text. |
| `POST /api/taxonomy/reorder` | Body: `{ ids }`: every child of one parent, in the new order. |
| `POST /api/taxonomy/library/accept` | Body: `{ ids }`. Adds those pending library nodes (with any missing parents) and skips the rest of that release's new nodes. |
| `GET /api/taxonomy/export` | The library as a file, `{ format: "startup-tracker-taxonomy", formatVersion: 1, nodes }`. |
| `POST /api/taxonomy/import` | Body: `{ library }`, such a file. Adds the nodes this tracker lacks, as custom nodes. Answers `{ added, skipped }`. |

## Fields

The target window draws its fields from `content/fields/*.json` (see [The target window and fields](fields.md)).

| Route | What it does |
|---|---|
| `GET /api/fields` | `{ registry: { common, mk, po, fu } }`: the shipped field registry. |

Every target, in every section, keeps the same keys:

- the basics flat: `id`, `name`, `organization`, `link`, `taxonomy` (category ids, the primary first), `status`, `priority`, `nextActionDate`, `nextActionTime`, `nextAction`, `deadline`, `owner`, `campaignId`, `tags`, `repeatInterval`, `repeatUnit`, `notes` (Markdown), and `roundId` in Funding;
- the section's fields under `details`, by their keys in the registry (an amount as `{ amount, currency }`);
- `customFields`: the target's own `[{ label, value }]`, both text;
- `timeline`: dated entries `{ id, date, time, type, title, outcome, nextAction, nextActionDate, statusAfter, sourceUrl, notes }`, where `type` is `key-date` for a date ahead (it shows on the calendar) or what happened (`research`, `sent`, `follow-up`, `reply`, `meeting`, `published`, `decision`, `other`);
- in Funding, `commitments` and `payments`, whose `state` and `status` take the option values of the registry.

Keys no field claims are kept as they are.

## Links

Links between two records of one startup live in that startup's `links` section, written with the usual operations: `{ id, a: { kind, id }, b: { kind, id }, relation, note, context, resultLink, createdAt }`. `kind` is `mk`, `po`, `fu`, `comp`, `media`, `feedback`, `campaign` or `research`. `relation` is `related` (the default), `uses` (`a` uses the media `b`), `feedback-about` (`a` is the feedback), `blocks` (`a` blocks `b`), `follow-up-of` or `funds` (`a` is the funding, `b` the program). The checks and the names each end shows are in `public/js/links-model.js`; see [Links](links.md).

Links to a record in the recycle bin stay and are hidden. When the server deletes records for good, it removes their links too.

## Statuses

One status list serves every startup and every section (MK, PO, FU and Company). It starts as `content/statuses.json` and is kept in the global scope, where Settings > Statuses edits it. There are four fixed groups (`planned`, `in_progress`, `done`, `closed`) and 22 built-in subtypes; built-in ids and their groups never change. Campaigns have their own, simpler list.

| Route | What it does |
|---|---|
| `GET /api/statuses` | `{ statuses: { defaultStatus, groups, statuses, waitingStatuses, campaignStatuses }, priorities, revision }`. A custom subtype has `custom: true`. `priorities` is the fixed list from `content/priorities.json`. |
| `PUT /api/statuses` | Body: `{ statuses: <the whole configuration> }`. Change labels, descriptions and order, or add custom subtypes to a group. Removing a status here is refused (`useDelete`); built-in ones cannot be removed at all. |
| `POST /api/statuses/:id/delete` | Body: `{ moveTo }`. Deletes a custom subtype after moving every record that uses it, in every startup and in the recycle bins, to `moveTo`. Answers `{ moved, statuses }`. |
| `POST /api/campaign-statuses/:id/delete` | The same for a campaign status. Every campaign status can be deleted, as long as one is left. |

A record whose status is not in the list keeps its value. The page shows it as "Unmapped" and the status filter can select it.

## Backups

A backup is a folder in `backups/` holding `tracker.sqlite` (the whole database, every startup and the global settings) and `media-manifest.json` (every media file with its SHA-256). Media files are stored once in `backups/media-store/<sha256>` and shared by all backups.

Three kinds:

- `automatic`: when the server starts and the data changed since the newest backup, and every `backups.intervalHours` (six by default) while edits are made, unless the setting `backups.automatic` is `false`. The newest `backups.keepAutomatic` are kept.
- `safety`: before a restore, an import or deleting a startup. The newest `backups.keepSafety` are kept, so they never push out automatic backups.
- `pinned`: taken on request, with an optional label. They never rotate away.

Data that has not changed since the newest backup is not backed up again (pinned backups excepted); the answer then has `skipped: true` and names the existing backup.

| Route | What it does |
|---|---|
| `GET /api/backups?startupId=<id>` | `{ backups: [{ id, kind, label, createdAt, reason, databaseBytes, mediaFiles, mediaBytes, startups, complete, counts }] }`, newest first. `counts` are that startup's records per section in the backup (only with `startupId`). |
| `POST /api/backups` | Takes a pinned backup. Body: optional `label`. |
| `POST /api/backups/:id/verify` | Full check: the database's integrity and hash, and every media file's hash. `{ ok, problems }` |
| `GET /api/backups/:id/compare?startupId=<id>` | What restoring that startup would change: `{ sections: [{ section, current, backup, added, removed, changed }], records: [{ section, id, change }], truncated }`. `added` are records the backup has and the startup lacks now. |
| `POST /api/backups/:id/restore` | Body: `{ scope: "startup", startupId }`, `{ scope: "database" }` or `{ scope: "records", startupId, records: [{ section, id }] }`. A safety backup is taken first; without it nothing is restored. `startup` replaces that startup's records and puts its media files back; other startups are not touched. `database` replaces every startup and the global settings and puts all media files back. `records` puts the listed records back as the backup has them. Media files the backup does not list are never deleted. |
| `GET /api/backups/:id/download` | The backup's `tracker.sqlite`. |
| `DELETE /api/backups/:id` | Deletes the backup, and media files no other backup lists. |

Requests are handled one at a time, so no edit lands in the middle of a restore. Afterwards the startup's revision has moved on: open pages reload it, and their unsent edits from before the restore come back as `restored` conflicts for you to decide on.

## Company

| Route | What it does |
|---|---|
| `GET /api/company/templates` | `{ templates: [{ id, country, countryName, entityType, nameLocal, nameEnglish, currency, bilingual, verifiedOn, draft }], ranking }`, Generic last. `ranking` says where the country list comes from. |
| `GET /api/company/templates/<id>` | One template as shipped in `content/company-templates/<id>.json`; 404 when there is none. |
| `GET /api/s/<startupId>/company/secrets` | The sensitive company values: `{ secrets: { fields, bankAccounts: [{ id, label, currency, account }], people: { <personId>: { idNumber } } } }`. Only for the tracker page or the master token; an agent token gets 403. |
| `PUT /api/s/<startupId>/company/secrets` | Body: `{ secrets, origin? }`; replaces them. |

The Company records live in the startup's own sections: `companyProfile` (one object), `companySteps`, `companyObligations`, `companyDeadlines` and `companyExpenses`, with `deletedCompanySteps`, `deletedCompanyObligations` and `deletedCompanyExpenses` as their recycle bins. The sensitive values are kept in `companySecrets`, which `/state`, the changes feed and the revision map leave out, `/state/operations` refuses (400) and the history route refuses (403).

## Export and import

| Route | What it does |
|---|---|
| `GET /api/s/:id/export?format=zip` | One startup as a zip: JSON per section, its media files and a manifest. `format=json` leaves the media out. Sensitive company values are left out unless `includeSensitive=1`. |
| `GET /api/export?format=zip&startups=<id>,<id>` | Several startups (all open ones when `startups` is left out). `format=sqlite` downloads a verified copy of the whole database instead. |
| `POST /api/import` | The file as the request body (`application/zip`, `application/json` or `application/octet-stream`, up to 512 MB). Nothing changes yet: the answer is `{ token, kind, preview }`. `kind` is `export` (with record counts per startup and section, and `unmappedStatuses`: the status values in each startup's records that this tracker's list does not know, as `{ id, count }`; the import keeps them unchanged) or `database` (a `.sqlite` backup, with its startup count). |
| `POST /api/import/:token/apply` | Body: `{ mode: "new" }` adds every startup in the export as a new startup, `{ mode: "replace", startupId }` replaces that startup with the export's only one, `{ mode: "database" }` restores a `.sqlite` file over the whole database. A safety backup comes first. Tokens expire after 15 minutes. |

Zip entries with `..`, absolute paths or symbolic links are refused, as are archives with more than 20,000 entries or more than 2 GB of content. The `secrets/` folder is never exported.

## Recycle bin

Deleting a record moves it to its paired section (`items` to `deletedItems`, `mediaItems` to `deletedMediaItems` and so on) with a `deletedAt` time. The server deletes records for good once they are older than `recycleBin.retentionDays`, when it starts and once a day.

An uploaded file stays while its media record is in the bin. When the server deletes the record for good it deletes the file too, unless anything else in that startup still names it. After the page deletes media for good, it asks for the same with `POST /api/s/<startupId>/media/remove-files` (body `{ files: [storedName] }`, answer `{ removed, kept }`). `node tools/media-orphans.js [--data-dir <folder>] [--json]` lists files no record names and folders of deleted startups; it never deletes anything.

## About

`GET /api/about` answers `{ version, dataFolder, databasePath, mediaDir, backupDir, port, schemaVersion, databaseBytes, integrity: { checkedAt, ok, problems } }`. `POST /api/about/verify` runs the integrity check now. `GET /api/about/update` answers `{ update: { configured, current, latest, available, checkedAt, error } }` from a cache that lasts a day, asking GitHub for the latest release only while the network switch (`network` in the settings) is on; `POST /api/about/update` asks now whatever the switch says. Neither installs anything. `node tools/about.js` prints the same facts in a terminal without changing anything.

`GET /api/exchange-rate?from=USD&to=RON` answers `{ rate: { from, to, rate, date, source, fetchedAt, cached } }`. It asks [Frankfurter](https://frankfurter.dev/) no more than once a day per pair and keeps the answer in `cache/exchange-rates.json`; `refresh=1` asks now. With the network switch off it answers from the cache when there is one (with `stale: true` and `error: "networkOff"`), and answers 503 when there is not.

## Setup and the demo startup

| Route | What it does |
|---|---|
| `GET /api/setup` | `{ setup: { step, startupId, skipped, open, completed, completedAt, needsSetup }, demo }`. `step` is the step shown last, `open` is true while the setup is on screen, `needsSetup` is true until Done was reached. With no stored state, an install that already has startups counts as completed. `demo` is the demo startup (`{ id, name, ... }`) or `null`. |
| `PUT /api/setup` | Saves any of `step`, `startupId`, `skipped`, `open` and `completed`; answers like `GET`. `step` must be one of `welcome`, `basics`, `startup`, `links`, `context`, `track-mk`, `track-po`, `track-fu`, `agents`, `backups`, `done`; `startupId` must name a startup. |
| `POST /api/demo` | Adds the fictional demo startup with its records and three shared campaigns: `201 { startup }`. `409` when it is there already. |
| `DELETE /api/demo` | Deletes the demo startup after a safety backup, like any startup, and its campaigns: `{ deleted, safetyBackup }`. `404` when there is none. |

The setup's progress is kept in the global `setupState` section.

## Pages and media

- `/s/<startupId>/` is the page for one startup. `?open=<type>:<id>` opens that record after the page loads. An unknown or archived id redirects to `/`.
- `/` redirects to the startup opened last. With no startups it shows the page that creates the first one.
- `/media/<startupId>/<file>` serves an upload.
- `POST /api/s/<startupId>/media/copy` with `{ mediaId, to }` copies a media item, and its file when it is an upload, to another open startup: `{ media, to }`. The copy gets a new id and `copiedFrom: { startupId, id }`; its links stay behind.
- `GET /api/health` answers `{ ok, filePath, mediaDir, version, revision, startupCount }`.
- `GET /api/changelog` answers the text of `CHANGELOG.md` as `text/markdown`, uncached. The version at the bottom of the sidebar reads it.
