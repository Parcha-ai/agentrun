// DELETE /v2/agents/{agent_id}: an agent another system owns (made by an inline run, POST /runs with `external`) deleted
// whole, for a host that must delete what it sent (deleteExternalAgent). An agent made here is purged once it is archived
// (purgeAgent; 409 agent_not_archived before). DELETE /v2/runs/{run_id}: one run purged (purgeRun), with the runs made
// from it. An owner must be able to delete what a run read; what it cost stays in every total. So a purge keeps each
// run's row, and an agent's, as a tombstone, and removes everything else of it.
//
// A run's purge (purgeRun), only once it is not live (409 run_not_final otherwise, nothing purged: live is not final, or
// held by a runner; a run that ended and can take a follow-up is not live), nor any run made from it: first each run made
// from it (the replay runs of its input, its audit's shadow run, a learning run its kept learning names; each one's own
// such runs before it), then the grades its agent keeps of it and the content its promotion records copied from it (each
// disagreement's input and answers, learn/promote.ts forgetRunCopies), then the run, each by purgeOne: the figures its spend's
// readers read from its journal (kept on the tombstone, PurgeKept), its folders (its own folder on the agent's Archil disk
// it resolved to, and on a disk its launch named), settings and kept answers, then its rows (store runs.purge, which sets
// its purge time last). A replay of its input or an audit's shadow made by a claim (in a runner, maybe another process)
// after the DELETE read the runs made from it is found by the store's purge, under the run's row lock: 409 run_not_final
// naming it, the run kept for the next DELETE, which purges it first (RunsMadeFromLeft); one made once the run is purged
// is refused at its create, nothing written (RunPurged). A DELETE stopped part way finds the run not purged yet and the
// next DELETE finishes it; a DELETE of a purged run is 204 again, and every other route of it is 410 purged with its
// tombstone.
//
// An archived agent made here (purgeAgent), by the same rule: 409 run_not_final while a run of it is live. Then its
// learning, its things (triggers, sign-ins, its own computer, its disk), each of its runs by purgeOne (the runs made from
// it first, as a run's purge does them), its folders, settings and kept answers, and its rows (store agents.purge: its
// revisions' content, its name and description blanked, its purge time last). Each step is idempotent, so a DELETE stopped part way is finished by the next. Archived, the agent
// takes no new run and no trigger fires it; a run that reached it anyway keeps it unpurged (the store refuses), for the
// next DELETE.
//
// Another system's agent (deleteExternalAgent), in order, each step finished before the next:
//   1. The agent refuses new runs, as a mark in the store that outlives a restart: its archive time, which only this
//      delete writes on an agent another system owns (its archive route is refused), set by the trigger engine with its
//      triggers off in the same commit. From that commit a person's run, an inline run, a trigger's firing, an SDK run and
//      a follow-up that would open one of its runs again are refused (store AgentDeleting / AgentArchived, each read in
//      the transaction that would start the run). Then each of its runs not yet final, its learning runs included, is
//      cancelled through the cancel path, and waited for until it is final.
//   2. Its learning, by the learning module's deleteLearning (learn/delete.ts: its learning folder's files, here and on
//      each Archil disk a launch of its runs named, a purged run's included, then its promotions and grades; its own
//      disk goes whole in step 3; idempotent; it refuses with LearningInFlight while learning work is in flight, which
//      answers 409 learning_busy with the agent left refusing runs).
//   3. Its things: its triggers through the trigger engine (each one's registration upstream first, then its adapter
//      settings, then its row), its saved sign-ins (each vendor object too), its own computer, its Archil disk; then each
//      run's folders (on a disk its launch named, the caller's, too: the run's own folder there, never the disk), settings
//      and kept answers, and its rows (store runs.remove); then the agent's folders, settings and kept answers, and its
//      rows (store agents.remove, which commits last).
// A DELETE stopped at any step finds the agent still there, marked, and does every step again: each is idempotent, so the
// next DELETE finishes it. Once the agent's row is gone the agent is unknown: 404. Nothing the agent owns elsewhere (a
// trigger's registration upstream, a saved sign-in at its vendor, its own computer, its Archil disk, a run's folder on a
// disk its launch named) is left with the agent's row gone: the record here that names it (for a run's folder, its launch
// record) is removed only once it is deleted there, and while it is not, the
// delete stops with 503 unavailable, the agent kept and refusing runs, for the next DELETE to finish. From step 1's mark
// the agent takes no new trigger, off or on (the trigger engine and the store refuse it), and no write to its home or its
// learning (the server's, in the delete's turn); a trigger that reached it anyway keeps its row (store TriggersLeft): the
// same 503, and the next DELETE removes that trigger as it removes the others.
import { ApiError } from "./errors.js";
import { LearningInFlight } from "./learn/delete.js";
import { FINAL_STATES, type PurgeKept, type RunState, RunsMadeFromLeft, type Store, StoreConstraint, TriggersLeft } from "./store/index.js";
import { forgetServed } from "./store-view.js";

