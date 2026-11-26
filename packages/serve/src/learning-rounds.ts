// An agent's open learning rounds: its runs whose round is going now and may still merge a correction a run started now
// should start from (runner/learning-reseed.ts). Only a run holding a person's words (a steer: a follow-up, a grade's
// words), which its round keeps as a line of corrections.md: an ordinary end-of-run round merges no correction, so a
// batch of runs on one agent never waits on each other. Its round read as the run's view reads it: a run looking back
// after its job's end (store-view.ts lookingBackEnd, its learning reflecting), or a run running again after an earlier
// round ended (a follow-up turn, whose round follows it). A run queued, parked on a person, or still at its first job is
// none: a new run never waits on a person or on a job.
import { readLaunchBody } from "./run-launch.js";
import { runLearningEnd } from "./store-reads/learning.js";
import { lookingBackEnd } from "./store-view.js";
import type { RunRow, Store } from "./store/index.js";

/** A page of an agent's running runs, as openRoundsOf reads them, and the most pages it reads. */
const OPEN_ROUNDS_PAGE = 50;
const OPEN_ROUNDS_PAGES = 10;

/** Whether run `row`'s learning round is going: running (never queued, parked or ended), and either looking back after its
 *  job's end or running again after an earlier round of it ended (a follow-up turn). */
export async function roundOpen(store: Pick<Store, "readJournal" | "commands" | "learning">, row: RunRow): Promise<boolean> {
  if (row.state !== "running") return false;
  if ((await lookingBackEnd(store as Store, row)) !== undefined) return true;
  return (await runLearningEnd(store, row.id)) !== null;
}

/** The agent's runs on the default disk that hold a steer, learn from a seed (a learning start that is no `use`) and
 *  whose learning round is going now (roundOpen): a run started now names them in its learning start (`after`), and its
 *  claim waits for them, bounded, then reads its seed again. Cheapest read first: only a running run's commands are
 *  read, and only one holding a steer is read past them. Only running runs are listed (Runs.list `state`), page by page
 *  (bounded: OPEN_ROUNDS_PAGES of OPEN_ROUNDS_PAGE), so newer queued or parked runs never hide an older running one. Newest
 *  first. */
export async function openRoundsOf(store: Pick<Store, "runs" | "readJournal" | "commands" | "learning">, agentId: string): Promise<string[]> {
  const going: RunRow[] = [];
  for (let page = 0; page < OPEN_ROUNDS_PAGES; page++) {
    const last = going.at(-1);
    const rows = await store.runs.list({ agentId, disk: null, state: "running", limit: OPEN_ROUNDS_PAGE, ...(last ? { before: { startedAt: last.startedAt, id: last.id } } : {}) });
    going.push(...rows);
    if (rows.length < OPEN_ROUNDS_PAGE) break;
  }
  const open: string[] = [];
  for (const run of going) {
    if (run.state !== "running") continue;
    if (!(await store.commands(run.id, 0).catch(() => [])).some((command) => command.kind === "steer")) continue;
    const start = readLaunchBody((await store.runs.launch(run.id).catch(() => undefined))?.body)?.learning;
    if (!start || start.use || start.seed === null) continue;
    if (await roundOpen(store, run).catch(() => false)) open.push(run.id);
  }
  return open;
}
