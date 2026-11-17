// What a runner's memory holds of runs (RunnerOptions.memory): the budget is the host's memory less the server's own
// (host.ts runsMemoryMib, of the container's limit when it has one), and each waiting run weighs what a run of its
// harness reserves (its table entry's runMib: pi 128 MiB, codex 192, claude-agent 288, opencode 704). The count alone
// (--max-runs, by default as many pi runs as fit) would let a 2 GB host take 15 claude-agent runs, about 3.2 GB as
// measured, and the host's OOM kill would take every run on it; by weight it holds 6 and the rest wait queued.
import { DEFAULT_HARNESS, harnessOfBody } from "../harness.js";
import { builtinHarness, ownerHarness } from "../harness-table.js";
import { hostMemory, runsMemoryMib } from "../host.js";
import type { Store } from "../store/store.js";
import type { RunnerMemory } from "./runner.js";

/** What a run launched on `harness` weighs: its entry's run size on the owner's table of `env` (harness-table.ts
 *  ownerHarness: a built-in's, or what a harness module declares; a test's stand-in weighs as the built-in it stands in
 *  for), or a pi run's for a run on no harness of that table (a learning run, which runs in the runner's own process as a
 *  pi run does). */
export function claimMibOf(harness: string, env: NodeJS.ProcessEnv = {}): number {
  return (ownerHarness(env, harness) ?? builtinHarness(DEFAULT_HARNESS)!).runMib;
}

/** The runner's memory budget over `store`: `memory` bytes (default the host's, hostMemory) less the server's own, each
 *  waiting run weighed by the harness its launch names (store.runs.launch) on the owner's table of `env` (the runner's run
 *  environment, which names its harness modules). A run whose launch cannot be read weighs a pi run: its claim fails it at
 *  once (dispatch.ts), holding nothing for long. */
export function runnerMemory(store: Pick<Store, "runs">, memory: number = hostMemory(), env: NodeJS.ProcessEnv = {}): RunnerMemory {
  return {
    budgetMib: runsMemoryMib(memory),
    weigh: async (runIds) =>
      new Map(
        await Promise.all(
          runIds.map(async (runId): Promise<[string, number]> => {
            const harness = await store.runs.launch(runId).then(
              (row) => harnessOfBody((row.body ?? {}) as { harness?: string }),
              () => DEFAULT_HARNESS,
            );
            return [runId, claimMibOf(harness, env)];
          }),
        ),
      ),
  };
}
