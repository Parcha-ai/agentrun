// A template eval's `$pattern` tested in a worker thread (pattern-bound.ts): a regex that backtracks without end blocks
// this thread, never the eval's, and pattern-bound.ts terminates it at its limit. One test at a time: the reply goes on
// the port the worker was handed, then the shared signal turns to 1 and wakes the caller waiting on it.
import { type MessagePort, parentPort, workerData } from "node:worker_threads";

export type PatternJob = { readonly source: string; readonly text: string };
export type PatternReply = { readonly matched: boolean } | { readonly failed: string };

const { signal, port } = workerData as { signal: SharedArrayBuffer; port: MessagePort };
const flag = new Int32Array(signal);

parentPort?.on("message", (job: PatternJob) => {
  let reply: PatternReply;
  try {
    reply = { matched: new RegExp(`^(?:${job.source})$`).test(job.text) };
  } catch (error) {
    reply = { failed: error instanceof Error ? error.name : "unknown" };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
