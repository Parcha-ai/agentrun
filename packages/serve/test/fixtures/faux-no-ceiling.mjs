// The tests' faux model priced on output ($100 per million tokens) with no output ceiling (an unbounded maxTokens):
// nothing bounds what a request may cost, so a run's cap refuses every request for good (cap.ts noCeiling) and the run
// fails, never pauses.
export { default } from "./faux-model.mjs";
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const maxTokens = Number.POSITIVE_INFINITY;
