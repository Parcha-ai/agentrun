// Shared by the kernel cap's tests: models priced as the catalog lists them (USD per million tokens), a cap on a clock the
// test moves, and the figures a test checks by hand.
import { createCap } from "../dist/kernel/cap/index.js";

/** Sonnet's list price: $3 in, $15 out, $0.30 a cache read, $3.75 a cache write, per million tokens. */
export const SONNET = Object.freeze({ id: "claude-sonnet-4-5", api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000, reasoning: true });
/** A model priced with no cache prices, on a Responses API. */
export const GPT = Object.freeze({ id: "gpt-5", api: "openai-responses", price: { input: 1.25, output: 10 }, outputCeiling: 128_000, reasoning: true });
/** A model the catalog lists at $0. */
export const FREE = Object.freeze({ id: "free-model", api: "openai-completions", price: { input: 0, output: 0 }, outputCeiling: 8_192 });
/** A model with no price. */
export const UNPRICED = Object.freeze({ id: "mystery", api: "openai-completions", price: null, outputCeiling: 8_192 });

export const T0 = Date.parse("2026-11-08T06:00:00Z");
/** Dollars for `tokens` at `perMillion`. */
export const usd = (tokens, perMillion) => (tokens * perMillion) / 1e6;

/** A cap of `capUsd` (a number, undefined for none, or a function the cap reads before each check) on a clock at T0. */
export function capOn(capUsd, { mode = "expected", spentUsd = 0, clock = { now: T0 } } = {}) {
  const read = typeof capUsd === "function" ? capUsd : () => capUsd;
  const cap = createCap({ capUsd: read, mode, spentUsd, now: () => clock.now });
  return { cap, clock };
}

let next = 0;
/** A model request of `inputTokens` on `model` asking `outputAsked`, with a fresh id unless one is given. */
export const modelRequest = (model, inputTokens, outputAsked = 4_096, extra = {}) => ({ kind: "model", id: extra.id ?? `req-${++next}`, model, inputTokens, outputAsked, ...extra });
/** A priced tool call held at `holdUsd`. */
export const toolRequest = (name, holdUsd, extra = {}) => ({ kind: "tool", id: extra.id ?? `call-${++next}`, name, holdUsd, basis: extra.basis ?? "its quote", ...extra });
