// The records an import has read are held in an exact hash index on typed arrays: every key whole, any number of them
// (a Map stops at 2^24), and a pass with a state still comes out as a fresh pass would.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { parseHome, READERS } from "../dist/index.js";
import { addAll, addRecord, dropOwner, locatorNumber, ownerOf, recordCount, recordIndex } from "../dist/record-index.js";
import { packed, packInto } from "../dist/record-key.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, tempHome, writeJsonl } from "./fixtures.mjs";

const hex = (n, width) => n.toString(16).padStart(width, "0");
/** The i-th of a run of uuids that differ in their first eight digits, then in their last twelve. */
const uuidKey = (i) => `u:${hex(i >>> 0, 8)}-0000-4000-8000-${hex(Math.floor(i / 7), 12)}`;
const at = packed();
const owner = (index, key) => ownerOf(index, packInto(key, at));
const add = (index, key, n) => addRecord(index, packInto(key, at), n);

test("each key is found with its owner, and only its own: uuids, message keys, and keys of any other shape", () => {
  const index = recordIndex(16);
  const keys = [];
  for (let i = 0; i < 50_000; i += 1) keys.push(uuidKey(i), `m:msg_01${hex(i, 6)}:req_011C${i}`, `l:msg_${i}`);
  keys.push("", "\0", "x".repeat(5000), "m:msg_日本:req_1", `u:${"A".repeat(8)}-0000-4000-8000-000000000000`, "u:\ud800");
  keys.forEach((key, i) => add(index, key, i % 1000));
  assert.equal(recordCount(index), keys.length);
  keys.forEach((key, i) => assert.equal(owner(index, key), i % 1000, key));
  // Another owner for a key held already changes nothing.
  add(index, keys[0], 999);
  assert.equal(owner(index, keys[0]), 0);
  assert.equal(recordCount(index), keys.length);
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
  assert.equal(recordCount(index), 1500);
  for (let i = 0; i < 3000; i += 1) assert.equal(owner(index, i % 3 === 0 ? uuidKey(i) : `m:msg_${i}:req_${i}`), i % 2 ? -1 : b);
  const staged = recordIndex(16);
  add(staged, uuidKey(1), a);
  add(staged, uuidKey(0), a);
  add(staged, "m:msg_1:req_1", a);
  addAll(index, staged);
  assert.deepEqual([owner(index, uuidKey(1)), owner(index, uuidKey(0)), owner(index, "m:msg_1:req_1")], [a, b, a]);
  assert.deepEqual(index.locators, ["a.jsonl", "b.jsonl"]);
});

test("an index kept as bytes (v8 serialize) finds what it held", () => {
  const index = recordIndex(16);
  for (let i = 0; i < 2000; i += 1) add(index, i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`, locatorNumber(index, `f${i % 5}`));
  const copy = deserialize(serialize(index));
  for (let i = 0; i < 2000; i += 1) assert.equal(copy.locators[owner(copy, i % 2 ? uuidKey(i) : `m:msg_${i}:req_${i}`)], `f${i % 5}`);
  add(copy, uuidKey(2001), 0);
  assert.equal(owner(copy, uuidKey(2001)), 0);
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
  assert.equal(recordCount(index), keys.length);
  keys.forEach((key, j) => assert.equal(owner(index, key), j & 0xffff, key));
  assert.equal(owner(index, uuidKey(40_001)), -1);
});

// Holds about 0.9 GB outside the JS heap, so it runs on demand, not beside the other tests.
const LARGE = process.env.AGENTRUN_IMPORT_LARGE_TESTS === "1" ? false : "holds ~0.9 GB outside the JS heap; set AGENTRUN_IMPORT_LARGE_TESTS=1 to run it";
test("more than 2^24 records, a Map's most, are held and found", { skip: LARGE }, () => {
  const n = 2 ** 24 + 4096;
  const index = recordIndex();
  for (let i = 0; i < n; i += 1) add(index, uuidKey(i), i & 0xffff);
  add(index, "m:msg_last:req_last", 7);
  assert.equal(recordCount(index), n + 1);
  for (const i of [0, 1, 2 ** 24 - 1, 2 ** 24, n - 1, 12_345_678]) assert.equal(owner(index, uuidKey(i)), i & 0xffff, String(i));
  assert.equal(owner(index, uuidKey(n)), -1);
  assert.equal(owner(index, "m:msg_last:req_last"), 7);
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

test("parseHome with a state kept by an earlier version, its records in a Map: the state is set aside and rebuilt, the pass a fresh one", async (t) => {
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
  const old = deserialize(serialize(state));
  assert.deepEqual(await scan(old), fresh);
  assert.ok(!(old.sources["claude-code"].owners instanceof Map), "the source's state rebuilt");
  assert.deepEqual(await scan(old), fresh, "and the next pass goes on from the rebuilt state");
});
