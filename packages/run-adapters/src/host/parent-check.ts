// The check in front of a child started with the kernel's parent-death signal (parent-death.ts). Written for AgentRun.
//   node parent-check.js <host pid> -- <command> [args...]
// setpriv sets the signal, then execs this: a signal set after the host is gone never fires, so this checks that its
// parent is still the host and replaces itself with the command in place (the same pid, so the signal still holds, and
// its environment passed on unchanged). Otherwise nothing runs, and it says why on stderr (exit 125).
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// PARENT_CHECK_FAILED in parent-death.ts, which this script does not import (it runs as its own process).
const FAILED = 125;

const [hostArg, separator, command, ...args] = process.argv.slice(2);
const host = Number(hostArg);
if (!Number.isSafeInteger(host) || host < 1 || separator !== "--" || !command) {
  process.stderr.write("usage: parent-check.js <host pid> -- <command> [args...]\n");
  process.exit(2);
}
if (process.ppid !== host) {
  process.stderr.write(`agentrun: parent check failed: started by ${process.ppid}, expected ${host} (the host died during startup, or the confine prefix does not exec in place)\n`);
  process.exit(FAILED);
}
const runnable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
// execve takes a path: a bare name is found on PATH, as a shell would.
const file = command.includes("/") ? command : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command)).find(runnable);
if (file === undefined || !runnable(file)) {
  process.stderr.write(`agentrun: parent check: ${command} is not an executable this process can run\n`);
  process.exit(127);
}
// Node 22.15 and later have process.execve. A Node without it fails here, loudly, and never falls back to a spawn
// that would leave the child outside the watch (parentWatchHere picks the shim on such a Node in the first place).
if (typeof process.execve !== "function") {
  process.stderr.write(`agentrun: parent check: this Node (${process.version}) has no process.execve; agentrun needs Node 22.15 or newer\n`);
  process.exit(FAILED);
}
process.execve(file, [command, ...args], process.env);
