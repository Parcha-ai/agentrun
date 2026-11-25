// The Jev model a decider sends. A Jev decider on TypeSafe's route (jevProvider reading TYPESAFE_API_KEY) sends
// JEV_MODEL, the version the thresholds were read on, never the moving jev-latest alias, unless the caller names a
// model; OpenRouter's route, and any other provider, is sent none. The decider is deciderFrom over the scoring fake
// (fixtures/decide-runs.mjs) under jevProvider's id and needs; no socket leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { decideWeb, PUBLIC, scoringProvider, SCORES, TASK } from "./fixtures/decide-runs.mjs";

const PRICE = { price: { requestUsd: 0.0002 } };

/** The scoring fake as jevProvider names itself on the route whose key it reads, its page guard answered as content. */
function jevOn(key) {
  const content = { type: "choice", choice: "content", probabilities: { content: 0.93, login_wall: 0.04, paywall: 0.03 } };
  const { asked, provider } = scoringProvider({ ...SCORES, wall: content, injection: 0.02 });
  return { asked, provider: { ...provider, id: "jev", needs: [key] } };
}
const searchOn = (provider, options = PRICE) => decideWeb({ decider: web.deciderFrom(provider, options) }).search("widgets delaware", { n: 4, task: TASK });

test("a Jev decider on TypeSafe's route sends JEV_MODEL with every request, never the moving alias; the caller's model wins; another provider, or Jev on OpenRouter's route, is sent none", async () => {
  const typesafe = jevOn("TYPESAFE_API_KEY");
  const w = decideWeb({ decider: web.deciderFrom(typesafe.provider, PRICE), pageGuard: true });
  await w.search("widgets delaware", { n: 4, task: TASK });
  await w.fetch(PUBLIC, { task: TASK });
  await w.fetch(PUBLIC, { task: TASK, lookingFor: "the registry entry" });
  const kinds = typesafe.asked.map(({ request }) => request.label);
  assert.deepEqual([...new Set(kinds)].sort(), ["web_fetch page guard", "web_fetch passages", "web_search sift"], "a sift, a judge and a page guard were asked");
  assert.deepEqual(typesafe.asked.map(({ request }) => request.model), kinds.map(() => "jev-1.14.0"), "a Jev request went out on the jev-latest alias, or naming no model, which is the alias");
  assert.equal(web.JEV_MODEL, "jev-1.14.0");

  const named = jevOn("TYPESAFE_API_KEY");
  await searchOn(named.provider, { ...PRICE, model: "jev-1.13.0" });
  assert.deepEqual(named.asked.map(({ request }) => request.model), ["jev-1.13.0"], "the caller's model wins");

  const routed = jevOn("OPENROUTER_API_KEY");
  await searchOn(routed.provider);
  assert.equal(Object.hasOwn(routed.asked[0].request, "model"), false, "OpenRouter's route names models its own way: its provider's default holds");

  const other = scoringProvider();
  await searchOn(other.provider);
  assert.equal(Object.hasOwn(other.asked[0].request, "model"), false, "another provider is sent none");
});
