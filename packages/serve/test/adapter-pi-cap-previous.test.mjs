// One cap mode, the worst case, on the runner: every request is held at its whole input bound uncached (at the dearer of
// the input and cache-write prices), whatever a previous request of its session read from the cache, so a cache miss can
// never take it past its hold. A previous request never loosens the next one's hold. Through the adapter loop on a real
// store: pi's two requests of one turn (a tool call, then its answer), each judged by the run's one cap.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);

/** Sonnet's prices: input $2, output $10, a cache read $0.10 and a cache write $2.50 a million tokens. */
const PRICED = Object.freeze({ id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 8_192 });

/** A run of one turn, a tool call and then its answer; each request the cap judged, with its hold. */
async function twoRequests(t) {
  const script = [{ call: "noop" }, { say: "done" }];
  const noop = { name: "noop", replaySafe: true, run: async () => "ok" };
  const specOf = (sent) => piAdapterSpec({ script, tools: { noop }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  const { row, asked } = await capRun(t, { script, specOf, runCap: { capUsd: () => 10, modelOf: () => PRICED } });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const judged = asked.filter((one) => one.request.host === undefined && !one.request.side);
  assert.equal(judged.length, 2, `two requests judged: ${JSON.stringify(judged.map((one) => one.request))}`);
  for (const one of judged) assert.ok(typeof one.answer?.holdUsd === "number", `admitted with a hold: ${JSON.stringify(one.answer)}`);
  return judged;
}

test("no request is priced from a previous one: each request's hold is its whole bound uncached, the second's as the first's", async (t) => {
  const [first, second] = await twoRequests(t);
  // Every token at the dearer of the input and cache-write prices, and the output ceiling at the output price.
  const whole = (request) => (request.inputTokensMax * 2.5 + Math.min(request.outputTokensAsked ?? Infinity, 8_192) * 10) / 1e6;
  assert.ok(Math.abs(first.answer.holdUsd - whole(first.request)) < 1e-9, `the first at its whole bound: ${first.answer.holdUsd} vs ${whole(first.request)}`);
  assert.ok(Math.abs(second.answer.holdUsd - whole(second.request)) < 1e-9, `the second at its whole bound too, its first's cache no discount: ${second.answer.holdUsd} vs ${whole(second.request)}`);
});
