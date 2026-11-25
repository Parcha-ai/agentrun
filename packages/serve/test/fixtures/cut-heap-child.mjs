// Run with --expose-gc (redact-cuts-keys.test.mjs): fills one store's kept cuts (store-reads/journal.ts rowCutsOnce) with
// cuts much smaller than the texts and held values they were made of, drops every reference the reader had, collects,
// and prints the heap's growth beside the bytes the cache counts (cutsKeptOf), as JSON, for each phase:
//  - texts: TEXTS raw outputs of about 1 MiB each, every one holding a held value past the cut's window, cut to its head;
//  - values: ROUNDS value sets, each with a held value of 512 KiB, over small texts.
// A kept cut that is a slice of its raw text (or holds the values in a closure) keeps them all in the heap.
import { randomBytes } from "node:crypto";

const { cutsKeptOf, rowCutsOnce, servedSince } = await import("../../dist/store-reads/journal.js");
const TEXTS = 100;
const ROUNDS = 12;
const KEY = ["Zq8V", "bN3x", "LmT6", "pR2w", "Yk9H", "sD4f"].join("");

const heap = () => {
  for (let i = 0; i < 4; i++) globalThis.gc();
  return process.memoryUsage().heapUsed;
};
const phase = (name, fill) => {
  const store = {};
  store.origin = store;
  const before = heap();
  fill(store);
  const after = heap();
  const kept = cutsKeptOf(store);
  return { name, growth: after - before, counted: kept.bytes, texts: kept.texts, sets: kept.sets, store };
};

// Each text unique and flat: its own random hex, the held value written past the window, and more after it.
const bigText = (i) => `${i} ${randomBytes(4096).toString("hex")} ${KEY} ${randomBytes(512 * 1024 - 4200).toString("hex")} ${KEY}`;
const texts = phase("texts", (store) => {
  const { redact, holds } = rowCutsOnce(store, "run-1", { values: [KEY] }, servedSince(store));
  for (let i = 0; i < TEXTS; i++) {
    const text = bigText(i);
    redact(text);
    holds(text);
  }
});
const values = phase("values", (store) => {
  for (let round = 0; round < ROUNDS; round++) {
    const held = [KEY, randomBytes(256 * 1024).toString("hex")];
    const { redact, holds } = rowCutsOnce(store, "run-1", { values: held }, servedSince(store));
    for (let i = 0; i < 20; i++) {
      const text = `round ${round} row ${i} ${KEY} ${randomBytes(512).toString("hex")}`;
      redact(text);
      holds(text);
    }
  }
});
// The stores stay referenced until here, so their kept cuts were in the heap when it was measured.
process.stdout.write(`${JSON.stringify([texts, values].map(({ store: _store, ...rest }) => rest))}\n`);
