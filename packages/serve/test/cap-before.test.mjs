// The cap on a run on another harness, before each request: what the run has spent, plus what its requests in flight
// may still cost, plus this request's worst case must stay within it. Two requests in flight together are held, as
// pi's own cap holds them, so neither can pass the cap with the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore } from "../dist/cap.js";

// One request may cost 0.6 of the cap: a 1000-token ceiling at $600 a million output tokens is $0.60, under a $1 cap.
const model = { id: "m", api: "openai-responses", provider: "p", maxTokens: 1000, contextWindow: 8000, cost: { input: 0, output: 600, cacheRead: 0, cacheWrite: 0 } };

test("a request in flight holds its worst case: a second one sent beside it is refused, and goes once the first has answered", async () => {
  const cap = await capBefore(1, model);
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [] }), undefined, "the first goes");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m" }] })?.refuse ?? "", /^spend_cap_reached: /, "the second, beside it, would pass the cap with it");
  assert.equal(cap.beforeRequest({ spentUsd: 0.3, inFlight: [] }), undefined, "once the first answered, its own cost is what counts");
  assert.match(cap.beforeRequest({ spentUsd: 0.5, inFlight: [] })?.refuse ?? "", /^spend_cap_reached: /, "spent and a request's worst case past the cap");
  assert.match(cap.beforeRequest({ spentUsd: null, inFlight: [] })?.refuse ?? "", /spent is unknown/);
});
