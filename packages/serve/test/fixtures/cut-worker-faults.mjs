// A cut worker that fails on cue, for cut-pool's tests: the text "hang" never answers, "exit" stops the worker, "throw"
// throws a TypeError whose message names the text and answers its name, "crash" throws one uncaught (the worker's
// "error" event), and any other text answers upper-cased.
import { parentPort } from "node:worker_threads";

parentPort.on("message", (job) => {
  if (job.text === "hang") for (;;);
  if (job.text === "exit") process.exit(3);
  if (job.text === "crash") throw new TypeError(`the text was ${job.text}`);
  if (job.text === "throw") {
    try {
      throw new TypeError(`the text was ${job.text}`);
    } catch (error) {
      parentPort.postMessage({ id: job.id, failed: error.name });
      return;
    }
  }
  parentPort.postMessage({ id: job.id, text: job.text.toUpperCase() });
});
