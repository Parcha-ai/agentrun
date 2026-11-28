// An agent's learning, deleted: the learning half of an agent's delete, and the whole of a reset of its learning. Its
// callers stop the agent's learning work first: DELETE /v2/agents/{id} stops all its runs, calls deleteLearning, then
// deletes the agent's store rows, in that order, so a call again after a crash finishes what a first one began and no
// learning is left with no agent to own it; DELETE /v2/agents/{id}/learning (learning-reset.ts) keeps the agent and its
// runs.
import { FINAL_STATES, type Store } from "../store/store.js";
import { resetAtKey, resetLedgerKey } from "./promote.js";

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

/** Agent `agentId`'s learning deleted: every learning row the store keeps for it (Store.learning: its items, saves,
 *  promotions, grades and audits), and the reset ledger and watermark its earlier resets kept, unless `keepResetLedger`
 *  (a reset keeps them, the runs they cover staying). Refused (LearningInFlight), with nothing removed, while a run of
 *  the agent has not ended. Idempotent: a second call removes nothing. `records`: the settings rows it removed. */
export async function deleteLearning(store: Store, agentId: string, { keepResetLedger = false }: { keepResetLedger?: boolean } = {}): Promise<{ records: number }> {
  const open = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && !FINAL_STATES.includes(run.state)).map((run) => run.id);
  if (open.length) throw new LearningInFlight(agentId, open);
  await (keepResetLedger ? store.learning.reset(agentId) : store.learning.erase(agentId));
  let records = 0;
  for (const key of keepResetLedger ? [] : [resetLedgerKey(agentId), resetAtKey(agentId)]) {
    if ((await store.settings.get(key)) === undefined) continue;
    await store.settings.remove(key);
    records += 1;
  }
  return { records };
}
