// DELETE /v2/agents/{agent_id}: an agent deleted whole, one made here or one another system owns (made by an inline run,
// POST /runs with `external`), for an owner or a host that must delete what it sent. DELETE /v2/runs/{run_id}: one final
// run deleted whole, with the runs made from it, by the same per-run step (removeRun).
//
// An agent, in order, each step finished before the next:
//   1. The agent refuses new runs, as a mark in the store that outlives a restart (store Agents.markDeleting), then
//      archived by the trigger engine with its triggers off in the same commit. From the mark a person's run, an inline
//      run, an SDK run, a follow-up that would open one of its runs again and a trigger made, moved to it or turned on are
//      refused (store AgentDeleting, each read in the transaction that would write); from the archive a trigger's firing
//      is (AgentArchived). Then each of its runs not yet final, its learning runs included, is cancelled through the cancel
//      path, and waited for until it is final.
//   2. Its learning, by the learning module's deleteLearning (learn/delete.ts: its learning folder's files, then its
//      promotions and grades; idempotent; it refuses with LearningInFlight while learning work
//      is in flight, which answers 409 learning_busy with the agent left refusing runs).
//   3. Its things: its triggers through the trigger engine (each one's registration upstream first, then its adapter
//      settings, then its row), its saved sign-ins (each vendor object too), its own computer, its Archil disk; then each
//      run's folders (on a disk its launch named, the caller's, too: the run's own folder there, never the disk), settings
//      and kept answers, and its rows (store runs.remove); then the agent's folders, settings and kept answers, and its
//      rows (store agents.remove, which commits last and takes the mark with them).
// A DELETE stopped at any step finds the agent still there, marked, and does every step again: each is idempotent, so the
// next DELETE finishes it. Once the agent's row is gone the agent is unknown: 404. Nothing the agent owns elsewhere (a
// trigger's registration upstream, a saved sign-in at its vendor, its own computer, its Archil disk, a run's folder on a
// disk its launch named) is left with the agent's row gone: the record here that names it (for a run's folder, its launch
// record) is removed only once it is deleted there, and while it is not, the
// delete stops with 503 unavailable, the agent kept and refusing runs, for the next DELETE to finish. From step 1's mark
// the agent takes no new trigger, off or on (the trigger engine and the store refuse it), and no write to its home or its
// learning (the server's, in the delete's turn); a trigger that reached it anyway keeps its row (store TriggersLeft): the
// same 503, and the next DELETE removes that trigger as it removes the others.
//
// A run (deleteRun), only once it is final, and every run made from it final too (409 run_not_final otherwise, nothing
// deleted): first each run made from it (the replay runs of its input, its audit's shadow run, a learning run its kept
// learning names; each one's own such runs before it), then the grades its agent keeps of it, then the run, each by
// removeRun: its folders (its own folder on the agent's Archil disk it resolved to, and on a disk its launch named),
// settings and kept answers, then its rows (store runs.remove). The run's row goes last, so a DELETE stopped part way
// finds it still there and the next DELETE finishes it; then it is unknown: 404.
import { ApiError } from "./errors.js";
import { LearningInFlight } from "./learn/delete.js";
import { FINAL_STATES, type RunState, type Store, StoreConstraint, TriggersLeft } from "./store/index.js";

/** The delete of an agent's learning: the server's is the learning module's deleteLearning over the agent's learning
 *  folder (learn/delete.ts). Idempotent; refuses with LearningInFlight while learning work of the agent is in flight. */
export type DeleteLearning = (store: Store, agentId: string) => Promise<unknown>;

/** A point of a delete a test may stop it at (AgentDeleteHost.at). An agent's: after step 1, after step 2, in step 3
 *  between a trigger's removal upstream and its settings', between its settings' and its row's, and in step 3 once its
 *  triggers and the agent's first run are gone. A run's: once the runs made from it are gone, and once its own things
 *  outside its rows are (its rows kept). */
export type AgentDeleteStep = "after_step_1" | "after_step_2" | "in_step_3_trigger" | "in_step_3_trigger_settings" | "in_step_3" | "run_made_from_gone" | "run_forgotten";

