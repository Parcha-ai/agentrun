// What a store's readers keep of a run's cuts (store-reads/journal.ts rowCutsOnce) is keyed by the run's whole cut: every
// held value in its order and its census mode. A cut that changed in any of them cuts every text again; nothing kept
// for one run, or one store (one owner), is served to another; and only what a reader is shown is kept, by digest,
// never a text the run wrote.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { cutPasses, withheldWhole } from "../dist/key-refusal.js";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { timelineOverStore } = await import("../dist/store-view.js");
const { cutBudget, cutsKeptOf, forgetServedAnswers, rowCutsOnce, servedSince } = await import("../dist/store-reads/journal.js");

// Held values of 24 characters in no secret's shape, made at runtime.
const KEY = ["Zq8V", "bN3x", "LmT6", "pR2w", "Yk9H", "sD4f"].join("");
const LATER = ["Wt5N", "hQ2c", "Jr8M", "vX3e", "Pd6K", "gB7s"].join("");
const SEARCHES = 8;

/** Search `n`'s answer: KEY in the first hit's title of every odd search, LATER in search 4's. */
const searchOf = (n) => JSON.stringify({
  query: `widgets ${n}`,
  results: [0, 1].map((i) => ({ url: `https://h.example/${n}/${i}`, title: `Widget ${n}.${i}${i === 0 && n % 2 === 1 ? ` ${KEY}` : ""}${i === 0 && n === 4 ? ` ${LATER}` : ""}`, snippet: `${"widgets are made of parts ".repeat(8)}end` })),
});
/** Every text the runs write that holds KEY or LATER. */
const rawHeld = () => Array.from({ length: SEARCHES }, (_, i) => searchOf(i + 1)).filter((text) => text.includes(KEY) || text.includes(LATER));

