// jevWebDecider: the web decider a host builds for Jev from what it is handed (the TypeSafe key, jevProvider, Jev's price
// and a fetch), never from the process's environment: null gives none even with TYPESAFE_API_KEY set here. It pins
// JEV_MODEL and ranks under rerank+label. And a decision request's charge: the cap settles it at the cost the provider
// reported, never above its hold, or at the hold when it reported none (decisionPay hands Pay `charged`). jevProvider
// here is a fake factory over the scoring fake (fixtures/decide-runs.mjs); no socket leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { decideWeb, scoringProvider, SCORES, TASK } from "./fixtures/decide-runs.mjs";

const SENTINEL = "ts-sentinel-web-0c1d2e3f4a5b";
const PRICE = { requestUsd: 0.0002 };

/** A jevProvider stand-in: what it was built with, and the scoring fake under Jev's id on TypeSafe's route. */
function fakeJevProvider(cost_usd = 0.0001) {
  const built = [];
  const { asked, provider } = scoringProvider(SCORES);
  const decide = async (request, ctx) => ({ ...(await provider.decide(request, ctx)), cost_usd, cost_basis: cost_usd === null ? "unknown" : "reported" });
  return { built, asked, jevProvider: (options) => (built.push(options), { ...provider, id: "jev", needs: ["TYPESAFE_API_KEY"], decide }) };
}

test("jevWebDecider(null) gives no decider, even with TYPESAFE_API_KEY in this process's environment", (t) => {
  assert.equal(typeof web.jevWebDecider, "function", "web exports jevWebDecider");
  const before = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = SENTINEL;
  t.after(() => (before === undefined ? delete process.env.TYPESAFE_API_KEY : (process.env.TYPESAFE_API_KEY = before)));
  assert.equal(web.jevWebDecider(null), undefined, "no Jev was handed, so there is no decider: the environment's key is never read");
});

test("jevWebDecider builds Jev on the key, price and fetch it is handed: JEV_MODEL on every request, rerank+label", async () => {
  assert.equal(typeof web.jevWebDecider, "function", "web exports jevWebDecider");
  const jev = fakeJevProvider();
  const fetchGiven = async () => new Response("{}");
  const got = web.jevWebDecider({ key: "fake-test-key", jevProvider: jev.jevProvider, price: PRICE, fetch: fetchGiven });
  assert.equal(got.policy, "rerank+label", "Jev ranks web_search's results under rerank+label");
  assert.equal(got.model, "jev-1.14.0", "the model pin lives in the construction");
  assert.equal(got.model, web.JEV_MODEL);
  assert.deepEqual(jev.built, [{ apiKey: "fake-test-key", fetch: fetchGiven }], "jevProvider was given the handed key and fetch, nothing else");
  const w = decideWeb({ decider: got.decider, policy: got.policy });
  const { answer } = await w.search("widgets delaware", { n: 4, task: TASK });
  assert.deepEqual(jev.asked.map(({ request }) => request.model), ["jev-1.14.0"], "the sift went out on jev-1.14.0");
  assert.deepEqual(answer.results.map((r) => r.relevance), [0.9, 0.21, 0.2, 0.05], "the results were reranked by relevance, every one kept");
  assert.match(answer.sift, /^jev ordered 4 results by relevance/);
  const bare = web.jevWebDecider({ key: "fake-test-key", jevProvider: jev.jevProvider, price: PRICE });
  assert.deepEqual(jev.built.at(-1), { apiKey: "fake-test-key" }, "with no fetch handed, none is passed");
  assert.equal(bare.policy, "rerank+label");
});

/** A web on the fakes whose decider reports `cost_usd` for each request, its Pay filing each decision's hold and the
 *  charge it is told to settle at. */
async function chargesFor(cost_usd) {
  const jev = fakeJevProvider(cost_usd);
  const filed = [];
  const pay = async (fee, send, charged) => {
    const response = await send();
    if (fee.by === "jev") filed.push({ hold: fee.usd, charged: charged?.() });
    return response;
  };
  const decider = web.deciderFrom(jev.jevProvider({ apiKey: "k" }), { price: PRICE });
  await decideWeb({ decider, pay }).search("widgets delaware", { n: 4, task: TASK });
  return filed;
}

test("a decision request settles at the cost its provider reported, capped at its hold; at its hold when it reported none", async () => {
  const below = await chargesFor(0.00004);
  assert.equal(below.length, 1, "one sift request");
  assert.equal(below[0].hold, 0.0002);
  assert.equal(below[0].charged, 0.00004, "a reported cost below the hold is what the cap settles at");
  const above = await chargesFor(0.5);
  assert.equal(above[0].charged, 0.0002, "a reported cost above the hold settles at the hold, never more");
  const none = await chargesFor(null);
  assert.equal(none[0].charged, 0.0002, "no cost reported: the hold");
});
