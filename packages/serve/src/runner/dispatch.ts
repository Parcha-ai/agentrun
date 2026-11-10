// The runner's dispatch loop (design 2.1: "the runner takes every run"). One loop the runner holds for every run; at the
// claim it reads the run's launch record (store.runs.launch), picks the harness its body names (harnessOfBody), and runs
// the run on that harness's own loop. The runner knows nothing about harnesses: it hands the dispatch its claim, its
// command rows and its stop, and the dispatch forwards them to the inner loop once one is chosen.
//
// A command or a stop can reach the dispatch before the launch read has chosen the inner loop (the runner delivers rows
// and the claim's start() race): they are buffered here (loop.ts buffers an early steer the same way) and replayed
// through the inner loop the moment it is chosen. A launch whose harness this runner does not run, or whose body cannot
// be read, fails the run in words (the dispatch's start() throws, which the runner records as the run failing).
import { harnessOfBody } from "../harness.js";
import { readLaunchBody, type RunLaunch } from "../run-launch.js";
import type { Claim, Command, CommandOutcome, Loop, LoopDeps, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";

/** What the dispatch reads of a run at its claim, and how it picks the harness's loop. */
export interface DispatchDeps {
  /** The run's launch row (store.runs.launch): its body names the harness. It throws (StoreLaunchMissing) when the run
   *  was not started with one, which fails the run in words. */
  launchOf(runId: string): Promise<{ readonly body: unknown }>;
  /** The loop factory for a run launched with `harness`, built from its `launch` record and its run id (so the switch may
   *  read the run's revision — a workflow revision runs on the workflow loop whatever its harness name), or undefined when
   *  this runner does not run it (the run fails in words). pi is the adapter loop with adapterRunSpecFromLaunch; a built-in
   *  learning run names "learning"; the CLI harnesses name their own. May be async (the revision read). */
  resolve(harness: string, launch: RunLaunch, runId: string): LoopFactory | undefined | Promise<LoopFactory | undefined>;
}

/** A launch naming a harness this runner does not run. */
export class UnknownHarness extends Error {
  override name = "UnknownHarness";
  constructor(readonly harness: string) {
    super(`this runner does not run the harness ${JSON.stringify(harness)}: start a runner that does, or change the run's harness.`);
  }
}

/** A launch body the store holds but the runner cannot read as one (not an object, or it names no place). */
export class LaunchUnreadable extends Error {
  override name = "LaunchUnreadable";
  constructor(runId: string) {
    super(`run ${runId}: its launch record could not be read as a launch (it names no place, or is not an object).`);
  }
}

/** The first wait before a buffered row whose delivery threw is tried again, and the most any later wait (doubling)
 *  grows to. */
export const REPLAY_RETRY_FIRST_MS = 250;
export const REPLAY_RETRY_MAX_MS = 5_000;

/** The loop factory the runner holds for every run: `createDispatchLoop(deps)` picks each run's harness loop at its
 *  claim. The inner loop gets the same LoopDeps the dispatch does, so the runner's fence, flush, live and end-of-run
 *  channels reach it unchanged. */
export function createDispatchLoop(deps: DispatchDeps): LoopFactory {
  return (loopDeps) => dispatchLoop(deps, loopDeps);
}

function dispatchLoop(deps: DispatchDeps, loopDeps: LoopDeps): Loop {
  /** The harness's loop, once the launch read has chosen it. */
  let inner: Loop | undefined;
  /** Commands handed over before the inner loop was chosen: replayed through it once it is. */
  const early: Command[] = [];
  /** A stop handed over before the inner loop was chosen: applied to it once it is. */
  let earlyStop: StopReason | undefined;
  /** start()'s promise, so stop() for a run whose inner loop is not chosen yet resolves only once start() settles (the
   *  inner loop has been told to stop, or the run failed to choose one and writes nothing). */
  let started: Promise<LoopEnd> | undefined;
  /** Resolved once the commands buffered before the inner loop was chosen have been replayed through its command(). */
  let replayed: () => void = () => {};
  const earlyReplayed = new Promise<void>((resolve) => (replayed = resolve));
  // The inner loop's `delivered` must not resolve until the runner's first delivery is done AND every command this
  // dispatch buffered before the inner loop was chosen has reached its command(): a loop that parks on `delivered` (the
  // adapter loop) would otherwise wake with a buffered answer still held here and park again, never ending. The runner's
  // delivered sees this dispatch's command() return at once for a buffered row, so the wait for the replay is added here.
  const innerDeps: LoopDeps = { ...loopDeps, delivered: Promise.all([loopDeps.delivered ?? Promise.resolve(), earlyReplayed]).then(() => undefined) };

  async function begin(claim: Claim): Promise<LoopEnd> {
    const row = await deps.launchOf(claim.runId);
    const launch = readLaunchBody(row.body);
    if (!launch) throw new LaunchUnreadable(claim.runId);
    const harness = harnessOfBody(row.body as { harness?: string });
    const factory = await deps.resolve(harness, launch, claim.runId);
    if (!factory) throw new UnknownHarness(harness);
    // Set the inner loop and start it before anything awaits: a command() or stop() that interleaves here sees it, so no
    // buffered row and no buffered stop is lost between choosing the loop and replaying what was buffered.
    inner = factory(innerDeps);
    const end = inner.start(claim);
    // Replay the buffered commands through the inner loop in order, each awaited, then let its `delivered` resolve. A
    // command whose delivery throws is never thrown out of here, where nothing would catch it and the runner's process
    // would go down. The runner already moved past its row (the dispatch said it holds it), so the dispatch tries it again
    // itself while the inner loop runs, as the runner tries again a row whose delivery threw (a store that failed for a
    // moment). Once the inner loop has ended, a row still not delivered stays untaken (the store's take is the inner
    // loop's own commit), so the run's next claim delivers it again and nobody's words are lost.
    const buffered = early.splice(0);
    void replay(claim.runId, inner, buffered, end);
    if (earlyStop) void inner.stop(earlyStop);
    return end;
  }

  /** Hands `buffered` to `loop` in order; the ones whose delivery threw are tried again, in order, until each goes through
   *  or the loop has ended. Never rejects. */
  async function replay(runId: string, loop: Loop, buffered: readonly Command[], end: Promise<LoopEnd>): Promise<void> {
    let ended = false;
    const loopEnded = end.then(() => undefined, () => undefined).then(() => void (ended = true));
    const delivers = async (command: Command): Promise<boolean> => {
      try {
        await loop.command(command);
        return true;
      } catch (error) {
        console.warn(`[runner] ${runId}: a ${command.kind} row held before its loop was chosen was not delivered (${(error as Error)?.message ?? String(error)}); it is tried again while the loop runs, else left for the run's next claim`);
        return false;
      }
    };
    const failed: Command[] = [];
    try {
      for (const command of buffered) if (failed.length > 0 || !(await delivers(command))) failed.push(command);
    } finally {
      replayed();
    }
    for (let wait = REPLAY_RETRY_FIRST_MS; failed.length > 0 && !ended; wait = Math.min(wait * 2, REPLAY_RETRY_MAX_MS)) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([loopEnded, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
      clearTimeout(timer);
      if (ended) break;
      while (failed.length > 0 && !ended && (await delivers(failed[0]!))) failed.shift();
    }
  }
    if (earlyStop) void inner.stop(earlyStop);
    return end;
  }

  return {
    start(claim) {
      return (started = begin(claim));
    },
    async command(command): Promise<CommandOutcome> {
      if (inner) return inner.command(command);
      // Before the inner loop is chosen: buffer it, as loop.ts buffers an early steer, taken now and replayed once the
      // loop is chosen (its own journal commit takes the row; a loop that then refuses it leaves it for the run's end).
      early.push(command);
      return { taken: true };
    },
    async stop(reason) {
      if (inner) {
        await inner.stop(reason);
        return;
      }
      // Not chosen yet: begin() applies this stop to the inner loop the moment it chooses one (or the run fails having
      // chosen none, writing nothing). Either way stop() resolves once start() settles, as the contract asks.
      earlyStop ??= reason;
      await started?.catch(() => undefined);
    },
  };
}
