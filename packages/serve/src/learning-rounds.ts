// An agent's open learning rounds: its runs whose round is going now, which may still merge a correction a run started
// now should start from (runner/learning-reseed.ts). Read as the run's view reads it: a run looking back after its job's
// end (store-view.ts lookingBackEnd, its learning reflecting), or a run running again after an earlier round ended (a
// follow-up turn, whose round follows it). A run queued, parked on a person, or still at its first job is none: a new run
// never waits on a person or on a job.
import { readLaunchBody } from "./run-launch.js";
import { runLearningEnd } from "./store-reads/learning.js";
import { lookingBackEnd } from "./store-view.js";
import type { RunRow, Store } from "./store/index.js";

/** The most runs still going that openRoundsOf reads of an agent. */
const OPEN_ROUNDS_READ = 50;

/** Whether run `row`'s learning round is going: running (never queued, parked or ended), and either looking back after its
 *  job's end or running again after an earlier round of it ended (a follow-up turn). */
export async function roundOpen(store: Pick<Store, "readJournal" | "commands" | "learning">, row: RunRow): Promise<boolean> {
  if (row.state !== "running") return false;
  if ((await lookingBackEnd(store as Store, row)) !== undefined) return true;
  return (await runLearningEnd(store, row.id)) !== null;
}

/** The agent's runs on the default disk whose learning round is going now (roundOpen) and that learn from a seed (a
 *  learning start that is no `use`): a run started now names them in its learning start (`after`), and its claim waits for
 *  them, bounded, then reads its seed again. Only a running run is read past its row. Newest first. */
export async function openRoundsOf(store: Pick<Store, "runs" | "readJournal" | "commands" | "learning">, agentId: string): Promise<string[]> {
  const going = await store.runs.list({ agentId, disk: null, scope: "active", limit: OPEN_ROUNDS_READ });
  const open: string[] = [];
  for (const run of going) {
    if (run.state !== "running") continue;
    const start = readLaunchBody((await store.runs.launch(run.id).catch(() => undefined))?.body)?.learning;
    if (!start || start.use || start.seed === null) continue;
    if (await roundOpen(store, run).catch(() => false)) open.push(run.id);
  }
  return open;
}
