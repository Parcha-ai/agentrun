// A run's spend over the one store (store-reads/cap.ts): the cap reads a run's entries from A and runs the one computation
// (cap.ts spentFrom) over them, the same it ran over a settled run's own database. The money is unchanged: the A read must
// feed spentFrom the same entries, so the spend matches spentFrom over those entries, and a priced run reads its cost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { spentOverStore } = await import("../dist/store-reads/cap.js");
const { spentFrom } = await import("../dist/cap.js");
const { runEntries } = await import("../dist/store-reads/journal.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const answer = (id, total) => ({ id, conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [], usage: { cost: { total } }, timestamp: 0 }] });

async function journalWith(store, writes, runId = "run-1") {
  await agentWithRevision(store);
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
  const journal = store.journal(await store.claim(runId, "runner-a", { leaseMs: 60_000 }));
  await commitWrites(journal, writes, context);
}

test("spentOverStore reads a priced run's cost from A, the same spentFrom reads from the entries", async (t) => {
  const { store } = await storeOn(t);
  await journalWith(store, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: answer(2, 0.4) }, { type: "entry", value: answer(3, 0.1) }]);
  const viaA = await spentOverStore(store, "run-1", context);
  // The same answer over spentFrom directly: the A read changes nothing but where the entries come from.
  assert.equal(viaA, spentFrom(await runEntries(store, "run-1", context)), "A read feeds the one computation");
  assert.equal(viaA, 0.5, "the two answers' cost");
});

test("a run with no journal spends 0", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await spentOverStore(store, "none", context), 0);
});
