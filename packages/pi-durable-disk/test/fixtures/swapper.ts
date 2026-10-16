import { execFileSync, spawn } from "node:child_process";
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

/**
 * Stops the swapper whose group `leader` leads, and returns once nothing in the group runs: SIGTERM to the group, SIGKILL
 * once `graceMs` has passed. A signal sent is not a swapper stopped: a member finishes the write it is in, and on macOS a
 * child forked as the signal lands can miss it and run its `ln` or `rm` after, so a layout removed right after the signal
 * can find a file made after the walk (ENOTEMPTY). Returns whether the group ended within `graceMs + killMs`.
 */
export async function stopSwapper(leader: number, graceMs = 2_000, killMs = 5_000): Promise<boolean> {
  const gone = () => !groupRuns(leader);
  const waitGone = async (ms: number) => {
    for (const deadline = Date.now() + ms; !gone() && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
    return gone();
  };
  for (const [signal, ms] of [["SIGTERM", graceMs], ["SIGKILL", killMs]] as const) {
    try {
      process.kill(-leader, signal);
    } catch {}
    if (await waitGone(ms)) return true;
  }
  return false;
}

/**
 * Whether a process other than a zombie is in the group `leader` leads. A swapper's children, orphaned when its shell dies,
 * stay zombies until their new parent reaps them, and a zombie writes nothing; but kill(0) still answers for a group that
 * holds one: Linux with success, macOS with EPERM (it skips the exited member and finds nothing it may signal). Only ESRCH
 * says the group is gone; any other answer is settled by the process table.
 */
export function groupRuns(leader: number): boolean {
  try {
    process.kill(-leader, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return true;
  }
  return listing.split("\n").some((line) => {
    const [pgid, stat] = line.trim().split(/\s+/);
    return Number(pgid) === leader && stat !== undefined && !stat.startsWith("Z");
  });
}
