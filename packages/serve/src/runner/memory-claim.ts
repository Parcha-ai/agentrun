// What a runner's memory holds of runs (RunnerOptions.memory): the budget is the host's memory less the server's own
// (host.ts runsMemoryMib, of the container's limit when it has one), and each waiting run weighs what a run of its
// harness reserves (its table entry's runMib: pi 128 MiB, codex 192, claude-agent 288, opencode 704). The count alone
// (--max-runs, by default as many pi runs as fit) would let a 2 GB host take 15 claude-agent runs, about 3.2 GB as
// measured, and the host's OOM kill would take every run on it; by weight it holds 6 and the rest wait queued.
import { DEFAULT_HARNESS, harnessOfBody } from "../harness.js";
import { builtinHarness } from "../harness-table.js";
import { hostMemory, neverFits, runsMemoryMib } from "../host.js";
import type { Store } from "../store/store.js";
import type { RunnerMemory } from "./runner.js";

/** What a run launched on `harness` weighs: its table entry's run size, or a pi run's for a run on no harness of the
 *  table (a learning run, which runs in the runner's own process as a pi run does). */
export function claimMibOf(harness: string): number {
  return (builtinHarness(harness) ?? builtinHarness(DEFAULT_HARNESS)!).runMib;
}

/** The runner's memory budget over `store`: `memory` bytes (default the host's, hostMemory) less the server's own, each
 *  waiting run weighed by the harness its launch names (store.runs.launch). A run whose launch cannot be read weighs a pi
 *  run: its claim fails it at once (dispatch.ts), holding nothing for long. A run of a table harness that never fits this
 *  memory (host.ts neverFits: an opencode run, 704 MiB, on a runner limited to 512 MB) is refused, in those words: the
 *  server's own admission reads the server's memory, and a runner in a container of its own may hold less. */
export function runnerMemory(store: Pick<Store, "runs">, memory: number = hostMemory()): RunnerMemory {
  const refused = new Map<string, string>();
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
            const why = builtinHarness(harness) ? neverFits(harness, memory) : undefined;
            if (why) refused.set(runId, why);
            else refused.delete(runId);
            return [runId, claimMibOf(harness)];
          }),
        ),
      ),
    refuses: (runId) => refused.get(runId),
  };
}
