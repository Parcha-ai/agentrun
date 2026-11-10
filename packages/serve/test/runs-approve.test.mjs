// The answer to a tool call that waits for approval, over the one store (runs-over-store.ts approve): the first answer wins
// from the moment it is written, before the run's runner takes it. The same answer again changes nothing; another is 409
// already_answered with the first one's decision; and two answers racing on one stale moment leave one command row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approve } from "../dist/runs-over-store.js";
import { queued, storeOn } from "./store-helpers.mjs";
import { onPostgres, raw } from "./store-target.mjs";

/** The one-answer index is SQLite's today (schema.ts COMMANDS_ONE_ANSWER); Postgres gets it in its own migration. */
const ONE_ANSWER_INDEX = { skip: onPostgres ? "waits on the Postgres commands_one_answer migration (pgstore-1)" : false };

const CALL = "call-1";
/** The moment a server reads before the runner took any answer: the call waits, nothing answered yet. */
const waiting = (id = "run-1") => ({ id, approvalIds: new Set([CALL]) });
const answers = async (store, runId = "run-1") => (await store.commands(runId, 0)).filter((c) => c.kind === "approve" || c.kind === "deny").map((c) => [c.kind, c.body.approval]);
const alreadyAnswered = (decision) => (error) => {
  assert.equal(error.code, "not_continuable");
  assert.deepEqual(error.extra.details, { reason: "already_answered", decision });
  return true;
};

test("an answer the runner has not taken yet already answers the call: the same one again changes nothing, another is 409 already_answered", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  await approve(store, waiting(), CALL, "allow");
  await approve(store, waiting(), CALL, "allow");
  await assert.rejects(approve(store, waiting(), CALL, "deny", "no"), alreadyAnswered("allow"));
  assert.deepEqual(await answers(store), [["approve", CALL]], "one command row");
});

test("a deny the runner has not taken yet: an allow after it is 409 with deny", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  await approve(store, waiting(), CALL, "deny", "That host is off limits.");
  await assert.rejects(approve(store, waiting(), CALL, "allow"), alreadyAnswered("deny"));
  assert.deepEqual(await answers(store), [["deny", CALL]]);
});

test("two answers racing on one stale moment: exactly one is written, the other is 409 with the winner's decision", ONE_ANSWER_INDEX, async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const moment = waiting();
  const settled = await Promise.allSettled([approve(store, moment, CALL, "allow"), approve(store, moment, CALL, "deny", "no")]);
  const won = await answers(store);
  assert.equal(won.length, 1, `one command row: ${JSON.stringify(won)}`);
  const winner = won[0][0] === "approve" ? "allow" : "deny";
  assert.deepEqual(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
  const lost = settled.find((s) => s.status === "rejected").reason;
  assert.ok(alreadyAnswered(winner)(lost));
});

test("the same answer racing itself: both succeed, one command row", ONE_ANSWER_INDEX, async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const moment = waiting();
  await Promise.all([approve(store, moment, CALL, "allow"), approve(store, moment, CALL, "allow")]);
  assert.deepEqual(await answers(store), [["approve", CALL]]);
});

/** Refuses command row `id` as the runner does when a woken run's loop cannot start (runner.ts resumeFailed): taken, with
 *  its reason, so the run is released parked with nothing to wake it. */
async function refuse(file, id) {
  const db = await raw(file);
  try {
    await db.run("UPDATE commands SET taken_at = ?, refused = ? WHERE id = ?", Date.now(), "the run could not resume", id);
  } finally {
    await db.close?.();
  }
}
const live = async (store, runId = "run-1") => (await store.commands(runId, 0)).filter((c) => (c.kind === "approve" || c.kind === "deny") && c.refused === null).map((c) => [c.kind, c.body.approval]);

test("an answer the runner refused (its run could not resume) answers nothing: the same answer again is written anew and wakes the run", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  await approve(store, waiting(), CALL, "allow");
  const [first] = (await store.commands("run-1", 0)).filter((c) => c.kind === "approve");
  await refuse(file, first.id);
  await approve(store, waiting(), CALL, "allow");
  assert.deepEqual(await live(store), [["approve", CALL]], "a new, unrefused answer");
  assert.equal((await store.commands("run-1", 0)).filter((c) => c.kind === "approve").length, 2, "the refused one kept, never deleted");
});

test("an answer the runner refused answers nothing: the other decision is taken, never 409", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  await approve(store, waiting(), CALL, "allow");
  const [first] = (await store.commands("run-1", 0)).filter((c) => c.kind === "approve");
  await refuse(file, first.id);
  await approve(store, waiting(), CALL, "deny", "Not now.");
  assert.deepEqual(await live(store), [["deny", CALL]]);
});
