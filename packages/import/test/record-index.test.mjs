// The records an import has read are held in an exact hash index on typed arrays: every key whole, and a pass with a
// state still comes out as a fresh pass would.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { READERS } from "../dist/index.js";
import { addAll, addDisjoint, addNew, addRecord, anyIn, dropOwner, locatorNumber, markOf, ownerOf, recordIndex, undoTo } from "../dist/record-index.js";
import { packed, packInto } from "../dist/record-key.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";

const hex = (n, width) => n.toString(16).padStart(width, "0");
/** The i-th of a run of uuids that differ in their first eight digits, then in their last twelve. */
const uuidKey = (i) => `u:${hex(i >>> 0, 8)}-0000-4000-8000-${hex(Math.floor(i / 7), 12)}`;
const at = packed();
const owner = (index, key) => ownerOf(index, packInto(key, at));
const add = (index, key, n) => addRecord(index, packInto(key, at), n);
const recordCount = (index) => index.uuids.count + index.others.count;

test("each key is found with its owner, and only its own: uuids, message keys, and keys of any other shape", () => {
  const index = recordIndex(16);
  const keys = [];
  for (let i = 0; i < 50_000; i += 1) keys.push(uuidKey(i), `m:msg_01${hex(i, 6)}:req_011C${i}`, `l:msg_${i}`);
  keys.push("", "\0", "x".repeat(5000), "m:msg_日本:req_1", `u:${"A".repeat(8)}-0000-4000-8000-000000000000`, "u:\ud800");
  keys.forEach((key, i) => add(index, key, i % 1000));
  keys.forEach((key, i) => assert.equal(owner(index, key), i % 1000, key));
  // Another owner for a key held already changes nothing.
  add(index, keys[0], 999);
  assert.equal(owner(index, keys[0]), 0);
  // Nor is it held twice: with its owner's records gone, it is gone.
  dropOwner(index, 0);
  assert.equal(owner(index, keys[0]), -1);
  for (const absent of [uuidKey(50_000), "m:msg_01000000:req_011C", "l:msg_50000", "x".repeat(4999), "x".repeat(5001), `u:${"a".repeat(8)}-0000-4000-8000-000000000000`, "u:\ud801", "\0\0"]) {
    assert.equal(owner(index, absent), -1, absent);
  }
});

test("dropOwner removes one owner's records and keeps the rest; addAll adds what it lacks with each owner", () => {
  const index = recordIndex();
  const [a, b] = [locatorNumber(index, "a.jsonl"), locatorNumber(index, "b.jsonl")];
  assert.equal(locatorNumber(index, "a.jsonl"), a);
  for (let i = 0; i < 3000; i += 1) add(index, i % 3 === 0 ? uuidKey(i) : `m:msg_${i}:req_${i}`, i % 2 ? a : b);
  dropOwner(index, a);
  for (let i = 0; i < 3000; i += 1) assert.equal(owner(index, i % 3 === 0 ? uuidKey(i) : `m:msg_${i}:req_${i}`), i % 2 ? -1 : b);
  const staged = recordIndex(16);
  add(staged, uuidKey(1), a);
  add(staged, uuidKey(0), a);
  add(staged, "m:msg_1:req_1", a);
  addAll(index, staged);
  assert.deepEqual([owner(index, uuidKey(1)), owner(index, uuidKey(0)), owner(index, "m:msg_1:req_1")], [a, b, a]);
  assert.deepEqual(index.locators, ["a.jsonl", "b.jsonl"]);
});

