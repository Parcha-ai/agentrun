// A request as the cap prices it (capRequestOf): the one place its model is chosen, so its admission, the wrap-up's note
// and what the run keeps back to answer (requestFigures) price it alike: its whole input bound uncached (at the dearer of
// the input and cache-write prices), whatever the session read from the cache before, a side call's and a host's alike.
// A request whose least does not fit what is left is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeRequestOf, capRequestOf, noteFor, requestFigures } from "../dist/kernel/cap/index.js";
import { usd } from "./kernel-cap-support.mjs";

/** A Responses model priced as gpt-6.1-sol is: $2 in, $10 out, $0.10 a cache read, $2.50 a cache write. */
const SOL = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });
/** Codex's request 25 of a growing conversation: its body's bytes (4 a token), 32,000 output tokens asked and 3,072 needed. */
const ASKED = Object.freeze({ model: SOL.id, inputTokensMax: 188_400, outputTokensAsked: 32_000, outputTokensLeast: 3_072 });
const pricing = { modelOf: (id) => (id === SOL.id ? SOL : undefined) };
/** The least answer: every byte at the price of input not read from the cache (the cache write's, the higher), and 3,072
 *  output tokens. */
const LEAST = usd(188_400, 2.5) + usd(3_072, 10);
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

test("a request's least is its whole input uncached and its least output; nothing of a session's cache is read", () => {
  const asked = capRequestOf("asked", ASKED, pricing);
  assert.equal("recent" in asked, false);
  close(requestFigures(asked).leastUsd, LEAST, "least");
});

test("the note: $0.23 left of $0.50 is under twice the request's least, so it is due", () => {
  const state = { capUsd: 0.5, spentUsd: 0.27, heldUsd: 0, costs: [0.01, 0.009, 0.0095], told: false };
  assert.ok(noteFor(capRequestOf("asked", ASKED, pricing), state), "due by its least");
});

test("a CLI's request names its model as its provider does (openai/gpt-6.1-sol): priced as the cap's model, at admission and for the note", async () => {
  const named = { ...ASKED, model: "openai/gpt-6.1-sol" };
  // One model per CLI session, whatever id its provider names it by.
  const cli = { modelOf: () => SOL };
  const asked = capRequestOf("asked", named, cli);
  assert.equal(asked.model.id, SOL.id);
  close(requestFigures(asked).leastUsd, LEAST, "least");
  const judge = (capUsd) => beforeRequestOf({ capUsd: () => capUsd, ...cli })({ ...named, key: "s", label: "s", turn: 2, maxTurns: null, spentUsd: 0, inFlight: [] });
  assert.ok("holdUsd" in (await judge(LEAST + 0.001)), "admitted at its least");
  assert.ok("refuse" in (await judge(LEAST - 0.001)), "refused a tenth of a cent under it");
});

test("a side call, a host's request and an unanswered one are priced the same as the session's own", () => {
  for (const other of [{ side: true }, { host: "node" }, { unanswered: true }]) {
    close(requestFigures(capRequestOf("asked", { ...ASKED, ...other }, pricing)).leastUsd, LEAST, JSON.stringify(other));
  }
  assert.equal(capRequestOf("asked", { ...ASKED, model: "elsewhere" }, pricing).model.price, null, "a model with no price here is unpriced");
});

test("the hard cap at admission: a request whose least does not fit what is left is refused; one that fits is admitted", async () => {
  const judge = (capUsd) => beforeRequestOf({ capUsd: () => capUsd, ...pricing })({ ...ASKED, key: "s", label: "s", turn: 2, maxTurns: null, spentUsd: 0, inFlight: [] });
  assert.ok("refuse" in (await judge(LEAST - 0.001)), "a tenth of a cent short: refused");
  assert.ok("holdUsd" in (await judge(LEAST + 0.001)), "a tenth of a cent over: admitted");
});
