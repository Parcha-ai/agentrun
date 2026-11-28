// A template eval's `$pattern` tested in a worker thread (pattern-bound.ts): a regex that backtracks without end blocks
// this thread, never the eval's, and pattern-bound.ts terminates it at its limit. One test at a time: the reply, with
// the job's id, goes on the port the worker was handed, then the shared signal is set to that id and the caller waiting
// on it is woken. The id, not a bare "done", is what the caller waits for, so a wake-up meant for one job is never
// read as the next one's answer.
import { type MessagePort, parentPort, workerData } from "node:worker_threads";

export type PatternJob = { readonly id: number; readonly source: string; readonly text: string };
export type PatternReply = { readonly id: number } & ({ readonly matched: boolean } | { readonly failed: string });

const { signal, port } = workerData as { signal: SharedArrayBuffer; port: MessagePort };
const flag = new Int32Array(signal);

parentPort?.on("message", (job: PatternJob) => {
  let reply: PatternReply;
  try {
    reply = { id: job.id, matched: new RegExp(`^(?:${job.source})$`).test(job.text) };
  } catch (error) {
    reply = { id: job.id, failed: error instanceof Error ? error.name : "unknown" };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, job.id);
  Atomics.notify(flag, 0);
});
