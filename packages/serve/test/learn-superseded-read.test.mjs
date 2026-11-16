// A beta.39 store holds promotion records with `decided: "superseded"` (a replay that a newer draft cancelled), a word
// beta.40 no longer writes. On read such a record is "skipped" (the word for an older draft a newer one passed), so it
// reads decided and never "running"; nothing rewrites the stored record, and it never blocks a new draft's replay.
import assert from "node:assert/strict";
import { test } from "node:test";

const { promotionOf, promotionsOf, replayingOf } = await import("../dist/learn/promote.js");
const { replayView } = await import("../dist/runner/promotion.js");

const REPLAY = "0198c0de-0000-7000-8000-000000000001";
/** The beta.39 shape: the digest's `replaying` record, then the `superseded` one a newer draft wrote after it. */
const stored = {
  v: 1,
  items: [
    { workflow: "answer", digest: "old0old0old0old0", at: "2026-11-10T10:00:00.000Z", decided: "replaying", source: "replay", reason: "replaying on 5 graded inputs", runs: ["r1", "r2"], inputs: ["g1", "g2"], replay_id: REPLAY },
    { workflow: "answer", digest: "old0old0old0old0", at: "2026-11-10T10:05:00.000Z", decided: "superseded", superseded_by: "new0new0new0new0", source: "replay", reason: "superseded by new0new0new0new0", replay_id: REPLAY },
  ],
};

function storeOf() {
  const kv = new Map([["learning.promotions.a", structuredClone(stored)]]);
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  return { settings, kv };
}

test("a superseded record from a beta.39 store reads skipped, with a reason, and is neither queued nor replaying", async () => {
  const { settings } = storeOf();
  const records = await promotionsOf(settings, "a");
  const own = promotionOf(records, "answer", "old0old0old0old0");
  assert.equal(own.decided, "skipped", JSON.stringify(own));
  assert.equal(own.skipped_by, "new0new0new0new0");
  assert.match(own.reason, /a newer draft arrived while it replayed \(before beta\.40\)/);
  // It blocks nothing: no revision of the workflow replays or waits behind it, so a new draft replays at once.
  assert.deepEqual(replayingOf(records, "answer", null), []);
  assert.deepEqual(replayingOf(records, "answer", null, "queued"), []);
});

test("nothing rewrites the stored record: a read leaves the store as it was", async () => {
  const { settings, kv } = storeOf();
  await promotionsOf(settings, "a");
  assert.deepEqual(kv.get("learning.promotions.a"), stored);
});

test("a replay read of a superseded revision is decided, never running", async () => {
  const { settings } = storeOf();
  const view = await replayView({ store: { settings }, agentId: "a" }, "answer", "old0old0old0old0", REPLAY);
  assert.notEqual(view.status, "running", JSON.stringify(view));
  assert.equal(view.status, "failed", JSON.stringify(view));
  assert.match(view.reason, /a newer draft arrived while it replayed \(before beta\.40\)/);
});
