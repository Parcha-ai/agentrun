// The parent watch where the kernel's parent-death signal is not available (parent-death.ts). Written for AgentRun.
//   node parent-watch.js <parent pid> -- <command> [args...]
// Runs the command with this process's stdio and environment, in this process's group (so a group kill ends both),
// passes TERM, INT and HUP on to it, exits as it exits, and kills it when this process is reparented: its parent, the
// host, is gone.
import { spawn } from "node:child_process";

const [parentArg, separator, command, ...args] = process.argv.slice(2);
const parent = Number(parentArg);
if (!Number.isSafeInteger(parent) || parent < 1 || separator !== "--" || !command) {
  process.stderr.write("usage: parent-watch.js <parent pid> -- <command> [args...]\n");
  process.exit(2);
}
// Started after the host was already gone: nothing to run for.
if (process.ppid !== parent) process.exit(1);

const child = spawn(command, args, { stdio: "inherit" });
const passed = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
for (const signal of passed) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  process.stderr.write(`parent-watch: ${error.message}\n`);
  process.exit(127);
});
const watch = setInterval(() => {
  if (process.ppid === parent) return;
  child.kill("SIGKILL");
  process.exit(1);
}, 250);
child.on("exit", (code, signal) => {
  clearInterval(watch);
  if (code !== null) process.exit(code);
  // Ended by a signal: end the same way, so the host sees what the child saw.
  for (const s of passed) process.removeAllListeners(s);
  process.kill(process.pid, signal ?? "SIGKILL");
});
