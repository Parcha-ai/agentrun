// The tests' faux model priced on input only ($100 per million tokens), its output free: a request's worst case is its
// measured input's price, so a note's bytes alone can take a request past what is left of a cap.
export { default } from "./faux-model.mjs";
export const cost = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
