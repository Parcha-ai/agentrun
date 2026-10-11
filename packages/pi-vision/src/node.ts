// The environment port over Node's file system and child processes, for a host whose `read` is its own: files are read
// and written where this process runs, programs are run by argv with no shell.
import type { VisionEnv } from "./core/env.js";
import { notBuilt } from "./core/not-built.js";

export function nodeVisionEnv(options: { cwd: string }): VisionEnv {
  return notBuilt("nodeVisionEnv");
}
