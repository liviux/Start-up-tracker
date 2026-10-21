// Data shared by every startup that the page edits directly: campaigns, tag
// definitions, the AI page, prompts with their presets and examples, and
// research links ticked "Shared" (window.StartupTrackerGlobalData).
//
// It changes rarely, so it skips the startup's outbox: the page changes its
// copy at once, and a short moment later the changed records go to PATCH
// /api/global/operations in the same operation format as a startup save, each
// with the revision it was based on. When another tab or startup changed the
// same record first the server refuses, and the page reloads the shared data
// instead of overwriting it. The last copy read is kept in localStorage so an
// offline start still shows campaigns and tags.
//
// UMD: browsers get window.StartupTrackerGlobalData, Node gets module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StartupTrackerGlobalData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // section: the name in the global scope. records: a list of records with
  // ids (anything else is saved whole).
  const SECTIONS = Object.freeze([
    { section: "campaigns", records: true },
    { section: "deletedCampaigns", records: true },
    { section: "tags", records: true },
    { section: "deletedTags", records: true },
    { section: "aiAccounts", records: true },
    { section: "aiFlow", records: true },
    { section: "aiSettings", records: false },
    { section: "prompts", records: true },
    { section: "deletedPrompts", records: true },
    { section: "promptPresets", records: true },
    { section: "promptExamples", records: true },
    { section: "dailyLinks", records: true },
    { section: "deletedDailyLinks", records: true },
    // Which shipped defaults were added once already, so a deleted default
    // tag does not come back.
    { section: "seeded", records: false },
  ].map((entry) => Object.freeze(entry)));
  const SECTION_NAMES = Object.freeze(SECTIONS.map((entry) => entry.section));
  const SAVE_DELAY_MS = 400;

  // What was last saved or read, per section: record ids in order and one
  // signature per record, or one signature for a whole value.
  function snapshot(sections) {
    const result = {};
    for (const spec of SECTIONS) {
      const value = sections?.[spec.section];
      if (spec.records) {
        const list = Array.isArray(value) ? value : [];
        const ids = [];
        const signatures = new Map();
        for (const record of list) {
          const id = String(record?.id ?? "");
          if (!id || signatures.has(id)) throw new Error(`Cannot save ${spec.section}: every record needs a unique id.`);
          ids.push(id);
          signatures.set(id, JSON.stringify(record));
        }
        result[spec.section] = { ids, signatures };
      } else {
        result[spec.section] = { value: value === undefined ? undefined : JSON.stringify(value) };
      }
    }
    return result;
  }

  function baseRevision(revisionMap, section, id) {
    const revision = revisionMap?.records?.[section]?.[id];
    return Number.isSafeInteger(revision) ? revision : 0;
  }

  // The operations that turn `previous` into `sections`.
  function diff(previous, sections, revisionMap) {
    const current = snapshot(sections);
    const operations = [];
    for (const spec of SECTIONS) {
      const before = previous?.[spec.section];
      const after = current[spec.section];
      if (!spec.records) {
        if (after.value !== undefined && after.value !== before?.value) {
          operations.push({ type: "replaceSection", section: spec.section, value: sections[spec.section], baseRevision: revisionMap?.sections?.[spec.section] });
        }
        continue;
      }
      const beforeIds = before?.ids || [];
      const beforeSignatures = before?.signatures || new Map();
      const records = new Map((sections?.[spec.section] || []).map((record) => [String(record.id), record]));
      for (const id of beforeIds) {
        if (!after.signatures.has(id)) operations.push({ type: "delete", section: spec.section, id, baseRevision: baseRevision(revisionMap, spec.section, id) });
      }
      after.ids.forEach((id, position) => {
        if (after.signatures.get(id) === beforeSignatures.get(id)) return;
        const operation = { type: "upsert", section: spec.section, id, value: records.get(id), baseRevision: baseRevision(revisionMap, spec.section, id) };
        if (!beforeSignatures.has(id)) operation.position = position;
        operations.push(operation);
      });
      const kept = beforeIds.filter((id) => after.signatures.has(id));
      const order = after.ids.filter((id) => beforeSignatures.has(id));
      if (kept.join("\n") !== order.join("\n")) operations.push({ type: "reorder", section: spec.section, ids: after.ids.slice() });
    }
    return operations;
  }

  function pick(state) {
    const sections = {};
    for (const name of SECTION_NAMES) if (state && state[name] !== undefined) sections[name] = state[name];
    return sections;
  }

  // hooks: collect() returns the sections as the page holds them now;
  // apply(sections, { reason }) gives the page newer ones; status(kind,
  // message) reports "saving", "saved", "conflict" or "error".
  function create({ fetchImpl, urls, hooks = {}, storage = null, cacheKey = "startup-tracker-global-cache", delay = SAVE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    let acknowledged = null;
    let revisionMap = null;
    let etag = "";
    let timer = null;
    let inFlight = null;
    let again = false;

    function readCache() {
      try {
        const text = storage?.getItem(cacheKey);
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    }

    function writeCache(sections) {
      try {
        storage?.setItem(cacheKey, JSON.stringify(sections));
      } catch {
        // The cache only helps an offline start.
      }
    }

    function accept(body) {
      const sections = pick(body.state || {});
      acknowledged = snapshot(sections);
      revisionMap = body.revisionMap || null;
      writeCache(sections);
      return sections;
    }

    // The shared data from the server, or the cached copy when it cannot be
    // reached (then nothing is saved until a load succeeds).
    async function load() {
      try {
        const response = await doFetch(urls.global, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
        etag = response.headers?.get?.("ETag") || "";
        return { sections: accept(body), offline: false };
      } catch (error) {
        acknowledged = null;
        return { sections: readCache() || {}, offline: true, error };
      }
    }

    // Newer shared data, or null when nothing changed or edits are on their way.
    async function refresh() {
      if (timer || inFlight || !acknowledged) return null;
      const response = await doFetch(urls.global, { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {} });
      if (response.status === 304) return null;
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      if (timer || inFlight) return null;
      etag = response.headers?.get?.("ETag") || "";
      const before = JSON.stringify([...acknowledgedSignature()]);
      const sections = accept(body);
      return before === JSON.stringify([...acknowledgedSignature()]) ? null : sections;
    }

    function acknowledgedSignature() {
      const parts = [];
      for (const name of SECTION_NAMES) {
        const entry = acknowledged?.[name];
        if (!entry) continue;
        parts.push(entry.ids ? `${name}:${entry.ids.map((id) => entry.signatures.get(id)).join("\u0000")}` : `${name}:${entry.value}`);
      }
      return parts;
    }

    function schedule() {
      if (!acknowledged) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        flush();
      }, delay);
    }

    async function flush() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      if (inFlight) {
        again = true;
        return inFlight;
      }
      if (!acknowledged) return null;
      const sections = pick(hooks.collect ? hooks.collect() : {});
      const operations = diff(acknowledged, sections, revisionMap);
      if (!operations.length) return null;
      hooks.status?.("saving");
      inFlight = (async () => {
        try {
          const response = await doFetch(urls.globalOperations, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operations, origin: "ui", label: "Shared data" }),
          });
          const body = await response.json().catch(() => ({}));
          if (response.status === 409) {
            hooks.status?.("conflict", body.message || "");
            const fresh = await load();
            hooks.apply?.(fresh.sections, { reason: "conflict" });
            return { conflict: true };
          }
          if (!response.ok || body.ok === false) throw new Error(body.message || body.error || `HTTP ${response.status}`);
          acknowledged = snapshot(sections);
          revisionMap = body.revisionMap || revisionMap;
          etag = "";
          writeCache(sections);
          hooks.status?.("saved");
          return { saved: operations.length };
        } catch (error) {
          hooks.status?.("error", error.message);
          return { error };
        } finally {
          inFlight = null;
          if (again) {
            again = false;
            schedule();
          }
        }
      })();
      return inFlight;
    }

    return Object.freeze({
      load,
      refresh,
      schedule,
      flush,
      isBusy: () => Boolean(timer || inFlight),
      isOnline: () => Boolean(acknowledged),
    });
  }

  return Object.freeze({ SECTIONS, SECTION_NAMES, SAVE_DELAY_MS, snapshot, diff, pick, create });
});
