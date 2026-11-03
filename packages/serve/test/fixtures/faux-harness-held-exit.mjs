// The faux harness (faux-harness.mjs's script) in a run's process that, once it has done everything it does before it
// exits (its drain, its release), cannot exit while the file EXIT_GATE names is missing (30 s at most): the server reads
// whatever that process wrote on its way out while the process still lives. faux-harness-slow-exit.mjs holds a process
// from its SIGTERM on, before its drain writes anything.
import { existsSync } from "node:fs";

// Only a run's process: the server never runs a turn.
if (process.argv.includes("--app")) {
  process.on("exit", () => {
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; process.env.EXIT_GATE && !existsSync(process.env.EXIT_GATE) && i < 1_500; i++) Atomics.wait(nap, 0, 0, 20);
  });
}

export { script } from "./faux-harness.mjs";
