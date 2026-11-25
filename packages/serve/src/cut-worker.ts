// The cut of a run file's text (cutFileText, the step a share's export takes too), in a worker thread: a text and a set
// of values whose cut runs long block this thread, never the server's, and cut-pool.ts terminates it at the read's
// deadline. One job at a time, each answered by its id: the cut text, or the name of what it threw (never its message,
// which may quote the text). The job's `max` is the text's byte length, which cutFileText measures itself.
import { parentPort } from "node:worker_threads";
import { cutFileText } from "./run-file-cut.js";

export type CutJob = {
  readonly id: number;
  readonly text: string;
  readonly values: readonly string[];
  readonly max: number;
  readonly held: readonly (readonly [number, number])[];
};
export type CutReply = { readonly id: number; readonly text: string } | { readonly id: number; readonly failed: string };

parentPort?.on("message", (job: CutJob) => {
  let reply: CutReply;
  try {
    reply = { id: job.id, text: cutFileText(job.text, job.values, job.held) };
  } catch (error) {
    reply = { id: job.id, failed: error instanceof Error ? error.name : "unknown" };
  }
  parentPort!.postMessage(reply);
});
