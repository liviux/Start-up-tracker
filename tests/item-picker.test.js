"use strict";

// The record picker's state and markup (public/js/components/item-picker.js),
// without a browser.
const assert = require("node:assert/strict");
const test = require("node:test");
const ItemPicker = require("../public/js/components/item-picker.js");

// 45 targets and 3 programs; every word typed must appear in the title.
const RECORDS = [
  ...Array.from({ length: 45 }, (_, index) => ({ kind: "mk", id: `t${index + 1}`, title: `Target ${index + 1}`, section: "mk" })),
  ...["Accelerator", "Grant <b>", "Fellowship"].map((title, index) => ({ kind: "po", id: `p${index + 1}`, title, section: "po", subtitle: "Programs · 2026-01-01" })),
];

function source(query, { kinds, limit }) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = RECORDS.filter((record) => kinds.includes(record.kind) && words.every((word) => record.title.toLowerCase().includes(word)));
  return { items: matches.slice(0, limit), total: matches.length };
}

const describe = (ref) => RECORDS.find((record) => record.kind === ref.kind && record.id === ref.id) || null;

test("results come in bounded pages with 'Show more'", () => {
  const core = ItemPicker.createCore({ kinds: ["mk", "po"], source });
  assert.equal(core.results.items.length, ItemPicker.PAGE_SIZE);
  assert.equal(core.results.total, 48);
  assert.ok(core.hasMore());
  core.showMore();
  assert.equal(core.results.items.length, 40);
  core.showMore();
  assert.equal(core.results.items.length, 48);
  assert.equal(core.hasMore(), false);
  core.setQuery("target 4");
  assert.deepEqual(core.results.items.map((item) => item.id), ["t4", "t14", "t24", "t34", "t40", "t41", "t42", "t43", "t44", "t45"]);
  core.setKindFilter("po");
  assert.equal(core.results.items.length, 0);
  core.setQuery("");
  assert.deepEqual(core.results.items.map((item) => item.id), ["p1", "p2", "p3"]);
});

test("the keyboard moves, picks, pages, closes and removes", () => {
  const core = ItemPicker.createCore({ kinds: ["mk", "po"], source, pageSize: 2 });
  assert.equal(core.key("ArrowUp"), "");
  assert.equal(core.key("ArrowDown"), "move");
  assert.equal(core.open, true);
  assert.equal(core.active, 0);
  assert.equal(core.activeId(), core.optionId(0));
  core.key("ArrowDown");
  core.key("ArrowDown");
  assert.equal(core.active, 2, "the third option is 'Show more'");
  assert.equal(core.key("ArrowDown"), "move");
  assert.equal(core.active, 2, "the last option stays the last");
  assert.equal(core.key("Enter"), "more");
  assert.equal(core.results.items.length, 4);
  assert.equal(core.key("Home"), "move");
  assert.equal(core.active, 0);
  assert.equal(core.key("Enter"), "choose");
  assert.deepEqual(core.value, [{ kind: "mk", id: "t1" }]);
  assert.equal(core.key("End"), "move");
  assert.equal(core.active, 4);
  core.key("ArrowUp");
  assert.equal(core.key("Enter"), "choose");
  assert.deepEqual(core.value.map((ref) => ref.id), ["t1", "t4"]);
  assert.equal(core.key("Enter"), "choose", "Enter on a picked option unpicks it");
  assert.deepEqual(core.value.map((ref) => ref.id), ["t1"]);
  assert.equal(core.key("Escape"), "close");
  assert.equal(core.open, false);
  assert.equal(core.activeId(), "");
  assert.equal(core.key("Escape"), "");
  assert.equal(core.key("Backspace"), "remove");
  assert.deepEqual(core.value, []);
  assert.equal(core.key("Backspace"), "");
  core.setQuery("x");
  assert.equal(core.key("Backspace"), "", "Backspace edits the text while there is some");
});

test("a single picker replaces its value and closes; recent picks come first", () => {
  const core = ItemPicker.createCore({ multiple: false, kinds: ["mk", "po"], source, describe, recent: ["po:p3", "mk:deleted"] });
  assert.equal(core.results.items.length, ItemPicker.PAGE_SIZE);
  assert.equal(core.results.items[0].id, "p3");
  core.open = true;
  core.choose({ kind: "mk", id: "t2" });
  core.choose({ kind: "po", id: "p1" });
  assert.deepEqual(core.value, [{ kind: "po", id: "p1" }]);
  assert.equal(core.open, false);
  assert.deepEqual(core.recent.slice(0, 3), ["po:p1", "mk:t2", "po:p3"]);
  core.refresh();
  assert.deepEqual(core.results.items.slice(0, 3).map((item) => item.id), ["p1", "t2", "p3"]);
  core.setQuery("t");
  assert.notEqual(core.results.items[0].id, "p1", "with text typed, the source's order stands");
});

