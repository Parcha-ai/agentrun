// A channel the server sends itself (Store.channels: the outbound webhook's): its outbox (channel_posts), each try of a
// post (channel_attempts) and what it told each run (channel_told), on the store the tests run on (store-target.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const CHANNEL = "webhook-out";
const post = (id, extra = {}) => ({ id, channel: CHANNEL, moment: "run.ended", body: `{"type":"run.ended","id":"${id}"}`, nextAt: 1_000, ...extra });
const tried = (postId, at, extra = {}) => ({ tryId: `${postId}@${at}`, postId, moment: "run.ended", at, statusCode: 500, latencyMs: 3, error: "answered 500", retryAt: null, redelivery: false, ...extra });

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
  await store.channels.settle("msg_a", { state: "queued", attempts: 1, nextAt: 9_000, reason: "answered 500" }, tried("msg_a", 1), { kept: 2 });
  assert.deepEqual(await store.channels.get("msg_a").then((p) => [p.state, p.attempts, p.nextAt, p.reason]), ["queued", 1, 9_000, "answered 500"]);
  await store.channels.settle("msg_a", { state: "sent", attempts: 2, reason: null }, tried("msg_a", 2, { statusCode: 200, error: null }), { kept: 2 });
  await store.channels.settle("msg_b", { state: "dropped", attempts: 1, reason: "answered 410" }, tried("msg_b", 3, { statusCode: 410, error: "answered 410" }), { kept: 2 });
  // Two tries kept: msg_a's second and msg_b's. msg_a is still named, so kept; then a third try pushes msg_a's out.
  assert.deepEqual((await store.channels.attempts(CHANNEL, 10)).map((a) => [a.postId, a.statusCode, a.redelivery]), [["msg_b", 410, false], ["msg_a", 200, false]], "newest first");
  await store.channels.settle("msg_c", { state: "sent", attempts: 1 }, tried("msg_c", 4, { statusCode: 200, error: null, redelivery: true }), { kept: 2 });
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

test("a sent post with a try in flight (sending) stays, though no kept try names it, so a redelivery of it still finds it", async (t) => {
  const store = await opened(t);
  await store.channels.post(post("msg_held"));
  await store.channels.settle("msg_held", { state: "sent", attempts: 1 }, tried("msg_held", 1, { statusCode: 200, error: null }), { kept: 1 });
  await store.channels.post(post("msg_next"));
  await store.channels.settle("msg_next", { state: "sent", attempts: 1 }, tried("msg_next", 2, { statusCode: 200, error: null }), { kept: 1, sending: ["msg_held"] });
  assert.equal((await store.channels.get("msg_held")).state, "sent", "kept while its try is in flight");
  await store.channels.settle("msg_next", { state: "sent", attempts: 1 }, tried("msg_next", 3, { statusCode: 200, error: null }), { kept: 1 });
  assert.equal(await store.channels.get("msg_held"), undefined, "then it goes");
});

