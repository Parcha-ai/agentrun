// An agent's learning, deleted: the learning half of an agent's delete, and the whole of a reset of its learning. Its
// callers stop the agent's learning work first: DELETE /v2/agents/{id} stops all its runs, calls deleteLearning, then
// deletes the agent's store rows, in that order, so a call again after a crash finishes what a first one began and no
// learning is left with no agent to own it; DELETE /v2/agents/{id}/learning (learning-reset.ts) keeps the agent and its
// runs.
import { FINAL_STATES, type Store } from "../store/store.js";
import type { LearningStore } from "./store.js";
import { gradesKey, promotionsKey, resetAtKey, resetLedgerKey } from "./promote.js";

/** A delete refused: work of the agent's learning is still in flight (`runs`: a run of the agent not ended, its
 *  compile turn, a check's replay or an audit's shadow among them). Nothing was removed. */
export class LearningInFlight extends Error {
  readonly runs: readonly string[];
  constructor(agentId: string, runs: readonly string[]) {
    super(`agent ${agentId}'s learning is at work in ${runs.slice(0, 5).join(", ")}${runs.length > 5 ? ` and ${runs.length - 5} more` : ""}: stop them, then delete`);
    this.name = "LearningInFlight";
    this.runs = runs;
  }
}

/** Agent `agentId`'s learning deleted: its learning store removed whole (`learning`, learn/store-of.ts
 *  learningStoreOf: its corrections.md and workflows, its audit ledger, every commit of its history), then the learning
 *  records the server's store keeps for it (its promotions and grades, and the reset ledger and watermark its earlier
 *  resets kept, unless `keepResetLedger`: a reset keeps them, the runs they cover staying). Refused (LearningInFlight),
 *  with nothing removed, while a run of the agent has not ended. Idempotent: what is gone already is skipped, so a
 *  second call removes nothing. `learned`: whether the learning store had a main; `records`: the server store's
 *  records it removed. */
export async function deleteLearning(store: Store, agentId: string, learning: LearningStore, { keepResetLedger = false }: { keepResetLedger?: boolean } = {}): Promise<{ learned: boolean; records: number }> {
  const open = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && !FINAL_STATES.includes(run.state)).map((run) => run.id);
  if (open.length) throw new LearningInFlight(agentId, open);
  const learned = (await learning.head()) !== null;
  // An agent's delete erases every trace in the store (code.storage: each of its repository generations); a reset starts
  // the store again empty.
  await learning.remove({ erase: !keepResetLedger });
  let records = 0;
  for (const key of [promotionsKey(agentId), gradesKey(agentId), ...(keepResetLedger ? [] : [resetLedgerKey(agentId), resetAtKey(agentId)])]) {
    if ((await store.settings.get(key)) === undefined) continue;
    await store.settings.remove(key);
    records += 1;
  }
  return { learned, records };
}