test("the markup follows the listbox pattern and escapes titles", () => {
  const core = ItemPicker.createCore({ kinds: ["mk", "po"], source, value: [{ kind: "po", id: "p2" }, { kind: "mk", id: "gone" }] });
  core.setQuery("");
  core.key("ArrowDown");
  const list = ItemPicker.listHtml(core);
  assert.match(list, /role="group" aria-labelledby="item-picker-\d+-group-0"/);
  assert.match(list, /class="item-picker-group-label" role="presentation">Marketing</);
  assert.match(list, /role="option" id="item-picker-\d+-option-0" class="item-picker-option is-active" aria-selected="false"/);
  assert.match(list, /data-more="1">Show more \(28 left\)/);
  core.setKindFilter("po");
  const programs = ItemPicker.listHtml(core);
  assert.match(programs, /Grant &lt;b&gt;/);
  assert.match(programs, /aria-selected="true" data-key="po:p2"/);
  assert.match(programs, /Programs · 2026-01-01/);
  core.setQuery("nothing like this");
  assert.match(ItemPicker.listHtml(core), /role="presentation">Nothing matches\./);

  const chips = ItemPicker.chipsHtml(core, describe);
  assert.match(chips, /Grant &lt;b&gt;/);
  assert.match(chips, /data-remove="po:p2" aria-label="Remove Grant &lt;b&gt;"/);
  assert.match(chips, /gone<\/span>\s*<span class="item-picker-chip-missing">\(not found\)/);
});

test("keys survive ids that contain a colon", () => {
  assert.deepEqual(ItemPicker.parseKey(ItemPicker.refKey({ kind: "research", id: "a:b" })), { kind: "research", id: "a:b" });
});

// A small fake document: enough for create() to wire its events.
function fakeHolder() {
  const listeners = new Map();
  const element = (name) => {
    const self = {
      name, hidden: false, innerHTML: "", value: "", attributes: {},
      listeners: {},
      addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
      setAttribute(key, value) { self.attributes[key] = value; },
      removeAttribute(key) { delete self.attributes[key]; },
      focus() {},
      querySelector() { return null; },
      fire(type, extra = {}) {
        const event = { type, target: self, preventDefault() {}, stopPropagation() {}, ...extra };
        (self.listeners[type] || []).forEach((fn) => fn(event));
      },
    };
    return self;
  };
  const parts = { ".item-picker-chips": element("chips"), ".item-picker-input": element("input"), ".item-picker-listbox": element("listbox"), ".item-picker-kind": element("kind") };
  const events = [];
  const holder = {
    classList: { add() {} },
    innerHTML: "",
    ownerDocument: { addEventListener(type, fn) { listeners.set(type, fn); } },
    querySelector: (selector) => parts[selector],
    contains: () => false,
    dispatchEvent: (event) => events.push(event.type),
  };
  return { holder, parts, events };
}

test("picking raises input and change on the holder, like a native control", () => {
  const previous = global.Event;
  global.Event = class { constructor(type) { this.type = type; } };
  try {
    const { holder, parts, events } = fakeHolder();
    const seen = [];
    const picker = ItemPicker.create(holder, { kinds: ["mk", "po"], source, describe, onChange: (value) => seen.push(value), recentName: "test" });
    parts[".item-picker-input"].fire("keydown", { key: "ArrowDown" });
    assert.equal(parts[".item-picker-listbox"].hidden, false);
    assert.equal(parts[".item-picker-input"].attributes["aria-expanded"], "true");
    parts[".item-picker-input"].fire("keydown", { key: "Enter" });
    assert.deepEqual(picker.getValue(), [{ kind: "mk", id: "t1" }]);
    assert.deepEqual(seen, [[{ kind: "mk", id: "t1" }]]);
    assert.deepEqual(events, ["input", "change"]);
    assert.match(parts[".item-picker-chips"].innerHTML, /Target 1/);
    picker.setValue([{ kind: "po", id: "p1" }]);
    assert.deepEqual(picker.getValue(), [{ kind: "po", id: "p1" }]);
    assert.deepEqual(events, ["input", "change"], "setting a value from code raises nothing");
  } finally {
    global.Event = previous;
  }
});
