// The output-priced faux model ($100 a million output tokens, faux-output-priced.mjs) in a process that cannot exit until
// the file EXIT_GATE names exists: its SIGTERM holds it, so a test can act while a run's process is being let go. With
// EXIT_CODE set, it then exits with that code at once, before its run is released, as a process its drain's end cuts.
import { existsSync } from "node:fs";

process.on("SIGTERM", () => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; process.env.EXIT_GATE && !existsSync(process.env.EXIT_GATE) && i < 1_500; i++) Atomics.wait(nap, 0, 0, 20);
  if (process.env.EXIT_CODE) process.exit(Number(process.env.EXIT_CODE));
});

export { default } from "./faux-model.mjs";
export { cost } from "./faux-output-priced.mjs";
