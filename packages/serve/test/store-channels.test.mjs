// A channel the server sends itself (Store.channels: the outbound webhook's): its outbox (channel_posts), each try of a
// post (channel_attempts) and what it told each run (channel_told), on the store the tests run on (store-target.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const CHANNEL = "webhook-out";
const post = (id, extra = {}) => ({ id, channel: CHANNEL, moment: "run.ended", body: `{"type":"run.ended","id":"${id}"}`, nextAt: 1_000, ...extra });
const tried = (postId, at, extra = {}) => ({ postId, moment: "run.ended", at, statusCode: 500, latencyMs: 3, error: "answered 500", retryAt: null, redelivery: false, ...extra });

async function opened(t) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  for (const id of ["run-1", "run-2"]) await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  return store;
}

test("a post is queued once by its id, with its told row in the same transaction; its body is kept byte for byte", async (t) => {
  const store = await opened(t);
  const body = '{"b": 1,  "a":"é"}';
  assert.equal(await store.channels.post(post("msg_1", { runId: "run-1", body }), { runId: "run-1", marker: "ended:t1" }), true);
  assert.equal(await store.channels.post(post("msg_1", { runId: "run-1", body: "{}" }), { runId: "run-1", marker: "ended:t1" }), false, "the same id again: left as it is");
  const [kept] = await store.channels.queued(CHANNEL);
  assert.deepEqual([kept.id, kept.runId, kept.moment, kept.body, kept.state, kept.attempts, kept.nextAt], ["msg_1", "run-1", "run.ended", body, "queued", 0, 1_000]);
  assert.deepEqual((await store.channels.told(CHANNEL, "run-1")).map((row) => row.marker), ["ended:t1"]);
  // A told row names a run the store holds: one it does not have refuses the post and its row together.
  await assert.rejects(store.channels.post(post("msg_2", { runId: "run-none" }), { runId: "run-none", marker: "ended:t2" }));
  assert.equal(await store.channels.get("msg_2"), undefined, "nothing of it written");
});

test("a told row replacing a prefix drops the run's markers under it first, in the same transaction; forget drops the rows named", async (t) => {
  const store = await opened(t);
  await store.channels.post(post("msg_w1", { runId: "run-1" }), { runId: "run-1", marker: "wait:row_1", replacing: "" });
  await store.channels.post(post("msg_e1", { runId: "run-1" }), { runId: "run-1", marker: "ended:t1", replacing: "ended:" });
  await store.channels.post(post("msg_e2", { runId: "run-1" }), { runId: "run-1", marker: "ended:t2", replacing: "ended:" });
  assert.deepEqual((await store.channels.told(CHANNEL, "run-1")).map((row) => row.marker).sort(), ["ended:t2", "wait:row_1"], "a new end replaces the last, and keeps the wait");
  await store.channels.post(post("msg_w2", { runId: "run-1" }), { runId: "run-1", marker: "wait:row_9", replacing: "" });
  assert.deepEqual((await store.channels.told(CHANNEL, "run-1")).map((row) => row.marker), ["wait:row_9"], "a new wait replaces every marker");
  await store.channels.post(post("msg_x", { runId: "run-2" }), { runId: "run-2", marker: "ended:t3" });
  await store.channels.forget(CHANNEL, [{ runId: "run-1", marker: "wait:row_9" }]);
  assert.deepEqual((await store.channels.told(CHANNEL)).map((row) => [row.runId, row.marker]), [["run-2", "ended:t3"]]);
});

test("a settle writes the post's state with its try in one transaction; the channel keeps its newest tries, and of its sent or dropped posts only those a kept try names", async (t) => {
  const store = await opened(t);
  for (const id of ["msg_a", "msg_b", "msg_c"]) await store.channels.post(post(id));
  await store.channels.settle("msg_a", { state: "queued", attempts: 1, nextAt: 9_000, reason: "answered 500" }, tried("msg_a", 1), 2);
  assert.deepEqual(await store.channels.get("msg_a").then((p) => [p.state, p.attempts, p.nextAt, p.reason]), ["queued", 1, 9_000, "answered 500"]);
  await store.channels.settle("msg_a", { state: "sent", attempts: 2, reason: null }, tried("msg_a", 2, { statusCode: 200, error: null }), 2);
  await store.channels.settle("msg_b", { state: "dropped", attempts: 1, reason: "answered 410" }, tried("msg_b", 3, { statusCode: 410, error: "answered 410" }), 2);
  // Two tries kept: msg_a's second and msg_b's. msg_a is still named, so kept; then a third try pushes msg_a's out.
  assert.deepEqual((await store.channels.attempts(CHANNEL, 10)).map((a) => [a.postId, a.statusCode, a.redelivery]), [["msg_b", 410, false], ["msg_a", 200, false]], "newest first");
  await store.channels.settle("msg_c", { state: "sent", attempts: 1 }, tried("msg_c", 4, { statusCode: 200, error: null, redelivery: true }), 2);
  assert.deepEqual((await store.channels.attempts(CHANNEL, 10)).map((a) => a.postId), ["msg_c", "msg_b"]);
  assert.equal(await store.channels.get("msg_a"), undefined, "a sent post no kept try names goes");
  assert.equal((await store.channels.get("msg_b")).state, "dropped", "a dropped one a kept try names stays, for a redelivery");
  assert.equal((await store.channels.attempts(CHANNEL, 10))[0].redelivery, true);
});

test("dropAll drops every queued post of the channel, with why, and answers how many; a settled one is left", async (t) => {
  const store = await opened(t);
  await store.channels.post(post("msg_1"));
  await store.channels.post(post("msg_2"));
  await store.channels.post(post("msg_3"));
  await store.channels.settle("msg_3", { state: "sent", attempts: 1 }, tried("msg_3", 1, { statusCode: 200, error: null }));
  await store.channels.post(post("msg_other", { channel: "slack" }));
  assert.equal(await store.channels.dropAll(CHANNEL, "the webhook was removed"), 2);
  assert.deepEqual(await store.channels.queued(CHANNEL), []);
  assert.deepEqual(await store.channels.get("msg_1").then((p) => [p.state, p.reason]), ["dropped", "the webhook was removed"]);
  assert.equal((await store.channels.get("msg_3")).state, "sent");
  assert.equal((await store.channels.queued("slack")).length, 1, "another channel's post is its own");
});
