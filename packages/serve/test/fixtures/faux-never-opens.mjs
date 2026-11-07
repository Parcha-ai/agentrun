// The tests' faux model, for a run's process that never opens its run: loaded as the run's app comes up (after its door
// listens), it never finishes loading, so the door answers 503 OPENING for as long as the process lives.
if (process.argv.includes("--app")) await new Promise(() => {});
export { default } from "./faux-model.mjs";