/** The delete of an agent's learning: the server's is the learning module's deleteLearning over the agent's learning
 *  folder, and its folder on each Archil disk a launch of its runs named, a purged run's included (learn/delete.ts;
 *  server.ts learningDisksOf), and its records. Idempotent; refuses with LearningInFlight while learning work of the
 *  agent is in flight. A reset of the agent's learning (learning-reset.ts), whose agent and runs stay, keeps its reset
 *  ledger and watermark (`keepResetLedger`) and deletes the folder on the agent's own disk too (`agentDisk`), which the
 *  agent's delete removes whole in its step 3. */
export type DeleteLearning = (store: Store, agentId: string, options?: { keepResetLedger?: boolean; agentDisk?: boolean }) => Promise<unknown>;

/** A point of a delete a test may stop it at (AgentDeleteHost.at). An agent's: after step 1, after step 2, in step 3
 *  between a trigger's removal upstream and its settings', between its settings' and its row's, and in step 3 once its
 *  triggers and the agent's first run are gone (a purge's: after its learning, then the same). A run's: once the runs
 *  made from it are purged, and once its own things outside its rows are gone (its rows kept). */
export type AgentDeleteStep = "after_step_1" | "after_step_2" | "in_step_3_trigger" | "in_step_3_trigger_settings" | "in_step_3" | "run_made_from_gone" | "run_forgotten";

/** What a delete does outside the store's own rows, as the server does it. */
export interface AgentDeleteHost {
  readonly store: Store;
  readonly deleteLearning: DeleteLearning;
  /** Step 1's mark: the agent archived, its triggers off in the same commit (the trigger engine's agentArchived). */
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
   *  there), its settings, the answers kept under its idempotency keys. `alone`: its agent's Archil disk stays (a run's
   *  purge, or its agent's), so its own folder on that disk is deleted there too; with an external agent's delete that
   *  disk went whole. */
  forgetRun(agentId: string, runId: string, alone: boolean): Promise<void>;
  /** The agent's things outside its rows: its folders, its settings, the answers kept under its idempotency keys. */
  forgetAgent(agentId: string): Promise<void>;
  /** The runs made from run `runId` (store runs.madeFrom, and its audit's shadow run), by id, whether there or not. */
  madeFrom(runId: string): Promise<string[]>;
  /** What agent `agentId`'s learning copied from run `runId`, gone: the grades it keeps of the run dropped, its promotion
   *  records' disagreements naming the run blanked, their decisions, numbers and run ids kept (learn/promote.ts
   *  forgetRunCopies). */
  forgetCopies(agentId: string, runId: string): Promise<void>;
  /** What run `runId`'s spend reads from its journal, read before its purge removes it (store-reads/cap.ts). */
  kept(runId: string): Promise<PurgeKept>;
  /** Whether run `runId`'s turn is over (it reads idle, a paused workflow aside): its runner writes it final next. */
  turnOver(runId: string): Promise<boolean>;
  /** How long step 1 waits for the agent's runs to be final (a purge: for a run whose turn is over), and how often it reads
   *  them meanwhile. */
  readonly waitMs: number;
  readonly pollMs: number;
  /** A test's seam: awaited at each step's point with the agent's id (a run's step: the run's), so a throw there stops
   *  the delete as a crash would. */
  at?(step: AgentDeleteStep, id: string): void | Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isFinal = (state: RunState) => (FINAL_STATES as readonly RunState[]).includes(state);

