// The tests' faux model priced on output only ($100 per million tokens), each answer reporting 400 output tokens and no
// input: every request costs $0.04, and the cap admits one only while $0.1024 (its least, 1,024 tokens) fits.
export { default } from "./faux-model.mjs";
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const usage = () => ({ input: 0, output: 400, cacheRead: 0, cacheWrite: 0 });
