// The tests' faux model priced on output only ($100 per million tokens), so a request's worst case is its max output
// tokens' price whatever its input.
export { default } from "./faux-model.mjs";
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
