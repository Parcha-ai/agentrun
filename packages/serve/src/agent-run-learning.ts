// An agent's learning settings as every agent-level reader takes them: the newer of its newest run that asked to learn
// (its launch's `learning.settings`, RunCreate `learning: {settings}`) and its current revision (its definition's
// `learning`). A revision saved after that run started wins (one saying `learning: false`, or none, reads as not
// learning); a run that asks after that save wins again. One rule, read here alone: the agent view's pending count, the
// promotions and loop reads, an owner's replay and an audit's hold. So an agent whose revision has no learning never reads
// empty while a run of it learns. A run's own loop reads its own launch first (learning-setting.ts runLearningOf); this is
// the agent's.
//
// The newest run that asked is named in one settings row per agent (`agent.run_learning.<agent id>`: its run id and the
// time its start named it), written before that run is made (runs-over-store.ts startRun): a write that fails refuses the
// start, nothing made, and a start that then fails puts back the row it replaced. Its settings are read from the run's
// launch, so a row naming a run that does not exist (never made, or purged) is ignored and the revision's stand.
import { type LearningLoop, runLearningOf } from "./learning-setting.js";
import { readLaunchBody } from "./run-launch.js";
import type { Settings, Store } from "./store/store.js";
import { isObject } from "./validate.js";

/** The settings row naming agent `agentId`'s newest run that asked to learn. */
export const agentRunLearningKey = (agentId: string): string => `agent.run_learning.${agentId}`;

type Asked = { readonly run: string; readonly at: number };
const askedOf = (value: unknown): Asked | undefined => (isObject(value) && typeof value.run === "string" && typeof value.at === "number" ? { run: value.run, at: value.at } : undefined);

/** A run named its agent's newest that asked; `undo` puts back the row it replaced while the row still names it (its
 *  start failed: no run of that id was made). */
export type RunLearningNamed = { readonly undo: () => Promise<void> };

/** Names run `runId` (its start at `at`, ms) as agent `agentId`'s newest run that asked to learn, unless one named at a
 *  later time is there already: one guarded write, so of two starts at once the later one stays. Throws when the row
 *  can't be written: its start is refused before anything is made. */
export async function noteRunLearning(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf" | "removeIf">, agentId: string, runId: string, at: number): Promise<RunLearningNamed> {
  const key = agentRunLearningKey(agentId);
  const value = { run: runId, at };
  const none: RunLearningNamed = { undo: async () => {} };
  for (let tries = 0; tries < 20; tries++) {
    const was = await settings.get(key);
    const named = askedOf(was);
    if (named && (named.at > at || (named.at === at && named.run >= runId))) return none;
    const written = was === undefined ? askedOf(await settings.putIfAbsent(key, value))?.run === runId : await settings.replaceIf(key, was, value);
    if (written) return { undo: async () => void (await (was === undefined ? settings.removeIf(key, value) : settings.replaceIf(key, value, was))) };
  }
  throw new Error(`The run's learning settings could not be named for its agent ${agentId}: the row kept changing under 20 tries.`);
}

/** The settings agent `agentId`'s newest run that asked to learn started with (its launch's `learning.settings`), when
 *  it was named no earlier than `savedAt` (its current revision's save, ms; a revision saved later wins); undefined when
 *  none asked, a later revision wins, or its row or its run's launch can't be read (a run never made or purged). */
export async function askedLearningOf(store: Pick<Store, "settings" | "runs">, agentId: string, savedAt?: number): Promise<LearningLoop | undefined> {
  const named = askedOf(await Promise.resolve().then(() => store.settings.get(agentRunLearningKey(agentId))).catch(() => undefined));
  if (!named || (savedAt !== undefined && savedAt > named.at)) return undefined;
  const launch = await Promise.resolve().then(() => store.runs.launch(named.run)).then((one) => readLaunchBody(one.body), () => undefined);
  return launch?.learning?.settings;
}

/** The `learning` agent `agentId`'s agent-level readers take: its newest run that asked to learn's settings when that
 *  run was named no earlier than `revision` was saved (askedLearningOf), else `revision`'s definition's `learning`.
 *  `savedAt`: the save time to compare with, when not `revision`'s own (the hold reads the served run's revision, compared
 *  at the agent's current one's save). */
export async function learningOfAgentNow(store: Pick<Store, "settings" | "runs">, agentId: string, revision: { readonly body: unknown; readonly createdAt: number } | null | undefined, savedAt = revision?.createdAt): Promise<unknown> {
  const settings = await askedLearningOf(store, agentId, savedAt);
  return runLearningOf(settings ? { learning: { settings } } : undefined, revision?.body);
}
