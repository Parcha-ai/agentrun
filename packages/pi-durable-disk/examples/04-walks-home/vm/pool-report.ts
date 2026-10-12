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

/** One line, in words: "ready: 3 of 3 GPU boxes", or what is missing and that it is being retried. */
export function readyLine(report: PoolReport): string {
  const have = Math.min(report.up, report.size);
  if (have >= report.size) return `ready: ${have} of ${report.size} GPU boxes`;
  return `ready: ${have} of ${report.size} GPU boxes (${report.size - have} still placing, retrying)`;
}
