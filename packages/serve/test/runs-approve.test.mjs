// The answer to a tool call that waits for approval, over the one store (runs-over-store.ts approve): the first answer wins
// from the moment it is written, before the run's runner takes it. The same answer again changes nothing; another is 409
// already_answered with the first one's decision; and two answers racing on one stale moment leave one command row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approve } from "../dist/runs-over-store.js";
import { queued, storeOn } from "./store-helpers.mjs";

const CALL = "call-1";
/** The moment a server reads before the runner took any answer: the call waits, nothing answered yet. */
const waiting = (id = "run-1") => ({ id, approvalIds: new Set([CALL]) });
const answers = async (store, runId = "run-1") => (await store.commands(runId, 0)).filter((c) => c.kind === "approve" || c.kind === "deny").map((c) => [c.kind, c.body.approval]);
const alreadyAnswered = (decision) => (error) => {
  assert.equal(error.code, "not_continuable");
  assert.deepEqual(error.details, { reason: "already_answered", decision });
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

test("two answers racing on one stale moment: exactly one is written, the other is 409 with the winner's decision", async (t) => {
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

test("the same answer racing itself: both succeed, one command row", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const moment = waiting();
  await Promise.all([approve(store, moment, CALL, "allow"), approve(store, moment, CALL, "allow")]);
  assert.deepEqual(await answers(store), [["approve", CALL]]);
});
