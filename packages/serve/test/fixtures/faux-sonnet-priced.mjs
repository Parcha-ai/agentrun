// The tests' faux model priced as Claude Sonnet 5.5 is ($2 input, $10 output, $0.20 a cache read and $2.50 a cache write,
// a million tokens), so a cap's expected and worst cases differ as they do on the real model.
export { default } from "./faux-model.mjs";
export const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