test("two senders claiming the same due post at once, on two connections: exactly one takes it; a claim that ran out is taken again; a start's release lets every claim go", async (t) => {
  const { store, file, clock } = await storeOn(t);
  await agentWithRevision(store);
  const other = (await storeOn(t, { file, clock, role: "runner" })).store;
  for (const id of ["msg_1", "msg_2", "msg_3"]) await store.channels.post(post(id));
  await store.channels.post(post("msg_later", { nextAt: 9_000 }));
  for (const id of ["msg_1", "msg_2", "msg_3"]) {
    const won = await Promise.all([store.channels.claim(id, 2_000, 60_000, "try-a"), other.channels.claim(id, 2_000, 60_000, "try-b")]);
    assert.deepEqual(won.filter(Boolean).length, 1, `${id}: one claim of two (${won})`);
    const taken = won.find(Boolean);
    assert.deepEqual([taken.id, taken.state, taken.claimedUntil, taken.attempts], [id, "sending", 62_000, 0], "the post as the claim took it");
    assert.deepEqual(await store.channels.get(id).then((p) => [p.state, p.claimedUntil, p.claim]), ["sending", 62_000, taken.claim]);
  }
  assert.equal(await store.channels.claim("msg_1", 30_000, 60_000, "try-c"), undefined, "held: its claim runs to 62 000");
  assert.equal((await other.channels.claim("msg_1", 62_001, 60_000, "try-d"))?.claim, "try-d", "a claim that ran out is taken again");
  assert.equal(await store.channels.claim("msg_later", 2_000, 60_000, "try-e"), undefined, "not due yet");
  await store.channels.settle("msg_2", { state: "sent", attempts: 1 }, tried("msg_2", 3, { statusCode: 200, error: null }));
  assert.equal(await store.channels.claim("msg_2", 200_000, 60_000, "try-f"), undefined, "a sent post is never claimed");
  assert.equal((await store.channels.get("msg_2")).claimedUntil, null, "a settle ends the claim");
  assert.equal(await store.channels.release(CHANNEL), 2, "msg_1 and msg_3 let go");
  assert.deepEqual((await store.channels.queued(CHANNEL)).map((p) => [p.id, p.state, p.claimedUntil, p.claim]), [["msg_1", "queued", null, null], ["msg_3", "queued", null, null], ["msg_later", "queued", null, null]]);
});

test("a try's settle is fenced on its claim: written again it lands once; written after a newer claim, a redelivery's landing or a drop it is a no-op, its try logged with no retry", async (t) => {
  const { store, file, clock } = await storeOn(t);
  await agentWithRevision(store);
  const other = (await storeOn(t, { file, clock, role: "runner" })).store;
  for (const id of ["msg_1", "msg_2", "msg_3"]) await store.channels.post(post(id));
  const shape = (id) => store.channels.get(id).then((p) => [p.state, p.attempts, p.nextAt, p.reason, p.claimedUntil, p.claim]);
  const logged = async (id) => (await store.channels.attempts(CHANNEL, 50)).filter((a) => a.postId === id).map((a) => [a.tryId, a.retryAt]);

  // Its outcome unknown (the store threw after the commit), the same write under the same claim lands again as it was.
  assert.equal((await store.channels.claim("msg_1", 2_000, 60_000, "a1")).claim, "a1");
  const failedA = [{ state: "queued", attempts: 1, nextAt: 5_000, reason: "answered 500" }, tried("msg_1", 2_000, { tryId: "a1", retryAt: 5_000 })];
  assert.equal(await store.channels.settle("msg_1", ...failedA, { claim: "a1" }), true);
  assert.equal(await other.channels.settle("msg_1", ...failedA, { claim: "a1" }), true, "written again: the same row");
  assert.deepEqual(await shape("msg_1"), ["queued", 1, 5_000, "answered 500", null, "a1"]);
  assert.deepEqual(await logged("msg_1"), [["a1", 5_000]], "logged once");
  // Its next try claims it: the first try's write, late, changes nothing.
  assert.equal((await other.channels.claim("msg_1", 5_000, 60_000, "a2")).attempts, 1);
  assert.equal(await store.channels.settle("msg_1", { state: "sent", attempts: 1, reason: null }, tried("msg_1", 2_001, { tryId: "a1-late", statusCode: 200, error: null }), { claim: "a1" }), false);
  assert.deepEqual(await shape("msg_1"), ["sending", 1, 5_000, "answered 500", 65_000, "a2"], "still the newer try's, its claim deadline kept");

  // A claim that ran out and was taken again: the first try's write, late, is a no-op; the newer one's lands.
  await store.channels.claim("msg_2", 2_000, 60_000, "b1");
  await other.channels.claim("msg_2", 62_001, 60_000, "b2");
  assert.equal(await store.channels.settle("msg_2", { state: "queued", attempts: 1, nextAt: 9_000, reason: "answered 500" }, tried("msg_2", 2_000, { tryId: "b1", retryAt: 9_000 }), { claim: "b1" }), false);
  assert.deepEqual(await shape("msg_2"), ["sending", 0, 1_000, null, 122_001, "b2"]);
  assert.deepEqual(await logged("msg_2"), [["b1", null]], "the try was made, so it is logged, with no retry it did not set");
  assert.equal(await other.channels.settle("msg_2", { state: "sent", attempts: 1, reason: null }, tried("msg_2", 62_001, { tryId: "b2", statusCode: 200, error: null }), { claim: "b2" }), true);
  assert.equal((await store.channels.get("msg_2")).state, "sent");

  // A redelivery's landing (no claim) takes the post from the try in flight: that try's write, after it, is a no-op, and
  // a failed redelivery writes no state at all, only its try.
  await store.channels.claim("msg_3", 2_000, 60_000, "c1");
  assert.equal(await other.channels.settle("msg_3", undefined, tried("msg_3", 2_500, { tryId: "r0", redelivery: true })), false, "a failed redelivery writes no state");
  assert.deepEqual(await shape("msg_3"), ["sending", 0, 1_000, null, 62_000, "c1"]);
  assert.equal(await other.channels.settle("msg_3", { state: "sent", reason: null }, tried("msg_3", 3_000, { tryId: "r1", statusCode: 200, error: null, redelivery: true })), true);
  assert.equal(await store.channels.settle("msg_3", { state: "queued", attempts: 1, nextAt: 9_000, reason: "answered 500" }, tried("msg_3", 2_000, { tryId: "c1", retryAt: 9_000 }), { claim: "c1" }), false);
  assert.deepEqual(await shape("msg_3"), ["sent", 0, 1_000, null, null, null], "sent stays sent");

  // A drop takes every claim: a try's write after it is a no-op.
  await store.channels.post(post("msg_4"));
  await store.channels.claim("msg_4", 2_000, 60_000, "d1");
  assert.equal(await store.channels.dropAll(CHANNEL, "the webhook was removed"), 2, "msg_4, and msg_1 under its newer claim");
  assert.equal(await store.channels.settle("msg_4", { state: "queued", attempts: 1, nextAt: 9_000, reason: "answered 500" }, tried("msg_4", 2_000, { tryId: "d1", retryAt: 9_000 }), { claim: "d1" }), false);
  assert.deepEqual(await shape("msg_4"), ["dropped", 0, 1_000, "the webhook was removed", null, null]);
});

