// The tests' faux model, loaded by each run's process as it comes up, before the run serves. It notes that start as one
// line in the file LAUNCH_COUNT_ENV names, and while the file LAUNCH_KILL_ENV names exists it kills the server that
// started it and exits: a launch that takes its server down with it. With LAUNCH_JAM_ENV set, it puts a non-empty
// directory where the run's launch mark is, so the server's removal of the mark fails.
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const LAUNCH_COUNT_ENV = "AGENTRUN_SERVE_TEST_LAUNCHES";
export const LAUNCH_KILL_ENV = "AGENTRUN_SERVE_TEST_KILL_SERVER";
export const LAUNCH_JAM_ENV = "AGENTRUN_SERVE_TEST_JAM_MARK";

// Only a run's process: the server itself never loads the model with `--app` in its arguments.
if (process.argv.includes("--app")) {
  if (process.env[LAUNCH_COUNT_ENV]) appendFileSync(process.env[LAUNCH_COUNT_ENV], `${process.pid}\n`);
  if (process.env[LAUNCH_KILL_ENV] && existsSync(process.env[LAUNCH_KILL_ENV])) {
    process.kill(process.ppid, "SIGKILL");
    process.exit(1);
  }
  if (process.env[LAUNCH_JAM_ENV]) {
    const mark = join(process.argv[process.argv.indexOf("--dir") + 1], "launching");
    rmSync(mark, { force: true });
    mkdirSync(join(mark, "held"), { recursive: true });
  }
}

export { default } from "./faux-model.mjs";
