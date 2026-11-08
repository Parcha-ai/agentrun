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
  /** The loop factory for a run launched with `harness`, built from its `launch` record, or undefined when this runner
   *  does not run that harness (the run fails in words). pi is createPiLoop with the launch's PiRunSpec; a built-in
   *  learning run names "learning"; the CLI harnesses name their own. */
  resolve(harness: string, launch: RunLaunch): LoopFactory | undefined;
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

  async function begin(claim: Claim): Promise<LoopEnd> {
    const row = await deps.launchOf(claim.runId);
    const launch = readLaunchBody(row.body);
    if (!launch) throw new LaunchUnreadable(claim.runId);
    const harness = harnessOfBody(row.body as { harness?: string });
    const factory = deps.resolve(harness, launch);
    if (!factory) throw new UnknownHarness(harness);
    // Set the inner loop and start it before anything awaits: a command() or stop() that interleaves here sees it, so no
    // buffered row and no buffered stop is lost between choosing the loop and replaying what was buffered.
    inner = factory(loopDeps);
    const end = inner.start(claim);
    for (const command of early.splice(0)) void inner.command(command);
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
