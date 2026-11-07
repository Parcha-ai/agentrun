// The tests' faux model priced on output only, and cheaply ($0.001 per million tokens), each answer reporting 400 output
// tokens and no input: every request costs $0.0000004, and the cap admits one while $0.000001024 (its least, 1,024
// tokens) fits. A decision on Jev then costs more than a model node's request: a cap can admit the node and refuse its
// verify decision.
export { default } from "./faux-model.mjs";
export const cost = { input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0 };
export const usage = () => ({ input: 0, output: 400, cacheRead: 0, cacheWrite: 0 });
