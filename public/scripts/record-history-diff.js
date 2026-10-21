(function exposeRecordHistoryDiff(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RecordHistoryDiff = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  // A full LCS table is (n+1)*(m+1) Int32 cells. Two million cells is 8MB,
  // which is fine for the notes in this tracker (the longest is a few hundred
  // lines) but still refuses to allocate a gigabyte if some record ever holds a
  // pasted log file. Past the cap the middle is reported as one replaced block,
  // which is honest rather than wrong.
  const MAX_LCS_CELLS = 2_000_000;

  // Word-level refinement inside a hunk is only useful when a removed line and
  // an added line are recognisably the same line edited. Beyond a handful of
  // lines the pairing is guesswork, and highlighting guessed pairs reads worse
  // than plain whole-line add/remove.
  const MAX_REFINED_PAIRS = 40;

  // Below this ratio of shared tokens the two lines are different sentences
  // rather than one edited sentence, so intra-line highlighting is skipped.
  const MIN_REFINE_SIMILARITY = 0.4;

  function splitLines(text) {
    const value = text == null ? "" : String(text);
    if (value === "") return [];
    return value.replace(/\r\n?/g, "\n").split("\n");
  }

  // Words, runs of whitespace, and individual punctuation marks are separate
  // tokens so that changing one word inside a sentence highlights that word
  // instead of the whole line.
  function splitWords(line) {
    const matches = String(line == null ? "" : line).match(/\s+|[A-Za-z0-9_]+|[^\s A-Za-z0-9_]/g);
    return matches || [];
  }

  // Longest common subsequence over two token arrays, returned as the list of
  // matched index pairs. The caller turns those into add/remove/context runs.
  function lcsPairs(left, right) {
    const n = left.length;
    const m = right.length;
    if (n === 0 || m === 0) return [];
    if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return null;

    const width = m + 1;
    const table = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      const rowOffset = i * width;
      const nextRowOffset = rowOffset + width;
      for (let j = m - 1; j >= 0; j -= 1) {
        table[rowOffset + j] = left[i] === right[j]
          ? table[nextRowOffset + j + 1] + 1
          : Math.max(table[nextRowOffset + j], table[rowOffset + j + 1]);
      }
    }

    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (left[i] === right[j]) {
        pairs.push([i, j]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
    return pairs;
  }

  // Similarity has to ignore whitespace tokens. Two unrelated sentences with the
  // same number of words always share every space between them, which is enough
  // to clear a naive ratio and produce word highlighting on lines that have
  // nothing in common.
  function isWhitespace(token) {
    return /^\s+$/.test(token);
  }

  function countShared(pairs, left, right) {
    if (!pairs) return 0;
    const leftWords = left.filter((token) => !isWhitespace(token)).length;
    const rightWords = right.filter((token) => !isWhitespace(token)).length;
    if (leftWords === 0 || rightWords === 0) return 0;
    const sharedWords = pairs.filter(([leftIndex]) => !isWhitespace(left[leftIndex])).length;
    return sharedWords / Math.max(leftWords, rightWords);
  }

  // Inline segments for one edited line: [{type, text}] where type is
  // "same" | "add" | "remove". Returns null when the two lines are too
  // dissimilar to be worth highlighting word by word.
  function diffWords(beforeLine, afterLine) {
    const before = splitWords(beforeLine);
    const after = splitWords(afterLine);
    const pairs = lcsPairs(before, after);
    if (!pairs) return null;
    if (countShared(pairs, before, after) < MIN_REFINE_SIMILARITY) return null;

    const segments = [];
    const push = (type, text) => {
      if (text === "") return;
      const last = segments[segments.length - 1];
      if (last && last.type === type) last.text += text;
      else segments.push({ type, text });
    };

    let beforeIndex = 0;
    let afterIndex = 0;
    for (const [leftIndex, rightIndex] of pairs) {
      while (beforeIndex < leftIndex) push("remove", before[beforeIndex++]);
      while (afterIndex < rightIndex) push("add", after[afterIndex++]);
      push("same", before[leftIndex]);
      beforeIndex = leftIndex + 1;
      afterIndex = rightIndex + 1;
    }
    while (beforeIndex < before.length) push("remove", before[beforeIndex++]);
    while (afterIndex < after.length) push("add", after[afterIndex++]);
    return segments;
  }

  // Rows describing the whole change, in display order. Each row is
  // { type: "context" | "add" | "remove", text, beforeLine, afterLine }
  // where the line numbers are 1-based and null on the side that has no line.
  function diffLines(beforeText, afterText) {
    const before = splitLines(beforeText);
    const after = splitLines(afterText);
    const rows = [];

    const pushRow = (type, text, beforeLine, afterLine) => {
      rows.push({ type, text, beforeLine, afterLine });
    };

    // Appending to a note is the common edit here, so trimming the shared head
    // and tail first keeps the expensive table small and keeps line numbers
    // aligned with the untouched parts of the text.
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0;
    while (
      tail < before.length - head
      && tail < after.length - head
      && before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) tail += 1;

    for (let i = 0; i < head; i += 1) pushRow("context", before[i], i + 1, i + 1);

    const beforeMiddle = before.slice(head, before.length - tail);
    const afterMiddle = after.slice(head, after.length - tail);
    const pairs = lcsPairs(beforeMiddle, afterMiddle);

    if (pairs === null) {
      // Too large to align line by line. Report the middle as replaced.
      beforeMiddle.forEach((text, index) => pushRow("remove", text, head + index + 1, null));
      afterMiddle.forEach((text, index) => pushRow("add", text, null, head + index + 1));
    } else {
      let beforeIndex = 0;
      let afterIndex = 0;
      const flushBlock = (removed, added) => {
        removed.forEach(({ text, line }) => pushRow("remove", text, line, null));
        added.forEach(({ text, line }) => pushRow("add", text, null, line));
      };
      let removedBlock = [];
      let addedBlock = [];

      const emit = (leftIndex, rightIndex) => {
        while (beforeIndex < leftIndex) {
          removedBlock.push({ text: beforeMiddle[beforeIndex], line: head + beforeIndex + 1 });
          beforeIndex += 1;
        }
        while (afterIndex < rightIndex) {
          addedBlock.push({ text: afterMiddle[afterIndex], line: head + afterIndex + 1 });
          afterIndex += 1;
        }
        flushBlock(removedBlock, addedBlock);
        removedBlock = [];
        addedBlock = [];
      };

      for (const [leftIndex, rightIndex] of pairs) {
        emit(leftIndex, rightIndex);
        pushRow("context", beforeMiddle[leftIndex], head + leftIndex + 1, head + rightIndex + 1);
        beforeIndex = leftIndex + 1;
        afterIndex = rightIndex + 1;
      }
      emit(beforeMiddle.length, afterMiddle.length);
    }

    const tailStartBefore = before.length - tail;
    const tailStartAfter = after.length - tail;
    for (let i = 0; i < tail; i += 1) {
      pushRow("context", before[tailStartBefore + i], tailStartBefore + i + 1, tailStartAfter + i + 1);
    }

    refineAdjacentRows(rows);
    return rows;
  }

  // Where a run of removals is immediately followed by an equal-length run of
  // additions, the pairs are almost always edited versions of each other, so
  // each pair gets word-level segments attached for inline highlighting.
  function refineAdjacentRows(rows) {
    let index = 0;
    while (index < rows.length) {
      if (rows[index].type !== "remove") {
        index += 1;
        continue;
      }
      let removeEnd = index;
      while (removeEnd < rows.length && rows[removeEnd].type === "remove") removeEnd += 1;
      let addEnd = removeEnd;
      while (addEnd < rows.length && rows[addEnd].type === "add") addEnd += 1;

      const removeCount = removeEnd - index;
      const addCount = addEnd - removeEnd;
      if (removeCount === addCount && removeCount > 0 && removeCount <= MAX_REFINED_PAIRS) {
        for (let offset = 0; offset < removeCount; offset += 1) {
          const removeRow = rows[index + offset];
          const addRow = rows[removeEnd + offset];
          const segments = diffWords(removeRow.text, addRow.text);
          if (!segments) continue;
          removeRow.segments = segments.filter((segment) => segment.type !== "add");
          addRow.segments = segments.filter((segment) => segment.type !== "remove");
        }
      }
      index = addEnd > index ? addEnd : index + 1;
    }
  }

  // Groups rows into hunks of changed lines surrounded by `contextLines` of
  // unchanged text, with the runs of hidden lines recorded so the UI can offer
  // to expand them. `gaps` entries are { afterHunkIndex, rows } in row order.
  function groupHunks(rows, options = {}) {
    const contextLines = Number.isInteger(options.contextLines) ? options.contextLines : 3;
    const changedIndexes = [];
    rows.forEach((row, index) => {
      if (row.type !== "context") changedIndexes.push(index);
    });
    if (changedIndexes.length === 0) return { hunks: [], gaps: [], unchanged: true };

    const ranges = [];
    for (const changedIndex of changedIndexes) {
      const start = Math.max(0, changedIndex - contextLines);
      const end = Math.min(rows.length - 1, changedIndex + contextLines);
      const last = ranges[ranges.length - 1];
      // Ranges that touch or overlap become one hunk, so two edits a line apart
      // do not render as two boxes with nothing between them.
      if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
      else ranges.push({ start, end });
    }

    const hunks = ranges.map((range) => ({
      rows: rows.slice(range.start, range.end + 1),
      startIndex: range.start,
      endIndex: range.end,
    }));

    const gaps = [];
    let cursor = 0;
    ranges.forEach((range, hunkIndex) => {
      if (range.start > cursor) {
        gaps.push({ afterHunkIndex: hunkIndex - 1, rows: rows.slice(cursor, range.start) });
      }
      cursor = range.end + 1;
    });
    if (cursor < rows.length) {
      gaps.push({ afterHunkIndex: ranges.length - 1, rows: rows.slice(cursor) });
    }

    return { hunks, gaps, unchanged: false };
  }

  function summarize(rows) {
    let added = 0;
    let removed = 0;
    for (const row of rows) {
      if (row.type === "add") added += 1;
      else if (row.type === "remove") removed += 1;
    }
    return { added, removed, changed: added > 0 || removed > 0 };
  }

  return {
    MAX_LCS_CELLS,
    diffLines,
    diffWords,
    groupHunks,
    splitLines,
    splitWords,
    summarize,
  };
});
