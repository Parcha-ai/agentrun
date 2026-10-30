// The worker thread of parent-host.mjs that starts the child itself, as a host spawning from a worker would. Posts
// {"child": <pid>} when the child is running, or {"refused": <error name>} when parentWatched throws; then stays alive
// until it is ended.
import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { parentWatched } from "@parcha/agentrun-adapters/host";

const { how, childArgs } = workerData;
let run;
try {
  run = parentWatched({ command: process.execPath, args: childArgs }, how);
} catch (error) {
  parentPort.postMessage({ refused: error.name });
}
if (run) {
  const child = spawn(run.command, run.args, { detached: true, stdio: ["pipe", "ignore", "inherit"] });
  child.on("spawn", () => parentPort.postMessage({ child: child.pid }));
}
setInterval(() => {}, 1000);
