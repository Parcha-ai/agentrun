// Whether a process runs. A zombie (it exited, and its parent has not reaped it) does not, though kill(pid, 0) still
// finds it: under a PID 1 that does not reap (a container started without an init), an orphan that exits stays one.
// On Linux, /proc/<pid>/stat says so (its state, after the command name's last ")"); elsewhere, and where that entry
// cannot be read, kill(pid, 0) is all there is.
import { existsSync, readFileSync } from "node:fs";

/** `readStat`: how /proc/<pid>/stat is read (a test's seam). */
export function processAlive(pid: number, readStat: (pid: number) => string = (id) => readFileSync(`/proc/${id}/stat`, "utf8")): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readStat(pid);
      const state = stat.charAt(stat.lastIndexOf(")") + 2);
      return state !== "Z" && state !== "X";
    } catch (error) {
      // Only a missing entry, with /proc mounted, proves it gone. One this process may not read (/proc mounted with
      // hidepid, another user's process) says nothing: the signal check below decides.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && existsSync("/proc/self/stat")) return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
