(function exposeRecordHistoryTimeline(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RecordHistoryTimeline = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  // Turning a stored list of field deltas back into "what did this record look
  // like on 11 August" is the part of the history feature most likely to be
  // quietly wrong, so it lives here as plain functions with no DOM and no
  // fetch, separate from the rendering.

  // Deleting in this app moves a record into a parallel section instead of
  // removing it, so one logical record owns a timeline in each half of the pair
  // and a delete plus a create at the same instant are a single move.
  const PAIRED_SECTIONS = {
    items: "deletedItems",
    deletedItems: "items",
    programs: "deletedPrograms",
    deletedPrograms: "programs",
    funding: "deletedFunding",
    deletedFunding: "funding",
  };

  // Mirrors the ignored paths the conflict merge uses: an id never changes and
  // updatedAt changes on every save, so neither is worth a timeline line.
  const DEFAULT_IGNORED_PATHS = new Set(["id", "updatedAt"]);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isTruncatedValue(value) {
    return isPlainObject(value) && value.truncated === true;
  }

  function isRecycleBinSection(section) {
    return String(section || "").startsWith("deleted");
  }

  function cloneValue(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneValue);
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = cloneValue(value[key]);
    return copy;
  }

  function normalizeValue(value) {
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isPlainObject(value)) return value;
    // Key order is not part of a value's identity, so two objects written by
    // different code paths must not read as a change.
    const normalized = {};
    for (const key of Object.keys(value).sort()) normalized[key] = normalizeValue(value[key]);
    return normalized;
  }

  function valuesEqual(left, right) {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));
  }

  // Splits a dotted history path into the keys the data actually nests by, so a
  // user-supplied label containing a dot stays one segment. details keys can
  // be free text, so "details.Reach (est.) 2026" is two levels, not four.
  // Longest candidate first, which makes a literal key
  // with dots win over a nested lookup that happens to match its prefix.
  // Returns null when the path does not resolve against this object at all.
  function splitPath(rootValue, path) {
    if (!isPlainObject(rootValue)) return null;
    if (Object.prototype.hasOwnProperty.call(rootValue, path)) return [String(path)];
    const segments = String(path).split(".");
    if (segments.length === 1) return null;

    for (let take = segments.length - 1; take >= 1; take -= 1) {
      const head = segments.slice(0, take).join(".");
      if (!Object.prototype.hasOwnProperty.call(rootValue, head)) continue;
      if (!isPlainObject(rootValue[head])) continue;
      const rest = splitPath(rootValue[head], segments.slice(take).join("."));
      if (rest) return [head, ...rest];
    }
    return null;
  }

  // Resolves a dotted history path to the object holding the last segment.
  function resolvePath(rootValue, path, createMissing) {
    if (!isPlainObject(rootValue)) return null;
    const resolved = splitPath(rootValue, path);
    if (resolved) {
      let container = rootValue;
      for (let index = 0; index < resolved.length - 1; index += 1) container = container[resolved[index]];
      return { container, key: resolved[resolved.length - 1] };
    }

    const segments = String(path).split(".");
    // A single segment always has a home, whether or not it is filled in yet,
    // so a delete of a field that is already gone stays a no-op.
    if (segments.length === 1) return { container: rootValue, key: segments[0] };
    if (!createMissing) return null;
    // Nothing along the path exists yet, so build it one segment at a time.
    let container = rootValue;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const key = segments[index];
      if (!isPlainObject(container[key])) container[key] = {};
      container = container[key];
    }
    return { container, key: segments[segments.length - 1] };
  }

  // Walks the same shape the store walks when it records a change: plain objects
  // recurse per key, arrays and scalars compare whole. Used for comparing two
  // reconstructed versions, where there is no stored delta to read.
  function describeChanges(before, after, options) {
    const ignored = (options && options.ignoredPaths) || DEFAULT_IGNORED_PATHS;
    const fields = [];

    const visit = (left, right, parentPath) => {
      const leftObject = isPlainObject(left) ? left : null;
      const rightObject = isPlainObject(right) ? right : null;
      const keys = new Set([
        ...(leftObject ? Object.keys(leftObject) : []),
        ...(rightObject ? Object.keys(rightObject) : []),
      ]);
      for (const key of keys) {
        const fieldPath = parentPath ? `${parentPath}.${key}` : key;
        if (ignored.has(fieldPath)) continue;
        const leftValue = leftObject ? leftObject[key] : undefined;
        const rightValue = rightObject ? rightObject[key] : undefined;
        if (valuesEqual(leftValue, rightValue)) continue;
        if (isPlainObject(leftValue) && isPlainObject(rightValue)) {
          visit(leftValue, rightValue, fieldPath);
          continue;
        }
        const field = { path: fieldPath };
        if (leftValue !== undefined) field.before = leftValue;
        if (rightValue !== undefined) field.after = rightValue;
        fields.push(field);
      }
    };

    visit(before, after, "");
    fields.sort((a, b) => a.path.localeCompare(b.path));
    return fields;
  }

  // Rolls one recorded change back: every field the entry touched goes to the
  // value it held before. A field with no `before` did not exist yet, so it is
  // removed rather than set to undefined.
  function applyBeforeValues(record, entry) {
    const next = isPlainObject(record) ? cloneValue(record) : {};
    for (const field of (entry && entry.fields) || []) {
      // A clamped value is not the value. Writing it back would fabricate a
      // version whose text is cut off partway through.
      if (isTruncatedValue(field.before) || isTruncatedValue(field.after)) continue;
      const target = resolvePath(next, field.path, true);
      if (!target) continue;
      if (Object.prototype.hasOwnProperty.call(field, "before")) {
        target.container[target.key] = cloneValue(field.before);
      } else {
        delete target.container[target.key];
      }
    }
    return next;
  }

  function entryKey(item) {
    if (item.kind === "activity") return `a${item.activity.id || item.at}`;
    return `${item.kind === "move" ? "m" : "e"}${item.entry.entryId}`;
  }

  // Collapses each same-instant delete-and-create pair in the merged server
  // timeline into one move, and interleaves hand-written activity entries.
  // `entries` arrives newest first and the result keeps that order.
  function buildTimeline(entries, options) {
    const settings = options || {};
    const items = [];
    const list = Array.isArray(entries) ? entries : [];

    let index = 0;
    while (index < list.length) {
      const entry = list[index];
      const next = list[index + 1];
      const isPair = Boolean(next)
        && entry.changedAt === next.changedAt
        && PAIRED_SECTIONS[entry.section] === next.section
        && ((entry.event === "created" && next.event === "deleted")
          || (entry.event === "deleted" && next.event === "created"));
      if (isPair) {
        const created = entry.event === "created" ? entry : next;
        items.push({
          kind: "move",
          at: entry.changedAt,
          entry: created,
          toBin: isRecycleBinSection(created.section),
          approximate: Boolean(entry.approximate || next.approximate),
        });
        index += 2;
        continue;
      }
      items.push({
        kind: "change",
        at: entry.changedAt,
        entry,
        approximate: Boolean(entry.approximate),
      });
      index += 1;
    }

    for (const activity of settings.activities || []) {
      if (!activity || !activity.at) continue;
      items.push({ kind: "activity", at: activity.at, activity: activity.activity || activity });
    }
    if ((settings.activities || []).length > 0) {
      items.sort((a, b) => (a.at === b.at ? 0 : (a.at < b.at ? 1 : -1)));
    }

    for (const item of items) item.key = entryKey(item);
    annotateVersions(items, settings.record);
    return items;
  }

  // Walks newest to oldest rolling each change back, so every item carries the
  // record as it looked on both sides of it. A creation has no before-state and
  // a deletion has no after-state; a move between the live and recycle-bin
  // sections changes no content, so it passes the state through untouched.
  function annotateVersions(items, record) {
    let current = record ? cloneValue(record) : null;
    for (const item of items) {
      if (item.kind === "activity" || item.kind === "move") {
        item.stateAfter = current;
        item.stateBefore = current;
        continue;
      }
      const entry = item.entry;
      if (entry.event === "created") {
        item.stateAfter = current;
        current = null;
      } else if (entry.event === "deleted") {
        item.stateAfter = null;
        // A delete stores the record's final state, a firmer anchor than
        // anything the chain of deltas above it could reconstruct.
        current = entry.snapshot === undefined ? current : cloneValue(entry.snapshot);
      } else {
        item.stateAfter = current;
        current = applyBeforeValues(current, entry);
      }
      item.stateBefore = current;
    }
    return items;
  }

  return {
    DEFAULT_IGNORED_PATHS,
    PAIRED_SECTIONS,
    annotateVersions,
    applyBeforeValues,
    buildTimeline,
    cloneValue,
    describeChanges,
    entryKey,
    isPlainObject,
    isRecycleBinSection,
    isTruncatedValue,
    normalizeValue,
    resolvePath,
    splitPath,
    valuesEqual,
  };
});
