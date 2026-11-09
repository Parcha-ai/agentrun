// A pi run through the adapter loop on a real catalog model with a price tier (gpt-6-sol, tiered past 272k input tokens),
// under the cap the runner's pi spec builds: CapModel.price is the catalog's cost WITH its tiers (adapter-run-spec.ts
// capModelOf), so a request past the threshold is held and booked at the tier's rates, as main's calculateCost prices it.
// A $1 cap parks such a run (its tier-priced input does not fit); at base rates the same input would fit, so the park is
// proof the tier's rates are held. These reuse B2c's capRun harness (adapter-pi-cap-support.mjs).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";

const { routeOf } = await import("../dist/runner/model-route.js");
const { capModelOf } = await import("../dist/runner/adapter-run-spec.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
after(closeOpenSessions);

const KEY = `not-a-secret-${"tier"}`;
const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => KEY };

/** A pi spec on `fetch` with `input` as the person's first message (its UTF-8 bytes bound the cap's input). */
const specWith = (fetch, input) => (_claim, run) => ({
  adapter: piAdapter({ run, model: MODEL, provider, fetch, price: () => 0 }),
  session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh" },
  input,
  hooks: quiet,
  gate: () => "allow",
});

// ~320,000 input tokens (one token a UTF-8 byte): past gpt-6-sol's 272k tier. At the tier's rates the worst case is about
// $1.6 (fresh input at the $5/M cache-write rate); at the base rates about $0.8. A $1 cap fits the base but not the tier.
const PAST_TIER = "a".repeat(320_000);

test("the cap's model is the route's catalog cost WITH tiers (a request past the tier is priced at the tier)", async () => {
  const route = await routeOf("openai/gpt-6-sol", { OPENAI_API_KEY: KEY });
  const model = capModelOf(route);
  assert.equal(model.id, "gpt-6-sol");
  assert.deepEqual(model.price, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }, "the catalog's cost, tiers included");
});

test("a run on a tiered model past its threshold parks at a $1 cap: the tier's rates are held, not the base's", async (t) => {
  const route = await routeOf("openai/gpt-6-sol", { OPENAI_API_KEY: KEY });
  const { row, sent } = await capRun(t, {
    specOf: (got) => specWith(scriptedOrigin([{ say: "done" }], got), PAST_TIER),
    beforeRequest: beforeRequestOf({ capUsd: () => 1, modelOf: () => capModelOf(route) }),
    cap: specCap(1),
  });
  assert.equal(row.state, "parked", "the tier-priced request does not fit $1: the run parks for a raise (at base rates it would fit)");
  assert.equal(sent.length, 0, "parked before the request left");
});

test("the same run goes at a $3 cap: the tier price fits, and the request is held at the tier, not the base", async (t) => {
  const route = await routeOf("openai/gpt-6-sol", { OPENAI_API_KEY: KEY });
  const { row, asked } = await capRun(t, {
    specOf: (got) => specWith(scriptedOrigin([{ say: "done" }], got), PAST_TIER),
    beforeRequest: beforeRequestOf({ capUsd: () => 3, modelOf: () => capModelOf(route) }),
    cap: specCap(3),
  });
  assert.notEqual(row.state, "parked", "the tier-priced request fits $3");
  const answer = asked[0]?.answer;
  assert.ok(answer && !("refuse" in answer), `the first request was admitted: ${JSON.stringify(answer)}`);
  // The base worst case for this input is about $0.8; held above $1 is the tier's rates, not the base's.
  assert.ok(answer.holdUsd > 1, `held at the tier, not the base: ${answer.holdUsd}`);
});
