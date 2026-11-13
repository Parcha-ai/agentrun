// A runner's start sweep of the scratch folders of runs that have ended (`<data>/scratch/<agent>/<run>`). A CLI run's
// files on a runner (its harness's home and session state) go at its claims' ends (cli-run-spec.ts sweepScratch), and a
// next claim sweeps what a killed claim left; a run that ends after its runner died has no next claim, so its folders stay
// until this sweep, at the next start of a runner on the data directory, takes them. It reads each run's row: a folder is
// swept only for a run the store says is final, and only the claims at or below the row's epoch (a follow-up that reopened
// the run claims above it, and its folder is never touched). A run that is not final, one the store has no row for, and a
// folder whose name is no run id stay. Bounded (`limit` run folders examined) and logged.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FINAL_STATES, type Store } from "../store/index.js";
import { sweepScratch } from "./cli-run-spec.js";

/** Most run folders one start examines: what is left past it is swept at the next start. */
export const SCRATCH_SWEEP_LIMIT = 500;

export type ScratchSwept = { readonly examined: number; readonly swept: number; readonly kept: number; readonly failed: number };

const words = (error: unknown): string => (error as Error)?.message ?? String(error);
const names = (folder: string): Promise<string[]> =>
  readdir(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });

export async function sweepEndedScratch(store: Pick<Store, "runs">, dataDir: string, options: { log?: (line: string) => void; limit?: number } = {}): Promise<ScratchSwept> {
  const log = options.log ?? (() => {});
  const limit = options.limit ?? SCRATCH_SWEEP_LIMIT;
  const root = join(dataDir, "scratch");
  let examined = 0;
  let swept = 0;
  let kept = 0;
  let failed = 0;
  try {
    outer: for (const agent of await names(root)) {
      const agentFolder = join(root, agent);
      for (const run of await names(agentFolder)) {
        if (examined >= limit) {
          log(`scratch sweep: stopped after ${limit} run folders; the rest is swept at the next start`);
          break outer;
        }
        examined += 1;
        try {
          const row = await store.runs.get(run);
          if (!row || !FINAL_STATES.includes(row.state)) {
            kept += 1;
            continue;
          }
          const harnesses = join(agentFolder, run, "harness");
          await sweepScratch(harnesses, row.epoch, [harnesses, join(agentFolder, run), agentFolder]);
          swept += 1;
        } catch (error) {
          failed += 1;
          log(`scratch sweep: run folder ${run} of ${agent} could not be swept: ${words(error)}`);
        }
      }
    }
  } catch (error) {
    failed += 1;
    log(`scratch sweep: the scratch folder could not be read: ${words(error)}`);
  }
  if (swept > 0 || failed > 0) log(`scratch sweep: ${swept} ended run${swept === 1 ? "" : "s"}' folders swept, ${kept} kept, ${failed} failed`);
  return { examined, swept, kept, failed };
}
