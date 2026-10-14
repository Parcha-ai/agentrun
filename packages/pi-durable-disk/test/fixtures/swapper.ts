import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * A command that flips `x` in `work` between a file and a link to the store, in a process group of its own. It ends by
 * itself once `parent` is gone, so a test process that is killed mid-test (no `finally` runs) does not leave it spinning.
 */
export function spawnSwapper(work: string, parent: number): ChildProcess {
  return spawn(
    "sh",
    ["-c", `cd ${work} && while kill -0 ${parent} 2>/dev/null; do rm -f x; ln -s ../store/run.sqlite x; rm -f x; : > x; done`],
    { stdio: "ignore", detached: true },
  );
}