/** Deletes agent `agentId` (another system's, as the route checked) in the three steps above. Throws ApiError
 *  runs_in_flight while a run of it is not final by the wait's end, learning_busy while its learning refuses. */
export async function deleteExternalAgent(host: AgentDeleteHost, agentId: string): Promise<void> {
  // 1. No new run, then none in flight.
  await host.refuse(agentId);
  await stopRuns(host, agentId);
  await host.at?.("after_step_1", agentId);

  // 2. Its learning.
  await learningGone(host, agentId);
  await host.at?.("after_step_2", agentId);

  // 3. Its things, then its rows; the agent's row last.
  await thingsGone(host, agentId);
  let first = true;
  for (const run of await host.store.runs.every(agentId)) {
    await host.forgetRun(agentId, run.id, false);
    await host.store.runs.remove(run.id);
    forgetServed(host.store, run.id);
    if (first) await host.at?.("in_step_3", agentId);
    first = false;
  }
  await host.forgetAgent(agentId);
  try {
    await host.store.agents.remove(agentId);
  } catch (error) {
    throw triggersLeft(error, agentId);
  }
}

/** Purges archived agent `agentId`, made here (as the route checked), as the header says: 409 run_not_final, nothing
 *  purged, while a run of it is live; learning_busy while its learning refuses. */
export async function purgeAgent(host: AgentDeleteHost, agentId: string): Promise<void> {
  const live = await liveOf(host, (await host.store.runs.every(agentId)).filter((run) => run.purgedAt === null));
  if (live.length) throw liveRuns(`The agent ${agentId} has ${live.length === 1 ? "a run" : "runs"} that ${live.length === 1 ? "has" : "have"} not ended (${live.join(", ")}): cancel ${live.length === 1 ? "it" : "them"} (POST /v2/runs/{run_id}/cancel), then send the DELETE again. Nothing was purged.`, live);
  // Marked before anything goes, and kept until its tombstone is written: a purge stopped part way leaves the agent
  // refusing an unarchive and every write (server.ts agentWrite) until a DELETE finishes it.
  await host.store.settings.put(purgingKey(agentId), true);
  await learningGone(host, agentId);
  await host.at?.("after_step_2", agentId);
  await thingsGone(host, agentId);
  let first = true;
  for (const run of await host.store.runs.every(agentId)) {
    if (run.purgedAt !== null) continue;
    // The runs made from it first, each one's own before it, as purgeRun does: the store refuses a run's purge while one
    // made from it (an audit's shadow, a replay, each started after it) is not purged. Its disk went whole above, each
    // of its runs' folders there with it; a run of another agent keeps that agent's disk.
    for (const one of await madeFromAll(host, run.id)) await purgeOneOrRefuse(host, one.agentId, one.id, agentId, one.agentId !== agentId);
    // A later run of the list may be gone as one made from an earlier.
    if ((await host.store.runs.get(run.id))?.purgedAt !== null) continue;
    await purgeOneOrRefuse(host, agentId, run.id, agentId, false);
    if (first) await host.at?.("in_step_3", agentId);
    first = false;
  }
  await host.forgetAgent(agentId);
  try {
    await host.store.agents.purge(agentId);
  } catch (error) {
    if (error instanceof StoreConstraint) throw liveRuns(`The agent ${agentId} has a run started while it was being purged (${error.message}): send the DELETE again once it has ended. Its runs purged so far stay purged.`, []);
    throw triggersLeft(error, agentId);
  }
  // Its tombstone refuses every write from here (410 purged).
  await host.store.settings.remove(purgingKey(agentId));
}

/** The setting that marks agent `agentId`'s purge begun and not finished (purgeAgent). */
export const purgingKey = (agentId: string): string => `agent.purging.${agentId}`;

