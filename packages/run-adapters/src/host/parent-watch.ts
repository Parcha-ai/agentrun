// The parent watch where the kernel's parent-death signal is not available (parent-death.ts). Written for AgentRun.
//   node parent-watch.js <parent pid> [--term-grace <ms>] -- <command> [args...]
// Runs the command with this process's stdio and environment, in this process's group (so a group kill ends both),
// passes TERM, INT and HUP on to it, exits as it exits, and kills it when this process is reparented: its parent, the
// host, is gone. With `--term-grace <ms>` it also kills the command (SIGKILL) when it outlasts a TERM passed on by
// that long.
import { spawn } from "node:child_process";
import { termGraceOf } from "./parent-death.js";

// `--term-grace`: a host that ends this child with TERM, and SIGKILL after a wait of its own sent to this process
// alone (startClaudeLogin's 5 s), asks for a grace shorter than that wait, since its SIGKILL would leave a child still
// running with no watch while the host lives. A host whose SIGKILL reaches the child too (a session machine's group
// kill) asks for none, and the child keeps all the time that host gives it. INT and HUP pass on with no kill after
// them: a session's CLI may take INT as "stop this turn" and go on.
const [parentArg, ...rest] = process.argv.slice(2);
const parent = Number(parentArg);
const graceAsked = rest[0] === "--term-grace";
const graceArg = graceAsked ? rest[1] : undefined;
// A positive whole number of milliseconds a timer can wait (longer ones fire at once), by the rule parentWatched reads
// a caller's grace by.
const termGraceMs = graceArg === undefined ? undefined : termGraceOf(graceArg);
const [separator, command, ...args] = graceAsked ? rest.slice(2) : rest;
if (!Number.isSafeInteger(parent) || parent < 1 || (graceAsked && termGraceMs === undefined) || separator !== "--" || !command) {
  process.stderr.write("usage: parent-watch.js <parent pid> [--term-grace <ms>] -- <command> [args...]\n");
  process.exit(2);
}
// Started after the host was already gone: nothing to run for.
if (process.ppid !== parent) process.exit(1);

const child = spawn(command, args, { stdio: "inherit" });
const passed = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
let grace: ReturnType<typeof setTimeout> | undefined;
for (const signal of passed) {
  process.on(signal, () => {
    child.kill(signal);
    if (signal === "SIGTERM" && termGraceMs !== undefined) grace ??= setTimeout(() => child.kill("SIGKILL"), termGraceMs);
  });
}
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
  clearTimeout(grace);
  if (code !== null) process.exit(code);
  // Ended by a signal: end the same way, so the host sees what the child saw.
  for (const s of passed) process.removeAllListeners(s);
  process.kill(process.pid, signal ?? "SIGKILL");
});
