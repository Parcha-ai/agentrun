// An agent's open learning rounds: its runs whose round is going now and may still merge a correction a run started now
// should start from (runner/learning-reseed.ts). Only a run holding a person's words (a steer: a follow-up, a grade's
// words), which its round keeps as a line of corrections.md: an ordinary end-of-run round merges no correction, so a
// batch of runs on one agent never waits on each other. Its round is going only while its end-of-run learning step runs:
// the run looks back after its job's end (feedback-round.ts keptEndOf: its job's end kept, or a grade's round not taken
// yet), the job a fresh run's, a follow-up's turn or a grade's round. A person's next message that waits untaken meanwhile
// keeps it going: the run reads as going on again (store-view.ts lookingBackOf), but its look-back still runs to its end
// and merges the correction (runner/adapter-loop.ts leaves the message for the turn after). A follow-up's turn itself is none: a run started while the person's turn runs
// starts from the learning as it is then, and only a run started once that turn's job ended waits on its round. A run
// queued, parked on a person, or still at its job is none: a new run never waits on a person or on a job.
import { readLaunchBody } from "./run-launch.js";
import { journalEntries } from "./runner/journal-reader.js";
import { keptEndOf } from "./runner/feedback-round.js";
import type { Command, RunRow, Store } from "./store/index.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** A page of an agent's running runs, as openRoundsOf reads them, and the most pages it reads. */
const OPEN_ROUNDS_PAGE = 50;
const OPEN_ROUNDS_PAGES = 10;

/** Whether run `row`'s learning round is going: running (never queued, parked or ended) and looking back after its job's
 *  end (its end-of-run learning step: keptEndOf), whatever person's message waits untaken meanwhile, never while a
 *  follow-up's turn runs. Its root entries only (no tasks, no submissions); its command rows `commands` when the caller
 *  read them already, else read here. */
export async function roundOpen(store: Pick<Store, "readJournal" | "commands">, row: RunRow, commands?: readonly Command[]): Promise<boolean> {
  if (row.state !== "running") return false;
  const entries = await journalEntries(store.readJournal(row.id), BACKGROUND_CONTEXT);
  return keptEndOf(entries, commands ?? (await store.commands(row.id, 0))) !== undefined;
}

/** The agent's runs on the default disk that hold a steer, learn from a seed (a learning start that is no `use`) and
 *  whose learning round is going now (roundOpen): a run started now names them in its learning start (`after`), and its
 *  claim waits for them, bounded, then reads its seed again. Cheapest read first: a page's commands in one read
 *  (Store.commandsOf), never one read a run; only a run holding a steer has its launch read, and only one that learns
 *  from a seed has its journal read. Only running runs are listed (Runs.list `state`), page by page (bounded:
 *  OPEN_ROUNDS_PAGES of OPEN_ROUNDS_PAGE), so newer queued or parked runs never hide an older running one. Newest first. */
export async function openRoundsOf(store: Pick<Store, "runs" | "readJournal" | "commands" | "commandsOf">, agentId: string): Promise<string[]> {
  const open: string[] = [];
  let last: RunRow | undefined;
  for (let page = 0; page < OPEN_ROUNDS_PAGES; page++) {
    const rows = await store.runs.list({ agentId, disk: null, state: "running", limit: OPEN_ROUNDS_PAGE, ...(last ? { before: { startedAt: last.startedAt, id: last.id } } : {}) });
    last = rows.at(-1);
    const running = rows.filter((run) => run.state === "running");
    const commands = running.length ? await store.commandsOf(running.map((run) => ({ runId: run.id, after: 0 }))).catch(() => new Map<string, Command[]>()) : new Map<string, Command[]>();
    for (const run of running) {
      const held = commands.get(run.id) ?? [];
      if (!held.some((command) => command.kind === "steer")) continue;
      const start = readLaunchBody((await store.runs.launch(run.id).catch(() => undefined))?.body)?.learning;
      if (!start || start.use || start.seed === null) continue;
      if (await roundOpen(store, run, held).catch(() => false)) open.push(run.id);
    }
    if (rows.length < OPEN_ROUNDS_PAGE) break;
  }
  return open;
}
