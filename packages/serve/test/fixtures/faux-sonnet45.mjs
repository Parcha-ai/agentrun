// The tests' faux model priced as Claude Sonnet 4.5 is ($3 input, $15 output, $0.30 a cache read and $3.75 a cache write,
// a million tokens) with its output ceiling (64,000 tokens): a request's whole output allowance is priced as on the real
// model, $0.96, as pi asks for it.
export { default } from "./faux-model.mjs";
export const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
export const maxTokens = 64_000;
