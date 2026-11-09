// A browser hand-over's answer is decided and written in one commit (runner/hand-back.ts answerOnce): two writers at once
// on a run's journal (the loop applying a person's hand-back row, the browser host writing the ask's expiry) leave
// exactly one answered entry, the one whose commit came first. Commits run one at a time on the run's Harness, so the
// order is the order they were asked in: no timing, no waits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const handBack = await import("../dist/runner/hand-back.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const answerOnce = (...args) => fn(handBack, "answerOnce")(...args);

const T0 = Date.parse("2001-02-03T04:05:06.007Z");
const iso = (ms) => new Date(ms).toISOString();
const ASK = { state: "waiting", id: `ask${"1".repeat(29)}`, session: "ar-run-1-1", instruction: "Sign in", completion_condition: "signed in", asked_at: iso(T0 - 60_000), expires_at: iso(T0 + 60_000), reason: "Sign in" };

/** A run's journal under its Harness, with the ask in its root. */
async function journalWithAsk(t) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const harness = await Harness.open(store.journal(claim), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => undefined));
  const root = await harness.root(ctx);
  await harness.commit((tx) => tx.appendEntry(root.id, { kind: "agent.handover", data: ASK }), ctx);
  const commit = (change) => harness.commit(change, ctx);
  const answers = async () => (await root.entries({ order: "ascending" }, 200, undefined, ctx)).items.filter((entry) => entry.kind === "agent.handover" && entry.data.state !== "waiting").map((entry) => entry.data);
  return { commit, rootId: root.id, answers };
}

test("two writers answering one ask at once leave exactly one answered entry: the first commit's, and the other reads it", async (t) => {
  const { commit, rootId, answers } = await journalWithAsk(t);
  // The loop applying the person's hand-back row (done, at its own time), and the browser host writing the ask's expiry,
  // each asked before the other's commit ran.
  const person = (entries) => handBack.handBackOf(entries, { ask: ASK.id, outcome: "done" }, T0);
  const expiry = (entries) => (handBack.answerIn(entries, ASK.id) ? { stood: handBack.answerIn(entries, ASK.id) } : { write: { state: "expired", id: ASK.id, session: ASK.session, at: ASK.expires_at } });
  const [first, second] = await Promise.all([answerOnce(commit, rootId, person), answerOnce(commit, rootId, expiry)]);
  assert.deepEqual(await answers(), [{ state: "done", id: ASK.id, session: ASK.session, at: iso(T0) }], "one answered entry");
  assert.deepEqual(first, { write: { state: "done", id: ASK.id, session: ASK.session, at: iso(T0) } }, "the first writer's answer is written");
  assert.deepEqual(second, { stood: { state: "done", id: ASK.id, session: ASK.session, at: iso(T0) } }, "the second reads it and writes nothing");
});
