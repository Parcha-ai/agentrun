// The cap's `expected` pricing on the runner (kernel cap price.ts expectedInput): a request is priced from a recent
// request of its session (here its previous one), its cache read at the cache-read price and only what the body grew by
// since at full price, as main's in-process cap priced it from the conversation's last answer. `strict` prices
// every token uncached, a previous request or not, and is never loosened by it. Through the adapter loop on a real store:
// pi's two requests of one turn (a tool call, then its answer), each judged by the run's one cap.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);

/** Sonnet's prices: input $2, output $10, a cache read $0.10 and a cache write $2.50 a million tokens. */
const PRICED = Object.freeze({ id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 8_192 });
/** What the scripted origin reports for each request: 100 input tokens, none read from or written to the cache. */
const REPORTED_INPUT = 100;

/** A run of one turn, a tool call and then its answer, under `mode`; each request the cap judged, with its hold. */
async function twoRequests(t, mode) {
  const script = [{ call: "noop" }, { say: "done" }];
  const noop = { name: "noop", replaySafe: true, run: async () => "ok" };
  const specOf = (sent) => piAdapterSpec({ script, tools: { noop }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  const { row, asked } = await capRun(t, { script, specOf, runCap: { capUsd: () => 10, modelOf: () => PRICED, ...(mode ? { mode } : {}) } });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const judged = asked.filter((one) => one.request.host === undefined && !one.request.side);
  assert.equal(judged.length, 2, `two requests judged: ${JSON.stringify(judged.map((one) => one.request))}`);
  for (const one of judged) assert.ok(typeof one.answer?.holdUsd === "number", `admitted with a hold: ${JSON.stringify(one.answer)}`);
  return judged;
}

test("expected: the session's second request is priced from its first, warm, its input after the cache and what the body grew by at full price", async (t) => {
  const [first, second] = await twoRequests(t);
  const [, strictSecond] = await twoRequests(t, "strict");
  // The previous request read nothing from the cache and reported 100 tokens of input, so the second's input is those 100
  // and what the body grew by since (its bound less the first's), not its whole bound, each at the dearer of the input and
  // cache-write prices: the first request's bound less the 100 it reported, at $2.50 a million, comes off the hold.
  const less = ((first.request.inputTokensMax - REPORTED_INPUT) * 2.5) / 1e6;
  assert.ok(less > 0, `the first request's bound is more than its reported input: ${first.request.inputTokensMax}`);
  assert.equal(second.request.inputTokensMax, strictSecond.request.inputTokensMax, "the same body under either mode");
  assert.ok(Math.abs(strictSecond.answer.holdUsd - second.answer.holdUsd - less) < 1e-9, `priced warm from the first: strict ${strictSecond.answer.holdUsd}, expected ${second.answer.holdUsd}, ${less} less`);
});

test("strict: no request is priced from a previous one: the second request's hold is its whole bound uncached", async (t) => {
  const [first, second] = await twoRequests(t, "strict");
  // Every token at the dearer of the input and cache-write prices, and the output ceiling at the output price.
  const whole = (request) => (request.inputTokensMax * 2.5 + Math.min(request.outputTokensAsked ?? Infinity, 8_192) * 10) / 1e6;
  assert.ok(Math.abs(first.answer.holdUsd - whole(first.request)) < 1e-9, `the first at its whole bound: ${first.answer.holdUsd} vs ${whole(first.request)}`);
  assert.ok(Math.abs(second.answer.holdUsd - whole(second.request)) < 1e-9, `the second at its whole bound too: ${second.answer.holdUsd} vs ${whole(second.request)}`);
});
