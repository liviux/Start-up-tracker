(function exposeRecordConflictMerge(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RecordConflictMerge = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const MISSING = Symbol("missing");
  const DEFAULT_IGNORED_PATHS = new Set(["id", "updatedAt"]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function valuesEqual(left, right) {
    if (left === MISSING || right === MISSING) return left === right;
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every((entry, index) => valuesEqual(entry, right[index]));
    }
    if (isPlainObject(left) || isPlainObject(right)) {
      if (!isPlainObject(left) || !isPlainObject(right)) return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      if (leftKeys.length !== rightKeys.length) return false;
      return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && valuesEqual(left[key], right[key]));
    }
    return false;
  }

  function joinPath(parent, key) {
    return parent ? `${parent}.${key}` : String(key);
  }

  function isIgnoredPath(path, ignoredPaths) {
    return ignoredPaths.has(path);
  }

  function listChangedPaths(baseValue, nextValue, options = {}) {
    const ignoredPaths = options.ignoredPaths || DEFAULT_IGNORED_PATHS;
    const changed = [];

    function visit(base, next, path) {
      if (path && isIgnoredPath(path, ignoredPaths)) return;
      if (valuesEqual(base, next)) return;

      const baseObject = isPlainObject(base);
      const nextObject = isPlainObject(next);
      if (baseObject && nextObject) {
        const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
        for (const key of keys) {
          visit(
            Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
            Object.prototype.hasOwnProperty.call(next, key) ? next[key] : MISSING,
            joinPath(path, key),
          );
        }
        return;
      }

      changed.push(path || "(record)");
    }

    visit(baseValue === undefined ? MISSING : baseValue, nextValue === undefined ? MISSING : nextValue, "");
    return changed;
  }

  function mergeRecords(baseRecord, localRecord, serverRecord, options = {}) {
    const ignoredPaths = new Set(options.ignoredPaths || DEFAULT_IGNORED_PATHS);
    const conflicts = [];

    function merge(base, local, server, path) {
      const localChanged = !valuesEqual(local, base);
      const serverChanged = !valuesEqual(server, base);

      if (!localChanged) return server;
      if (!serverChanged) return local;
      if (valuesEqual(local, server)) return local;
      if (path && isIgnoredPath(path, ignoredPaths)) return local;

      const baseObject = base === MISSING || isPlainObject(base);
      if (baseObject && isPlainObject(local) && isPlainObject(server)) {
        const merged = {};
        const baseKeys = base === MISSING ? [] : Object.keys(base);
        const keys = new Set([...baseKeys, ...Object.keys(local), ...Object.keys(server)]);
        for (const key of keys) {
          const child = merge(
            base !== MISSING && Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
            Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
            Object.prototype.hasOwnProperty.call(server, key) ? server[key] : MISSING,
            joinPath(path, key),
          );
          if (child !== MISSING) merged[key] = child;
        }
        return merged;
      }

      conflicts.push({
        path: path || "(record)",
        base: base === MISSING ? undefined : base,
        local: local === MISSING ? undefined : local,
        server: server === MISSING ? undefined : server,
        baseMissing: base === MISSING,
        localMissing: local === MISSING,
        serverMissing: server === MISSING,
      });
      return local;
    }

    const base = baseRecord === undefined ? MISSING : baseRecord;
    const local = localRecord === undefined ? MISSING : localRecord;
    const server = serverRecord === undefined ? MISSING : serverRecord;
    const value = merge(base, local, server, "");

    return {
      merged: value === MISSING ? undefined : value,
      localPaths: listChangedPaths(baseRecord, localRecord, { ignoredPaths }),
      serverPaths: listChangedPaths(baseRecord, serverRecord, { ignoredPaths }),
      overlapPaths: conflicts.map((entry) => entry.path),
      conflicts,
      canAutoMerge: conflicts.length === 0,
    };
  }

  return {
    DEFAULT_IGNORED_PATHS,
    isPlainObject,
    listChangedPaths,
    mergeRecords,
    valuesEqual,
  };
});
