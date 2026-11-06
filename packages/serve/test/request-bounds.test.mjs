// A run's request bounds (bounds.ts), read from its root's entries as the server reads them: live, then again whole on a
// reconnect's snapshot or a full read of the store (the settle's, a load's). Each entry changes them once, by its id. A
// harness request's bound closes when its own answer is booked (its BOOKED marker names it), in whatever order answers
// come, or when its late cost comes in; a pi request's closes on its end or answer, pi's generation requests going one at
// a time. What ended since the run's cost last fit its cap is summed: two requests that missed the cache together may
// pass the cap by both their bounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { RequestBounds } from "../dist/bounds.js";

let id = 0;
const next = () => (id += 1);
const piStart = (bound) => ({ id: next(), kind: REQUEST_STARTED, data: { heldUsd: 0.1, ...(bound ? { boundUsd: bound } : {}) } });
const piAnswer = (stopReason = "toolUse") => ({ id: next(), kind: "pi.assistant", model: [{ role: "assistant", stopReason }] });
const piEnded = () => ({ id: next(), kind: REQUEST_ENDED, data: { heldUsd: 0.1 } });
const KEY = "run:r1";
const harnessStart = (request, bound) => ({ id: next(), kind: REQUEST_STARTED, data: { key: KEY, request, boundUsd: bound } });
/** A harness answer as harness-app writes it: its entry, and its BOOKED marker naming its request, in one commit. */
const harnessAnswer = (request, { unpriced = false } = {}) => [
  { id: next(), kind: "pi.assistant", model: [{ role: "assistant", api: "agentrun-adapter", stopReason: "toolUse" }] },
  { id: next(), kind: "adapter.request", data: { key: KEY, request, ...(unpriced ? { unpriced: true } : {}) } },
];
const close = (a, b) => Math.abs(a - b) < 1e-12;

test("a replay of entries already read (a reconnect's snapshot, the settle's full read) changes nothing: the warm request in flight keeps its own bound, and once it answers none is left open", () => {
  const bounds = new RequestBounds();
  const live = [piStart(0.01), piAnswer(), piStart(0.02), piAnswer(), piStart(0.03)];
  bounds.note(live);
  bounds.fit();
  assert.ok(close(bounds.inFlight(), 0.03), `in flight: ${bounds.inFlight()}`);
  bounds.note(live);
  assert.ok(close(bounds.inFlight(), 0.03), `after the replay, the same: ${bounds.inFlight()}`);
  bounds.note([piAnswer()]);
  assert.equal(bounds.inFlight(), 0, "the warm request answered: nothing open");
  assert.ok(close(bounds.ended(), 0.03), `its own bound ended: ${bounds.ended()}`);
});

test("harness answers out of order: each closes its own request's bound (its BOOKED marker), and the bounds that ended since the cost last fit are summed", () => {
  const bounds = new RequestBounds();
  bounds.note([harnessStart(1, 0.01), harnessStart(2, 0.1)]);
  assert.ok(close(bounds.inFlight(), 0.11));
  // B (request 2) missed the cache and answers first.
  bounds.note(harnessAnswer(2));
  assert.ok(close(bounds.inFlight(), 0.01), `A's bound still in flight: ${bounds.inFlight()}`);
  assert.ok(close(bounds.ended(), 0.1), `B's own bound ended: ${bounds.ended()}`);
  bounds.note(harnessAnswer(1));
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.11), `both ended since the cost last fit: ${bounds.ended()}`);
  bounds.fit();
  assert.equal(bounds.ended(), 0, "the cost fits again: none of them explains a later overshoot");
});

test("a harness answer booked before its cost keeps its bound in flight until the late cost comes in", () => {
  const bounds = new RequestBounds();
  bounds.note([harnessStart(1, 0.2), ...harnessAnswer(1, { unpriced: true })]);
  assert.ok(close(bounds.inFlight(), 0.2), `its cost not in yet: ${bounds.inFlight()}`);
  bounds.note([{ id: next(), kind: REQUEST_COST_LATE, data: { key: KEY, request: 1, usd: 0.3 } }]);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.2));
});

test("pi: a request stopped (its end mark, then pi's aborted entry) closes once; one a crash cut is over when the next process's request starts", () => {
  const bounds = new RequestBounds();
  bounds.note([piStart(0.05), piEnded(), piAnswer("aborted")]);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.05), `closed once, its bound counted once: ${bounds.ended()}`);
  bounds.fit();
  // A request cut by a crash has a start and nothing after it; the run's next process sends the next one.
  bounds.note([piStart(0.2), piStart(0.03)]);
  assert.ok(close(bounds.inFlight(), 0.03), `only the new process's request is in flight: ${bounds.inFlight()}`);
});

test("pi side requests (a hosted search's, a learned workflow's model node, a summary) run inside tool calls, which pi runs side by side: each closes its own bound, by its request id, in whatever order they answer", () => {
  const bounds = new RequestBounds();
  const sideStart = (requestId, bound) => ({ id: next(), kind: REQUEST_STARTED, data: { request: "web_search", requestId, heldUsd: 0.1, boundUsd: bound } });
  const sideCost = (requestId, usd) => ({ id: next(), kind: "agentrun.request_cost", data: { request: "web_search", requestId, usd } });
  bounds.note([sideStart("s1", 0.01), sideStart("s2", 0.1)]);
  assert.ok(close(bounds.inFlight(), 0.11), `both in flight: ${bounds.inFlight()}`);
  // The second missed the cache and answers first.
  bounds.note([sideCost("s2", 0.3)]);
  assert.ok(close(bounds.inFlight(), 0.01), `the first still in flight: ${bounds.inFlight()}`);
  assert.ok(close(bounds.ended(), 0.1), `the second's own bound ended: ${bounds.ended()}`);
  bounds.note([{ id: next(), kind: REQUEST_ENDED, data: { request: "web_search", requestId: "s1", heldUsd: 0.1 } }]);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.11));
});

test("a full read after a restart keeps only the bounds since the run's cost last fit its cap, as the live read does: never the sum of every bound the run ever had", () => {
  const cap = 0.5;
  /** pi requests answered under the cap, then one whose cache miss takes the run past it. */
  const answered = (usd) => ({ id: next(), kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", usage: { cost: { total: usd } } }] });
  const entries = [];
  for (let k = 0; k < 5; k++) entries.push(piStart(0.2), answered(0.09));
  entries.push(piStart(0.3), answered(0.12));
  // Live: the entries one at a time.
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], cap);
  // A new server: the whole store at once.
  const replay = new RequestBounds();
  replay.note(entries, cap);
  assert.ok(close(live.ended(), 0.3), `live: the crossing request's bound alone: ${live.ended()}`);
  assert.ok(close(replay.ended(), live.ended()), `after a restart, the same: ${replay.ended()} vs ${live.ended()}`);
});
