// faux-read-notes at a price, so each of its two model requests has a cost above zero.
export { default } from "./faux-read-notes.mjs";
export const cost = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