test("two posts to one channel at once, on two connections, then settles that trim the channel to its newest try: neither unread post is lost, whatever order they committed in (a trim drops only settled posts)", async (t) => {
  const { store, file, clock } = await storeOn(t);
  await agentWithRevision(store);
  const other = (await storeOn(t, { file, clock, role: "runner" })).store;
  await store.channels.post(post("msg_old"));
  await store.channels.settle("msg_old", { state: "sent", attempts: 1 }, tried("msg_old", 1, { statusCode: 200, error: null }), { kept: 1 });
  const added = await Promise.all([store.channels.post(post("msg_a")), other.channels.post(post("msg_b"))]);
  assert.deepEqual(added, [true, true]);
  // Tries of other posts, each trimming the channel to one: every settled post no kept try names goes, never a queued one.
  for (const [i, id] of ["msg_c", "msg_d"].entries()) {
    await store.channels.post(post(id));
    await (i ? other : store).channels.settle(id, { state: "sent", attempts: 1 }, tried(id, 10 + i, { statusCode: 200, error: null }), { kept: 1 });
  }
  assert.deepEqual((await store.channels.queued(CHANNEL)).map((p) => p.id).sort(), ["msg_a", "msg_b"], "both unread posts kept");
  assert.equal(await store.channels.get("msg_old"), undefined, "a settled post past the kept tries goes");
  assert.equal(await store.channels.get("msg_c"), undefined);
  assert.deepEqual((await store.channels.attempts(CHANNEL, 10)).map((a) => a.postId), ["msg_d"], "the channel keeps its newest try");
});
