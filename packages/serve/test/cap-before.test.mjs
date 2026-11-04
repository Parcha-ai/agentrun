// The cap on a run on another harness, before each request: what the run has spent, plus what its requests in flight
// may still cost, plus this request's worst case must stay within it. Two requests in flight together are held, as
// pi's own cap holds them, so neither can pass the cap with the other. A request admitted is limited to the output what
// is left buys (`outputTokensMax`); on this model's 1,000-token ceiling, under the 1,024 floor, its least is all of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore, NATIVE_SEARCH_ALLOWANCE_TOKENS, paidCall, useSpend } from "../dist/cap.js";
import { nativeOptions } from "../dist/adapters.js";
import { withOverCap } from "../dist/runs.js";

// One request may cost 0.6 of the cap: a 1000-token ceiling at $600 a million output tokens is $0.60, under a $1 cap.
const model = { id: "m", api: "openai-responses", provider: "p", maxTokens: 1000, contextWindow: 8000, cost: { input: 0, output: 600, cacheRead: 0, cacheWrite: 0 } };

test("a request in flight holds its worst case: a second one sent beside it is refused, and goes once the first has answered", async () => {
  const cap = await capBefore(1, model);
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 }), { outputTokensMax: 1000 }, "the first goes");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 0 }], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, "the second, beside it, would pass the cap with it");
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0.3, inFlight: [], inputTokensMax: 0 }), { outputTokensMax: 1000 }, "once the first answered, its own cost is what counts");
  assert.match(cap.beforeRequest({ spentUsd: 0.5, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, "spent and a request's worst case past the cap");
  assert.match(cap.beforeRequest({ spentUsd: null, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /spent is unknown/);
});

test("a paid call under way holds what it is held at here too: a request that fits only without it is refused, and goes once the call's charge is in", async (t) => {
  const cap = await capBefore(1, model);
  // The run's spend as the harness gives it to a paid call (harness-app.ts), and monid's run held at a $0.6 quote.
  let spent = 0;
  useSpend({ cap: 1, spent: () => spent, add: (usd) => void (spent += usd) });
  t.after(() => useSpend(undefined));
  const call = { sent: false };
  const answer = new Promise((resolve) => (call.settle = resolve));
  const paid = paidCall("monid_run", () => ((call.sent = true), answer), (charged) => charged, { usd: 0.6, basis: "the price monid_inspect quoted" });
  t.after(() => call.settle(0));
  while (!call.sent) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 })?.refuse, "spend_cap_reached (out of budget): Not sent: the run has spent $0 and holds $0.60 for requests still answering, of its $1 cap, and its next m request needs at least $0.60. Raise the cap to at least $1.20 to run it.");
  call.settle(0.1);
  assert.deepEqual(await paid, { result: 0.1 });
  assert.deepEqual(cap.beforeRequest({ spentUsd: spent, inFlight: [], inputTokensMax: 0 }), { outputTokensMax: 1000 }, "once its $0.1 charge is in, the request goes");
});

// $1 per million input tokens, a cache write at $2, and no output price: a request's worst case is its input bound alone.
const inputPriced = { ...model, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 2 } };

test("a request's input bound is priced, at the dearer of input and cache write: one whose input alone passes what is left of the cap is not sent", async () => {
  const cap = await capBefore(0.001, inputPriced);
  // 400 tokens at the cache write's $2 a million is $0.0008, within $0.001; 600 is $0.0012, past it.
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 400 }), { outputTokensMax: 1000 }, "an input within the cap goes");
  // $0.0012 at the cache-write price, past $0.001: the least in the words is rounded up to the cent.
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 600 })?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: this run's cap of \$0\.001 can't cover one m request \(at least \$0\.01\)\. Raise the cap to at least \$0\.01 to run it\.$/, "an input past it is refused, at the cache-write price");
  assert.match(cap.beforeRequest({ spentUsd: 0.0005, inFlight: [], inputTokensMax: 400 })?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, "and past what is left once the run has spent");
});

test("each request in flight holds its own input bound: two that fit alone cannot pass the cap side by side", async () => {
  const cap = await capBefore(0.001, inputPriced);
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 300 }), { outputTokensMax: 1000 }, "the first goes: $0.0006");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 300 }], inputTokensMax: 300 })?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, "the second, beside it, would make $0.0012");
  assert.deepEqual(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m", inputTokensMax: 100 }], inputTokensMax: 300 }), { outputTokensMax: 1000 }, "beside a small one it fits");
});

test("an input that could not be measured is not read as none: under a cap the request is refused", async () => {
  const cap = await capBefore(1, inputPriced);
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [] })?.refuse ?? "", /^spend_cap_reached: .*input/, "its own input unmeasured");
  assert.match(cap.beforeRequest({ spentUsd: 0, inFlight: [{ turn: 1, model: "m" }], inputTokensMax: 1 })?.refuse ?? "", /^spend_cap_reached: .*input/, "one in flight unmeasured");
});

test("a model serve has no price for is refused under a cap, and only under one; a model the catalog lists at $0 is a known $0 and passes", async () => {
  for (const unpriced of [await capBefore(1, undefined), await capBefore(1, model, { listed: false })]) {
    assert.match(unpriced?.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 })?.refuse ?? "", /^spend_cap_reached: .*no price.*out of budget/, "refused under a cap");
  }
  assert.equal(await capBefore(undefined, undefined), undefined, "no cap, no refusal");
  assert.equal(await capBefore(undefined, model, { listed: false }), undefined, "no cap, no refusal, priced or not");
  const free = await capBefore(0.000001, { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(free.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 1_000_000 }), { outputTokensMax: 1000 }, "a listed $0 model passes any cap");
});

test("claude-agent's own search is opened with the stated allowance, 8 searches of 25,000 tokens, which its proxy adds to a search request's bound; codex's own search, live (its adapter books each search); nothing where web_search does not resolve native", () => {
  assert.equal(NATIVE_SEARCH_ALLOWANCE_TOKENS, 200_000);
  const plane = (web_search) => ({ AGENTRUN_SERVE_TOOL_PLANE: JSON.stringify({ web_search }) });
  assert.deepEqual(nativeOptions("claude-agent", plane("native")), { webSearch: true, webSearchAllowance: 200_000 });
  assert.deepEqual(nativeOptions("codex", plane("native")), { webSearch: "live" });
  for (const [harness, env] of [["pi", plane("native")], ["codex", plane("exa-keyless")], ["claude-agent", plane("parallel")], ["codex", {}]]) assert.deepEqual(nativeOptions(harness, env), {}, `${harness} ${JSON.stringify(env)}`);
});

test("the over-cap row: after the usage row, once its booked cost is past the cap, saying by how much; none at or under it, or with no cap or no known cost", () => {
  const usage = (usd) => ({ id: "1:usage", kind: "usage", summary: "Cost so far", seq: 9, text: null, usage: { usd, requests: 2 } });
  const rows = (usd) => [{ id: "1:3", kind: "final_answer", summary: "Done.", seq: 8, text: "Done." }, usage(usd)];
  const [, , over] = withOverCap(rows(1.25), 1);
  assert.deepEqual([over.id, over.kind, over.summary, over.seq, "usage" in over], ["1:usage:over_cap", "phase", "Spent $1.2500, $0.2500 over the run's cap of $1", 9, false]);
  for (const [usd, cap] of [[1, 1], [0.5, 1], [null, 1], [2, undefined]]) assert.equal(withOverCap(rows(usd), cap).length, 2, `${usd} under ${cap}`);
});
