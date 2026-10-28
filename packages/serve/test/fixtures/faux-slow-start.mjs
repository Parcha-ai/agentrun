// The tests' faux model, loaded 3 s late: a run's process that is slow to come up, as on a loaded machine.
await new Promise((resolve) => setTimeout(resolve, 3_000));
export { default } from "./faux-model.mjs";
