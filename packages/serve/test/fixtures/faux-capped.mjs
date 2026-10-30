// The tests' faux model at a real model's kind of price ($1 a million tokens in and out), for a run under a cap: a cap
// refuses a model with no price, and this one's ceiling stays far under a $1 cap.
export { default } from "./faux-model.mjs";
export const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
