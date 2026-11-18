// The tests' faux model priced on output only ($100 per million tokens), each answer reporting 400 output tokens and a
// million input tokens: past any bound a short request is held at, at no input price, so the run stays well in its cap.
export { default } from "./faux-model.mjs";
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const usage = () => ({ input: 1_000_000, output: 400, cacheRead: 0, cacheWrite: 0 });
