// An agent's learning, deleted: the learning half of an agent's delete. Its caller (DELETE /v2/agents/{id}) stops the
// agent's runs and learning work first, then calls deleteLearning, then deletes the agent's store rows, in that order:
// a call again after a crash finishes what a first one began, and no learning is left with no agent to own it.
import { isWorkspaceError } from "../workspace/workspace.js";
import { FINAL_STATES, type Store } from "../store/store.js";
import type { LearningFolder } from "./folder.js";
import { gradesKey, promotionsKey } from "./promote.js";
import { learningIdOf } from "./learning-of.js";

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

/** Agent `agentId`'s learning deleted: every file of its learning folder (`folder`, learning.ts learningFolderOf: its
 *  corrections.md and workflows, its git history and snapshot, audits.jsonl), then the learning records the store keeps
 *  for it (its promotions and grades). Refused (LearningInFlight), with nothing removed, while a run of the agent has not
 *  ended. Idempotent: what is gone already is skipped, so a second call removes nothing. `files`: the folder's entries it
 *  removed; `records`: the store's records. `folder` is ended here. */
export async function deleteLearning(store: Store, agentId: string, folder: LearningFolder): Promise<{ files: number; records: number }> {
  try {
    const runs = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
    const open = runs.filter((run) => !FINAL_STATES.includes(run.state)).map((run) => run.id);
    if (open.length) throw new LearningInFlight(agentId, open);
    const entries = await folder.workspace.list("").catch((error: unknown) => (isWorkspaceError(error, "NOT_FOUND") ? [] : Promise.reject(error)));
    for (const entry of entries) await folder.workspace.remove(entry.name, { recursive: true, force: true });
    let records = 0;
    // Its records on every disk it learned on (learn/learning-of.ts): the default disk's, and each named disk a run of it
    // was on.
    const learnings = [null, ...new Set(runs.map((run) => run.disk).filter((disk): disk is string => disk !== null))].map((disk) => learningIdOf({ agentId, disk }));
    for (const key of learnings.flatMap((learning) => [promotionsKey(learning), gradesKey(learning)])) {
      if ((await store.settings.get(key)) === undefined) continue;
      await store.settings.remove(key);
      records += 1;
    }
    return { files: entries.length, records };
  } finally {
    await folder.end();
  }
}
