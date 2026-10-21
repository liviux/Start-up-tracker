const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Browser files live in public/.
const root = path.join(__dirname, "..", "public");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const markup = fs.readFileSync(path.join(root, "index.html"), "utf8");
// UI text lives in en.json; tests that care about wording read it there.
const en = JSON.parse(fs.readFileSync(path.join(root, "..", "content", "i18n", "en.json"), "utf8"));
const enText = (key) => key.split(".").reduce((node, part) => node?.[part], en);
const modalStyles = fs.readFileSync(path.join(root, "styles", "modals-markdown.css"), "utf8");
const baseStyles = fs.readFileSync(path.join(root, "styles", "base.css"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const drawerStyles = fs.readFileSync(path.join(root, "styles", "drawer-theme.css"), "utf8");
const settingsSource = fs.readFileSync(path.join(root, "js", "settings.js"), "utf8");
const SettingsPanel = require("../public/js/settings.js");
const ClientApi = require("../public/js/api.js");

test("browser cache keeps revision locks and isolates dirty tab state", () => {
  assert.match(source, /revisionMap: clonePersistedState\(serverRevisionMap\)/);
  assert.match(source, /const CACHE_SYNC_KEY = `sync:\$\{cacheTabId\}`/);
  assert.match(source, /const CACHE_RECORD_KEY = `current:\$\{cacheTabId\}`/);
  assert.match(source, /state\.lastServerRevision && serverRevisionMap/);
});

test("every request and every cache name comes from js/api.js for this page's startup", () => {
  // No route is spelled out in app.js: the startup prefix lives in one place.
  assert.doesNotMatch(source, /["'`]\/api\//);
  assert.match(source, /const Api = window\.StartupTrackerApi;/);
  assert.match(source, /const STARTUP_ID = Api\.startupId;/);
  assert.match(source, /const API_STATE_URL = STARTUP_ID \? Api\.api\("\/state"\) : "";/);
  assert.match(source, /const API_MEDIA_UPLOAD_URL = STARTUP_ID \? Api\.api\("\/media\/upload"\) : "";/);
  assert.match(source, /const API_MEDIA_DOCUMENT_URL = STARTUP_ID \? Api\.api\("\/media\/document"\) : "";/);
  // Backups moved to the Settings panel (js/settings.js), which builds its
  // routes from the same helper.
  assert.doesNotMatch(source, /API_BACKUPS/);
  assert.match(settingsSource, /api\.urls\.backupRestore\(backupId\)/);
  assert.doesNotMatch(settingsSource, /["'`]\/api\//);
  // The cache database, and with it the outbox, belongs to this startup only.
  assert.match(source, /const CACHE_DB_NAME = STARTUP_ID \? Api\.cacheDbName\(STARTUP_ID\) : "";/);
  assert.match(source, /const CACHE_STORE_NAME = Api\.CACHE_STORE_NAME;/);
  assert.match(source, /indexedDB\.open\(CACHE_DB_NAME, CACHE_DB_VERSION\)/);
  assert.match(source, /if \(!globalThis\.indexedDB \|\| !CACHE_DB_NAME\)/);
  // Without a startup the tracker does not boot at all.
  assert.match(source, /async function boot\(\) \{\s*\/\/[^\n]*\n\s*if \(!STARTUP_ID\) return;/);
});

test("a restore reloads the page instead of patching it in place", async () => {
  // Restoring replaces data this page holds in memory, so the page starts
  // again: for the whole database and for this startup alike. The edit in
  // progress is saved first, and nothing reloads when the restore failed.
  const api = ClientApi.createApi({ pathname: "/s/acme-7f3k/" });
  for (const scope of ["database", "startup", "records"]) {
    const calls = [];
    const location = { reload: () => calls.push("reload"), assign: (url) => calls.push(`assign ${url}`) };
    const actions = SettingsPanel.createBackupActions({
      fetch: async (url, options) => {
        calls.push(`${options.method} ${url} ${options.body}`);
        return { ok: true, status: 200, json: async () => ({ ok: true, restored: { scope } }) };
      },
      location,
      api,
      startupId: "acme-7f3k",
      prepareToLeave: async () => calls.push("prepareToLeave"),
    });
    await actions.restore("20261017-080000-000-pinned", scope, [{ section: "items", id: "a1" }]);
    const body = scope === "database" ? '{"scope":"database","origin":"ui"}'
      : scope === "startup" ? '{"scope":"startup","startupId":"acme-7f3k","origin":"ui"}'
        : '{"scope":"records","startupId":"acme-7f3k","records":[{"section":"items","id":"a1"}],"origin":"ui"}';
    assert.deepEqual(calls, [`POST /api/backups/20261017-080000-000-pinned/restore ${body}`, "prepareToLeave", "reload"], scope);
  }
  const failed = [];
  const actions = SettingsPanel.createBackupActions({
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: "brokenBackup", message: "did not verify" }) }),
    location: { reload: () => failed.push("reload"), assign: () => failed.push("assign") },
    api,
    startupId: "acme-7f3k",
  });
  await assert.rejects(actions.restore("20261017-080000-000-pinned", "startup"), /did not verify/);
  assert.deepEqual(failed, []);
  // app.js keeps no restore path of its own that could patch state in place.
  assert.doesNotMatch(source, /function restoreBackup\(/);
});

test("leaving for another startup saves the edit in progress first", () => {
  assert.match(source, /async function prepareToLeave\(\) \{\s*flushAutosave\(\);/);
  assert.match(source, /window\.StartupTrackerPage = Object\.freeze\(\{\s*prepareToLeave,/);
  assert.match(source, /async function openRecordInOtherStartup\(startupId, type, id\) \{\s*if \(!Api\.isStartupId\(startupId\) \|\| startupId === STARTUP_ID\) return false;\s*await prepareToLeave\(\);/);
  // The record named by ?open= opens after the state loaded, and the
  // parameter leaves the address so a reload does not open it again.
  assert.match(source, /applyPanelCollapseState\(\);\s*\}\s*openRecordFromAddress\(\);\s*\}/);
  assert.match(source, /params\.delete\("open"\);/);
});

test("cached outbox reloads refresh from the authoritative server snapshot", () => {
  assert.match(source, /async function loadStateFromServer\(options = \{\}\)/);
  assert.match(source, /const forceSnapshot = options\.forceSnapshot === true/);
  assert.match(source, /if \(pendingOutbox\.length > 0 && !forceSnapshot\)/);
  assert.match(source, /const synced = await persist\(SAVE_STATE\.synced\)/);
  assert.match(source, /if \(synced && pendingOutbox\.length === 0\) \{\s*await loadStateFromServer\(\{ forceSnapshot: true \}\)/);
  assert.match(source, /if \(!forceSnapshot && !serverFileChanged\)/);
  // Window-focus sync uses the same recovery path, so returning to a stale tab
  // cannot leave it behind after its sendable local queue is drained.
  assert.match(source, /if \(pendingOutbox\.length > 0\) \{\s*state\.apiReady = true;\s*const synced = await persist\(SAVE_STATE\.synced\);\s*if \(synced && pendingOutbox\.length === 0\) \{\s*await loadStateFromServer\(\{ forceSnapshot: true \}\)/);
});

test("operation requests use the locked mutation protocol", () => {
  assert.match(source, /protocolVersion: 2/);
  assert.match(source, /missingBaseRevision/);
  assert.match(source, /payload\.error === "reloadRequired"/);
});

test("ordinary updates do not carry stale list positions", () => {
  assert.match(
    source,
    /if \(!previousCollection\.signatures\.has\(id\)\) operation\.position = position/,
  );
});

test("record conflicts stay durable until the user decides", () => {
  assert.match(source, /blockedByConflict: true/);
  assert.match(source, /pendingOutbox\.push\(\{[\s\S]*blockedByConflict: true/);
  assert.match(source, /conflicts: clonePersistedState\(unresolvedConflicts\)/);
  assert.match(source, /function rebaseBlockedConflictBatches\(\)/);
  assert.match(source, /if \(hasBlockedConflictBatch\(\)\) \{\s*showRecordConflictNotification/);
});

test("only an explicit choice resolves a conflict, never autosave", () => {
  // persist() is the autosave path and runs on any keystroke anywhere in the
  // app. If it rebased held-back edits, simply typing in an unrelated field
  // would overwrite the other writer's version without the user deciding.
  const persistStart = source.indexOf("async function persist(message =");
  assert.ok(persistStart > 0, "persist() should exist");
  const persistBody = source.slice(persistStart, source.indexOf("\n  }", persistStart));
  assert.doesNotMatch(persistBody, /rebaseBlockedConflictBatches\(\)/);

  // The compact badge opens a review. Only the modal decision buttons call the
  // two destructive resolution paths.
  assert.match(source, /data-conflict-action="review"/);
  assert.match(source, /keepMineConflictButton.*resolveRecordConflictsKeepingMine/);
  assert.match(source, /useTheirsConflictButton.*resolveRecordConflictsUsingTheirs/);
  assert.match(source, /async function resolveRecordConflictsKeepingMine\(\)/);
  assert.match(source, /async function resolveRecordConflictsUsingTheirs\(\)/);
  // Both are destructive in opposite directions, so both confirm first.
  assert.match(source, /window\.confirm\(t\("app\.resolveRecordConflictsKeepingMine\.confirm"/);
  assert.match(source, /window\.confirm\(t\("app\.resolveRecordConflictsUsingTheirs\.confirm"/);
});

test("same-record edits merge by field before prompting", () => {
  assert.match(source, /RecordConflictMerge\.mergeRecords\(baseRecord, localRecord, serverRecord\)/);
  assert.match(source, /const localRecord = readLiveRecord\(conflict\.section, conflict\.id\)/);
  assert.match(source, /if \(!mergeResult\.canAutoMerge\)/);
  assert.match(source, /autoMergedOperations\.push/);
  assert.match(source, /applyAcknowledgedRecord\(conflict\.section, conflict\.id, serverRecord\)/);
  assert.match(source, /applyLiveRecord\(conflict\.section, conflict\.id, mergedRecord\)/);
});

test("field conflicts open an accessible comparison dialog", () => {
  assert.match(markup, /id="recordConflictModal"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(markup, /id="recordConflictReview"/);
  assert.match(markup, /id="saveStateLabel"[^>]*tabindex="-1"/);
  assert.match(markup, /id="useTheirsConflictButton"/);
  assert.match(markup, /id="keepMineConflictButton"/);
  assert.match(source, /recordConflictReturnFocus = document\.activeElement/);
  assert.match(source, /elements\.closeRecordConflictModal\?\.focus\(\)/);
  assert.match(source, /else elements\.saveStateLabel\?\.focus\(\)/);
  assert.match(source, /if \(event\.key !== "Tab"\) return/);
  assert.match(modalStyles, /\.record-conflict-comparison\s*\{[\s\S]*grid-template-columns/);
  assert.match(modalStyles, /\.record-conflict-modal-body\s*\{[\s\S]*overflow-y: auto/);
});

test("blocked records are not duplicated by later autosaves", () => {
  assert.match(source, /function blockedRecordIds\(section\)/);
  assert.match(source, /if \(!blockedIds\.has\(id\) && !currentCollection\.signatures\.has\(id\)\)/);
  assert.match(source, /if \(!blockedIds\.has\(id\)[\s\S]*currentCollection\.signatures\.get\(id\)/);
  assert.match(source, /if \(blockedIds\.size === 0[\s\S]*currentCollection\.ids/);
  assert.match(source, /pendingOutbox = pendingOutbox\.filter\(\(batch\) => !batch\.blockedByConflict\)/);
});

test("definition collections use their live standalone arrays during conflict resolution", () => {
  // A startup's older category list is kept as it was (the library replaced it).
  assert.match(source, /if \(section === "categories"\) return state\.legacyCategories \|\| \[\]/);
  assert.match(source, /if \(section === "extraParamsDefinition"\) return extraParamsDefinition/);
  assert.match(source, /if \(section === "tagDefinitions"\) return tagDefinitions/);
  assert.match(source, /const collection = getLiveCollection\(section\)/);
  assert.match(source, /setLiveSection\(section, copy\)/);
  assert.match(source, /const liveCollection = getLiveCollection\(operation\.section\)/);
});

test("a collection the startup does not have diffs as empty instead of stopping saves", () => {
  // Startups made after the category library have no "categories" list; the
  // record diff must treat it as empty, or every save throws and waits.
  assert.match(source, /new Map\(\(trackerState\[section\] \|\| \[\]\)\.map/);
});

test("a held-back conflict never stalls unrelated saves", () => {
  // Blocked batches stay in the outbox so they survive a reload, but the sender
  // skips them and new edits queue ahead of them. Using pendingOutbox.length
  // as the "is anything queued" test would freeze all syncing until the user
  // resolved the conflict.
  assert.match(source, /function firstSendableOutboxIndex\(\)/);
  assert.match(source, /pendingOutbox\.findIndex\(\(batch\) => !batch\.blockedByConflict\)/);
  assert.match(source, /if \(!hasSendableOutboxBatch\(\)\) \{/);
  assert.match(source, /pendingOutbox\.unshift\(makeOutboxBatch\(persistedState, operations\)\)/);
  // The sent batch is not necessarily at index 0 any more.
  assert.match(source, /function removeOutboxBatch\(batch\)/);
  assert.doesNotMatch(source, /pendingOutbox\.shift\(\)/);
});

test("per-tab caches are swept so old sessions cannot fill browser storage", () => {
  // Tab-scoped keys are created per session and each holds a full copy of the
  // state, so without a sweep every app open leaks another multi-megabyte
  // record until the storage quota is hit.
  assert.match(source, /async function pruneStaleTabCaches\(\)/);
  assert.match(source, /pruneStaleTabCaches\(\);/);
  assert.match(source, /store\.delete\(`sync:\$\{tabId\}`\)/);
  assert.match(source, /store\.delete\(`current:\$\{tabId\}`\)/);
  // Only caches with nothing pending may be removed.
  assert.match(source, /if \(outbox\.length === 0\) removable\.push\(tabId\)/);
});

test("calendar today button updates expanded calendar anchor", () => {
  assert.match(
    source,
    /calendarTodayBtn\.addEventListener\("click",\s*\(\)\s*=>\s*\{[\s\S]*state\.calendarMonthAnchor\s*=\s*calendarMonthOf\(/,
  );
});

test("global search in top bar shows item current status and date", () => {
  assert.match(source, /global-search-result-status/);
  assert.match(source, /data-status="\$\{escapeAttribute\(result\.rawStatus \|\| result\.status\)\}"/);
  assert.match(source, /global-search-result-info/);
  assert.match(source, /global-search-result-date/);
  assert.match(source, /global-search-result-updated/);
  assert.match(drawerStyles, /\.global-search-result-status/);
  assert.match(drawerStyles, /\.global-search-result-info/);
  assert.match(drawerStyles, /\.global-search-result-date/);
  assert.match(drawerStyles, /\.global-search-result-updated/);
});

test("the target window has one History pane, which the history timeline fills", () => {
  // js/record-window.js builds the six tab panes; app.js points the timeline at
  // the History one and reads the record the window has open.
  const windowSource = fs.readFileSync(path.join(root, "js", "record-window.js"), "utf8");
  assert.match(windowSource, /id="recordWindowPane-\$\{tab\.id\}" data-rw-pane="\$\{tab\.id\}"/);
  assert.match(markup, /<div class="modal-overlay record-window" id="recordWindow" hidden><\/div>/);
  assert.match(source, /const RECORD_WINDOW_HISTORY_PANE = "recordWindowPane-history";/);
  assert.match(source, /"recordWindowPane-history": \{/);
  // The pane's section follows the open target, and a draft has no history yet.
  const panes = source.match(/const HISTORY_PANES = \{[\s\S]*?\n  \};/)?.[0] || "";
  assert.match(panes, /get section\(\)/);
  assert.match(panes, /return open && !open\.draft \? open\.id : "";/);
  assert.match(panes, /activityLog: true/);
  // The window's change check compares field values, never DOM controls, so
  // the buttons the timeline draws cannot read as an edit.
  assert.match(windowSource, /function changedFields\(section, original, work\)/);
});

test("history is fetched on tab activation, not on modal open", () => {
  // Only the History tab asks for the timeline (js/record-window.js renders a
  // tab when it opens).
  assert.match(source, /renderHistory: \(\) => activateRecordHistoryPane\(RECORD_WINDOW_HISTORY_PANE\)/);
  assert.match(source, /\$\{API_STATE_URL\}\/history\?\$\{query\}/);
  assert.match(source, /cache: "no-store"/);
  // A second activation while a request is in flight must win, or a slow reply
  // for the previous record would paint over the current one.
  assert.match(source, /if \(paneState\.loadToken !== token \|\| paneState\.recordId !== recordId\) return/);
});

test("history text is escaped everywhere it is rendered", () => {
  // renderMarkdown does not escape, and history text is record content the user
  // typed. Diff rows, chips and scalar values all go through escapeHtml.
  const start = source.indexOf("function renderHistoryDiffRow(row)");
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /escapeHtml\(segment\.text\)/);
  assert.match(body, /escapeHtml\(row\.text\)/);
  assert.doesNotMatch(body, /\$\{segment\.text\}/);
  assert.doesNotMatch(body, /\$\{row\.text\}/);
});

test("restoring one field is a normal save that reopens the modal", () => {
  // Writing the value onto the record without reopening would leave the form
  // showing the old value and the unsaved-changes baseline pointing at a version
  // that no longer exists.
  assert.match(source, /function restoreHistoryFieldValue\(paneId, fieldKey\)/);
  assert.match(source, /persist\(t\("app\.restoreHistoryFieldValue\.restored", \{ label \}\)\)/);
  assert.equal(enText("app.restoreHistoryFieldValue.restored"), "Restored {label}");
  assert.match(source, /view\.reopen\(paneState\.recordId\)/);
  // A clamped value is not the value, so it must not be offered for restore.
  assert.match(source, /const restorable = hasBefore && !isTruncatedHistoryValue\(field\.before\)/);
});

test("restore asks in a dialog that shows what it will overwrite", () => {
  // A bare window.confirm names the field and nothing else, so it cannot say
  // what the record holds now or what is about to replace it.
  assert.doesNotMatch(source, /window\.confirm\([^)]*back to the value/);
  assert.match(source, /function openHistoryRestoreDialog\(paneId, fieldKey\)/);
  // The click opens the dialog; only the dialog's own button writes.
  const clickStart = source.indexOf("function handleRecordHistoryClick(paneId, event)");
  const clickBody = source.slice(clickStart, source.indexOf("\n  }", clickStart));
  assert.match(clickBody, /openHistoryRestoreDialog\(paneId, restoreButton\.dataset\.historyRestore\)/);
  assert.doesNotMatch(clickBody, /restoreHistoryFieldValue\(/);
  assert.match(source, /function confirmHistoryRestoreDialog\(\)[\s\S]{0,220}restoreHistoryFieldValue\(request\.paneId, request\.fieldKey\)/);
  // Reading with create:false, so opening the dialog cannot bring a missing path
  // into being on the record.
  assert.match(source, /const slot = resolveHistoryPath\(record, target\.path, false\)/);
  assert.match(source, /renderHistoryRestorePreview\(currentValue, target\.value, unchanged\)/);
  // Nothing to put back means nothing to confirm.
  assert.match(source, /elements\.confirmHistoryRestoreModal\.disabled = unchanged/);
  assert.match(source, /t\("app\.renderHistoryRestorePreview\.theRecordAlreadyHoldsThis"\)/);
  assert.match(enText("app.renderHistoryRestorePreview.theRecordAlreadyHoldsThis"), /The record already holds this value/);
  assert.match(markup, /id="historyRestoreModal"/);
  assert.match(markup, /id="confirmHistoryRestoreModal"/);
});

test("the markdown preview opens in a window instead of replacing the diff", () => {
  assert.match(markup, /id="historyPreviewModal"/);
  assert.match(source, /function openHistoryPreviewDialog\(paneId, fieldKey\)/);
  // The texts have to be reachable from a click that only carries the field key.
  assert.match(source, /paneState\.previewable\.set\(fieldKey, \{ label: label \|\| fieldKey, before: beforeText, after: afterText \}\)/);
  // The old inline toggle swapped the diff out for the rendered markdown.
  assert.doesNotMatch(source, /data-history-mode="preview"/);
  assert.doesNotMatch(source, /previewFields/);
  // Both dialogs sit above a detail modal, so Escape has to reach them first.
  const escapeStart = source.indexOf('if (e.key === "Escape") {');
  const escapeHead = source.slice(escapeStart, escapeStart + 700);
  assert.ok(
    escapeHead.indexOf("closeHistoryPreviewDialog()") < escapeHead.indexOf("closeRecordConflictModal()"),
    "the history dialogs must take Escape before the modal underneath them",
  );
});

test("entries and days collapse, and the state survives a re-render", () => {
  // The pane rewrites its innerHTML on every click, so a native <details> open
  // state would be lost each time. Both live in the pane state instead.
  assert.match(source, /expandedEntries: new Set\(\)/);
  assert.match(source, /collapsedDays: new Set\(\)/);
  // Entries start closed and days start open, which is why one Set holds what is
  // open and the other what is closed.
  assert.match(source, /data-history-entry="\$\{escapeAttribute\(item\.key\)\}"\$\{open \? " open" : ""\}/);
  assert.match(source, /const open = !paneState\.collapsedDays\.has\(group\.label\)/);
  // toggle does not bubble, so the pane has to listen in the capture phase.
  assert.match(source, /pane\.addEventListener\("toggle", \(event\) => handleRecordHistoryToggle\(paneId, event\), true\)/);
  // Buttons inside a <summary> would fold the entry shut on the way to acting.
  const clickStart = source.indexOf("function handleRecordHistoryClick(paneId, event)");
  const clickBody = source.slice(clickStart, source.indexOf("\n  }", clickStart));
  for (const guarded of [
    "gapButton", "wrapButton", "viewResetButton", "previewButton", "compareButton", "restoreButton",
  ]) {
    const branch = clickBody.slice(clickBody.indexOf(`if (${guarded}) {`));
    assert.match(branch.slice(0, 200), /event\.preventDefault\(\);/, `${guarded} must not toggle the entry`);
  }
});

test("the collapsed digest counts the same lines the opened diff shows", () => {
  // One decision about what is worth diffing, used by both, so a summary saying
  // "+12 −3" cannot sit above a diff that disagrees.
  assert.match(source, /function historyTextDiffTexts\(field\)/);
  assert.match(source, /function summariseHistoryEntry\(paneId, item\)[\s\S]{0,600}historyTextDiffTexts\(field\)/);
  assert.match(source, /function renderHistoryFieldValue\(paneId, fieldKey, field, label\)[\s\S]{0,900}historyTextDiffTexts\(field\)/);
  // Diffing every text field on every re-render would re-run the LCS for the
  // whole timeline each time a caret is clicked.
  assert.match(source, /diffStats: new Map\(\)/);
  assert.match(source, /function historyDiffStats\(paneId, fieldKey, beforeText, afterText\)[\s\S]{0,400}paneState\.diffStats\.set\(fieldKey, stats\)/);
  // A reload can extend the newest entry rather than add one, so the cache keyed
  // by entry id has to be dropped.
  assert.match(source, /paneState\.status = "ready";[\s\S]{0,300}paneState\.diffStats\.clear\(\)/);
  // MK stores status ids; PO and FU store the label itself, so only MK is looked
  // up. Running the lookup over the others would relabel what is already a label.
  assert.match(source, /return section === "items" \? getStatusLabel\(text\) : text;/);
  // The field count is what else moved: a field the +N −M chip already speaks
  // for, and the status the arrow chip already shows, are not counted twice.
  assert.match(source, /const others = digest\.fieldCount - digest\.textFields - \(digest\.statusField \? 1 : 0\)/);
});

test("hidden context opens five lines at a time from either end", () => {
  assert.match(source, /const HISTORY_GAP_STEP = 5;/);
  assert.match(source, /gapReveals: new Map\(\)/);
  assert.match(source, /function revealHistoryGapLines\(paneId, gapKey, edge\)/);
  const revealStart = source.indexOf("function revealHistoryGapLines(paneId, gapKey, edge)");
  const revealBody = source.slice(revealStart, source.indexOf("\n  }", revealStart));
  assert.match(revealBody, /if \(edge === "tail"\) next\.tail \+= HISTORY_GAP_STEP;/);
  assert.match(revealBody, /else next\.head \+= HISTORY_GAP_STEP;/);
  // The head and tail counts have to stay inside the run they belong to.
  assert.match(source, /tail = Math\.max\(0, Math\.min\(tail, total - head\)\)/);
  // The all-or-nothing button the partial reveal replaced.
  assert.doesNotMatch(source, /expandedGaps/);

  // A run at either end of a diff has a change on one side only. Offering the
  // other direction there is what walked the bar into the middle of the lines it
  // had just uncovered; with one direction it stays at its edge of the diff.
  assert.match(source, /hasChangeAbove: gap\.afterHunkIndex >= 0/);
  assert.match(source, /hasChangeBelow: gap\.afterHunkIndex \+ 1 < grouped\.hunks\.length/);
  const gapStart = source.indexOf("function renderHistoryDiffGap(paneId, gapKey, gap, position = {})");
  assert.ok(gapStart > 0, "renderHistoryDiffGap should take the gap's position in the diff");
  const gapBody = source.slice(gapStart, source.indexOf("\n  }", gapStart));
  assert.match(gapBody, /if \(canOpenDown\) \{[\s\S]{0,200}step\("head"/);
  assert.match(gapBody, /if \(canOpenUp\) \{[\s\S]{0,200}step\("tail"/);
  // What was asked of the direction with nowhere to open moves to the other end,
  // so "show all" still lands on the runs at either edge.
  assert.match(gapBody, /if \(!canOpenDown\) tail \+= reveal\.head;/);
  assert.match(gapBody, /if \(!canOpenUp\) head \+= reveal\.tail;/);
  // The way back, offered as soon as anything is open rather than only once the
  // whole run is.
  assert.match(gapBody, /if \(head \+ tail > 0\) \{[\s\S]{0,120}step\("none", t\("app\.renderHistoryDiffGap\.hideAgain"\)/);
});

test("a diff opened up can be put back the way it started", () => {
  assert.match(source, /function resetHistoryDiffView\(paneId, fieldKey\)/);
  const resetStart = source.indexOf("function resetHistoryDiffView(paneId, fieldKey)");
  const resetBody = source.slice(resetStart, source.indexOf("\n  }", resetStart));
  // Both halves of "how it opened": folded runs and unwrapped lines.
  assert.match(resetBody, /paneState\.wrapFields\.delete\(fieldKey\)/);
  assert.match(resetBody, /if \(key\.startsWith\(gapPrefix\)\) paneState\.gapReveals\.delete\(key\)/);
  // One field, not the pane: the other diffs were opened on purpose too.
  assert.doesNotMatch(resetBody, /gapReveals\.clear\(\)/);
  assert.doesNotMatch(resetBody, /wrapFields\.clear\(\)/);
  // Nothing to undo, nothing to offer, so the row stays two buttons wide.
  assert.match(source, /const reset = wrapped \|\| hasOpenGap/);
  assert.match(source, /data-history-view-reset="\$\{escapeAttribute\(fieldKey\)\}"/);
});

test("each diff can be switched to wrapped lines", () => {
  assert.match(source, /wrapFields: new Set\(\)/);
  assert.match(source, /data-history-wrap="\$\{escapeAttribute\(fieldKey\)\}"/);
  assert.match(source, /aria-pressed="\$\{wrapped \? "true" : "false"\}"/);
  // min-width is what holds a long line on one row, so dropping it is the toggle.
  assert.match(modalStyles, /\.record-history-diff\.is-wrapped \.record-history-diff-row \{[^}]*min-width: 0/);
});

test("history pane styles define their own add and remove tokens for both themes", () => {
  // --green and --red exist only in the light palette, so a diff built on them
  // would keep light-theme colours in dark mode.
  assert.match(modalStyles, /\.record-history-pane \{[\s\S]*--history-add-text:/);
  assert.match(modalStyles, /\[data-theme="dark"\] \.record-history-pane \{[\s\S]*--history-add-text:/);
  for (const className of [
    "record-history-timeline", "record-history-entry", "record-history-diff-row",
    "record-history-diff-add", "record-history-diff-remove", "record-history-segment-add",
    "record-history-segment-remove", "record-history-diff-gap", "record-history-diff-step",
    "record-history-chip-added",
    "record-history-chip-removed", "record-history-scalar", "record-history-compare",
    "record-history-preview", "record-history-badge",
    "record-history-day", "record-history-digest", "record-history-refresh",
    "history-dialog-card",
  ]) {
    assert.ok(modalStyles.includes(`.${className}`), `.${className} should be styled`);
  }
  // Every new colour comes from a theme token or a pane token, both of which flip
  // with the theme. A literal hex outside the token blocks would not.
  const historySection = modalStyles.slice(modalStyles.indexOf(".record-history-pane {"));
  const tokenBlockEnd = historySection.indexOf('[data-theme="dark"] .record-history-pane {');
  const afterTokens = historySection.slice(historySection.indexOf("}", tokenBlockEnd));
  assert.doesNotMatch(afterTokens.slice(0, afterTokens.indexOf("/* Comparison")), /:\s*#[0-9a-fA-F]{3,8}\b/);
  // Long diff lines scroll inside the pane rather than widening the modal.
  assert.match(modalStyles, /\.record-history-diff-rows \{[\s\S]*overflow-x: auto/);
});

test("the history pane scrolls sideways on a narrow screen instead of restacking", () => {
  // The shared mobile rule turns the horizontal axis off for every pane; the
  // History pane needs it back, and needs the extra class plus !important to
  // outrank a rule that is already !important.
  assert.match(
    modalStyles,
    /\.modal-card-funding \.notes-editor-pane\.record-history-pane \{[^}]*overflow-x: auto !important/,
  );
  const narrow = modalStyles.slice(modalStyles.lastIndexOf("@media (max-width: 640px) {"));
  assert.match(narrow, /\.record-history-pane \{[^}]*overflow-x: auto/);
  // Restacking a row at a breakpoint is what this replaced.
  assert.doesNotMatch(narrow, /\.record-history-entry-head \{[^}]*align-items: flex-start/);
  // Rows that stay on one line at every width are what makes the scroll work.
  for (const rule of [
    ".record-history-entry-head", ".record-history-digest",
    ".record-history-badges", ".record-history-day-head",
    ".record-history-head",
  ]) {
    const block = modalStyles.slice(modalStyles.indexOf(`${rule} {`));
    assert.match(block.slice(0, block.indexOf("}")), /flex-wrap: nowrap/, `${rule} should not wrap`);
  }
  // .secondary-button's 42px min-height would make a one-line summary 61px tall.
  // The reset lives outside the breakpoint so the pane reads the same at any
  // width; inside it, only the touch rule's side padding needs undoing.
  const reset = modalStyles.indexOf(".record-history-pane .small-btn,");
  assert.ok(reset > 0 && reset < modalStyles.lastIndexOf("@media (max-width: 640px) {"),
    "the min-height reset should apply at every width");
  assert.match(modalStyles.slice(reset, reset + 160), /min-height: 0/);
  assert.match(narrow, /\.record-history-field-head \.small-btn \{[^}]*padding: 4px 10px/);
});

test("nothing sits between a modal tab row and the pane below it", () => {
  // Three wrappers each left room under the row: the tab row's own margin, the
  // panes wrapper's, and the modal body's flex gap. Stacked, they read as an
  // element of their own, and the negative margin the History pane used to claw
  // that space back was clipped by the panes wrapper's overflow, cutting the row
  // with the change count and the refresh button in half.
  assert.match(modalStyles, /\.notes-editor-tabs \{[^}]*margin-bottom: 0/);
  assert.match(modalStyles, /\.modal-card-notes \.notes-editor-panes \{[^}]*margin-top: 0/);
  const narrowPanes = modalStyles.slice(modalStyles.indexOf("@media (max-width: 900px)"));
  assert.match(narrowPanes, /\.modal-card-funding \.notes-editor-panes \{[^}]*margin-top: 0/);
  const paneBlock = modalStyles.slice(modalStyles.indexOf(".record-history-pane {"));
  assert.doesNotMatch(
    paneBlock.slice(0, paneBlock.indexOf("}")),
    /margin-top: -/,
    "a pane cannot reach above its wrapper, which clips",
  );
});

test("a dialog opened from inside a modal paints above it", () => {
  // Every overlay carries the same z-index, so which one wins comes down to
  // document order, and both history dialogs are written before the record modals
  // they open from. They opened behind them.
  assert.match(modalStyles, /\.modal-overlay \{[^}]*z-index: 1100/);
  assert.match(source, /function initOverlayStacking\(\)/);
  assert.match(source, /initAllHorizontalScrollContainers\(\);\s*\n\s*initOverlayStacking\(\);/);
  const stackStart = source.indexOf("function initOverlayStacking()");
  const stackBody = source.slice(stackStart, source.indexOf("\n  }", stackStart));
  assert.match(stackBody, /attributeFilter: \["class"\]/);
  assert.match(stackBody, /Math\.max\(highest, OVERLAY_BASE_Z_INDEX\) \+ OVERLAY_STACK_STEP/);
  // Lifting one that is already open would push it over whatever opened on top.
  assert.match(stackBody, /if \(openOverlays\.has\(overlay\)\) continue;/);
  // The inline value has to outlast the fade, or a closing overlay drops behind
  // the one underneath it halfway through.
  assert.match(stackBody, /window\.setTimeout\(\(\) => \{[\s\S]{0,140}overlay\.style\.zIndex = "";/);
});

test("a long collapsed summary keeps the compare button inside the card", () => {
  // An entry carrying three badges and a full digest ran wider than its own card
  // and pushed the compare button out past the right edge, where nothing could
  // reach it.
  assert.match(modalStyles, /\.record-history-entry-head \{[^}]*overflow: hidden/);
  assert.match(modalStyles, /\.record-history-entry-head > \* \{[^}]*flex-shrink: 0/);
  // What gives way, in order: the badges, then the digest, never the button.
  assert.match(modalStyles, /\.record-history-badges \{[^}]*flex-shrink: 8/);
  assert.match(modalStyles, /\.record-history-digest \{[^}]*flex-shrink: 1/);
  assert.match(modalStyles, /\.record-history-compare-btn \{[^}]*flex-shrink: 0/);
  // Same specificity, so the blanket rule has to come first to be overridden.
  assert.ok(
    modalStyles.indexOf(".record-history-entry-head > * {") < modalStyles.indexOf(".record-history-badges {"),
    "the blanket flex-shrink must not outrank the per-part factors",
  );
});

test("saves from the browser are stamped so the timeline can name the source", () => {
  assert.match(source, /origin: "ui",/);
  // A browser edit is one person sitting at the keyboard, so their name carries
  // everything "Browser" would say and more. The name replaces the origin label
  // rather than sitting next to it, which would read as two separate facts.
  assert.match(source, /const namedByActor = origin === "ui" && Boolean\(entry\.actor\)/);
  assert.match(source, /namedByActor \? entry\.actor : \(HISTORY_ORIGIN_LABELS\[origin\] \|\| origin\)/);
  // Every other origin keeps its own label and shows the actor as a second badge:
  // "Reconstructed" and the git author it came from really are two facts.
  assert.match(source, /if \(entry\.actor && !namedByActor\) \{/);
  // The server decides the name, because who is at the keyboard is a property of
  // the install rather than something a request should be able to claim.
  assert.doesNotMatch(source, /\bactor: "[^"]+"/);
});

test("both history modules load before app.js", () => {
  const diffTag = markup.indexOf("scripts/record-history-diff.js");
  const timelineTag = markup.indexOf("scripts/record-history-timeline.js");
  const appTag = markup.indexOf('src="/app.js');
  assert.ok(appTag > 0, "app.js is loaded by its absolute path");
  assert.ok(diffTag > 0 && timelineTag > 0, "both history modules should be loaded");
  assert.ok(diffTag < appTag && timelineTag < appTag, "app.js reads both at definition time");
});

test("field labels split the path against the record, not on every dot", () => {
  // extraParams and programs.details keys are labels the user typed, and some
  // of them contain dots ("Reach (est.) 2026"). Splitting the stored path
  // blindly turns that into three crumbs of nonsense, so the label function
  // takes the version of the record the path was read against.
  assert.match(source, /function historyFieldLabel\(path, root\)/);
  assert.match(source, /splitHistoryPath\(root, path\)/);
  assert.match(source, /historyFieldLabel\(field\.path, root\)/);
  // Both renderers hand it a real object: the entry view and the comparison.
  assert.match(source, /renderHistoryFieldBlock\(paneId, `e\$\{entry\.entryId\}`, field, item\.stateAfter \|\| item\.stateBefore\)/);
  assert.match(source, /renderHistoryFieldBlock\(paneId, `cmp-\$\{older\.key\}-\$\{newer\.key\}`, field, newer\.stateAfter\)/);
  // The restore confirmation names the same field, so it needs the record too.
  assert.match(source, /historyFieldLabel\(target\.path, record\)/);
});

test("modal tab rows stay on one line and scale to fit", () => {
  // Every pattern here is bounded with [^}] so it cannot wander past the closing
  // brace of the rule it is about and match a declaration from somewhere else in
  // the file.
  //
  // Wrapping was the old behaviour, and base.css forced it with !important, so a
  // nowrap rule anywhere else was powerless. Adding the History tab is what took
  // the Programs row onto a second line.
  assert.doesNotMatch(
    baseStyles,
    /\.notes-editor-tabs[^{}]*\{[^}]*flex-wrap: wrap/,
    "the modal tab rows must not be in the force-wrap group",
  );
  assert.match(baseStyles, /\.notes-editor-tabs \{[^}]*flex-wrap: nowrap !important/);
  assert.match(modalStyles, /\.notes-editor-tabs \{[^}]*flex-wrap: nowrap/);

  // One multiplier drives the whole row, so the label, the padding around it and
  // the space between tabs shrink together instead of the text alone getting
  // small inside buttons that kept their old width.
  assert.match(modalStyles, /\.notes-editor-tabs \{[^}]*--tab-fit: 1/);
  assert.match(modalStyles, /\.notes-editor-tabs \{[^}]*gap: calc\(6px \* var\(--tab-fit\)\)/);
  assert.match(modalStyles, /\.notes-editor-tab \{[^}]*padding: 6px calc\(14px \* var\(--tab-fit\)\)/);
  assert.match(modalStyles, /\.notes-editor-tab \{[^}]*font-size: calc\(0\.82rem \* var\(--tab-fit\)\)/);
  // The narrow-window overrides restate both values, so they have to scale too or
  // they would pin the row back to a fixed size exactly where space is tightest.
  assert.match(modalStyles, /gap: calc\(4px \* var\(--tab-fit\)\)/);
  assert.match(modalStyles, /padding: 6px calc\(10px \* var\(--tab-fit\)\)/);
  assert.match(modalStyles, /font-size: calc\(0\.78rem \* var\(--tab-fit\)\)/);
  // Transitioning the font size would leave the fitter measuring a row still
  // animating towards the size it just asked for.
  assert.doesNotMatch(modalStyles, /\.notes-editor-tab \{[^}]*transition: all/);

  // Measuring always starts from full size. Scaling relative to the current size
  // only ratchets down, so a row squeezed in a narrow window would stay squeezed.
  assert.match(source, /function fitTabRowToOneLine\(row\)/);
  assert.match(source, /row\.style\.setProperty\("--tab-fit", "1"\)/);
  assert.match(source, /const available = row\.clientWidth;\s*\n\s*if \(available <= 0\) return;/);
  assert.match(source, /Math\.max\(TAB_FIT_MIN_SCALE, scale \* \(target \/ needed\)\)/);
  // scrollWidth never reports less than clientWidth, so a row with room to spare
  // measures the same as one that fits exactly and the loop shrinks it for no
  // reason. Adding the tabs up is the only measurement that can say "it fits".
  assert.match(source, /function measureTabRowContent\(row\)/);
  assert.match(source, /const needed = measureTabRowContent\(row\)/);
  assert.doesNotMatch(source, /const needed = row\.scrollWidth/);
  // A closed modal card sits at scale(0.95). Bounding rects come back scaled with
  // it and clientWidth does not, so measuring one against the other read the
  // Programs row 5% narrower than it lays out: it was left just fitting and then
  // overflowed the moment the modal opened, cutting the History tab in half.
  assert.match(source, /for \(const child of row\.children\) total \+= child\.offsetWidth;/);
  assert.doesNotMatch(source, /total \+= child\.getBoundingClientRect\(\)\.width/);
  // Fitted to the row's widest state, with every tab as bold as the selected one,
  // so clicking a different tab cannot push the row past the edge of the modal.
  assert.match(source, /row\.classList\.add\("tab-fit-measuring"\)/);
  assert.match(source, /finally \{\s*\n\s*row\.classList\.remove\("tab-fit-measuring"\);/);
  assert.match(
    modalStyles,
    /\.notes-editor-tabs\.tab-fit-measuring \.notes-editor-tab \{[^}]*font-weight: 700/,
    "the measuring class has to raise every tab to the weight the active one uses",
  );
  assert.match(modalStyles, /\.notes-editor-tab\.active \{[^}]*font-weight: 700/);
  // A width that has not changed cannot change whether the row fits, and acting
  // on the height the fitter itself just changed would restart the measuring.
  assert.match(source, /if \(lastWidth\.get\(entry\.target\) === width\) continue/);
  // A closed overlay is still laid out, so the row already has its full width and
  // the resize observer says nothing when the modal opens. What changes then is
  // which tab starts out selected and whether the body scrollbar takes width off
  // the row, so opening has to fit the row again.
  assert.match(
    source,
    /overlayObserver = new MutationObserver\([\s\S]{0,400}classList\.contains\("open"\)[\s\S]{0,300}querySelectorAll\(TAB_FIT_ROW_SELECTOR\)[\s\S]{0,120}scheduleFit\(row\)/,
    "opening a modal has to re-fit the tab rows inside it",
  );
  assert.match(source, /overlayObserver\.observe\(overlay, \{ attributes: true, attributeFilter: \["class"\] \}\)/);
  // boot() waits for the translations first, then starts the fitter before any render.
  assert.match(source, /boot\(\) \{[^}]{0,300}?await I18n\.ready;\s*\n\s*initModalScrollLockObserver\(\);\s*\n\s*initTabRowFitter\(\);/);

  // Once even the smallest size does not fit, the row scrolls, and dragging it is
  // the only way to reach the last tab with a mouse. The tab rows used to be the
  // one group left out of the drag the category tables have.
  assert.doesNotMatch(source, /container\.classList\.contains\("notes-editor-tabs"\)/);
  assert.match(source, /function initAllHorizontalScrollContainers\(\)[\s\S]{0,900}enableHorizontalScroll\(container\)/);
  // A row that fits has nothing to drag, and counting a small mouse move as a
  // drag there would swallow the click that came with it.
  assert.match(source, /if \(container\.scrollWidth <= container\.clientWidth\) return;\s*\n\s*isDown = true;/);
});

test("every script and stylesheet URL is versioned by content when served", () => {
  // Versioned URLs are cached for a year, so a hand-bumped ?v= that someone
  // forgets leaves a warm cache serving old code. The server stamps each local
  // script and stylesheet with a hash of its content instead, including the
  // @import lines inside styles.css.
  const { createStaticHandler } = require("../lib/http/static");
  const handler = createStaticHandler({ publicDir: root, contentDir: path.join(root, "..", "content"), sendBody() {}, sendNotModified() {} });
  const served = handler.versionHtml(markup, path.join(root, "index.html"));
  const localUrls = [...served.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map((match) => match[1]);
  assert.ok(localUrls.length >= 7, "the page loads its scripts and stylesheet");
  for (const url of localUrls) {
    const [file, query] = url.split("?");
    const expected = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex").slice(0, 12);
    assert.equal(query, `v=${expected}`, `${file} must carry the hash of its content`);
  }
  const importedSheets = [...styles.matchAll(/@import url\("\.\/styles\/([\w-]+\.css)"\)/g)].map((match) => match[1]);
  assert.ok(importedSheets.length > 0, "styles.css imports the section files");
  const servedCss = handler.versionCss(styles, path.join(root, "styles.css"));
  for (const name of importedSheets) {
    assert.ok(fs.existsSync(path.join(root, "styles", name)), `${name} should exist`);
    assert.match(servedCss, new RegExp(`@import url\\("\\./styles/${name.replace(".", "\\.")}\\?v=[0-9a-f]{12}"\\)`));
  }
  // The source files carry no hand-made version strings any more.
  assert.doesNotMatch(markup, /\.(?:js|css)\?v=/);
  assert.doesNotMatch(styles, /\.css\?v=/);
});

test("multi-line note, next action, and blocker fields expand below across modals", () => {
  // The target window draws long text fields as textareas that grow (js/fields.js).
  const Fields = require("../public/js/fields.js");
  assert.match(Fields.inputHtml({ key: "rules", type: "textarea", label: "Rules" }, ""), /<textarea /);
  assert.match(Fields.inputHtml({ key: "items", type: "list", label: "Items" }, ["a", "b"]), /<textarea [^>]*>a\nb<\/textarea>/);

  // Managers use auto-expanding textareas
  assert.match(markup, /<textarea id="dailyDescriptionInput"[^>]*class="[^"]*auto-expand-field[^"]*"[^>]*><\/textarea>/);
  assert.match(markup, /<textarea id="mediaNotesInput"[^>]*class="[^"]*auto-expand-field[^"]*"[^>]*><\/textarea>/);
  assert.match(markup, /<textarea id="feedbackDescriptionInput"[^>]*class="[^"]*auto-expand-field[^"]*"[^>]*><\/textarea>/);
  assert.match(markup, /<textarea id="campaignHypothesisInput"[^>]*class="[^"]*auto-expand-field[^"]*"[^>]*><\/textarea>/);
  assert.match(markup, /<textarea id="tagDescriptionInput"[^>]*class="[^"]*auto-expand-field[^"]*"[^>]*><\/textarea>/);

  // So does the Company window (js/company-page.js): steps, obligations,
  // deadlines and expenses.
  const CompanyPage = require("../public/js/company-page.js");
  assert.match(CompanyPage.windowFieldHtml({ key: "notes", label: "Notes", type: "textarea", value: "a\nb" }), /<textarea id="cw-notes" name="notes" class="auto-expand-field"[^>]*>a\nb<\/textarea>/);

  // Global textarea styles and modal auto-expand styles include field-sizing: content
  const formStyles = fs.readFileSync(path.join(root, "styles", "forms-buttons.css"), "utf8");
  assert.match(formStyles, /textarea\s*\{[\s\S]*?field-sizing:\s*content/);
  assert.match(modalStyles, /\.auto-expand-field,\s*\n\s*\.metadata-form-grid textarea/);
  assert.match(modalStyles, /field-sizing:\s*content/);
});

test("the calendar and every section's Focus queue show counts on their date mode buttons", () => {
  // The calendar keeps its own bar.
  assert.match(markup, /class="focus-date-mode calendar-mode-toggle"[\s\S]*?data-calendar-mode="on"[^>]*><span data-i18n="ui\.common\.onThisDay">On this day<\/span> <span class="tab-count">0<\/span><\/button>/);
  assert.match(markup, /class="focus-date-mode calendar-mode-toggle"[\s\S]*?data-calendar-mode="by"[^>]*><span data-i18n="ui\.common\.dueBy">Due by<\/span> <span class="tab-count">0<\/span><\/button>/);
  assert.match(source, /function renderCalendarTab\([^)]*\)[\s\S]*?onCount[\s\S]*?byCount[\s\S]*?\.tab-count/);
  // MK, PO and FU share one Focus queue with the same wording as the calendar.
  for (const view of ["pipelineView", "programsView", "fundingView"]) {
    const start = markup.indexOf(`id="${view}"`);
    const html = markup.slice(start, markup.indexOf("data-sp-focus-list", start));
    assert.match(html, /data-sp-focus-mode="on"><span data-i18n="ui\.common\.onThisDay">On this day<\/span> <span class="tab-count">0<\/span><\/button>/, view);
    assert.match(html, /data-sp-focus-mode="by"><span data-i18n="ui\.common\.dueBy">Due by<\/span> <span class="tab-count">0<\/span><\/button>/, view);
  }
  const pageSource = fs.readFileSync(path.join(root, "js", "section-page.js"), "utf8");
  assert.match(pageSource, /count\.textContent = String\(button\.dataset\.spFocusMode === "on" \? on\.length : by\.length\)/);
  const layoutStyles = fs.readFileSync(path.join(root, "styles", "layout.css"), "utf8");
  assert.match(layoutStyles, /\.focus-date-mode-btn\s*\{[\s\S]*?display:\s*inline-flex;/);
  assert.match(layoutStyles, /\.focus-date-mode-btn\s+\.tab-count\s*\{[\s\S]*?border-radius:\s*999px;/);
});

test("rendered markdown and note code blocks wrap text cleanly without horizontal scrolling", () => {
  // Code blocks in notes wrap preformatted text instead of requiring horizontal scroll
  assert.match(modalStyles, /\.markdown-rendered pre\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(modalStyles, /\.markdown-rendered pre\s*\{[^}]*word-break:\s*break-word/);
  assert.match(modalStyles, /\.markdown-rendered pre code\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(modalStyles, /\.markdown-rendered code\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(modalStyles, /\.markdown-rendered\s*\{[^}]*overflow-wrap:\s*break-word/);
});

test("the Details tab shows the core fields first, in the same order in every section", () => {
  const Fields = require("../public/js/fields.js");
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "..", "content", "fields", `${name}.json`), "utf8"));
  Fields.setRegistry({ common: read("common"), mk: read("mk"), po: read("po"), fu: read("fu") });
  const order = (section) => Fields.coreFields(section).map((field) => field.key);
  // ID, name, categories, status and the next action date come first, then
  // organization, link and priority.
  for (const section of ["mk", "po", "fu"]) {
    const keys = order(section);
    for (const [before, after] of [["id", "name"], ["name", "taxonomy"], ["taxonomy", "status"], ["status", "nextActionDate"], ["nextActionDate", "organization"], ["organization", "link"], ["link", "priority"]]) {
      assert.ok(keys.indexOf(before) < keys.indexOf(after), `${section}: ${before} before ${after}`);
    }
  }
  // PO adds the record kind, FU the funding round; the rest is shared.
  assert.ok(order("po").includes("recordKind") && !order("mk").includes("recordKind"));
  assert.ok(order("fu").includes("roundId") && !order("po").includes("roundId"));
});

test("extra/ai includes Current flow section with Sub/API, model, and details columns", () => {
  assert.match(markup, /<div class="ai-flow-wrap" id="aiFlowWrap"><\/div>/);
  // The flow is shared by every startup (js/global-data.js).
  assert.match(source, /aiFlow: state\.aiFlow,/);
  assert.match(source, /function renderAiFlow\(\)/);
  assert.match(source, /function addAiFlowItem\(\)/);
  assert.match(source, /function deleteAiFlowItem\(/);
  assert.match(source, /function moveAiFlowItem\(/);
  assert.match(source, /function reorderAiFlowItem\(/);
  assert.match(source, /function ensureAiFlowSeparator\(/);
  assert.match(source, /ai-flow-separator-row/);
  assert.match(source, /data-ai-flow-action="move-up"/);
  assert.match(source, /data-ai-flow-action="move-down"/);
  for (const [key, text] of [["subApi", "Sub/API"], ["model", "model"], ["details", "details"]]) {
    assert.match(source, new RegExp(`<span>\\$\\{escapeHtml\\(t\\("app\\.renderAiFlow\\.${key}"\\)\\)\\}<\\/span>`));
    assert.equal(enText(`app.renderAiFlow.${key}`), text);
  }

  // A new install starts with no AI entries: subscriptions and the flow are
  // personal, so the user adds their own. They are shared by every startup.
  assert.doesNotMatch(source, /DEFAULT_AI_(FLOW|ACCOUNTS)/);
  assert.match(source, /state\.aiAccounts = list\(sections\.aiAccounts\)\.map\(normalizeAiAccount\)/);
  assert.match(source, /state\.aiFlow = list\(sections\.aiFlow\)\.map\(normalizeAiFlowItem\)/);
});

test("the Romanian template keeps the EUID after the trade register number, and ID numbers stay sensitive", () => {
  // The old SRL tab's fixed fields (EUID, the founders' CNP and identity
  // card) now come from content/company-templates/ro-srl.json.
  const template = JSON.parse(fs.readFileSync(path.join(root, "..", "content", "company-templates", "ro-srl.json"), "utf8"));
  const keys = template.profileFields.map((field) => field.key);
  assert.ok(keys.indexOf("euid") > keys.indexOf("registrationNumber") && keys.indexOf("registrationNumber") >= 0, "EUID follows the trade register number");
  assert.equal(template.profileFields.find((field) => field.key === "euid").sensitive, false);
  // A person's national ID number is a person field kept with the
  // sensitive values, never in the profile the state carries.
  assert.ok(template.people.fields.includes("idNumber"));
  const Company = require("../public/js/company-model.js");
  const profile = Company.normalizeProfile({ people: [{ id: "p1", name: "Ana", idNumber: "ID-TEST-0123" }] });
  assert.equal("idNumber" in profile.people[0], false, "the profile drops an ID number put in it");
  const secrets = Company.normalizeSecrets({ people: { p1: { idNumber: "ID-TEST-0123" } } });
  assert.equal(secrets.people.p1.idNumber, "ID-TEST-0123");
  assert.equal(Company.mask(secrets.people.p1.idNumber), "•••• 0123");
  // No reader of the old single "srl" section is left in the page.
  assert.doesNotMatch(source, /state\.srl\b|DEFAULT_SRL_DATA|\bsrl[A-Z]\w*\(/);
  assert.doesNotMatch(markup, /\bsrl[A-Z-]/);
});

test("global search and tab search filters inspect record IDs (MK, PO, FU)", () => {
  const currentSource = fs.readFileSync(path.join(root, "app.js"), "utf8");

  // Global search makeGlobalSearchResult appends record ID and badge-prefixed ID
  assert.match(
    currentSource,
    /appendGlobalSearchFields\(fields,\s*"ID",\s*recordId,\s*"id"\)/,
    "makeGlobalSearchResult should append the record ID"
  );
  assert.match(
    currentSource,
    /appendGlobalSearchFields\(fields,\s*"ID",\s*`\$\{badgePrefix\}\$\{recordId\}`,\s*"id"\)/,
    "makeGlobalSearchResult should append badge-prefixed ID for matching by badge prefix"
  );

  // findGlobalSearchMatch scores ID kind
  assert.match(
    currentSource,
    /field\.kind === "title" \? 0 : field\.kind === "id" \? 5 : field\.kind === "note" \? 20 : 40/,
    "findGlobalSearchMatch should score id matches with higher priority than notes and details"
  );

  // Global search snippet preserves actual record ID on ID matches
  assert.match(
    currentSource,
    /snippet:\s*match\.field\.kind === "id" \? String\(config\.id \|\| match\.field\.value\) : getGlobalSearchSnippet\(match\.field\.value, queryTerms\)/,
    "makeGlobalSearchResult should use record ID as snippet on ID match"
  );

  // The search box of every section page reads the record ID too.
  assert.match(currentSource, /search: \[record\.id, name, organization/, "describeTarget puts the ID in the searched text");
});

test("the Prompts page lives in js/prompts-page.js; app.js only hands it the startup", () => {
  // The scope, smart selection and variable rules moved with the page and are
  // tested on the module (tests/prompts-page.test.js).
  assert.match(markup, /<div id="promptsPage" class="prompts-page"><\/div>/);
  assert.doesNotMatch(source, /function (getSubstitutedPromptText|promptScopeFromPicks|formatSmartSelectionList|hasUnsavedPromptFilterChanges)\(/);
  assert.doesNotMatch(markup, /id="prompt(VarsPanel|Select|ExampleModal|MarkdownTextarea)"/);
  const glue = source.match(/function promptsPage\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  for (const hook of ["shared:", "saveShared:", "deletePrompt:", "profile:", "createToken:", "checkImport:", "importRows:"]) assert.ok(glue.includes(hook), hook);
  // The copied prompt's token comes from the startup's own route.
  assert.match(glue, /fetch\(Api\.api\("\/agent-tokens"\)/);
  // Prompts, presets and examples are shared by every startup.
  const shared = source.match(/function collectGlobalSections\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  for (const section of ["prompts: state.prompts", "deletedPrompts: state.deletedPrompts", "promptPresets: state.promptPresets", "promptExamples: state.promptExamples"]) assert.ok(shared.includes(section), section);
});

test("adding a record sends no reorder; only a changed order of existing records does", () => {
  const body = source.match(/function buildIncrementalOperations\(trackerState\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(body, /const kept = previousCollection\.ids\.filter\(\(id\) => currentCollection\.signatures\.has\(id\)\);/);
  assert.match(body, /const order = currentCollection\.ids\.filter\(\(id\) => previousCollection\.signatures\.has\(id\)\);/);
  assert.match(body, /JSON\.stringify\(kept\) !== JSON\.stringify\(order\)/);
  // New records still carry their position, and the page's copy of what the
  // server holds puts them there too, so the next save sees no change of order.
  assert.match(body, /if \(!previousCollection\.signatures\.has\(id\)\) operation\.position = position;/);
  const vm = require("node:vm");
  const fn = source.match(/function applyOperationsToPersistedState\(baseState, operations, updatedAt\) \{[\s\S]*?\n  \}/)?.[0];
  const sandbox = { clonePersistedState: (value) => JSON.parse(JSON.stringify(value)) };
  vm.runInNewContext(`${fn}; this.apply = applyOperationsToPersistedState;`, sandbox);
  const next = sandbox.apply({ items: [{ id: "a" }, { id: "b" }] }, [{ type: "upsert", section: "items", id: "n", value: { id: "n" }, position: 0 }, { type: "upsert", section: "items", id: "z", value: { id: "z" } }], "t");
  assert.deepEqual(next.items.map((item) => item.id), ["n", "a", "b", "z"]);
});

test("every write names the revision the page loaded, also for older cached batches", () => {
  const vm = require("node:vm");
  const make = source.match(/function makeOutboxBatch\(persistedState, operations\) \{[\s\S]*?\n  \}/)?.[0];
  const request = source.match(/function getOutboxRequest\(batch\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(make && request);
  assert.match(make, /knownRevision: state\.lastServerRevision \|\| 0/);
  const getOutboxRequest = vm.runInNewContext(`(${request.replace("function getOutboxRequest", "function")})`);
  assert.equal(getOutboxRequest({ mutationId: "m", baseRevision: 7, knownRevision: 5, operations: [] }).knownRevision, 5);
  assert.equal(getOutboxRequest({ mutationId: "m", baseRevision: 7, operations: [] }).knownRevision, 7, "a batch cached before Part 3 uses its baseRevision");
  assert.equal(getOutboxRequest({ mutationId: "m", baseRevision: 7, knownRevision: 0, operations: [] }).knownRevision, 0);
  assert.equal(getOutboxRequest({ mutationId: "m", operations: [] }).protocolVersion, 2);
});

test("a write refused as restored is held for the user and never resent on its own", () => {
  assert.match(source, /if \(payload\.error === "restored"\) \{\s*return handleRestoredConflict\(payload\);/);
  const handler = source.match(/async function handleRestoredConflict\(payload\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(handler);
  // Every queued batch is held as a conflict; the restored state is loaded.
  assert.match(handler, /blockedByConflict: true,\s*restoredConflict: true,/);
  assert.match(handler, /pendingOutbox\.filter\(\(batch\) => !batch\.blockedByConflict\)/);
  assert.match(handler, /fetch\(API_STATE_URL, \{ cache: "no-store" \}\)/);
  assert.match(handler, /applyLoadedState\(serverState\);\s*acceptAcknowledgedPersistedState\(buildPersistedState\(\)\);/);
  // The held records keep the user's version on screen, for Keep mine.
  assert.match(handler, /applyLiveRecord\(entry\.section, entry\.id, clonePersistedState\(entry\.value\)\)/);
  assert.match(handler, /showRecordConflictNotification\(state\.recordConflicts\);\s*return false;/);
  // Nothing in it sends, rebases or resolves.
  assert.doesNotMatch(handler, /rebaseBlockedConflictBatches|sendPendingOutboxBatch|persist\(|resolveRecordConflicts/);
  // Edits typed while the refused request was out are held too, not lost.
  assert.match(handler, /const unsent = acknowledgedPatchSnapshot \? buildIncrementalOperations\(buildPersistedState\(\)\) : \[\];/);
  // The badge says why these edits wait.
  assert.match(source, /conflicts\.every\(\(conflict\) => conflict\.restored\)\) \{\s*return t\("sync\.restoredConflicts"/);
});

test("every record type is soft deleted into its paired recycle-bin section", () => {
  const Recycle = require("../public/js/recycle.js");
  const collections = source.match(/const PATCHABLE_RECORD_COLLECTIONS = \[([\s\S]*?)\];/)?.[1] || "";
  const persisted = source.match(/function buildPersistedState\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  const shared = source.match(/function collectGlobalSections\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  for (const section of Recycle.DELETED_SECTIONS) {
    // Campaign and tag bins are shared by every startup (js/global-data.js).
    if (["deletedCampaigns", "deletedTags", "deletedPrompts"].includes(section)) {
      assert.match(shared, new RegExp(`${section}: state\\.${section}`), `${section} is saved with the shared data`);
      assert.doesNotMatch(collections, new RegExp(`"${section}"`), `${section} is not saved with the startup`);
      continue;
    }
    assert.match(collections, new RegExp(`"${section}"`), `${section} is saved record by record`);
    assert.match(persisted, new RegExp(`${section}: state\\.${section}`), `${section} is persisted`);
  }
  // Deleting a tag takes it off records in every startup, on the server
  // (lib/tags.js), which moves the definition to the bin.
  const deleteTag = source.match(/function deleteTagDefinition\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(deleteTag, /runTagAction\("delete", \{ tag: tagId \}/);
  for (const [fn, live] of [["deleteCampaign", "campaigns"], ["deleteDailyLink", "dailyLinks"], ["deleteFeedbackItem", "feedbackItems"], ["deleteMediaItem", "mediaItems"]]) {
    const body = source.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(body, fn);
    assert.match(body, new RegExp(`moveRecordToBin\\("${live}", `), `${fn} moves the record to the bin`);
    assert.doesNotMatch(body, /\.filter\(\(entry\) => entry\.id !==/, `${fn} no longer deletes for good`);
  }
  assert.match(source, /if \(!window\.confirm\(t\("recycle\.confirmDeletePrompt"[\s\S]{0,120}moveRecordToBin\("prompts", prompt\.id\)/);
  // The default tags are added once, never again after they were deleted.
  assert.match(source, /if \(seedDefaults && !state\.globalSeeded\.tags\)/);
  assert.doesNotMatch(source, /mergeTagDefinitions/);
  // Settings reaches the bin and the profile only through this page's outbox.
  const bridge = source.match(/window\.StartupTrackerPage = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || "";
  for (const name of ["prepareToLeave", "getProfile", "saveProfile", "getRecycleBin", "restoreFromBin", "deleteFromBin", "emptyBin"]) {
    assert.match(bridge, new RegExp(`\\b${name}\\b`), name);
  }
  for (const fn of ["restoreFromBin", "deleteFromBin", "emptyBin", "saveProfile"]) {
    const body = source.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert.match(body, /persist\(/, `${fn} saves through persist()`);
  }
});

test("dates, the time zone and the calendar week follow Settings > General", () => {
  assert.match(source, /return Settings\.effectiveTimeZone\(Settings\.get\(\), Dates\.defaultTimeZone\(\)\);/);
  assert.match(source, /const formatted = Dates\.formatDateAs\(value, getLocale\(\), getDateFormat\(\)\);/);
  assert.match(source, /Dates\.formatInstantAs\(date, getLocale\(\), getTimeZone\(\), getDateFormat\(\)\)/);
  // The month panel's weeks start on the chosen day (calendar-model.test.js
  // checks the grid itself).
  assert.match(source, /Calendar\.monthGrid\([^)]*, getWeekStart\(\)\)/);
  // A change applies at once: cached dates are dropped and the page re-renders.
  const apply = source.match(/function applySettingsToPage\(settings, previous\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(apply, /formattedDateCache\.clear\(\);/);
  assert.match(apply, /render\(\);/);
  assert.match(source, /Settings\.subscribe\(applySettingsToPage\);/);
});

test("links are one saved collection, and old link fields are written out once", () => {
  assert.match(source, /const PATCHABLE_RECORD_COLLECTIONS = \[\s*"links",/);
  assert.match(source, /\n      links: state\.links,\n/);
  // Stored links win over the ones read again from old fields.
  assert.match(source, /state\.links = Links\.mergeLinks\(storedLinks, legacyLinks\);/);
  // After a load, the links read from old fields and the records that carried
  // them are forgotten from the saved copy, so the next save writes them.
  const accept = source.match(/function acceptAcknowledgedPersistedState\(trackerState\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(accept, /if \(pendingLinkMigration\) applyPendingLinkMigration\(\);/);
  const migrate = source.match(/function applyPendingLinkMigration\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(migrate, /forget\("links", id\)/);
  assert.match(migrate, /migration\.records\.forEach/);
  assert.match(migrate, /scheduleAutosave\(\);/);
  // Deleting for good drops the links too; a target's old dependency fields
  // are retired, funding keeps its text ones.
  for (const fn of ["deleteFromBin", "emptyBin"]) {
    const body = source.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || "";
    assert.match(body, /dropLinksTo\(/, `${fn} drops links`);
  }
  assert.match(source, /const RETIRED_EXTRA_PARAM_IDS = new Set\(\["assets", "linkedMedia"\]\);/);
  assert.match(source, /const extraParams = filterRetiredExtraParams\(rawExtra, RETIRED_TARGET_EXTRA_PARAM_IDS\);/);
  assert.match(markup, /<script src="\/js\/links-model\.js"><\/script>\s*<script src="\/js\/components\/item-picker\.js"><\/script>[\s\S]*<script src="\/app\.js"><\/script>/);
});

test("the target window saves through the outbox on every path, and old link and field keys are written out once", () => {
  const save = source.match(/function saveTargetFromWindow\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] || "";
  // Edits and drafts both reach the server as normal record operations with
  // their history, and a draft is added only on its first Save.
  assert.match(save, /markDataChanged\(\);/);
  assert.match(save, /persist\(draft \? t\("app\.saveTargetFromWindow\.targetAdded"\) : t\("app\.saveTargetFromWindow\.targetUpdated"\)\);/);
  assert.match(save, /if \(draft\) \{\s*list\.unshift\(next\);/);
  assert.match(save, /finishAddForm\(section\);/);
  // A repeating target still makes its next occurrence when it is closed.
  assert.match(save, /handleRepeatingTarget\(next\)/);
  // Older field keys move on load and those records are saved once.
  assert.match(source, /const result = Fields\.migrate\(section, record\);\s*if \(result\.changed\) migrated\.records\.push/);
  // Normalizers keep keys they do not know.
  assert.match(source, /function withTargetFields\(raw, normalized\)/);
  assert.match(source, /return withTargetFields\(item, \{/);
  assert.match(source, /return withTargetFields\(prog, \{/);
  assert.match(source, /return withTargetFields\(fund, \{/);
  assert.match(markup, /<script src="\/js\/fields\.js"><\/script>\s*<script src="\/js\/record-window\.js"><\/script>[\s\S]*<script src="\/app\.js"><\/script>/);
});
