// Setup's import of this machine's sessions, on a worker thread: node:sqlite's wait for a busy store and the parsing of
// every session line happen here, so neither holds up a request the server answers. `plan` counts what an import would
// take; `import` takes it. The message "stop" ends either between two files or two sessions; what is written stays, and
// the next import goes on from there. Its one message back is its answer.
// Before anything loads node:sqlite, as in the server's own thread: its ExperimentalWarning is not the server's to print.
import "./quiet-sqlite-warning.js";
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@parcha/pi-durable-agent";
import { planImport, runImport } from "./import.js";

/** `secrets`: the server's own, and `stored`: the keys saved on its Tool keys page (tool-keys.ts' `values`), both cut
 *  out of everything the import writes; never put in an environment. */
export type ImportTask = { task: "plan" | "import"; data: string; home: string; temp?: string; secrets?: Record<string, string>; stored?: Record<string, string> };
/** `took`: what this start's import took (stopped too: what it took before it stopped), its agents by id, so the server
 *  adds it to what earlier starts took. */
export type ImportAnswer = { projects: number; sessions: number } | { took: { agents: string[]; runs: number; skipped: number }; stopped?: true } | { stopped: true };

const { task, data, home, temp, secrets = {}, stored = {} } = workerData as ImportTask;
const stop = new AbortController();
parentPort!.on("message", (message) => void (message === "stop" && stop.abort()));
// The port does not keep the thread alive: the task does, and the thread ends with it.
parentPort!.unref();
// The values to cut: this thread's environment (the server's, which holds none of its secrets) with the server's secrets as
// properties that do not enumerate, as secrets.ts's withSecrets gives them: read by name, left out of a spread or a spawn.
const env: NodeJS.ProcessEnv = { ...process.env };
for (const [name, value] of Object.entries(secrets)) Object.defineProperty(env, name, { value, enumerable: false });
const options = { home, ...(temp ? { temp } : {}), env, stored, signal: stop.signal };
const answer = async (): Promise<ImportAnswer> => {
  if (task === "plan") {
    const plan = await planImport(options);
    // Sessions as the import takes them: a session written in several files (a resumed thread) is one run.
    return stop.signal.aborted ? { stopped: true } : { projects: plan.projects.length, sessions: plan.projects.reduce((n, p) => n + new Set(p.sessions.map((s) => `${s.source}:${s.id}`)).size, 0) };
  }
  // A connection of its own, which may wait for the store: only this thread waits.
  const store = openStore(data);
  try {
    const report = await runImport(store, await planImport(options, store), options);
    const took = { agents: report.agents.filter((a) => a.runs + a.finished > 0).map((a) => a.id), runs: report.agents.reduce((n, a) => n + a.runs + a.finished, 0), skipped: report.skipped.length };
    return stop.signal.aborted ? { took, stopped: true } : { took };
  } finally {
    store.close();
  }
};
parentPort!.postMessage(await answer());