/** What a delete does outside the store's own rows, as the server does it. */
export interface AgentDeleteHost {
  readonly store: Store;
  readonly deleteLearning: DeleteLearning;
  /** Step 1's mark (store Agents.markDeleting), then the agent archived, its triggers off in the same commit (the trigger
   *  engine's agentArchived). */
  refuse(agentId: string): Promise<void>;
  /** The cancel path, for one run that is not final: true once a cancel stands for it (written now, or the run is ending
   *  already), false when this server cannot end it (an SDK run, which only its application ends; an imported run). */
  cancel(runId: string): Promise<boolean>;
  /** One trigger's registration upstream removed, the trigger kept (the trigger engine's removeThere); an ApiError
   *  (503 unavailable) while it is not. */
  removeTriggerThere(triggerId: string): Promise<void>;
  /** Then its adapter settings, the trigger kept (the engine's removeSettings): they have no link to its row. */
  removeTriggerSettings(triggerId: string): Promise<void>;
  /** Then the trigger itself, its row (the engine's removeHere, which removes any settings left first). */
  removeTrigger(triggerId: string): Promise<void>;
  /** Every saved sign-in of the agent forgotten, its object at the vendor deleted; an ApiError (503 unavailable) while a
   *  vendor has not deleted one, each kept as a tombstone for the next call. */
  forgetSignIns(agentId: string): Promise<void>;
  /** The agent's own computer deleted at its provider, and its record with it; an ApiError while it cannot be yet. */
  removeOwnComputer(agentId: string): Promise<void>;
  /** The agent's Archil disk deleted, when one is stored on it, whatever the server's Archil settings are now
   *  (archil-routes.ts removeAgentDisk); an ApiError (503 unavailable) while it is not, Archil off included. */
  removeDisk(agentId: string): Promise<void>;
  /** A final run's things outside its rows: its folders (its own folder on an Archil disk its launch named, read from its
   *  launch record, which goes with its rows after; an ApiError (503 unavailable) while that folder is not deleted
   *  there), its settings, the answers kept under its idempotency keys. `alone`: the run is deleted by itself, its agent
   *  kept, so its own folder on the agent's Archil disk it resolved to is deleted there too (with the agent's, that disk
   *  goes whole). */
  forgetRun(agentId: string, runId: string, alone: boolean): Promise<void>;
  /** The agent's things outside its rows: its folders, its settings, the answers kept under its idempotency keys. */
  forgetAgent(agentId: string): Promise<void>;
  /** The runs made from run `runId` (store runs.madeFrom, and its audit's shadow run), by id, whether there or not. */
  madeFrom(runId: string): Promise<string[]>;
  /** The grades agent `agentId` keeps of run `runId` dropped (learn/promote.ts). */
  forgetGrades(agentId: string, runId: string): Promise<void>;
  /** How long step 1 waits for the agent's runs to be final, and how often it reads them meanwhile. */
  readonly waitMs: number;
  readonly pollMs: number;
  /** A test's seam: awaited at each step's point with the agent's id (a run's step: the run's), so a throw there stops
   *  the delete as a crash would. */
  at?(step: AgentDeleteStep, id: string): void | Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isFinal = (state: RunState) => (FINAL_STATES as readonly RunState[]).includes(state);

/** Deletes agent `agentId` in the three steps above. Throws ApiError runs_in_flight while a run of it is not final by the
 *  wait's end, learning_busy while its learning refuses. */
export async function deleteAgent(host: AgentDeleteHost, agentId: string): Promise<void> {
  // 1. No new run, then none in flight.
  await host.refuse(agentId);
  await stopRuns(host, agentId);
  await host.at?.("after_step_1", agentId);

  // 2. Its learning. Its refusal while learning work is in flight is learning_busy; any other failure is the server's own.
  try {
    await host.deleteLearning(host.store, agentId);
  } catch (error) {
    if (!(error instanceof LearningInFlight)) throw error;
    throw new ApiError(
      "learning_busy",
      `The agent ${agentId}'s learning could not be deleted yet (${error.message}). The agent starts no run meanwhile: send the DELETE again later to finish it.`,
      { details: { runs: [...error.runs] }, retry_after_ms: 5_000 },
    );
  }
  await host.at?.("after_step_2", agentId);

  // 3. Its things, then its rows; the agent's row last.
  for (const trigger of await host.store.triggers.list(agentId)) {
    // Upstream first, then its settings, then its row: the row names what is left to remove until each is gone.
    await host.removeTriggerThere(trigger.id);
    await host.at?.("in_step_3_trigger", agentId);
    await host.removeTriggerSettings(trigger.id);
    await host.at?.("in_step_3_trigger_settings", agentId);
    await host.removeTrigger(trigger.id);
  }
  await host.forgetSignIns(agentId);
  await host.removeOwnComputer(agentId);
  await host.removeDisk(agentId);
  let first = true;
  for (const run of await host.store.runs.every(agentId)) {
    await removeRun(host, agentId, run.id, false);
    if (first) await host.at?.("in_step_3", agentId);
    first = false;
  }
  await host.forgetAgent(agentId);
  try {
    await host.store.agents.remove(agentId);
  } catch (error) {
    // A trigger that reached the agent after the listing above (the store refuses one once the agent is marked; this is
    // its backstop): the agent is kept, refusing, for the next DELETE to remove it upstream, its settings, then its row.
    if (!(error instanceof TriggersLeft)) throw error;
    throw new ApiError("unavailable", `The agent ${agentId} has ${error.triggerIds.length === 1 ? "a trigger" : "triggers"} made while it was being deleted (${error.triggerIds.join(", ")}), not removed yet. It starts no run meanwhile: send the DELETE again to finish it.`, { details: { triggers: error.triggerIds }, retry_after_ms: 5_000 });
  }
}

/** Deletes final run `runId` whole, with every run made from it, as the header says. 404 not_found when it is not there;
 *  409 run_not_final, nothing deleted, while it or a run made from it is not final. */
export async function deleteRun(host: AgentDeleteHost, runId: string): Promise<void> {
  const run = await host.store.runs.get(runId);
  if (!run) throw new ApiError("not_found", `no run ${runId}`);
  const made = await madeFromAll(host, runId);
  const live = [...(isFinal(run.state) ? [] : [runId]), ...made.filter((one) => !isFinal(one.state)).map((one) => one.id)];
  if (live.length) throw notFinal(runId, live);
  for (const one of made) await removeRunOrRefuse(host, one.agentId, one.id, runId);
  await host.at?.("run_made_from_gone", runId);
  await host.forgetGrades(run.agentId, runId);
  await removeRunOrRefuse(host, run.agentId, runId, runId);
}

/** The one per-run step of both deletes: a final run's things outside its rows, then its rows. */
async function removeRun(host: AgentDeleteHost, agentId: string, runId: string, alone: boolean): Promise<void> {
  await host.forgetRun(agentId, runId, alone);
  if (alone) await host.at?.("run_forgotten", runId);
  await host.store.runs.remove(runId);
}

/** removeRun for a run deleted alone: its store's refusal of a run not final (a follow-up opened it again since it was
 *  read) is 409 run_not_final, as a run read not final is. */
async function removeRunOrRefuse(host: AgentDeleteHost, agentId: string, id: string, deleted: string): Promise<void> {
  try {
    await removeRun(host, agentId, id, true);
  } catch (error) {
    if (error instanceof StoreConstraint) throw notFinal(deleted, [id]);
    throw error;
  }
}

/** Every run made from run `runId` that is there, each one's own before it (deepest first), never `runId` itself. */
async function madeFromAll(host: AgentDeleteHost, runId: string, seen = new Set<string>([runId])): Promise<{ id: string; agentId: string; state: RunState }[]> {
  const out: { id: string; agentId: string; state: RunState }[] = [];
  for (const id of await host.madeFrom(runId)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = await host.store.runs.get(id);
    if (!row) continue;
    out.push(...(await madeFromAll(host, id, seen)), { id, agentId: row.agentId, state: row.state });
  }
  return out;
}

const notFinal = (runId: string, live: readonly string[]) =>
  new ApiError(
    "run_not_final",
    live.length === 1 && live[0] === runId
      ? `The run ${runId} has not ended: cancel it first (POST /v2/runs/${runId}/cancel), then send the DELETE again. Nothing was deleted.`
      : `The run ${runId} has ${live.length === 1 ? "a run" : "runs"} made from it that ${live.length === 1 ? "has" : "have"} not ended (${live.join(", ")}): send the DELETE again once ${live.length === 1 ? "it has" : "they have"} ended. Nothing was deleted.`,
    { details: { runs: [...live] } },
  );

/** Step 1's second half: each run of the agent not final cancelled once, then read again until every one is final. A run's
 *  end may queue its learning run, so the runs are listed again on each read. A run this server cannot end, or one still
 *  going at the wait's end, is 409 runs_in_flight, the agent left refusing runs. */
async function stopRuns(host: AgentDeleteHost, agentId: string): Promise<void> {
  const deadline = Date.now() + host.waitMs;
  const asked = new Set<string>();
  for (;;) {
    const live = (await host.store.runs.every(agentId)).filter((run) => !isFinal(run.state));
    if (live.length === 0) return;
    const unended: string[] = [];
    for (const run of live) {
      if (asked.has(run.id)) continue;
      if (await host.cancel(run.id)) asked.add(run.id);
      else unended.push(run.id);
    }
    if (unended.length) {
      throw new ApiError("runs_in_flight", `The agent ${agentId} has ${unended.length === 1 ? "a run" : "runs"} this server cannot end (${unended.join(", ")}): an SDK run is ended by its application. It starts no run meanwhile: send the DELETE again once ${unended.length === 1 ? "it has" : "they have"} ended.`, { details: { runs: unended }, retry_after_ms: 5_000 });
    }
    if (Date.now() >= deadline) {
      throw new ApiError("runs_in_flight", `The agent ${agentId}'s runs were cancelled and ${live.length === 1 ? "one has" : `${live.length} have`} not ended yet (${live.map((run) => run.id).join(", ")}). It starts no run meanwhile: send the DELETE again to finish it.`, { details: { runs: live.map((run) => run.id) }, retry_after_ms: 2_000 });
    }
    await sleep(host.pollMs);
  }
}

/** One delete at a time per key (an agent's id: its delete, and each delete of one of its runs): a second DELETE waits for
 *  the first, then finds it gone (404) or finishes what the first left. */
export function oneAtATime(): <T>(agentId: string, work: () => Promise<T>) => Promise<T> {
  const turns = new Map<string, Promise<unknown>>();
  return <T>(agentId: string, work: () => Promise<T>): Promise<T> => {
    const before = turns.get(agentId) ?? Promise.resolve();
    const turn = before.then(work, work);
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    turns.set(agentId, settled);
    void settled.then(() => {
      if (turns.get(agentId) === settled) turns.delete(agentId);
    });
    return turn;
  };
}
