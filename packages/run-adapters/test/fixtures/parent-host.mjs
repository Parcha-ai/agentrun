// A host for parent-death.test.mjs: starts one child as a session machine does (detached, its own process group,
// watched by this process), with `workers` worker threads alive beside the main one, and reports on stdout:
//   {"child": <pid>}   when the child is running;
//   {"worker": "exited"} after one worker thread ends, if asked (`end-worker`).
// Then it waits to be killed. argv: <watch: pdeathsig|shim> <workers> <end-worker: yes|no> <child args (JSON)>
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { parentWatched } from "@parcha/agentrun-adapters/host";

const [how, workers, endWorker, childArgs] = process.argv.slice(2);
const threads = Array.from({ length: Number(workers) }, () => new Worker("setInterval(() => {}, 1000);", { eval: true }));
const run = parentWatched({ command: process.execPath, args: JSON.parse(childArgs) }, how);
const child = spawn(run.command, run.args, { detached: true, stdio: ["pipe", "ignore", "inherit"] });
child.on("spawn", async () => {
  process.stdout.write(`${JSON.stringify({ child: child.pid })}\n`);
  if (endWorker === "yes" && threads.length) {
    await threads[0].terminate();
    process.stdout.write(`${JSON.stringify({ worker: "exited" })}\n`);
  }
});
setInterval(() => {}, 1000);
