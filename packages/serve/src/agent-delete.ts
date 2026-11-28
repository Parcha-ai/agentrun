// DELETE /v2/agents/{agent_id} deletes an agent another system owns whole (deleteExternalAgent), for a host that must
// delete what it sent, and purges an archived agent made here (purgeAgent). DELETE /v2/runs/{run_id} purges one run with
// the runs made from it (purgeRun). An owner must be able to delete what a run read, and what it cost stays in every
// total, so a purge keeps each run's row, and an agent's, as a tombstone and removes everything else of it.
//
// Every step is idempotent and ordered so that a DELETE stopped part way leaves the row there, for the next DELETE to
// finish; a DELETE of a purged run is 204 again. A live run (not final, or held by a runner) refuses its purge with 409
// run_not_final and nothing purged. The runs made from a run are purged before it: one a claim made after the DELETE read
// them is found by the store's purge under the run's row lock (RunsMadeFromLeft, 409 naming it), and one made once the run
// is purged is refused at its create (RunPurged). A run's purge deletes its agent's learning rows that hold its text (the
// store's purge, Store.learning purgeRun) and blanks what its agent's records copied from it (forgetCopies).
//
// Another system's agent is first marked refusing new runs (its archive time, set with its triggers off in one commit, read
// by every path that would start a run), then its runs are cancelled and waited for, then its learning goes, then its
// things and rows, the agent's row last. Nothing it owns elsewhere (a trigger's registration upstream, a saved sign-in at
// its vendor, its own computer, its Archil disk, a run's folder on a disk its launch named) is left with no record here
// naming it: each record goes only once its thing is deleted there, and until then the DELETE is 503 unavailable, the
// agent kept and refusing runs. A trigger that reached it anyway keeps its row (store TriggersLeft): the same 503.
import { ApiError } from "./errors.js";
import { LearningInFlight } from "./learn/delete.js";
import { learningChildrenOf } from "./learning-work.js";
import { sendCommand } from "./runner/commands.js";
import { FINAL_STATES, type PurgeKept, RunFinal, type RunState, RunsMadeFromLeft, type Store, StoreConstraint, TriggersLeft } from "./store/index.js";
import { forgetServed } from "./store-view.js";
import { requireSourceIOIdle } from "./source-sync/io.js";

/** The delete of an agent's learning: the server's is the learning module's deleteLearning over the store's learning
 *  rows (learn/delete.ts). Idempotent; refuses with LearningInFlight while learning work of the agent is in flight. A
 *  reset of the agent's learning (learning-reset.ts), whose agent and runs stay, keeps its reset ledger and watermark
 *  (`keepResetLedger`). */
export type DeleteLearning = (store: Store, agentId: string, options?: { keepResetLedger?: boolean }) => Promise<unknown>;

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
   *  forgetRunCopies), and every SDK run's inbox that holds its workflow text emptied of it (sdk/runs.ts forgetSdkCopies).
   *  Idempotent: run before the run's purge and again after it commits, and a purged run's DELETE runs it again. */
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
  await requireSourceIOIdle(host.store, agentId);

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
  await requireSourceIOIdle(host.store, agentId);
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

/** Run `runId`'s learning work still going, ended before anything of the run is purged: the replay runs of its learned
 *  workflow's check (learning-work.ts names them), which are made from the runs whose input they replay, never from it,
 *  so neither its live check nor the store's purge waits for them. Its caller reads the run's `learning_work` to know
 *  when the run's own model key may be revoked, and a purged run reads nothing: so each one still going has its sealed
 *  launch secrets (its copy of the run's key, its handed MCP credentials) erased in the same store write as its cancel
 *  (runs.command's launchSealed), no claim of it from here opening a key, and is waited for until it is final and let go,
 *  its spend booked. Each child is named in the run's record before it is created, under the run's own claim
 *  (runner/promotion.ts startReplay, runner/audit.ts startAudit; a keyed one is never relaunched), and this runs only once
 *  that claim let the run go (liveOf): none starts after it. Its audit's shadow is made from it, so a live one refused
 *  the purge above (409) and none is here. One not ended by the wait's end refuses the purge with 409 run_not_final,
 *  nothing of the run purged; its cancel stands, and the next DELETE finds it ended. */
async function endLearningWork(host: AgentDeleteHost, runId: string): Promise<void> {
  const going = async () => {
    const out: string[] = [];
    for (const child of await learningChildrenOf(host.store.settings, runId)) {
      if (child.run === null || out.includes(child.run)) continue;
      const row = await host.store.runs.get(child.run);
      if (row && row.purgedAt === null && isLive(row)) out.push(child.run);
    }
    return out;
  };
  let live = await going();
  if (!live.length) return;
  for (const id of live) {
    try {
      await sendCommand(host.store, id, { kind: "cancel", body: {} }, { launchSealed: () => null });
    } catch (error) {
      // Final already: the write that ended it erased its secrets with it.
      if (!(error instanceof RunFinal)) throw error;
    }
  }
  const deadline = Date.now() + host.waitMs;
  while ((live = await going()).length && Date.now() < deadline) await sleep(host.pollMs);
  if (live.length) {
    throw liveRuns(`The run ${runId}'s learning work was cancelled and has not ended yet (${live.join(", ")}): send the DELETE again once ${live.length === 1 ? "it has" : "they have"} ended. Nothing was purged.`, live);
  }
}

/** The setting that marks agent `agentId`'s purge begun and not finished (purgeAgent). */
export const purgingKey = (agentId: string): string => `agent.purging.${agentId}`;

/** Purges run `runId` with every run made from it, as the header says. 404 not_found when it is not there; 409
 *  run_not_final, nothing purged, while it or a run made from it is live. Its learning work still going is ended first
 *  (endLearningWork). A purged run's only work is forgetCopies again, which finds nothing left once a purge finished it;
 *  its store scrub was marked before the purge changed a row (sqlite/store.ts #purging). */
export async function purgeRun(host: AgentDeleteHost, runId: string): Promise<void> {
  const run = await host.store.runs.get(runId);
  if (!run) throw new ApiError("not_found", `no run ${runId}`);
  if (run.purgedAt !== null) return host.forgetCopies(run.agentId, runId);
  const made = await madeFromAll(host, runId);
  const live = await liveOf(host, [run, ...made]);
  if (live.length) throw notFinal(runId, live);
  await endLearningWork(host, runId);
  for (const one of made) await purgeOneOrRefuse(host, one.agentId, one.id, runId, true);
  await host.at?.("run_made_from_gone", runId);
  await host.forgetCopies(run.agentId, runId);
  await purgeOneOrRefuse(host, run.agentId, runId, runId, true);
  // Again after the purge committed: a copy written meanwhile (an SDK start's inbox, which checks its writers after it is
  // written) is seen by this pass, or saw the purge itself.
  await host.forgetCopies(run.agentId, runId);
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
    // A purge can commit and still throw (a Postgres commit unanswered), and a retried DELETE skips a purged run: what
    // the process served of it goes now unless the store reads it not purged.
    if ((await host.store.runs.get(runId).catch(() => undefined))?.purgedAt !== null) forgetServed(host.store, runId);
    throw error;
  }
  // Its answer and input as this process last served them: every route of it is 410 from here, so none is read again.
  forgetServed(host.store, runId);
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
