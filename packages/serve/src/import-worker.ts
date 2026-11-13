// Setup's import of this machine's sessions, on a worker thread: node:sqlite's wait for a busy store and the parsing of
// every session line happen here, so neither holds up a request the server answers. `plan` counts what an import would
// take; `import` takes it. The message "stop" ends either between two files or two sessions; what is written stays, and
// the next import goes on from there. Its one message back is its answer.
// Before anything loads node:sqlite, as in the server's own thread: its ExperimentalWarning is not the server's to print.
import "./quiet-sqlite-warning.js";
import { parentPort, workerData } from "node:worker_threads";
import { ownSecrets, planImport, runImport } from "./import.js";
import { importStoreProxy } from "./import-proxy.js";
import { toolKeysOverStore } from "./tool-keys-store.js";

/** `secrets`: the server's own, cut out of everything the import writes and never put in an environment; the seal key
 *  among them, so the worker opens the saved tool keys the import cuts too (read over the port from the server's store). */
export type ImportTask = { task: "plan" | "import"; data: string; home: string; temp?: string; secrets?: Record<string, string> };
/** `took`: what this start's import took (stopped too: what it took before it stopped), its agents by id, so the server
 *  adds it to what earlier starts took. */
export type ImportAnswer = { projects: number; sessions: number } | { took: { agents: string[]; runs: number; skipped: number }; stopped?: true } | { stopped: true };

const { task, data, home, temp, secrets = {} } = workerData as ImportTask;
const stop = new AbortController();
parentPort!.on("message", (message) => void (message === "stop" && stop.abort()));
// The port does not keep the thread alive on its own: the task does (the proxy references it only while it waits for the
// server), and the thread ends with the task.
parentPort!.unref();
// The values to cut: this thread's environment (the server's, which holds none of its secrets) with the server's secrets as
// properties that do not enumerate, as secrets.ts's withSecrets gives them: read by name, left out of a spread or a spawn.
const env: NodeJS.ProcessEnv = { ...process.env };
for (const [name, value] of Object.entries(secrets)) Object.defineProperty(env, name, { value, enumerable: false });
const options = { home, ...(temp ? { temp } : {}), env, signal: stop.signal };
const answer = async (): Promise<ImportAnswer> => {
  if (task === "plan") {
    // A count keeps no transcript: no key scan (a whole history read through secretlint at every start).
    const plan = await planImport({ ...options, keys: false });
    // Sessions as the import takes them: a session written in several files (a resumed thread) is one run.
    return stop.signal.aborted ? { stopped: true } : { projects: plan.projects.length, sessions: plan.projects.reduce((n, p) => n + new Set(p.sessions.map((s) => `${s.source}:${s.id}`)).size, 0) };
  }
  // No store of its own: the worker reaches the server's one open store over the port. The server holds the exclusive owner
  // lock, so a second opener here would be refused; every read and write the import needs crosses the port instead.
  const store = importStoreProxy(parentPort!);
  // The keys saved on the Tool keys page, read from the store (sealed rows) and opened with the seal key the worker holds:
  // cut out of everything the import writes, as the CLI's import cuts them.
  const keys = toolKeysOverStore(store, env, () => {});
  await keys.load();
  // The secrets this server made and keeps, read from the store as the import starts: cut by their values too.
  const taking = { ...options, stored: keys.values(), own: await ownSecrets(store, data, env) };
  const report = await runImport(store, await planImport(taking, store), taking);
  const took = { agents: report.agents.filter((a) => a.runs > 0).map((a) => a.id), runs: report.agents.reduce((n, a) => n + a.runs, 0), skipped: report.skipped.length };
  return stop.signal.aborted ? { took, stopped: true } : { took };
};
parentPort!.postMessage(await answer());