test("anyIn finds a record of one index in another: a uuid's, any other key's, or none", () => {
  const held = recordIndex(16);
  for (let i = 0; i < 2000; i += 1) add(held, i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`, 0);
  const asked = (keys) => {
    const index = recordIndex(16);
    for (const key of keys) add(index, key, 0);
    return anyIn(held, index);
  };
  assert.equal(asked([]), false, "an empty index");
  assert.equal(asked([uuidKey(2000), uuidKey(2001), "m:msg_1:req_1", "l:msg_2", "x".repeat(300)]), false, "none held");
  assert.equal(asked([uuidKey(2001), uuidKey(1999)]), true, "a uuid held, after one not");
  assert.equal(asked(["l:msg_2", "m:msg_1998:req_1998"]), true, "a message key held, after one not");
  assert.equal(asked([`u:${"A".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`]), false, "a uuid key of capitals: another shape, not held");
});

test("undoTo takes out what was added since the mark, and only that: the slots as they were, across the index's growing too", () => {
  const index = recordIndex(16);
  const key = (i) => (i % 3 === 0 ? uuidKey(i) : `m:msg_${i}:req_${i}`);
  for (let i = 0; i < 1000; i += 1) add(index, key(i), 1);
  const slots = [index.uuids.slots.slice(), index.others.slots.slice()];
  const mark = markOf(index);
  // A few, so no table grows: the slots come back as they were, bit for bit.
  for (let i = 1000; i < 1003; i += 1) add(index, key(i), 2);
  undoTo(index, mark);
  assert.deepEqual([index.uuids.slots, index.others.slots], slots);
  assert.deepEqual(markOf(index), mark);
  // Many, so both tables grow, and some held already (left as they are): those added since go, the rest stay.
  for (let i = 500; i < 9000; i += 1) add(index, key(i), 2);
  undoTo(index, mark);
  assert.equal(recordCount(index), 1000);
  assert.deepEqual(markOf(index), mark);
  for (let i = 0; i < 9000; i += 1) assert.equal(owner(index, key(i)), i < 1000 ? 1 : -1, key(i));
  // And they can be added again, with another owner.
  for (let i = 1000; i < 9000; i += 1) add(index, key(i), 3);
  for (let i = 0; i < 9000; i += 1) assert.equal(owner(index, key(i)), i < 1000 ? 1 : 3, key(i));
  // A mark at the index's end takes out nothing.
  undoTo(index, markOf(index));
  assert.equal(recordCount(index), 9000);
});

test("addDisjoint joins two indexes with no record in common, either the larger: each record found with its owner, the locators the first's", () => {
  const key = (i) => (i % 3 === 0 ? uuidKey(i) : `m:msg_${i}:req_${i}`);
  for (const [small, big] of [[30, 5000], [5000, 30]]) {
    const into = recordIndex();
    const [a, b] = [locatorNumber(into, "a.jsonl"), locatorNumber(into, "b.jsonl")];
    for (let i = 0; i < small; i += 1) add(into, key(i), a);
    const from = recordIndex(64);
    for (let i = small; i < small + big; i += 1) add(from, key(i), b);
    const bigUuids = from.uuids;
    addDisjoint(into, from);
    assert.equal(recordCount(into), small + big);
    for (let i = 0; i < small + big + 10; i += 1) assert.equal(owner(into, key(i)), i < small ? a : i < small + big ? b : -1, key(i));
    // The larger table is kept, not copied.
    assert.equal(into.uuids === bigUuids, big > small);
    assert.deepEqual(into.locators, ["a.jsonl", "b.jsonl"]);
    // Records added after it are found too.
    add(into, key(small + big), a);
    assert.equal(owner(into, key(small + big)), a);
  }
});

test("an index kept as bytes (v8 serialize) finds what it held", () => {
  const index = recordIndex(16);
  for (let i = 0; i < 2000; i += 1) add(index, i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`, locatorNumber(index, `f${i % 5}`));
  const copy = deserialize(serialize(index));
  for (let i = 0; i < 2000; i += 1) assert.equal(copy.locators[owner(copy, i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`)], `f${i % 5}`);
  add(copy, uuidKey(2001), 0);
  assert.equal(owner(copy, uuidKey(2001)), 0);
});

test("an index saved before its slots carried tags (an older HomeState) finds what it held, and takes more", () => {
  const index = recordIndex(16);
  const keys = [];
  for (let i = 0; i < 20_000; i += 1) keys.push(uuidKey(i), `m:msg_01${hex(i, 6)}:req_011C${i}`);
  keys.forEach((key, i) => add(index, key, i % 100));
  assert.ok(index.uuids.tags && index.others.tags, "a table of 1024 slots or more is tagged");
  const old = deserialize(serialize(index));
  delete old.uuids.tags;
  delete old.others.tags;
  keys.forEach((key, i) => assert.equal(owner(old, key), i % 100, key));
  assert.equal(owner(old, uuidKey(20_000)), -1);
  const more = [];
  for (let i = 20_000; i < 40_000; i += 1) more.push(uuidKey(i), `m:msg_01${hex(i, 6)}:req_011C${i}`);
  more.forEach((key, i) => add(old, key, i % 100));
  [...keys, ...more].forEach((key, i) => assert.equal(owner(old, key), i % keys.length % 100, key));
  // A small table carries none: a file's own index, kept in its cursor, is no larger than before tags.
  assert.equal("tags" in recordIndex(2).uuids, false);
});

test("addNew adds a key ownerOf found none for as addRecord does, from a table too small for tags to one past them", () => {
  const a = recordIndex(2);
  const b = recordIndex(2);
  const keys = [];
  for (let i = 0; i < 5_000; i += 1) keys.push(uuidKey(i), `m:msg_01${hex(i, 6)}:req_011C${i}`, `l:msg_${i}`);
  keys.forEach((key, i) => {
    const packedKey = packInto(key, at);
    assert.equal(ownerOf(b, packedKey), -1);
    addNew(b, packedKey, i % 9);
    add(a, key, i % 9);
  });
  assert.equal(recordCount(b), recordCount(a));
  keys.forEach((key, i) => {
    assert.equal(owner(a, key), i % 9, key);
    assert.equal(owner(b, key), i % 9, key);
  });
  assert.deepEqual(serialize(b), serialize(a));
});

test("from 4 slots, every key is found with its owner across each doubling of the index", () => {
  const index = recordIndex(4);
  const keys = [];
  const size = () => index.uuids.slots.length + index.others.slots.length;
  let slots = size();
  let doublings = 0;
  for (let i = 0; i < 40_000; i += 1) {
    const key = i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`;
    add(index, key, i & 0xffff);
    keys.push(key);
    if (size() === slots) continue;
    doublings += 1;
    slots = size();
    for (let j = 0; j < keys.length; j += 1 + (keys.length >> 8)) assert.equal(owner(index, keys[j]), j & 0xffff, `${keys[j]} after doubling ${doublings}`);
  }
  assert.ok(doublings >= 20, `${doublings} doublings`);
  keys.forEach((key, j) => assert.equal(owner(index, key), j & 0xffff, key));
  assert.equal(owner(index, uuidKey(40_001)), -1);
});

// A reader of Claude Code whose reads of the files named in `failing` fail.
const failingReader = (failing) => {
  const claude = READERS["claude-code"];
  return { ...claude, read: (locator, cursor, options) => (failing.has(locator.file) ? Promise.reject(Object.assign(new Error("fixture"), { code: "EIO" })) : claude.read(locator, cursor, options)) };
};

test("parseHome with a state: a file read before that fails gives up its records to the file holding their copies, as a fresh pass would", async (t) => {
  const home = await tempHome(t);
  const records = [
    claudeUser({ uuid: "0f1e2d3c-4b5a-4697-8877-665544332211", text: "First.", i: 0 }),
    claudeAnswer({ uuid: "1f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01A", req: "req_011A", usage: anthropicUsage(10, 1), i: 1 }),
  ];
  const first = await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000a"), records);
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000b"), [...records, claudeAnswer({ uuid: "2f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01B", req: "req_011B", usage: anthropicUsage(100, 1), i: 2 })]);
  const failing = new Set();
  const scan = async (state) => {
    const failures = [];
    const sessions = await parseHome(home, { sources: ["claude-code"], catalog: false, readers: { "claude-code": failingReader(failing) }, failures, ...(state ? { state } : {}) });
    return { totals: sessions.map(({ key, tokens, calls, turns }) => ({ key, input: tokens.input, calls, turns })), failed: failures.length };
  };
  let state = {};
  const before = await scan(state);
  assert.deepEqual(before.totals.map(({ input }) => input).sort((a, b) => a - b), [10, 100]);
  failing.add(first);
  state = deserialize(serialize(state));
  const failed = await scan(state);
  assert.deepEqual(failed, await scan());
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.totals.map(({ input, calls, turns }) => [input, calls, turns]), [[110, 2, 1]]);
  failing.clear();
  const again = await scan(state);
  assert.deepEqual(again, await scan());
  assert.deepEqual(again, before);
});

test("parseHome with a state kept by an earlier version (none named, its records in a Map), or of another version: the state is set aside and rebuilt, the pass a fresh one", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000c"), [
    claudeUser({ uuid: "3f1e2d3c-4b5a-4697-8877-665544332211", text: "First.", i: 0 }),
    claudeAnswer({ uuid: "4f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01C", req: "req_011C", usage: anthropicUsage(10, 1), i: 1 }),
  ]);
  const scan = (state) => parseHome(home, { sources: ["claude-code"], catalog: false, ...(state ? { state } : {}) });
  const fresh = await scan();
  const state = {};
  await scan(state);
  // As an earlier version kept it: each record's key a string in a Map, with the locator that read it first.
  const kept = state.sources["claude-code"];
  const [locator] = [...kept.cursors.keys()];
  kept.owners = new Map([["u:3f1e2d3c-4b5a-4697-8877-665544332211", locator], ["m:msg_01C:req_011C", locator]]);
  const { version, ...unversioned } = state;
  assert.equal(typeof version, "number");
  const old = deserialize(serialize(unversioned));
  assert.deepEqual(await scan(old), fresh);
  assert.ok(!(old.sources["claude-code"].owners instanceof Map), "the source's state rebuilt");
  assert.equal(old.version, version);
  assert.deepEqual(await scan(old), fresh, "and the next pass goes on from the rebuilt state");
  // Another version's, whatever it holds: set aside the same.
  const other = deserialize(serialize({ ...state, version: version + 1 }));
  assert.deepEqual(await scan(other), fresh);
  assert.ok(!(other.sources["claude-code"].owners instanceof Map), "the source's state rebuilt");
  assert.equal(other.version, version);
});
