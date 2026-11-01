// Setup's import of this machine's sessions, on a worker thread: node:sqlite's wait for a busy store and the parsing of
// every session line happen here, so neither holds up a request the server answers. `plan` counts what an import would
// take; `import` takes it. The message "stop" ends either between two files or two sessions; what is written stays, and
// the next import goes on from there. Its one message back is its answer.
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@parcha/pi-durable-agent";
import { planImport, runImport } from "./import.js";

export type ImportTask = { task: "plan" | "import"; data: string; home: string; temp?: string };
export type ImportAnswer = { projects: number; sessions: number } | { took: { agents: number; runs: number; skipped: number } } | { stopped: true };

const { task, data, home, temp } = workerData as ImportTask;
const stop = new AbortController();
parentPort!.on("message", (message) => void (message === "stop" && stop.abort()));
// The port does not keep the thread alive: the task does, and the thread ends with it.
parentPort!.unref();
const options = { home, ...(temp ? { temp } : {}), env: process.env, signal: stop.signal };
const answer = async (): Promise<ImportAnswer> => {
  if (task === "plan") {
    const plan = await planImport(options);
    return stop.signal.aborted ? { stopped: true } : { projects: plan.projects.length, sessions: plan.projects.reduce((n, p) => n + p.sessions.length, 0) };
  }
  // A connection of its own, which may wait for the store: only this thread waits.
  const store = openStore(data);
  try {
    const report = await runImport(store, await planImport(options, store), options);
    return stop.signal.aborted ? { stopped: true } : { took: { agents: report.agents.length, runs: report.agents.reduce((n, a) => n + a.runs + a.finished, 0), skipped: report.skipped.length } };
  } finally {
    store.close();
  }
};
parentPort!.postMessage(await answer());
