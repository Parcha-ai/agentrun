// An agent's learning settings as every agent-level reader takes them: those of its newest run that asked to learn (its
// launch's `learning.settings`, RunCreate `learning: {settings}`), else its revision's definition's `learning`. One rule,
// read here alone: the agent view's pending count, the promotions and loop reads, an owner's replay and an audit's hold.
// So an agent whose revision has no learning never reads empty while a run of it learns. A run's own loop reads its own
// launch first (learning-setting.ts runLearningOf); this is the agent's.
//
// The newest run that asked is named in one settings row per agent (`agent.run_learning.<agent id>`: its run id and
// start time), written when that run is started (runs-over-store.ts startRun); its settings are read from the run's
// launch, so a run gone (purged) reads as none and the revision's stand.
import { type LearningLoop, runLearningOf } from "./learning-setting.js";
import { readLaunchBody } from "./run-launch.js";
import type { Settings, Store } from "./store/store.js";
import { isObject } from "./validate.js";

/** The settings row naming agent `agentId`'s newest run that asked to learn. */
export const agentRunLearningKey = (agentId: string): string => `agent.run_learning.${agentId}`;

type Asked = { readonly run: string; readonly at: number };
const askedOf = (value: unknown): Asked | undefined => (isObject(value) && typeof value.run === "string" && typeof value.at === "number" ? { run: value.run, at: value.at } : undefined);

/** Names run `runId` (started at `at`, ms) as agent `agentId`'s newest run that asked to learn, unless one started later
 *  is named already: one guarded write, so of two starts at once the later one stays. */
export async function noteRunLearning(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, agentId: string, runId: string, at: number): Promise<void> {
  const key = agentRunLearningKey(agentId);
  const value = { run: runId, at };
  for (let tries = 0; tries < 20; tries++) {
    const was = await settings.get(key);
    const named = askedOf(was);
    if (named && (named.at > at || (named.at === at && named.run >= runId))) return;
    if (was === undefined) {
      const saved = askedOf(await settings.putIfAbsent(key, value));
      if (saved?.run === runId) return;
      continue;
    }
    if (await settings.replaceIf(key, was, value)) return;
  }
}

/** The settings agent `agentId`'s newest run that asked to learn started with (its launch's `learning.settings`), or
 *  undefined when none asked or its row or launch can't be read. */
export async function askedLearningOf(store: Pick<Store, "settings" | "runs">, agentId: string): Promise<LearningLoop | undefined> {
  const named = askedOf(await Promise.resolve().then(() => store.settings.get(agentRunLearningKey(agentId))).catch(() => undefined));
  const launch = named ? await Promise.resolve().then(() => store.runs.launch(named.run)).then((one) => readLaunchBody(one.body), () => undefined) : undefined;
  return launch?.learning?.settings;
}

/** The `learning` agent `agentId`'s agent-level readers take: its newest run that asked to learn's settings
 *  (askedLearningOf), else `revisionBody`'s (its current revision's definition) `learning`. */
export async function learningOfAgentNow(store: Pick<Store, "settings" | "runs">, agentId: string, revisionBody: unknown): Promise<unknown> {
  const settings = await askedLearningOf(store, agentId);
  return runLearningOf(settings ? { learning: { settings } } : undefined, revisionBody);
}
