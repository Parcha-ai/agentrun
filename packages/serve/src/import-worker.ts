// Setup's import of this machine's sessions, on a worker thread: node:sqlite's wait for a busy store and the parsing of
// every session line happen here, so neither holds up a request the server answers. `plan` counts what an import would
// take; `import` takes it, in two passes: every run's row first (the index pass), so the lists fill at once, then the
// transcripts. The message "stop" ends either between two files or two sessions; what is written stays, and the next
// import goes on from there. An import posts how far it has got as it goes (ImportNote); its last message is its answer.
// Before anything loads node:sqlite, as in the server's own thread: its ExperimentalWarning is not the server's to print.
import "./quiet-sqlite-warning.js";
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@parcha/pi-durable-agent";
import { type ImportProgress, type Plan, planImport, runImport } from "./import.js";

/** `secrets`: the server's own, and `stored`: the keys saved on its Tool keys page (tool-keys.ts' `values`), both cut
 *  out of everything the import writes; never put in an environment. */
export type ImportTask = { task: "plan" | "import"; data: string; home: string; temp?: string; secrets?: Record<string, string>; stored?: Record<string, string> };
/** `took`: what this start's import took (stopped too: what it took before it stopped), its agents by id, so the server
 *  adds it to what earlier starts took. */
export type ImportAnswer = { projects: number; sessions: number } | { took: { agents: string[]; runs: number; skipped: number }; stopped?: true } | { stopped: true };
/** What an import posts as it goes, before its answer: the pass it is in, the sessions it takes (`total`), and how far it
 *  has got (import.ts' ImportProgress). */
export type ImportNote = { progress: { phase: "index" | "transcripts"; total: number } & ImportProgress };

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
/** The agents an import's pass put a run into. */
const tookAgents = (agents: { id: string; runs: number; finished: number }[]) => agents.filter((a) => a.runs + a.finished > 0).map((a) => a.id);
/** Projects by their latest session, the newest first; a tie keeps the plan's order. */
const newestFirst = (projects: Plan["projects"]) => {
  const latest = (p: Plan["projects"][number]) => p.sessions.reduce((max, s) => ((s.startedAt ?? "") > max ? (s.startedAt ?? "") : max), "");
  return projects.map((p) => [latest(p), p] as const).sort((a, b) => b[0].localeCompare(a[0])).map(([, p]) => p);
};
const answer = async (): Promise<ImportAnswer> => {
  if (task === "plan") {
    const plan = await planImport(options);
    // Sessions as the import takes them: a session written in several files (a resumed thread) is one run.
    return stop.signal.aborted ? { stopped: true } : { projects: plan.projects.length, sessions: plan.projects.reduce((n, p) => n + new Set(p.sessions.map((s) => `${s.source}:${s.id}`)).size, 0) };
  }
  // A connection of its own, which may wait for the store: only this thread waits.
  const store = openStore(data);
  try {
    const plan = await planImport(options, store);
    // The newest projects first: what a person looks for first is in first. A project's own sessions keep their order,
    // which what a later file counts once depends on.
    plan.projects = newestFirst(plan.projects);
    const total = plan.projects.reduce((n, p) => n + new Set(p.sessions.map((s) => `${s.source}:${s.id}`)).size, 0);
    // The transcripts pass counts against what the index pass holds, its rows and agents in already: a session it left
    // out (a file of copies alone, a broken one) has no transcript to come.
    let indexed: ImportProgress = { rows: 0, transcripts: 0, agents: 0 };
    const note = (phase: ImportNote["progress"]["phase"]) => (done: ImportProgress) => {
      if (phase === "index") indexed = done;
      const rows = Math.max(indexed.rows, done.rows);
      const progress = phase === "index" ? { phase, total, ...done } : { phase, total: rows, rows, transcripts: done.transcripts, agents: Math.max(indexed.agents, done.agents) };
      parentPort!.postMessage({ progress } satisfies ImportNote);
    };
    note("index")({ rows: 0, transcripts: 0, agents: 0 });
    const index = await runImport(store, plan, { ...options, index: true, onProgress: note("index") });
    // Stopped in the index pass: rows with no transcript, which the next start's transcripts pass finishes. It took no
    // run whole yet.
    if (stop.signal.aborted) return { took: { agents: tookAgents(index.agents), runs: 0, skipped: 0 }, stopped: true };
    const report = await runImport(store, plan, { ...options, onProgress: note("transcripts") });
    const took = { agents: [...new Set([...tookAgents(index.agents), ...tookAgents(report.agents)])], runs: report.agents.reduce((n, a) => n + a.runs + a.finished, 0), skipped: report.skipped.length };
    return stop.signal.aborted ? { took, stopped: true } : { took };
  } finally {
    store.close();
  }
};
parentPort!.postMessage(await answer());
