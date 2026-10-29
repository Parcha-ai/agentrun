// A harness's own process (its CLI, its app-server) dies with the process that started it. Written for AgentRun.
//
// A session machine starts that process detached, in its own process group, so its group kill (abort, close) ends it
// and everything it started. A SIGKILLed host runs no close, and a detached child outlives it: reparented, it sleeps on
// (the pinned Claude Agent CLI does not exit when its stdin closes), one more per crash. So the child is started with a
// watch on its parent:
//  - Linux with util-linux setpriv: `setpriv --pdeathsig KILL --` in front of it. setpriv sets the parent-death signal
//    and execs the child in place (the same pid, still the host's direct child), so the kernel sends it SIGKILL the
//    moment the thread that spawned it exits. That is the thread whose event loop ran the spawn: the main one for a
//    machine used from the main thread, so a worker thread's exit does not trigger it, while a machine used from a
//    worker thread ties its child to that worker. The signal survives the exec, as the child is not set-user-ID. A signal set
//    after the parent is gone never fires, so a host that dies between the spawn and setpriv would leave the child
//    unwatched: after setting it, a /bin/sh in front of the child checks that its parent is still the host
//    (PARENT_CHECK) and runs nothing otherwise, then execs the child in place.
//  - elsewhere (macOS, or no setpriv): `node parent-watch.js <host pid> -- <child>`, a shim that runs the child and
//    kills it when the shim is reparented, checked four times a second.
// The watch goes INSIDE the host's confinement (the machine applies its confine prefix to the watched command): the
// kernel clears a parent-death signal when credentials change, so it is set after any switch of user the prefix makes.
// The child's environment is the machine's: the watch adds nothing to it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A command and its arguments. */
export interface LaunchCommand {
  command: string;
  args: string[];
}

/** How a child is tied to its parent: the kernel's parent-death signal, or the shim that watches. */
export type ParentWatch = "pdeathsig" | "shim";

/** The util-linux setpriv that sets the parent-death signal. */
export const SETPRIV = "/usr/bin/setpriv";

/** The check after the signal is set: the parent is still the host (its pid, `$1`), or nothing runs (exit 1). */
export const PARENT_CHECK = '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"';

/** The shim, run with this process's node where setpriv cannot be. */
export const PARENT_WATCH_SHIM = fileURLToPath(new URL("./parent-watch.js", import.meta.url));

let here: ParentWatch | undefined;
/** The watch this machine supports: pdeathsig on Linux with a setpriv that has `--pdeathsig`, else the shim. Read once. */
export function parentWatchHere(): ParentWatch {
  if (here) return here;
  let pdeathsig = false;
  if (process.platform === "linux" && existsSync(SETPRIV)) {
    try {
      pdeathsig = execFileSync(SETPRIV, ["--help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5_000 }).includes("--pdeathsig");
    } catch {}
  }
  return (here = pdeathsig ? "pdeathsig" : "shim");
}

/** `child`, started so that it dies with this process (`how`, default what this machine supports). */
export function parentWatched(child: Readonly<LaunchCommand>, how: ParentWatch = parentWatchHere()): LaunchCommand {
  if (how === "pdeathsig") {
    return { command: SETPRIV, args: ["--pdeathsig", "KILL", "--", "/bin/sh", "-c", PARENT_CHECK, "sh", String(process.pid), child.command, ...child.args] };
  }
  return { command: process.execPath, args: [PARENT_WATCH_SHIM, String(process.pid), "--", child.command, ...child.args] };
}
