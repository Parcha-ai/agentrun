// A run's listing keeps the digest of the server's secrets it was cut of (store-view.ts listingOverStore), and a list
// serves it as built only while the server holds the same set (builtOfNow, listedItem); under any other set it is built
// or cut again. So two sets that differ must never share a digest: not two values that differ only in a lone UTF-16
// surrogate (one replacement character as UTF-8), and not one value holding a NUL against the two it would join.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { builtOfNow, listedItem, listingOverStore } = await import("../dist/store-view.js");

// Values of 24 characters in no secret's shape, made at runtime.
const KEY = ["Zq8V", "bN3x", "LmT6", "pR2w", "Yk9H", "sD4f"].join("");
const LATER = ["Wt5N", "hQ2c", "Jr8M", "vX3e", "Pd6K", "gB7s"].join("");
const ORIGIN = "http://127.0.0.1:7340";

/** A run titled `title` in a fresh store, and its listing built while the server held `held`. */
async function listedUnder(t, title, held) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say it." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: title }, title, place: { mode: "runner" } } });
  return listingOverStore(store, "run-1", { origin: ORIGIN, serverSecrets: () => held });
}

const cases = [
  { why: "two values that differ only in a lone surrogate", built: [`${KEY}\ud800`], now: [`${KEY}\ud801`], shown: `${KEY}\ud801` },
  { why: "two reversed pairs (a low surrogate before a high)", built: [`${KEY}\udc00\ud800`], now: [`${KEY}\udfff\udbff`], shown: `${KEY}\udfff\udbff` },
  // The two values sorted and joined by a NUL, as one value: the old digest's own input for the pair.
  { why: "one value holding a NUL against the two it joins", built: [[KEY, LATER].sort().join("\0")], now: [KEY, LATER], shown: KEY },
];

for (const { why, built, now, shown } of cases) {
  test(`a listing cut of one set is cut again under another: ${why}`, async (t) => {
    const listing = await listedUnder(t, `say ${shown} now`, built);
    assert.ok(String(listing.item.title).includes(shown), "built under the first set, which does not hold it, the title shows it");
    assert.equal(builtOfNow(listing, built), true, "under the set it was cut of, it is current");
    assert.equal(builtOfNow(listing, [...built, ...built].reverse()), true, "the same set in another order, a value twice: the same digest");
    const item = listedItem(listing, ORIGIN, null, now);
    assert.ok(!JSON.stringify(item).includes(JSON.stringify(shown).slice(1, -1)), `the list never serves ${JSON.stringify(shown)} as cut under the other set: ${JSON.stringify(item.title)}`);
    assert.equal(builtOfNow(listing, now), false, "under the other set it is built again");
  });
}