/** `runId` in `store`: a pi run of SEARCHES web searches, each a call and its answer, after the person's message. */
async function searchRun(store, runId) {
  // The agent, once per store (a second run's create finds it there).
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search." } }).catch(() => {});
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Search." }, title: "Search", place: { mode: "runner" } } });
  const journal = store.journal(await store.claim(runId, "runner-a", { leaseMs: 600_000 }));
  const entry = async (kind, model) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind, model: [{ ...model, timestamp: T0 }] } });
  const writes = [{ type: "conversation", value: { id: 1 } }, await entry("pi.user", { role: "user", content: "Search." })];
  for (let n = 1; n <= SEARCHES; n++) {
    writes.push(await entry("pi.assistant", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${n}`, name: "web_search", arguments: { query: `widgets ${n}` } }] }));
    writes.push(await entry("pi.tool-result", { role: "toolResult", toolCallId: `c${n}`, toolName: "web_search", content: [{ type: "text", text: searchOf(n) }], isError: false }));
  }
  await commitWrites(journal, writes, BACKGROUND_CONTEXT);
}

/** A page's two reads of `runId` (its view, then its served rows), the server holding `held`; and the texts they cut. */
async function read(store, runId, held) {
  const before = cutPasses.count;
  const view = await timelineOverStore(store, runId, { origin: "https://run.test", serverSecrets: () => held, sealKey: undefined });
  const rows = await servedTimelineRows({ serverSecrets: () => held, sealKey: undefined, keyEnv: () => ({}) }, store, runId, BACKGROUND_CONTEXT);
  return { bytes: JSON.stringify(view) + JSON.stringify(rows), passes: cutPasses.count - before };
}

test("a value saved since a read cuts every text again, as many as the first read cut; the same set read again cuts none", async (t) => {
  const { store } = await storeOn(t);
  await searchRun(store, "run-1");
  const first = await read(store, "run-1", [KEY]);
  assert.ok(first.passes >= 2 * SEARCHES, `the first read cuts each search: ${first.passes}`);
  assert.equal((await read(store, "run-1", [KEY])).passes, 0, "the same set again: nothing cut again");
  const saved = await read(store, "run-1", [KEY, LATER]);
  assert.equal(saved.passes, first.passes, `a value saved since: every text cut again, ${saved.passes} as the first read's ${first.passes}`);
  assert.ok(!saved.bytes.includes(LATER) && !saved.bytes.includes(KEY));
  assert.equal((await read(store, "run-1", [KEY, LATER])).passes, 0);
  t.diagnostic(`texts cut: ${first.passes} by the first read, ${saved.passes} once LATER was saved, 0 by each read again`);
});

test("a run's cut keys its kept cuts whole: its values, their order and its census mode each make a new set", () => {
  const store = {};
  store.origin = store;
  const texts = Array.from({ length: 12 }, (_, i) => `row ${i} ${i % 3 === 0 ? KEY : "plain words"} ${i % 4 === 0 ? LATER : ""}`);
  const cutAll = (cut) => {
    const before = cutPasses.count;
    const { redact, holds } = rowCutsOnce(store, "run-1", cut, servedSince(store));
    const out = texts.map((text) => [redact(text), holds(text)]);
    return { out, passes: cutPasses.count - before };
  };
  const all = 2 * texts.length;
  assert.equal(cutAll({ values: [KEY, LATER] }).passes, all, "the first read cuts every text");
  assert.equal(cutAll({ values: [KEY, LATER] }).passes, 0, "the same cut: none");
  assert.equal(cutAll({ values: [KEY, LATER], censusDigest: "a".repeat(64) }).passes, all, "a census written since: every text again");
  assert.equal(cutAll({ values: [KEY, LATER], censusDigest: "a".repeat(64) }).passes, 0);
  assert.equal(cutAll({ values: [KEY, LATER], censusDigest: "b".repeat(64) }).passes, all, "another census: every text again");
  assert.equal(cutAll({ values: [LATER, KEY], censusDigest: "b".repeat(64) }).passes, all, "the values in another order: every text again");
  assert.equal(cutAll({ values: [KEY] }).passes, all, "a value fewer: every text again");
  assert.equal(cutAll("unreadable").passes, all, "a cut no longer readable: its own set");
  // Each set cuts what it holds: KEY cut under every set that holds it, LATER only under those that hold it.
  const [only] = [cutAll({ values: [KEY] }).out];
  assert.ok(only.every(([text]) => !text.includes(KEY)));
  assert.ok(only.some(([text]) => text.includes(LATER)), "LATER, held by no set here, shows");
});

test("nothing one run or one store kept is served to another: the same text, held in one and shown plainly in the other", async (t) => {
  const a = await storeOn(t);
  const b = await storeOn(t);
  // Two runs of one store with the same words, and a run of the same id in another store (another owner's server).
  await searchRun(a.store, "run-1");
  await searchRun(a.store, "run-2");
  await searchRun(b.store, "run-1");
  for (let round = 0; round < 3; round++) {
    const heldA1 = await read(a.store, "run-1", [KEY]);
    const plainA2 = await read(a.store, "run-2", []);
    const plainB1 = await read(b.store, "run-1", []);
    const heldB1 = await read(b.store, "run-1", [LATER]);
    assert.ok(!heldA1.bytes.includes(KEY) && heldA1.bytes.includes("[redacted]"), `round ${round}: run-1 holds KEY, never shown`);
    assert.ok(plainA2.bytes.includes(KEY) && plainA2.bytes.includes(LATER), `round ${round}: run-2 holds nothing: KEY and LATER show plainly, never run-1's cut`);
    assert.ok(plainB1.bytes.includes(KEY), `round ${round}: the other store's run-1 holds nothing: KEY shows, never this store's cut`);
    assert.ok(!heldB1.bytes.includes(LATER) && heldB1.bytes.includes(KEY), `round ${round}: the other store's run-1 under LATER: LATER cut, KEY shows`);
    assert.notEqual(heldA1.bytes, plainA2.bytes);
  }
});

test("what is kept is only what a reader is shown, by digest: no held value, and no text the run wrote that held one", async (t) => {
  const { store } = await storeOn(t);
  await searchRun(store, "run-1");
  await read(store, "run-1", [KEY, LATER]);
  const { kept, texts } = cutsKeptOf(store);
  assert.ok(texts >= 2 * SEARCHES, `the read kept its cuts: ${texts}`);
  const raw = rawHeld();
  assert.ok(raw.length >= SEARCHES / 2);
  for (const { set, slot, made } of kept) {
    assert.match(set, /^run-1\0[0-9a-f]{64}$/, "a set is the run and a digest");
    assert.match(slot, /^(redact|holds)\0[A-Za-z0-9+/]{43}=$/, "a slot is a sha256 digest");
    assert.ok(typeof made === "boolean" || typeof made === "string");
    const all = `${set}${slot}${made}`;
    assert.ok(!all.includes(KEY) && !all.includes(LATER), `no held value kept: ${all.slice(0, 120)}`);
    for (const text of raw) {
      assert.ok(typeof made !== "string" || !made.includes(text), "no text the run wrote that held a value is kept");
      assert.ok(!slot.includes(text) && !set.includes(text));
    }
  }
});

test("a value shown before it was held, then written again: once saved, the new row and the old are both cut", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say." }, title: "Say", place: { mode: "runner" } } });
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 600_000 }));
  const said = async (text) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: T0 }] } });
  const words = `The token is ${LATER} for now.`;
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, await said(words)], BACKGROUND_CONTEXT);
  assert.ok((await read(store, "run-1", [KEY])).bytes.includes(LATER), "LATER is no held value yet: it shows");
  await commitWrites(journal, [await said(words)], BACKGROUND_CONTEXT);
  const saved = await read(store, "run-1", [KEY, LATER]);
  assert.ok(!saved.bytes.includes(LATER), "LATER saved: neither row that says it shows it");
  assert.equal(saved.bytes.split("[redacted]").length - 1 >= 2, true, "both rows cut");
});