/** A DELETE of a run, or of agent `agentId`, already purged: 204 with no purge, but what a purge that committed and then
 *  threw left undone (its scrub's marker not written, sqlite/store.ts #purged): the scrub arranged again (store
 *  purgeScrub), and the agent's purge mark dropped (purgeAgent removes it only after its store purge returns). */
export async function purgedAgain(host: AgentDeleteHost, agentId?: string): Promise<void> {
  await host.store.purgeScrub();
  if (agentId !== undefined) await host.store.settings.remove(purgingKey(agentId));
}

/** Purges run `runId` with every run made from it, as the header says. 404 not_found when it is not there; 409
 *  run_not_final, nothing purged, while it or a run made from it is live. A purged run is no work. */
export async function purgeRun(host: AgentDeleteHost, runId: string): Promise<void> {
  const run = await host.store.runs.get(runId);
  if (!run) throw new ApiError("not_found", `no run ${runId}`);
  if (run.purgedAt !== null) return purgedAgain(host);
  const made = await madeFromAll(host, runId);
  const live = await liveOf(host, [run, ...made]);
  if (live.length) throw notFinal(runId, live);
  for (const one of made) await purgeOneOrRefuse(host, one.agentId, one.id, runId, true);
  await host.at?.("run_made_from_gone", runId);
  await host.forgetCopies(run.agentId, runId);
  await purgeOneOrRefuse(host, run.agentId, runId, runId, true);
}

/** The one per-run step of both purges: the figures its spend's readers read from its journal, its things outside its
 *  rows, then its rows (a tombstone). Its store's refusal of a run gone live again since it was read (a follow-up opened
 *  it) is 409 run_not_final, as a run read live is (`purged`: the run or agent the DELETE names; `alone`: its agent's disk
 *  stays, AgentDeleteHost.forgetRun). */
async function purgeOneOrRefuse(host: AgentDeleteHost, agentId: string, runId: string, purged: string, alone: boolean): Promise<void> {
  const kept = await host.kept(runId);
  await host.forgetRun(agentId, runId, alone);
  await host.at?.("run_forgotten", runId);
  try {
    await host.store.runs.purge(runId, kept);
  } catch (error) {
    // A replay or shadow made from it after the runs made from it were read: named, for the next DELETE to purge first.
    if (error instanceof RunsMadeFromLeft) throw notFinal(purged, error.runs);
    if (error instanceof StoreConstraint) throw notFinal(purged, [runId]);
    throw error;
  } finally {
    // Its answer and input as this process last served them, dropped whatever the purge answered: every route of it is 410
    // once it committed, so none is read again. A purge can commit and still throw (its checkpoint held back and the
    // scrub's marker not written, sqlite/store.ts #purged), and no later DELETE comes back here (purgeRun: a purged run is
    // only purgedAgain). One that did not commit loses a cache its next read fills again.
    forgetServed(host.store, runId);
  }
}

/** Every run made from run `runId` that is there and not purged, each one's own before it (deepest first), never `runId`. */
async function madeFromAll(host: AgentDeleteHost, runId: string, seen = new Set<string>([runId])): Promise<{ id: string; agentId: string; state: RunState; runner: string | null }[]> {
  const out: { id: string; agentId: string; state: RunState; runner: string | null }[] = [];
  for (const id of await host.madeFrom(runId)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = await host.store.runs.get(id);
    if (!row || row.purgedAt !== null) continue;
    out.push(...(await madeFromAll(host, id, seen)), { id, agentId: row.agentId, state: row.state, runner: row.runner });
  }
  return out;
}

/** Live: not final, or held by a runner. A run that ended and can take a follow-up (it reads idle) is not. */
const isLive = (run: { state: RunState; runner: string | null }) => !isFinal(run.state) || run.runner !== null;

/** Of `runs`, the ids of the live ones. A run whose turn is over (it reads idle: a person's stop, or its turn's end) is
 *  written final by its runner a moment after it reads so, so while every live run is such a one, each is read again
 *  every host.pollMs, for host.waitMs at most, until it is final and let go. A live run whose turn is not over makes the
 *  answer at once, and so does one still live at the end. */
