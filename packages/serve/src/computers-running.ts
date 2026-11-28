// GET /v2/computers/running: every run still going whose agent has a computer, each as GET /v2/runs/{run_id} answers
// it. The runs list reads run rows alone and carries no computer, so this is the one read of the computers up across
// runs and agents. A run whose agent has no computer is passed over before its read, so the list costs one run read for
// each going run that has a computer and nothing for the rest.
import { type Definition, settingOfDefinition } from "./computer-setting.js";
import { COMPUTER_UP, type ComputerState } from "./run-computer.js";
import type { ReleasedState, Store } from "./store/index.js";

/** Every state a run's row is in while the run is still going: typed against the store's, so a new one is added here. */
const GOING = Object.keys({ queued: true, running: true, parked: true } satisfies Record<ReleasedState, true>) as ReleasedState[];

/** GET /v2/computers/running's answer: the runs still going whose agent has a computer, newest first, each read by
 *  `read` (the run as GET /v2/runs/{run_id} answers it; undefined for a run gone meanwhile). A run is listed once though
 *  it moves from one state's rows to the next while they are listed, and one whose computer ended or failed since is
 *  left out. `scope`: the request's workspace (server.ts scopeOf), whose runs alone are listed; none for an unscoped one. */
export async function runningComputers(store: Pick<Store, "runs" | "agents">, read: (runId: string) => Promise<Record<string, unknown> | undefined>, scope: { workspace?: string }): Promise<{ runs: Record<string, unknown>[] }> {
  const going = new Map<string, string>();
  for (const state of GOING) for (const row of await store.runs.list({ state, ...scope })) going.set(row.id, row.revisionId);
  const computerOf = new Map<string, Promise<boolean>>();
  const hasComputer = (revisionId: string): Promise<boolean> => {
    if (!computerOf.has(revisionId)) computerOf.set(revisionId, store.agents.revision(revisionId).then((revision) => (settingOfDefinition((revision?.body ?? {}) as Definition)?.computer.kind ?? "none") !== "none"));
    return computerOf.get(revisionId)!;
  };
  const reads = await Promise.all([...going].map(async ([runId, revisionId]) => ((await hasComputer(revisionId)) ? read(runId) : undefined)));
  const runs = reads.filter((run): run is Record<string, unknown> => COMPUTER_UP.has((run?.computer as { state: ComputerState } | undefined)?.state as ComputerState));
  return { runs: runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) };
}
