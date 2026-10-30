// The cap on a run on another harness, before each request: what the run has spent, plus what its requests in flight
// may still cost, plus this request's worst case must stay within it. Two requests in flight together are held, as
// pi's own cap holds them, so neither can pass the cap with the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore, guardOf } from "../dist/cap.js";

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

const first = (cap) => cap?.beforeRequest({ spentUsd: 0, inFlight: [] })?.refuse ?? "";

test("under a cap, a model this process cannot find refuses every request, by name: it never runs with no guard", async () => {
  assert.match(first(await capBefore(1, undefined)), /^spend_cap_reached: .*\(model unknown\)/);
});

test("under a cap, a model with no price refuses, by name: its requests are never read as $0", async () => {
  const free = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.match(first(await capBefore(1_000_000, free)), /^spend_cap_reached: .*\(no price\)/);
});

test("under a cap, a model with no output ceiling to price a request by refuses, by name", async () => {
  for (const bounds of [{ maxTokens: 0, contextWindow: 0 }, { maxTokens: undefined, contextWindow: undefined }]) {
    assert.match(first(await capBefore(1_000_000, { ...model, ...bounds })), /^spend_cap_reached: .*\(no output ceiling\)/, JSON.stringify(bounds));
  }
});

test("a worst case that is not a number refuses: the cap's comparison never admits a NaN", () => {
  assert.match(first(guardOf(1, Number.NaN)), /^spend_cap_reached: /);
});

test("with no cap, nothing is guarded, whatever the model", async () => {
  assert.equal(await capBefore(undefined, undefined), undefined);
  assert.equal(await capBefore(undefined, model), undefined);
});
