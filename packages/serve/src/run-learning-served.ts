// GET /runs/{id}/learning over the store: the run's learning view (store-reads/learning.ts runLearningOverStore), cut by the
// run's one cut (run-cut.ts) as its words are: every secret this server keeps and every sign-in pointer the run was
// handed, so a note's name or a proposal's words holding one shows none of it. A run whose hand can't be read back here
// is refused (403, in the view's words), as its graph and its files are.
import { ApiError } from "./errors.js";
import { secretsShown } from "./learning.js";
import { runCutValues } from "./run-cut.js";
import { type SignInReader, WITHHELD_SIGN_IN } from "./run-view.js";
import { runLearningOverStore } from "./store-reads/learning.js";
import { runDiffOverStore } from "./learning-routes.js";
import type { Store } from "./store/store.js";

/** Run `runId`'s learning as GET /runs/{id}/learning serves it, or ApiError forbidden for a withheld run. */
export async function servedRunLearning(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Store, runId: string) {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return runLearningOverStore(store, runId, secretsShown(cut.values), cut.values);
}

/** Run `runId`'s learning diff as GET /runs/{id}/learning/diff serves it (learning-routes.ts runDiffOverStore), cut by the
 *  run's one cut, or ApiError forbidden for a withheld run. */
export async function servedRunDiff(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Store, data: string, runId: string) {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return runDiffOverStore(data, store, runId, secretsShown(cut.values));
}
