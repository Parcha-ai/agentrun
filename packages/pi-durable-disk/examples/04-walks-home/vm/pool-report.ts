// What the person starting the demo is told about the GPU boxes, read from the server's log (pool.box-ready, pool.box-failed, pool.box-retry): in words, as a count against the boxes the demo needs.

export interface PoolReport {
  /** Boxes up (spares included). */
  readonly up: number;
  /** Boxes whose first attempt has settled, up or failed: when this reaches the pool's total, nobody is still on a first try. */
  readonly settled: number;
  /** The boxes the demo needs. */
  readonly size: number;
}

/** The pool's state from the server log text: the last pool event of each box says where it is. */
export function poolReport(logText: string, size: number): PoolReport {
  const last = new Map<number, string>();
  for (const line of logText.split("\n")) {
    if (!line.includes('"event":"pool.box-')) continue;
    try {
      const e = JSON.parse(line) as { event?: string; index?: number };
      if (typeof e.index === "number" && typeof e.event === "string") last.set(e.index, e.event);
    } catch {
      // a line cut off mid-write
    }
  }
  const states = [...last.values()];
  return { up: states.filter((s) => s === "pool.box-ready").length, settled: states.length, size };
}

/** One line, in words: "ready: 3 of 3 GPU boxes", or how many are still on their way (Modal queues a create it has no capacity for, and places it when capacity comes). */
export function readyLine(report: PoolReport): string {
  const have = Math.min(report.up, report.size);
  if (have >= report.size) return `ready: ${have} of ${report.size} GPU boxes`;
  return `ready: ${have} of ${report.size} GPU boxes (${report.size - have} still placing)`;
}

/**
 * Whether live should print its ready line now. Every box the demo needs is up, or every box has settled (up or failed with an error), or at least one is up and `graceMs` has passed: boxes that Modal is
 * still queuing are not waited for (the threads queue for the boxes that are up, and the ready line is printed again as each late box joins).
 */
export function shouldAnnounce(report: PoolReport, total: number, waitedMs: number, graceMs: number): boolean {
  if (report.up >= report.size) return true;
  if (report.settled >= total) return true;
  return report.up >= 1 && waitedMs >= graceMs;
}
