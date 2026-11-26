// A claim of a run started while its agent's learning round was going: its launch's learning start names those runs
// (`after`, learning-rounds.ts openRoundsOf: runs looking back after their job's end, or running a follow-up turn, whose
// round keeps the owner's words as a line of corrections.md). Its seed was read at its start, before that round merged,
// so its first claim waits for each of those rounds to end, bounded (the runner's AGENTRUN_LEARNING_ROUND_WAIT_MS, else
// ROUND_WAIT_MS), reads the agent's seed again and writes it as the run's learning start (store.runs.reseedLearning),
// without `after` and with how the wait ended (`waited`), before the run's spec reads its launch: its # Learned text, the
// merge base of its own round (learning-end.ts) and what its view says it started from are then the one start.
// Only before the run's first turn: a claim after one (a crash, a lost claim) keeps the start it ran on, since its round
// merges against that seed. A run started with no round going names none and is claimed as it always was.
import { roundOpen } from "../learning-rounds.js";
import { type Shown, secretsShown, seedOf } from "../learning.js";
import { readLaunchBody, type RunLaunch, type SeedWaited } from "../run-launch.js";
import { startOfSeed } from "../runs-over-store.js";
import type { RunLaunchRow, Store } from "../store/index.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalEntries } from "./journal-reader.js";
import { runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";

/** The longest a first claim waits on its agent's open rounds by default before it reads the seed as it is. */
export const ROUND_WAIT_MS = 3 * 60_000;
/** The runner's own bound, in milliseconds (a whole number, 0 for no wait). */
export const ROUND_WAIT_ENV = "AGENTRUN_LEARNING_ROUND_WAIT_MS";
/** How often the wait reads the open rounds' runs. */
const POLL_MS = 250;

/** The bound runner environment `env` sets (ROUND_WAIT_ENV), else ROUND_WAIT_MS. */
export function roundWaitMsOf(env: NodeJS.ProcessEnv): number {
  const set = env[ROUND_WAIT_ENV]?.trim();
  const ms = set ? Number(set) : NaN;
  return Number.isInteger(ms) && ms >= 0 ? ms : ROUND_WAIT_MS;
}

/** What the read reads with: the store, the data directory (the agent's learning queue, learning.ts seedOf), the host's
 *  secrets as the run's start cut its corrections with (`shown`), the log, the bound, and for tests the clock. */
export interface ReseedDeps {
  readonly store: Pick<Store, "runs" | "learning" | "readJournal" | "commands">;
  readonly data: string;
  readonly shown: () => Promise<Shown>;
  readonly log: (line: string) => void;
  readonly waitMs: number;
  readonly now?: () => number;
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The runner's `shown`, as a run's spec cuts what it lays (adapter-run-spec.ts): the runner's secrets and the store's. */
export const runnerShown = (deps: { readonly env: NodeJS.ProcessEnv; readonly store: Store; readonly sealKey: Buffer | undefined; readonly data: string }) => async (): Promise<Shown> =>
  secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true });

/** Whether run `runId` (its row `epoch`) has taken no turn yet: its first claim (epoch 1) and nothing in its journal. */
async function beforeFirstTurn(store: ReseedDeps["store"], runId: string, epoch: number): Promise<boolean> {
  if (epoch > 1) return false;
  return (await journalEntries(store.readJournal(runId), BACKGROUND_CONTEXT)).length === 0;
}

/** A claim's read of run `runId`'s launch (the dispatch's launchOf): the stored row, but for a run whose learning start
 *  names open rounds (`after`) and that has taken no turn yet, whose start is first read again once they end, bounded,
 *  and written in place. A read that fails writes the start it had, without `after`; a learning fault never stops a run. */
export function reseededLaunchOf(deps: ReseedDeps): (runId: string) => Promise<RunLaunchRow> {
  const now = deps.now ?? Date.now;
  return async (runId) => {
    const row = await deps.store.runs.launch(runId);
    const start = readLaunchBody(row.body)?.learning;
    if (!start?.after?.length) return row;
    const { after, ...started } = start;
    const run = await deps.store.runs.get(runId);
    // A run that took a turn already keeps the start it ran on, whatever its body still names.
    if (!run || !(await beforeFirstTurn(deps.store, runId, run.epoch).catch(() => false))) return row;
    const until = now() + deps.waitMs;
    const open = new Set(after);
    for (;;) {
      for (const id of [...open]) {
        const other = await deps.store.runs.get(id).catch(() => undefined);
        if (!other || !(await roundOpen(deps.store, other).catch(() => false))) open.delete(id);
      }
      if (!open.size || now() >= until) break;
      // The run's own end (a person's cancel while it waited) ends the wait too: its start is left as it is.
      const own = await deps.store.runs.get(runId).catch(() => undefined);
      if (!own || own.state !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const waited: SeedWaited = open.size ? "timed_out" : "ended";
    if (open.size) deps.log(`run ${runId}: starts from its agent's learning as it is now: its open round${open.size === 1 ? "" : "s"} (${[...open].join(", ")}) did not end within ${Math.round(deps.waitMs / 1000)} s`);
    const own: Pick<NonNullable<RunLaunch["learning"]>, "use" | "noWorkflows" | "model"> = { ...(start.noWorkflows ? { noWorkflows: true as const } : {}), ...(start.use ? { use: true as const } : {}), ...(start.model ? { model: start.model } : {}) };
    try {
      await deps.store.runs.reseedLearning(runId, { ...startOfSeed(await seedOf(deps.data, deps.store, run.agentId), await deps.shown(), own), waited });
    } catch (error) {
      deps.log(`run ${runId}: starts from the learning its start read: its agent's could not be read again: ${said(error)}`);
      // The start it had, without `after`: a later claim never waits on those rounds again.
      await deps.store.runs.reseedLearning(runId, started).catch(() => undefined);
    }
    return deps.store.runs.launch(runId).catch(() => row);
  };
}
