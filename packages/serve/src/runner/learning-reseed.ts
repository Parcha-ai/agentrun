// A claim of a run started while its agent's learning round was open: its launch's learning start names those runs
// (`after`, runs-over-store.ts openRoundsOf: runs still going whose owner sent a follow-up or a grade's words, which
// their round keeps as a line of corrections.md at its end). Its seed was read at its start, before that round merged,
// so the claim waits for each of them to end, bounded (ROUND_WAIT_MS), reads the agent's seed again and writes it as the
// run's learning start (store.runs.reseedLearning) before the run's spec reads its launch: its # Learned text, the merge
// base of its own round and what its view says it started from are then the one start. A run started with no round open
// names none and is claimed as it always was: no wait, no read, no write.
import { type Shown, secretsShown, seedOf } from "../learning.js";
import { readLaunchBody, type RunLaunch } from "../run-launch.js";
import { startOfSeed } from "../runs-over-store.js";
import { FINAL_STATES, type RunLaunchRow, type Store } from "../store/index.js";
import { runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";

/** The longest a claim waits on its agent's open rounds before it starts from the seed it has. */
export const ROUND_WAIT_MS = 3 * 60_000;
/** How often the wait reads the open rounds' runs. */
const POLL_MS = 250;

/** What the read reads with: the store, the data directory (the agent's learning queue, learning.ts seedOf), the host's
 *  secrets as the run's start cut its corrections with (`shown`), the log, and for tests the bound and the clock. */
export interface ReseedDeps {
  readonly store: Pick<Store, "runs" | "learning">;
  readonly data: string;
  readonly shown: () => Promise<Shown>;
  readonly log: (line: string) => void;
  readonly waitMs?: number;
  readonly now?: () => number;
}

const isFinal = (state: string): boolean => (FINAL_STATES as readonly string[]).includes(state);
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The runner's `shown`, as a run's spec cuts what it lays (adapter-run-spec.ts): the runner's secrets and the store's. */
export const runnerShown = (deps: { readonly env: NodeJS.ProcessEnv; readonly store: Store; readonly sealKey: Buffer | undefined; readonly data: string }) => async (): Promise<Shown> =>
  secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true });

/** A claim's read of run `runId`'s launch (the dispatch's launchOf): the stored row, but for a run whose learning start
 *  names open rounds (`after`), whose start is first read again once they end, bounded, and written in place. A read or
 *  a write that fails leaves the start its run's start read: a learning fault never stops a run. */
export function reseededLaunchOf(deps: ReseedDeps): (runId: string) => Promise<RunLaunchRow> {
  const now = deps.now ?? Date.now;
  return async (runId) => {
    const row = await deps.store.runs.launch(runId);
    const start = readLaunchBody(row.body)?.learning;
    if (!start?.after?.length) return row;
    const run = await deps.store.runs.get(runId);
    if (!run) return row;
    const until = now() + (deps.waitMs ?? ROUND_WAIT_MS);
    const open = new Set(start.after);
    for (;;) {
      for (const id of [...open]) {
        const other = await deps.store.runs.get(id).catch(() => undefined);
        if (!other || isFinal(other.state)) open.delete(id);
      }
      if (!open.size || now() >= until) break;
      // The run's own end (a person's cancel while it waited) ends the wait too.
      const own = await deps.store.runs.get(runId).catch(() => undefined);
      if (!own || isFinal(own.state)) return row;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (open.size) deps.log(`run ${runId}: starts from its agent's learning as it is now, its open round${open.size === 1 ? "" : "s"} (${[...open].join(", ")}) not ended after ${Math.round((deps.waitMs ?? ROUND_WAIT_MS) / 1000)} s`);
    const own: Pick<NonNullable<RunLaunch["learning"]>, "use" | "noWorkflows" | "model"> = { ...(start.noWorkflows ? { noWorkflows: true as const } : {}), ...(start.use ? { use: true as const } : {}), ...(start.model ? { model: start.model } : {}) };
    try {
      const learning = startOfSeed(await seedOf(deps.data, deps.store, run.agentId), await deps.shown(), own);
      await deps.store.runs.reseedLearning(runId, learning);
      return await deps.store.runs.launch(runId);
    } catch (error) {
      deps.log(`run ${runId}: starts from the learning its start read: its agent's could not be read again: ${said(error)}`);
      return row;
    }
  };
}
