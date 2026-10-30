// A host for parent-death.test.mjs: starts one child as a session machine does (detached, its own process group,
// watched by this process), with `workers` worker threads alive beside the main one, and reports on stdout:
//   {"child": <pid>}   when the child is running;
//   {"refused": <error name>} when the watch is refused (spawner "worker" only), and nothing is spawned;
//   {"worker": "exited"} after one worker thread ends, if asked (`end-worker`).
// With spawner "worker", a worker thread spawns the child (fixtures/parent-spawner.mjs), and `end-worker` ends that one.
// Then it waits to be killed.
// argv: <watch: pdeathsig|shim|default> <workers> <end-worker: yes|no> <child args (JSON)> [<spawner: main|worker>]
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { parentWatched } from "@parcha/agentrun-adapters/host";

const [how, workers, endWorker, childArgs, spawner = "main"] = process.argv.slice(2);
const watch = how === "default" ? undefined : how;
const report = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const threads = Array.from({ length: Number(workers) }, () => new Worker("setInterval(() => {}, 1000);", { eval: true }));
if (spawner === "worker") {
  const thread = new Worker(new URL("./parent-spawner.mjs", import.meta.url), { workerData: { how: watch, childArgs: JSON.parse(childArgs) } });
  thread.on("message", async (message) => {
    report(message);
    if (message.child && endWorker === "yes") {
      await thread.terminate();
      report({ worker: "exited" });
    }
  });
} else {
  const run = parentWatched({ command: process.execPath, args: JSON.parse(childArgs) }, watch);
  const child = spawn(run.command, run.args, { detached: true, stdio: ["pipe", "ignore", "inherit"] });
  child.on("spawn", async () => {
    report({ child: child.pid });
    if (endWorker === "yes" && threads.length) {
      await threads[0].terminate();
      report({ worker: "exited" });
    }
  });
}
setInterval(() => {}, 1000);
