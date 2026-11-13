// The tests' faux model priced as Claude Sonnet 5.5 is, from the price table the repo ships (pi-ai's anthropic data,
// "chat:claude-sonnet-5-5": $2 input, $10 output, $0.10 a cache read and $2.50 a cache write, a million tokens) with its
// output ceiling (128,000 tokens): a request's whole output allowance is priced as on the real model, $1.28, as pi asks
// for it.
export { default } from "./faux-model.mjs";
export const cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
export const maxTokens = 128_000;
