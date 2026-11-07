// The tests' faux model priced on both sides, input $10 and output $100 per million tokens: a first request's least is
// its input bound's price plus 1,024 output tokens' ($0.1024), so a change in the input moves the figure.
export { default } from "./faux-model.mjs";
export const cost = { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 };
