import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** How long a swapper may run at most, whatever else happens: longer than any test needs, short enough that nothing outlives it by much. */
export const SWAPPER_CAP_SECONDS = 120;

/** The swapper's shell loop: it runs while `parent` exists, flipping `x` in `work` between a file and a link to the store. */
export function swapperLoop(work: string, parent: number): string {
  return `cd ${work} && while kill -0 ${parent} 2>/dev/null; do rm -f x; ln -s ../store/run.sqlite x; rm -f x; : > x; done`;
}

/**
 * The swapper, a shell leading a process group of its own. It carries two ends: the loop stops once `parent` is gone (a test
 * process that is killed mid-test runs no finally), and a sleeper in the group kills the group after `capSeconds` whatever
 * `parent` does; the loop's end kills the group too, sleeper included. A sleeper rather than `$SECONDS` in the loop, which
 * `sh` is not guaranteed to have (dash has none), and rather than GNU `timeout`, which macOS does not have.
 */
export function spawnSwapper(work: string, parent: number, capSeconds = SWAPPER_CAP_SECONDS): ChildProcess {
  const group = "kill -s KILL -- -$$";
  return spawn("sh", ["-c", `(sleep ${capSeconds}; ${group}) & ${swapperLoop(work, parent)}; ${group}`], { stdio: "ignore", detached: true });
}
