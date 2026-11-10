// GET /runs/{id}/learning over the store: the run's learning view (store-reads/learning.ts runLearningOverStore), cut by the
// run's one cut (run-cut.ts) as its words are: every secret this server keeps and every sign-in pointer the run was
// handed, and every pointer of its agent's own sign-ins, live and forgotten (agentPointers), as the agent's learning routes
// cut them, so a note's name or a proposal's words holding one shows none of it. A run whose hand can't be read back here
// is refused (403, in the view's words), as its graph and its files are.
import { ApiError } from "./errors.js";
import { agentPointers, WITHHELD_LEARNING } from "./handed-values.js";
import { secretsShown } from "./learning.js";
import { runCutValues } from "./run-cut.js";
import { type SignInReader, WITHHELD_SIGN_IN } from "./run-view.js";
import { runLearningOverStore } from "./store-reads/learning.js";
import type { Store } from "./store/store.js";

/** Run `runId`'s learning as GET /runs/{id}/learning serves it, or ApiError forbidden for a withheld run. */
export async function servedRunLearning(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Store, runId: string) {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const agentId = (await store.runs.get(runId))?.agentId;
  const pointers = agentId ? await agentPointers(deps.signIns, agentId) : [];
  // One of the agent's own pointers can't be read here: its learning may hold it, so it is withheld too.
  if (pointers === "unreadable") throw new ApiError("forbidden", WITHHELD_LEARNING);
  const values = [...cut.values, ...pointers];
  return runLearningOverStore(store, runId, secretsShown(values), values);
}
