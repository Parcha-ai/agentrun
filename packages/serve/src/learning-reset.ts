// DELETE /v2/agents/{agent_id}/learning: an agent's learning reset, the agent kept. What it learned goes (the learning
// module's deleteLearning: its learning rows, every save, note, workflow, promotion record, grade and audit row); the agent, its
// definition, its runs and everything kept of them (their files, journals, costs, the learning each one kept) stay, so
// the run list, the stats and the usage read the same before and after. A served run's cost carries its share of its
// revision's compile and check, read from the promotion records the reset deletes: each revision they name is kept
// first in the agent's reset ledger (learn/promote.ts keepResetLedger: workflow, digest and K alone), so the share reads
// the same after.
//
// What goes with the rows: each run's learning diff (GET /runs/{id}/learning/diff, the text it merged) is read from its
// save, so it is 404 after; what the run's own record keeps of its learning end stays with the run.
//
// In order, in the agent's delete turn (server.ts agentWrite: one learning write of an agent at a time, and none once
// its DELETE began):
//   1. The agent's learning work in flight is stopped. A run that exists only for its learning (a check's or an owner's
//      replay, an audit's shadow, a built-in learning run) is cancelled through the cancel path and waited for until it
//      is final. A run of the agent's own still going is not: its learning lives in it (the seed it was started from,
//      a workflow it may be served, its compile turn and look-back at its end), and the owner's job is never cancelled
//      to reset learning. Any such run, or a learning run this server cannot end (an SDK run, an imported one) or one
//      not final by the wait's end, is 409 learning_busy, naming them, and the agent's learning is left as it was.
//   2. In the agent's learning queue (learning.ts inLearningQueue, where a run's start reads its seed), the agent's runs are read again: one still going (a run started meanwhile) is 409 learning_busy, nothing
//      deleted. Then deleteLearning, which reads them once more itself.
// Idempotent: an agent that never learned, or one reset already, has nothing to delete, and is answered as done.
//
// Step 2 sets the agent's reset watermark (learn/promote.ts resetAtKey) before it deletes: from then on learning reads
// only runs after it (learn/compile.ts sinceReset: compile_after's count, a compile's traces, a check's inputs, an
// audit's draws, the money rule). A run whose start read its seed before step 2
// and whose row the store wrote after it keeps what it was started with (its corrections are in its launch), but
// learns nothing: its seed was read before the watermark, so its learning end drops it whole at its entry
// (runner/learning-end.ts, reason `reset`), and the store refuses a save on a seed the agent's learning no longer holds
// (Store.learning save). No workflow is laid for it either: they are read at its seed's save, which is gone.
import { ApiError } from "./errors.js";
import type { DeleteLearning } from "./agent-delete.js";
import { LearningInFlight } from "./learn/delete.js";
import { isShadowRun } from "./learn/audit.js";
import { keepResetAt, keepResetLedger, promotionsOf, resetAtKey, resetAtOf } from "./learn/promote.js";
import { readLaunchBody } from "./run-launch.js";
import { FINAL_STATES, type RunState, type Store, StoreLaunchMissing } from "./store/index.js";

/** What a reset does outside the learning module, as the server does it. */
export interface LearningResetHost {
  readonly store: Store;
  readonly deleteLearning: DeleteLearning;
  /** The cancel path, for one run that is not final: true once a cancel stands for it, false when this server cannot
   *  end it (agent-delete.ts AgentDeleteHost.cancel). */
  cancel(runId: string): Promise<boolean>;
  /** `work` in agent `agentId`'s learning queue (learning.ts inLearningQueue). */
  inQueue<T>(agentId: string, work: () => Promise<T>): Promise<T>;
  /** How long step 1 waits for the agent's learning runs to be final, and how often it reads them meanwhile. */
  readonly waitMs: number;
  readonly pollMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isFinal = (state: RunState) => (FINAL_STATES as readonly RunState[]).includes(state);

/** Whether run `runId` exists only for its agent's learning: an audit's shadow, a replay (a check's or an owner's), or a
 *  built-in learning run, by its launch. A run with no launch read here is the agent's own. */
async function learningOnly(store: Store, runId: string): Promise<boolean> {
  if (isShadowRun(runId)) return true;
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), (error: unknown) => (error instanceof StoreLaunchMissing ? undefined : Promise.reject(error)));
  return launch !== undefined && (launch.replay !== undefined || launch.audit !== undefined || launch.harness === "learning");
}

/** The agent's runs not final, its built-in learning runs included, each with whether it exists only for learning. */
async function goingOf(store: Store, agentId: string): Promise<{ id: string; learning: boolean }[]> {
  const going = (await store.runs.every(agentId)).filter((run) => !isFinal(run.state));
  return Promise.all(going.map(async (run) => ({ id: run.id, learning: await learningOnly(store, run.id) })));
}

