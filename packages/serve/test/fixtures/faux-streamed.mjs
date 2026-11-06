// The tests' faux model, streaming its answers at a rate, so each delta reaches the server on its own (model.ts).
export { default } from "./faux-model.mjs";
export const tokensPerSecond = 400;
