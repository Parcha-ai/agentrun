// The output-priced faux model ($100 a million output tokens, faux-output-priced.mjs). A run's process that comes up while
// the file LAUNCH_KILL names exists removes it and kills the server that started it, then goes on serving: a server gone
// between a launch and the message it launched for.
import { existsSync, rmSync } from "node:fs";

// Only a run's process: the server itself never loads the model with `--app` in its arguments.
if (process.argv.includes("--app") && process.env.LAUNCH_KILL && existsSync(process.env.LAUNCH_KILL)) {
  rmSync(process.env.LAUNCH_KILL, { force: true });
  // Its output pipes go with the server: a write to one must not end it.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
  process.kill(process.ppid, "SIGKILL");
}

export { default } from "./faux-model.mjs";
export { cost } from "./faux-output-priced.mjs";
