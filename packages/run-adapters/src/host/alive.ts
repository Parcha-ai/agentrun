// Whether a process runs. A zombie (it exited, and its parent has not reaped it) does not, though kill(pid, 0) still
// finds it: under a PID 1 that does not reap (a container started without an init), an orphan that exits stays one.
// On Linux, /proc/<pid>/stat says so (its state, after the command name's last ")"); elsewhere kill(pid, 0) is all
// there is.
import { existsSync, readFileSync } from "node:fs";

export function processAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.charAt(stat.lastIndexOf(")") + 2);
      return state !== "Z" && state !== "X";
    } catch {
      // No entry with /proc mounted: the process is gone.
      if (existsSync("/proc/self/stat")) return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
