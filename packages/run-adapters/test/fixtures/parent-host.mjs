// A host for parent-death.test.mjs: starts one child as a session machine does (detached, its own process group,
// watched by this process), with `workers` worker threads alive beside the main one, and reports on stdout:
//   {"child": <pid>}   when the child is running;
//   {"worker": "exited"} after one worker thread ends, if asked (`end-worker`).
// Then it waits to be killed. argv: <watch: pdeathsig|shim> <workers> <end-worker: yes|no> <child args (JSON)> [<hold fifo>]
// With a hold fifo, the watched command starts under a confinement-like prefix that waits on the fifo and then execs it
// in place, so a test can kill this host before the watch is set. With `fork` there, the prefix runs it without exec
// (a wrapper that stays as its parent). When the child exits, it reports {"exit": <code>, "stderr": <its stderr>}.
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { parentWatched } from "@parcha/agentrun-adapters/host";

const [how, workers, endWorker, childArgs, hold] = process.argv.slice(2);
const threads = Array.from({ length: Number(workers) }, () => new Worker("setInterval(() => {}, 1000);", { eval: true }));
const watched = parentWatched({ command: process.execPath, args: JSON.parse(childArgs) }, how);
const run =
  hold === "fork"
    ? { command: "/bin/sh", args: ["-c", '"$@"', "sh", watched.command, ...watched.args] }
    : hold
      ? { command: "/bin/sh", args: ["-c", 'read _ < "$0"; exec "$@"', hold, watched.command, ...watched.args] }
      : watched;
const child = spawn(run.command, run.args, { detached: true, stdio: ["pipe", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("exit", (code) => process.stdout.write(`${JSON.stringify({ exit: code, stderr })}\n`));
child.on("spawn", async () => {
  process.stdout.write(`${JSON.stringify({ child: child.pid })}\n`);
  if (endWorker === "yes" && threads.length) {
    await threads[0].terminate();
    process.stdout.write(`${JSON.stringify({ worker: "exited" })}\n`);
  }
});
setInterval(() => {}, 1000);
