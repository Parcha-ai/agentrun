// A runner's metrics as log lines, in the server's one log format (print.ts logLine: `at=<ISO> event=<name> key=value`),
// so a log-based metric counts them or reads a figure from them with no metrics server. Runner names, run ids, epochs,
// causes and numbers only: never a prompt, a key, a path or a customer's word. Six lines:
//
// - `runner_claimed runner run epoch from`, one per claim; `took_over=1` when it took the run over from a runner whose
//   lease ran out (`lost_runner`, that runner): the run's earlier runner died or lost its claim.
// - `runner_hand_back runner run epoch cause`, one per run the runner gave back still running (runner.ts HandBackCause:
//   drain, interrupted, end_retry, give_back), and `cause=claim_lost` with `why` (fenced, not_renewed) for a claim it lost.
// - `runner_drained runner ms held left`, once per close that held a run: how long the drain took, how many runs it began
//   with and how many it handed back at its end.
// - `runner_gauge runner active slots rss_mib`, every RUNNER_GAUGE_EVERY_MS while the runner runs: the runs it holds, the
//   most it holds at once, and its process's resident memory.
// - `runner_census_failed runner run cause`, one per end that made no census (runner.ts census-failed: the error's code
//   or name, or "timeout"): that end writes "unscanned" and the run's files are withheld after it. Any of these is worth
//   an alert: a runner that can't count a run's files (its Archil key, its disk) fails every end the same way.
import { logLine } from "../print.js";
import type { RunnerEvent } from "./runner.js";

/** How often a runner says its gauge line. */
export const RUNNER_GAUGE_EVERY_MS = 60_000;

const MIB = 1024 * 1024;

/** The metric line of runner `runner`'s `event`, or undefined for an event that is none (a run's start and end have their
 *  own lines: print.ts runLine; an error is said as trouble: main.ts troubleLine). */
export function metricLine(runner: string, event: RunnerEvent): string | undefined {
  switch (event.type) {
    case "claimed": {
      const { claim } = event;
      return logLine("runner_claimed", { runner, run: claim.runId, epoch: claim.epoch, from: claim.from, ...(claim.lost ? { took_over: 1, lost_runner: claim.lost.runner } : {}) });
    }
    case "handed-back":
      return logLine("runner_hand_back", { runner, run: event.runId, epoch: event.epoch, cause: event.cause });
    case "claim-lost":
      return logLine("runner_hand_back", { runner, run: event.runId, epoch: event.epoch, cause: "claim_lost", why: event.why === "not-renewed" ? "not_renewed" : event.why });
    case "drained":
      return logLine("runner_drained", { runner, ms: event.ms, held: event.held, left: event.left });
    case "census-failed":
      return logLine("runner_census_failed", { runner, run: event.runId, cause: event.cause });
    default:
      return undefined;
  }
}

/** The gauge line: `active` runs held of `slots`, and `rssBytes` as MiB. */
export const gaugeLine = (runner: string, active: number, slots: number, rssBytes: number): string => logLine("runner_gauge", { runner, active, slots, rss_mib: Math.round(rssBytes / MIB) });

/** Says runner `runner`'s gauge line through `write` every `everyMs` (its timer never holds the process up) until stop(). */
export function startRunnerGauge({ runner, held, slots, write, everyMs = RUNNER_GAUGE_EVERY_MS, rssBytes = () => process.memoryUsage.rss() }: { runner: string; held: () => number; slots: number; write: (line: string) => void; everyMs?: number; rssBytes?: () => number }): { stop(): void } {
  const timer = setInterval(() => {
    try {
      write(gaugeLine(runner, held(), slots, rssBytes()));
    } catch {
      // A gauge it could not read or write never stops the runner.
    }
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
