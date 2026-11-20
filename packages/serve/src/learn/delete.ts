// An agent's learning, deleted: the learning half of an agent's delete, and the whole of a reset of its learning. Its
// callers stop the agent's learning work first: DELETE /v2/agents/{id} stops all its runs, calls deleteLearning, then
// deletes the agent's store rows, in that order, so a call again after a crash finishes what a first one began and no
// learning is left with no agent to own it; DELETE /v2/agents/{id}/learning (learning-reset.ts) keeps the agent and its
// runs.
import { isWorkspaceError } from "../workspace/workspace.js";
import { FINAL_STATES, type Store } from "../store/store.js";
import type { LearningFolder } from "./folder.js";
import { gradesKey, promotionsKey, resetLedgerKey } from "./promote.js";

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

/** Agent `agentId`'s learning deleted: its learning folder on each other disk it is on (`elsewhere`: a Mode 2 run's end
 *  writes it on the Archil disk its claim mounted; server.ts names those disks), then every file of its learning folder
 *  here (`folder`, learning.ts learningFolderOf: its corrections.md and workflows, its git history and snapshot,
 *  audits.jsonl), then the learning records the store keeps for it (its promotions and grades, and the reset ledger its
 *  earlier resets kept, unless `keepResetLedger`: a reset keeps it, the runs it costs staying). Refused
 *  (LearningInFlight), with nothing removed, while a run of the agent has not ended; `elsewhere` failing leaves this
 *  folder and the records for the next call. Idempotent: what is gone already is skipped, so a second call removes
 *  nothing. `files`: this folder's entries it removed; `records`: the store's records. `folder` is ended here. */
export async function deleteLearning(store: Store, agentId: string, folder: LearningFolder, { keepResetLedger = false, elsewhere }: { keepResetLedger?: boolean; elsewhere?: () => Promise<void> } = {}): Promise<{ files: number; records: number }> {
  try {
    const open = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && !FINAL_STATES.includes(run.state)).map((run) => run.id);
    if (open.length) throw new LearningInFlight(agentId, open);
    await elsewhere?.();
    const entries = await folder.workspace.list("").catch((error: unknown) => (isWorkspaceError(error, "NOT_FOUND") ? [] : Promise.reject(error)));
    for (const entry of entries) await folder.workspace.remove(entry.name, { recursive: true, force: true });
    let records = 0;
    for (const key of [promotionsKey(agentId), gradesKey(agentId), ...(keepResetLedger ? [] : [resetLedgerKey(agentId)])]) {
      if ((await store.settings.get(key)) === undefined) continue;
      await store.settings.remove(key);
      records += 1;
    }
    return { files: entries.length, records };
  } finally {
    await folder.end();
  }
}
