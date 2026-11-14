// A request as the cap prices it (capRequestOf): the one place its model and the session's previous request are chosen, so
// its admission, the wrap-up's note and what the run keeps back to answer (requestFigures) price it alike. A request on a
// warm cache reads the previous request's input at the cache's price; with no previous request (step 0), or one measured
// another way, or another conversation's request (a side call, a host's, an unanswered one), its input is priced fresh.
// Admission is unchanged: a request whose least does not fit what is left is refused, warm or cold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeRequestOf, capRequestOf, noteFor, requestFigures } from "../dist/kernel/cap/index.js";
import { T0, usd } from "./kernel-cap-support.mjs";

/** A Responses model priced as gpt-6.1-sol is: $2 in, $10 out, $0.10 a cache read, $2.50 a cache write. */
const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });
/** Codex's request 25 of a growing conversation: its body's bytes (4 a token), 32,000 output tokens asked and 3,072 needed. */
const ASKED = Object.freeze({ model: SOL.id, inputTokensMax: 188_400, outputTokensAsked: 32_000, outputTokensLeast: 3_072 });
/** The request before it, answered a second ago: its 46,000-token prompt read from or written to the cache, 3 fresh. */
const PREVIOUS = Object.freeze({ model: SOL.id, cachedTokens: 46_000, inputTokens: 3, boundTokens: 184_000, endedAt: T0 - 1_000 });
const pricing = (previous = PREVIOUS) => ({ modelOf: (id) => (id === SOL.id ? SOL : undefined), previousOf: (model) => (model === previous?.model ? previous : undefined) });
/** The least answer warm: the previous prompt at the cache read's price, the 3 fresh tokens and the 4,400 grown bytes at
 *  the price of input not read from the cache (the cache write's, the higher), and 3,072 output tokens. Cold: every byte
 *  at that price, and the same output. */
const WARM_LEAST = usd(46_000, 0.1) + usd(3 + 4_400, 2.5) + usd(3_072, 10);
const COLD_LEAST = usd(188_400, 2.5) + usd(3_072, 10);
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

test("a request on a warm cache: its least reads the previous request's input at the cache's price, a tenth of it priced fresh", () => {
  const asked = capRequestOf("asked", ASKED, pricing());
  assert.deepEqual(asked.previous, PREVIOUS);
  close(requestFigures(asked, "expected", T0).leastUsd, WARM_LEAST, "warm least");
  assert.ok(WARM_LEAST < 0.05 && COLD_LEAST > 0.5, `${WARM_LEAST} warm, ${COLD_LEAST} cold`);
});

test("the note on a warm cache: $0.23 left of $0.50 is over twice its least and three typical steps, so it is not due; priced fresh it was", () => {
  const state = { capUsd: 0.5, spentUsd: 0.27, heldUsd: 0, costs: [0.01, 0.009, 0.0095], told: false, mode: "expected", now: T0 };
  assert.equal(noteFor(capRequestOf("asked", ASKED, pricing()), state), undefined);
  assert.ok(noteFor(capRequestOf("asked", ASKED, pricing(null)), state), "the same request with no previous one in hand is due by its least");
});

test("a CLI's request names its model as its provider does (openai/gpt-6.1-sol): priced as the cap's model, it reads the previous request filed under that model's id, at admission and for the note", async () => {
  const named = { ...ASKED, model: "openai/gpt-6.1-sol" };
  // One model per CLI session, whatever id its provider names it by; the previous request is filed under the priced id.
  const cli = { modelOf: () => SOL, previousOf: (model) => (model === SOL.id ? PREVIOUS : undefined) };
  const asked = capRequestOf("asked", named, cli);
  assert.deepEqual([asked.model.id, asked.previous], [SOL.id, PREVIOUS]);
  close(requestFigures(asked, "expected", T0).leastUsd, WARM_LEAST, "warm least");
  const judge = (capUsd) => beforeRequestOf({ capUsd: () => capUsd, now: () => T0, ...cli })({ ...named, key: "s", label: "s", turn: 2, maxTurns: null, spentUsd: 0, inFlight: [] });
  assert.ok("holdUsd" in (await judge(WARM_LEAST + 0.001)), "admitted at its warm least");
});

test("the cold case is unchanged: no previous request, one measured another way, or another conversation's request is priced fresh", () => {
  close(requestFigures(capRequestOf("asked", ASKED, pricing(null)), "expected", T0).leastUsd, COLD_LEAST, "no previous");
  close(requestFigures(capRequestOf("asked", ASKED, pricing({ ...PREVIOUS, counted: true })), "expected", T0).leastUsd, COLD_LEAST, "previous counted, this one bytes");
  for (const other of [{ side: true }, { host: "node" }, { unanswered: true }]) {
    const asked = capRequestOf("asked", { ...ASKED, ...other }, pricing());
    assert.equal(asked.previous, undefined, JSON.stringify(other));
  }
  assert.equal(capRequestOf("asked", { ...ASKED, model: "elsewhere" }, pricing()).model.price, null, "a model with no price here is unpriced");
});

test("the hard cap at admission is unchanged: a request whose least does not fit what is left is refused, warm or cold; one that fits is admitted", async () => {
  const judge = (capUsd, previous) => beforeRequestOf({ capUsd: () => capUsd, now: () => T0, ...pricing(previous) })({ ...ASKED, key: "s", label: "s", turn: 2, maxTurns: null, spentUsd: 0, inFlight: [] });
  assert.ok("refuse" in (await judge(WARM_LEAST - 0.001)), "warm, a tenth of a cent short: refused");
  assert.ok("holdUsd" in (await judge(WARM_LEAST + 0.001)), "warm, a tenth of a cent over: admitted");
  assert.ok("refuse" in (await judge(COLD_LEAST - 0.001, null)), "cold, a tenth of a cent short: refused");
  assert.ok("holdUsd" in (await judge(COLD_LEAST + 0.001, null)), "cold, a tenth of a cent over: admitted");
});
