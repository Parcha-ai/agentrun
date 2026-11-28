// The `learning` a learning child's grade reads (its agree_on: runner/adapter-run-spec.ts graderRouteOf,
// run-child-host.ts): the loop numbers the run that started it asked to learn with, else its revision's definition's
// (learning-setting.ts runLearningOf). A check's replay run carries its run's learning start in its own launch
// (runner/promotion.ts); an audit's shadow runs with learning off, so its served run's launch (`audit.of`) is read.
import { runLearningOf } from "../learning-setting.js";
import { readLaunchBody, type RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";

/** The `learning` run `launch`'s grade compares on: its own launch's settings, else (a shadow) its served run's, else
 *  `body`'s (its revision's definition). A served run's launch that can't be read reads as none. */
export async function childLearningOf(store: Pick<Store, "runs">, launch: RunLaunch, body: unknown): Promise<unknown> {
  if (launch.learning?.settings) return runLearningOf(launch, body);
  const served = launch.audit ? await store.runs.launch(launch.audit.of).then((one) => readLaunchBody(one.body), () => undefined) : undefined;
  return runLearningOf(served, body);
}
