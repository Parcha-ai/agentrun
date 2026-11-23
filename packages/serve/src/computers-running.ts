// GET /v2/computers/running: every run still going whose agent has a computer, each with the run read's own `computer`
// field (run-computer.ts runComputerField, computer-held-routes.ts runComputerRead: its kind, provider and state, who
// holds it, a held run's hold). It is the one read behind a list of the computers up now, across runs and agents: the
// runs list reads run rows alone and carries no computer, so without it a page would read every going run in turn.
//
// A run is going while its row is queued, running or parked. Its agent has a computer when its revision's setting names
// one (or its place stands for one); a run with none is left out before anything of it is read, so the read costs a
// run read for each going run that has a computer, and nothing for the rest. A run moving between states while the
// rows are listed is listed once. A run whose read no longer says it is going (it ended, or failed for want of its
// computer, between the list and its read) is left out: its computer went with it.
import { computerOfPlace, type ComputerSetting, type PlaceView } from "./computer-setting.js";
import type { RunState, Store } from "./store/index.js";

/** A run still going with a computer, as GET /v2/computers/running lists it: the run's id, agent, title, status and
 *  state as its read says them, and its `computer` as its read carries it. */
export type RunningComputer = {
  run_id: string;
  agent_id: string;
  title: string;
  status: string;
  state: string;
  created_at: string;
  computer: Record<string, unknown>;
};

/** What the list reads of each run, passed in where the route is answered (server.ts): the run's read (GET
 *  /v2/runs/{run_id}'s, undefined for a run gone meanwhile) and that read's `computer` field. */
export type RunningDeps = {
  readonly view: (runId: string) => Promise<Record<string, unknown> | undefined>;
  readonly computer: (runId: string, view: Record<string, unknown>) => Promise<{ computer?: Record<string, unknown> }>;
};

/** A run's row states while it is still going. */
const GOING: readonly RunState[] = ["queued", "running", "parked"];
/** A run read's statuses while it is still going (run-view.ts Status): any other has ended. */
const GOING_STATUS: ReadonlySet<string> = new Set(["queued", "working", "paused", "input_required"]);

/** GET /v2/computers/running's answer: the runs still going that have a computer, newest first. */
export async function runningComputers(store: Pick<Store, "runs" | "agents">, deps: RunningDeps): Promise<{ computers: RunningComputer[] }> {
  // Whether a revision's agent has a computer, read once a revision: many runs share one.
  const settings = new Map<string, Promise<boolean>>();
  const hasComputer = (revisionId: string): Promise<boolean> => {
    let known = settings.get(revisionId);
    if (!known) {
      known = store.agents.revision(revisionId).then((revision) => {
        const body = revision?.body as { computer?: ComputerSetting; place?: PlaceView } | undefined;
        const setting = body?.computer ?? (body?.place ? computerOfPlace(body.place) : undefined);
        return !!setting && setting.kind !== "none";
      });
      settings.set(revisionId, known);
    }
    return known;
  };
  // Every going row first, once by id: a run listed as queued can be running by the next state's list.
  const rows = new Map<string, Awaited<ReturnType<Store["runs"]["list"]>>[number]>();
  for (const state of GOING) for (const row of await store.runs.list({ state })) if (!rows.has(row.id)) rows.set(row.id, row);
  const computers: RunningComputer[] = [];
  for (const row of rows.values()) {
    if (!(await hasComputer(row.revisionId))) continue;
    const view = await deps.view(row.id);
    // A run gone, or ended (failed for want of its computer included), between the list and its read is left out.
    if (!view || !GOING_STATUS.has(String(view.status))) continue;
    const { computer } = await deps.computer(row.id, view);
    if (!computer) continue;
    computers.push({ run_id: row.id, agent_id: row.agentId, title: String(view.title ?? ""), status: String(view.status), state: String(view.state), created_at: String(view.created_at), computer });
  }
  computers.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return { computers };
}