async function liveOf(host: AgentDeleteHost, runs: readonly { id: string; state: RunState; runner: string | null }[]): Promise<string[]> {
  const deadline = Date.now() + host.waitMs;
  let live = runs.filter(isLive).map((run) => run.id);
  for (;;) {
    if (!live.length) return live;
    for (const id of live) if (!(await host.turnOver(id))) return live;
    if (Date.now() >= deadline) return live;
    await sleep(host.pollMs);
    const rows = await Promise.all(live.map((id) => host.store.runs.get(id)));
    live = rows.filter((row) => row !== undefined && row.purgedAt === null && isLive(row)).map((row) => row!.id);
  }
}

const liveRuns = (message: string, runs: readonly string[]) => new ApiError("run_not_final", message, { details: { runs: [...runs] } });

const notFinal = (runId: string, live: readonly string[]) =>
  liveRuns(
    live.length === 1 && live[0] === runId
      ? `The run ${runId} has not ended: cancel it first (POST /v2/runs/${runId}/cancel), then send the DELETE again. Nothing was purged.`
      : `${runId} has ${live.length === 1 ? "a run" : "runs"} that ${live.length === 1 ? "has" : "have"} not ended (${live.join(", ")}): send the DELETE again once ${live.length === 1 ? "it has" : "they have"} ended. Runs purged so far stay purged.`,
    live,
  );

/** An agent's learning deleted (step 2 of a delete, the first of a purge). Its refusal while learning work is in flight is
 *  learning_busy; any other failure is the server's own. */
async function learningGone(host: AgentDeleteHost, agentId: string): Promise<void> {
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
}

/** An agent's things outside the store's rows: its triggers through the trigger engine (each one's registration upstream
 *  first, then its settings, then its row: the row names what is left to remove until each is gone), its saved sign-ins,
 *  its own computer, its Archil disk. */
async function thingsGone(host: AgentDeleteHost, agentId: string): Promise<void> {
  for (const trigger of await host.store.triggers.list(agentId)) {
    await host.removeTriggerThere(trigger.id);
    await host.at?.("in_step_3_trigger", agentId);
    await host.removeTriggerSettings(trigger.id);
    await host.at?.("in_step_3_trigger_settings", agentId);
    await host.removeTrigger(trigger.id);
  }
  await host.forgetSignIns(agentId);
  await host.removeOwnComputer(agentId);
  await host.removeDisk(agentId);
}

/** A trigger that reached the agent after its delete listed them (the store refuses one once the agent is marked; this is
 *  its backstop): the agent is kept for the next DELETE to remove it upstream, its settings, then its row. */
function triggersLeft(error: unknown, agentId: string): unknown {
  if (!(error instanceof TriggersLeft)) return error;
  return new ApiError("unavailable", `The agent ${agentId} has ${error.triggerIds.length === 1 ? "a trigger" : "triggers"} made while it was being deleted (${error.triggerIds.join(", ")}), not removed yet. It starts no run meanwhile: send the DELETE again to finish it.`, { details: { triggers: error.triggerIds }, retry_after_ms: 5_000 });
}

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

/** One delete of an agent at a time: a second DELETE of the same agent waits for the first, then finds it gone (404) or
 *  finishes what the first left. `queued`, a test's seam: told each time a work waits behind another of its agent's,
 *  with how many of that agent's wait now (the one running not counted). */
export function oneAtATime(queued?: (agentId: string, waiting: number) => void): <T>(agentId: string, work: () => Promise<T>) => Promise<T> {
  const turns = new Map<string, Promise<unknown>>();
  const waiting = new Map<string, number>();
  return <T>(agentId: string, work: () => Promise<T>): Promise<T> => {
    const held = turns.get(agentId);
    let run = work;
    if (held && queued) {
      waiting.set(agentId, (waiting.get(agentId) ?? 0) + 1);
      run = () => {
        const left = waiting.get(agentId)! - 1;
        if (left) waiting.set(agentId, left);
        else waiting.delete(agentId);
        return work();
      };
      queued(agentId, waiting.get(agentId)!);
    }
    const before = held ?? Promise.resolve();
    const turn = before.then(run, run);
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