const busy = (agentId: string, runs: readonly string[], why: string, retryMs = 5_000) =>
  new ApiError("learning_busy", `The agent ${agentId}'s learning was not reset: ${why} (${runs.slice(0, 5).join(", ")}${runs.length > 5 ? ` and ${runs.length - 5} more` : ""}). Nothing of its learning was deleted: send the DELETE again once ${runs.length === 1 ? "it has" : "they have"} ended.`, { details: { runs: [...runs] }, retry_after_ms: retryMs });

const OWN = (n: number) => (n === 1 ? "a run of its own is still going, and its learning lives in it" : `${n} runs of its own are still going, and their learning lives in them`);

/** Agent `agentId`'s learning reset in the two steps above. Throws ApiError learning_busy, nothing of its learning
 *  deleted, while a run of the agent's own is going or its learning runs cannot be stopped in time. */
export async function resetLearning(host: LearningResetHost, agentId: string): Promise<void> {
  // 1. Its own runs refuse the reset before anything is cancelled; its learning runs are cancelled and waited for.
  const going = await goingOf(host.store, agentId);
  const own = going.filter((run) => !run.learning).map((run) => run.id);
  if (own.length) throw busy(agentId, own, OWN(own.length));
  await stopLearningRuns(host, agentId, going.map((run) => run.id));

  // 2. In the agent's learning queue: nothing going (a run started meanwhile refuses it), then its learning deleted.
  await host.inQueue(agentId, async () => {
    const still = await goingOf(host.store, agentId);
    if (still.length) throw busy(agentId, still.map((run) => run.id), still.some((run) => !run.learning) ? OWN(still.filter((run) => !run.learning).length) : "its learning work started again");
    // What the agent's kept runs carry of their revisions' compile and check, kept before the records it is read from go.
    await keepResetLedger(host.store.settings, agentId, await promotionsOf(host.store.learning, agentId));
    // The watermark, before anything goes: learning reads no run that started, or read its seed, at or before it (each
    // seed is read in this queue, so one read before this moment never holds a later time). A seed read in the same
    // millisecond counts as before it: its run learns nothing (reason reset) and an SDK start is refused, to start again,
    // never a run given what the reset deleted; the reset answers only once the clock is past it (below), so no seed read
    // after its answer shares it. Set first, so no moment has the folder gone and the old runs
    // still read. A delete refused before it removed anything (LearningInFlight) puts the earlier one back, its learning
    // left as it was; one that failed on the way (a disk, a file, a record) may have removed some of it, so the watermark
    // stays and the next call finishes the reset: the old runs never feed a compile into a folder emptied part way.
    const earlier = await resetAtOf(host.store.settings, agentId);
    const at = Date.now();
    await keepResetAt(host.store.settings, agentId, at);
    try {
      await host.deleteLearning(host.store, agentId, { keepResetLedger: true });
    } catch (error) {
      if (!(error instanceof LearningInFlight)) throw error;
      await (earlier === undefined ? host.store.settings.remove(resetAtKey(agentId)) : keepResetAt(host.store.settings, agentId, earlier));
      throw busy(agentId, error.runs, "its learning work is in flight");
    }
    // The answer, only once the clock is past the watermark, still holding the queue: a reset with nothing to wait for
    // can end in the millisecond it began, and a seed read or a run started after its answer must never read as before
    // it (at most a millisecond's wait).
    while (Date.now() <= at) await sleep(1);
  });
}

/** Step 1's second half: each learning run cancelled once, then read again until each is final. One this server cannot
 *  end, or one still going at the wait's end, is learning_busy. */
async function stopLearningRuns(host: LearningResetHost, agentId: string, runs: readonly string[]): Promise<void> {
  if (!runs.length) return;
  const unended: string[] = [];
  for (const runId of runs) if (!(await host.cancel(runId))) unended.push(runId);
  if (unended.length) throw busy(agentId, unended, `its learning work is in ${unended.length === 1 ? "a run" : "runs"} this server cannot end`);
  const deadline = Date.now() + host.waitMs;
  for (;;) {
    const states = new Map((await host.store.runs.every(agentId)).map((run) => [run.id, run.state]));
    // A run no longer there is ended.
    const live = runs.filter((runId) => !isFinal(states.get(runId) ?? "ended"));
    if (!live.length) return;
    if (Date.now() >= deadline) throw busy(agentId, live, `its learning work was cancelled and ${live.length === 1 ? "one run has" : `${live.length} runs have`} not ended yet`, 2_000);
    await sleep(host.pollMs);
  }
}