test("texts and held values that differ only in a lone surrogate are kept apart: each is cut as itself", () => {
  const store = {};
  store.origin = store;
  // A high, a low, and a low before a high (a pair reversed): as UTF-8 each is the one replacement character.
  const lone = ["\ud800", "\ud801", "\udc00", "\udc00\ud800"];
  const texts = lone.map((s) => `note ${s} ${KEY}`);
  const { redact, holds } = rowCutsOnce(store, "run-1", { values: [KEY] }, servedSince(store));
  for (const [i, text] of texts.entries()) {
    const before = cutPasses.count;
    const [cut, held] = [redact(text), holds(text)];
    assert.equal(cutPasses.count - before, 2, `text ${i} is cut, not served from another text's slot`);
    assert.equal(cut, `note ${lone[i]} [redacted]`, `text ${i} is cut as itself, never as another's kept cut`);
    assert.equal(held, withheldWhole(text, [KEY]));
  }
  // What was kept is a copy of each cut (no slice of the text it was cut of), its lone surrogates as written.
  const plain = lone.map((s) => `plain ${s} words`);
  for (const text of plain) redact(text);
  for (const [i, text] of plain.entries()) {
    const before = cutPasses.count;
    assert.equal(redact(text), text, `kept text ${i} reads back unit for unit`);
    assert.equal(cutPasses.count - before, 0, `kept text ${i} is read from what was kept`);
  }
  // The held set's key is the values' JSON, where a lone surrogate is escaped as written: two sets that differ only in
  // one miss each other. A lone surrogate shows as a box at most, so each set's value reads as KEY and both copies in
  // the text are cut in place, each lone surrogate left as written: each set still cuts in its own slot.
  const cutOf = (values) => {
    const before = cutPasses.count;
    const out = rowCutsOnce(store, "run-1", { values }, servedSince(store)).redact(`said ${KEY}\ud800 and ${KEY}\ud801`);
    return { out, passes: cutPasses.count - before };
  };
  assert.deepEqual(cutOf([`${KEY}\ud800`]), { out: `said [redacted] and [redacted]\ud801`, passes: 1 });
  assert.deepEqual(cutOf([`${KEY}\ud801`]), { out: `said [redacted]\ud800 and [redacted]`, passes: 1 }, "a set that differs only in a lone surrogate is its own set");
});

test("what is kept costs the heap what is counted: no kept cut holds the raw text it was cut of, or the values it was cut by", { timeout: 120_000 }, async () => {
  // A child with --expose-gc (fixtures/cut-heap-child.mjs): 100 outputs of about 1 MiB, each cut to its head, and 12 value
  // sets each holding a value of 512 KiB; collected, the heap grows by no more than a small multiple of what the cache
  // counts, and a fixed allowance for the rest of the child.
  const child = fileURLToPath(new URL("./fixtures/cut-heap-child.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", child], { maxBuffer: 1 << 20 });
  const ALLOWANCE = 4 * 1024 * 1024;
  for (const { name, growth, counted, texts } of JSON.parse(stdout)) {
    assert.ok(texts > 0, `${name}: the cache kept cuts`);
    assert.ok(growth <= 3 * counted + ALLOWANCE, `${name}: the heap grew ${(growth / 1048576).toFixed(1)} MiB for ${texts} kept cuts counted at ${(counted / 1024).toFixed(0)} KiB (at most 3x that and ${ALLOWANCE / 1048576} MiB)`);
  }
});

test("past the bound the least recently used cut goes first: a cut read again is kept over one only written", (t) => {
  const store = {};
  store.origin = store;
  const budget = cutBudget.bytes;
  t.after(() => { cutBudget.bytes = budget; });
  const texts = Array.from({ length: 6 }, (_, i) => `row ${i} plain words`);
  const passesOf = (values, text) => {
    const before = cutPasses.count;
    rowCutsOnce(store, "run-1", { values }, servedSince(store)).redact(text);
    return cutPasses.count - before;
  };
  // Every text costs the same: room for four.
  assert.equal(passesOf([KEY], texts[0]), 1);
  const each = cutsKeptOf(store).bytes;
  cutBudget.bytes = 4 * each + Math.floor(each / 2);
  for (const text of texts.slice(1, 4)) assert.equal(passesOf([KEY], text), 1);
  assert.equal(passesOf([KEY], texts[0]), 0, "row 0 read again, from what was kept");
  assert.equal(passesOf([KEY], texts[4]), 1, "a fifth: one must go");
  assert.equal(passesOf([KEY], texts[0]), 0, "row 0, the first written but read since, stays");
  assert.equal(passesOf([KEY], texts[1]), 1, "row 1, the least recently used, went");
  // Across sets: a set read again is kept over one written after it.
  forgetServedAnswers(store, "run-1");
  for (const text of texts.slice(0, 2)) assert.equal(passesOf([KEY], text), 1);
  for (const text of texts.slice(2, 4)) assert.equal(passesOf([LATER], text), 1);
  assert.equal(passesOf([KEY], texts[0]), 0, "the first set read again");
  assert.equal(passesOf([KEY, LATER], texts[4]), 1, "a third set: one text must go");
  assert.equal(passesOf([KEY], texts[0]), 0, "the first set, read since the second was written, keeps its row");
  assert.equal(passesOf([LATER], texts[2]), 1, "the second set, the least recently used, lost its oldest row");
});
