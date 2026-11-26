// A claim of a run started while its agent's learning round was going: its launch's learning start names those runs
// (`after`, learning-rounds.ts openRoundsOf: runs looking back after their job's end, whose round keeps the owner's words
// as a line of corrections.md). Its seed was read at its start, before that round merged, so its claim waits for each of
// those rounds to end, bounded (the runner's AGENTRUN_LEARNING_ROUND_WAIT_MS, else ROUND_WAIT_MS), reads the agent's
// seed again and writes it as the run's learning start (store.runs.reseedLearning), without `after` and with how the wait
// ended (`waited`), before the run's spec reads its launch: its # Learned text, the merge base of its own round
// (learning-end.ts) and what its view says it started from are then the one start.
// Only before the run's first turn (its journal empty, its start still naming `after`): a claim after one (a crash, a
// lost claim) keeps the start it ran on, since its round merges against that seed. A claim handed back before any turn
// waits and reads again on its next claim, whatever its epoch; the store's claim fence keeps a stale claim from writing.
// A claim that cannot read its own row or journal before the wait hands the run back (CLAIM_GONE), tried again later.
// A run started with no round going names none and is claimed as it always was.
import { roundOpen } from "../learning-rounds.js";
import { type Shown, secretsShown, seedOf } from "../learning.js";
import { readLaunchBody, type RunLaunch, type SeedWaited } from "../run-launch.js";
import { startOfSeed } from "../runs-over-store.js";
import type { RunLaunchRow, RunRow, Store } from "../store/index.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CLAIM_GONE } from "./dispatch.js";
import { journalEntries } from "./journal-reader.js";
import { runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";

/** The longest a first claim waits on its agent's open rounds by default before it reads the seed as it is. */
export const ROUND_WAIT_MS = 3 * 60_000;
/** The runner's own bound, in milliseconds (a whole number, 0 for no wait). */
export const ROUND_WAIT_ENV = "AGENTRUN_LEARNING_ROUND_WAIT_MS";
/** The wait's first pause between reads of the open rounds' runs, and the most a later pause (doubling) grows to. */
export const POLL_FIRST_MS = 250;
export const POLL_MAX_MS = 2_000;

/** The pause after the wait's read number `pass` (from 0): POLL_FIRST_MS, doubling, at most POLL_MAX_MS. */
export const pollPauseMs = (pass: number): number => Math.min(POLL_FIRST_MS * 2 ** Math.min(pass, 16), POLL_MAX_MS);

/** The bound runner environment `env` sets (ROUND_WAIT_ENV), else ROUND_WAIT_MS. */
export function roundWaitMsOf(env: NodeJS.ProcessEnv): number {
  const set = env[ROUND_WAIT_ENV]?.trim();
  const ms = set ? Number(set) : NaN;
  return Number.isInteger(ms) && ms >= 0 ? ms : ROUND_WAIT_MS;
}

/** What the read reads with: the store, the data directory (the agent's learning queue, learning.ts seedOf), the host's
 *  secrets as the run's start cut its corrections with (`shown`), the log, the bound, and for tests the clock and the
 *  pause (`sleep`: resolves after `ms`, or at once when `signal` aborts). */
export interface ReseedDeps {
  readonly store: Pick<Store, "runs" | "learning" | "readJournal" | "commands">;
  readonly data: string;
  readonly shown: () => Promise<Shown>;
  readonly log: (line: string) => void;
  readonly waitMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolves after `ms`, or at once when `signal` aborts (never rejects). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The runner's `shown`, as a run's spec cuts what it lays (adapter-run-spec.ts): the runner's secrets and the store's. */
export const runnerShown = (deps: { readonly env: NodeJS.ProcessEnv; readonly store: Store; readonly sealKey: Buffer | undefined; readonly data: string }) => async (): Promise<Shown> =>
  secretsShown(runnerSecrets(deps.env, await storeSecrets(deps.store, deps.sealKey, deps.data)), { local: true });

/** A read of another run that failed: its round counts as still open (the wait goes on, to its bound at most). */
const UNREAD: unique symbol = Symbol("unread");

/** Whether run `id`'s round still counts as open: true when it is (roundOpen), or when a read of it failed. */
async function stillOpen(store: ReseedDeps["store"], id: string): Promise<boolean> {
  const other: RunRow | undefined | typeof UNREAD = await store.runs.get(id).catch((): typeof UNREAD => UNREAD);
  if (other === UNREAD) return true;
  if (!other) return false;
  return roundOpen(store, other).catch(() => true);
}

/** A claim's read of run `runId`'s launch (the dispatch's launchOf, under the claim at `epoch`): the stored row, but for a
 *  run whose learning start names open rounds (`after`) and that has taken no turn yet, whose start is first read again
 *  once they end, bounded, and written in place, fenced by the claim; the row returned is built from what was written.
 *  A read of the seed that fails writes the start it had, without `after`; a learning fault never stops a run. The wait
 *  ends at once:
 *  - CLAIM_GONE (the dispatch starts no loop) when the run is no longer this claim's: its epoch moved, it ended, or the
 *    fenced write was refused; and when its own row or journal could not be read before the wait (the run handed back,
 *    claimed again later: never failed for it, never started without the wait);
 *  - the row as it is, nothing written, when `signal` aborts: the claim lost, the runner closing, or a person's stop or
 *    cancel, which the runner hands the dispatch (dispatch.ts stop) and the dispatch applies to the loop it then starts.
 *  Between reads it pauses POLL_FIRST_MS, doubling to POLL_MAX_MS. A failed read of another run keeps its round open; a
 *  failed read of the run's own row is tried at the next read. The runner keeps renewing the claim's lease while this
 *  waits (runner.ts holds the claim before its loop's start, which reads this). */
export function reseededLaunchOf(deps: ReseedDeps): (runId: string, epoch: number, signal?: AbortSignal) => Promise<RunLaunchRow | typeof CLAIM_GONE> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? pause;
  return async (runId, epoch, signal) => {
    const row = await deps.store.runs.launch(runId);
    const start = readLaunchBody(row.body)?.learning;
    if (!start?.after?.length) return row;
    const { after, ...started } = start;
    const run = await deps.store.runs.get(runId).catch((): typeof UNREAD => UNREAD);
    if (run === UNREAD || !run || run.state !== "running" || run.epoch !== epoch) return CLAIM_GONE;
    // A run that took a turn already keeps the start it ran on, whatever its body still names.
    const entries = await journalEntries(deps.store.readJournal(runId), BACKGROUND_CONTEXT).catch((): typeof UNREAD => UNREAD);
    if (entries === UNREAD) return CLAIM_GONE;
    if (entries.length > 0) return row;
    const until = now() + deps.waitMs;
    const open = new Set(after);
    for (let pass = 0; ; pass++) {
      for (const id of [...open]) if (!(await stillOpen(deps.store, id))) open.delete(id);
      if (!open.size || now() >= until) break;
      if (signal?.aborted) return row;
      // The run's own end or a claim lost (its epoch moved) ends the wait with no loop; a person's stop or cancel aborts
      // `signal` (dispatch.ts stop). A read of its own row that fails is tried at the next read.
      const own = await deps.store.runs.get(runId).catch((): typeof UNREAD => UNREAD);
      if (own !== UNREAD && (!own || own.state !== "running" || own.epoch !== epoch)) return CLAIM_GONE;
      await sleep(Math.min(pollPauseMs(pass), Math.max(0, until - now())), signal);
      if (signal?.aborted) return row;
    }
    // An abort that came while the last read ran (the round ending, the bound passing) writes nothing either: `after`
    // stays, so the next claim waits on those rounds again.
    if (signal?.aborted) return row;
    const waited: SeedWaited = open.size ? "timed_out" : "ended";
    if (open.size) deps.log(`run ${runId}: starts from its agent's learning as it is now: its open round${open.size === 1 ? "" : "s"} (${[...open].join(", ")}) did not end within ${Math.round(deps.waitMs / 1000)} s`);
    const own: Pick<NonNullable<RunLaunch["learning"]>, "use" | "noWorkflows" | "model"> = { ...(start.noWorkflows ? { noWorkflows: true as const } : {}), ...(start.use ? { use: true as const } : {}), ...(start.model ? { model: start.model } : {}) };
    let written: unknown;
    try {
      written = { ...startOfSeed(await seedOf(deps.data, deps.store, run.agentId), await deps.shown(), own), waited };
      if (signal?.aborted) return row;
      if (!(await deps.store.runs.reseedLearning(runId, written, epoch))) return CLAIM_GONE;
    } catch (error) {
      deps.log(`run ${runId}: starts from the learning its start read: its agent's could not be read again: ${said(error)}`);
      // The start it had, without `after`: a later claim never waits on those rounds again. A write that throws leaves
      // the row as it is; one the fence refuses is a claim gone.
      written = started;
      if (signal?.aborted) return row;
      const wrote = await deps.store.runs.reseedLearning(runId, started, epoch).catch(() => undefined);
      if (wrote === undefined) return row;
      if (!wrote) return CLAIM_GONE;
    }
    // As the store wrote it (sqlite/run-launch.ts writeLaunchLearning): the body's learning member replaced, nothing read
    // back, so the run runs on exactly the start it wrote.
    return { ...row, body: { ...((row.body as Record<string, unknown> | null) ?? {}), learning: written } };
  };
}
