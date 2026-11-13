// GET /runs/{id}/learning and GET /runs/{id}/learning/diff over the store: the run's learning view (store-reads/learning.ts
// runLearningOverStore) and its learning diff (learning-routes.ts runDiffOverStore), each cut by the run's one cut
// (run-cut.ts) as its words are: every secret this server keeps and every sign-in pointer the run was handed, and every
// pointer of its agent's own sign-ins, live and forgotten (agentPointers), as the agent's learning routes cut them, so a
// note's name, a patch or a proposal's words holding one shows none of it. A run whose hand can't be read back here is
// refused (403, in the view's words), as its graph and its files are; so is one whose agent's sign-in can't be.
import { ApiError } from "./errors.js";
import { agentPointers, WITHHELD_LEARNING } from "./handed-values.js";
import { type ItemStatus, secretsShown } from "./learning.js";
import { runCutValues } from "./run-cut.js";
import { type SignInReader, WITHHELD_SIGN_IN } from "./run-view.js";
import { runLearningOverStore } from "./store-reads/learning.js";
import { runDiffOverStore } from "./learning-routes.js";
import type { Store } from "./store/store.js";

/** What run `runId`'s learning reads are cut of: the run's one cut and its agent's own sign-in pointers. ApiError forbidden
 *  for a withheld run, and for one whose agent has a pointer that can't be read here (its learning may hold it). */
async function learningCutOf(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Store, runId: string): Promise<string[]> {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const agentId = (await store.runs.get(runId))?.agentId;
  const pointers = agentId ? await agentPointers(deps.signIns, agentId) : [];
  if (pointers === "unreadable") throw new ApiError("forbidden", WITHHELD_LEARNING);
  return [...cut.values, ...pointers];
}

/** Run `runId`'s learning as GET /runs/{id}/learning serves it, or ApiError forbidden for a withheld run. */
export async function servedRunLearning(deps: { serverSecrets: () => string[]; signIns?: SignInReader; statuses?: (agentId: string) => Promise<ReadonlyMap<string, ItemStatus> | undefined> }, store: Store, runId: string) {
  const values = await learningCutOf(deps, store, runId);
  return runLearningOverStore(store, runId, secretsShown(values), values, deps.statuses);
}

/** Run `runId`'s learning diff as GET /runs/{id}/learning/diff serves it (learning-routes.ts runDiffOverStore), cut as its
 *  learning is, or ApiError forbidden for a withheld run. */
export async function servedRunDiff(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Store, data: string, runId: string) {
  return runDiffOverStore(data, store, runId, secretsShown(await learningCutOf(deps, store, runId)));
}
