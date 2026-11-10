import { useEffect, useRef } from "react";
import { underWay } from "./learning";
import type { RunSummary } from "./v2";

/** A run in one of these has ended: its learning may still be deciding what to keep. */
const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
/** The waits between reads: 2 s, doubling to 16 s at most, and about two minutes of waiting in all. */
export const SETTLE = { firstMs: 2_000, maxMs: 16_000, totalMs: 120_000 };

/** Reads an ended run again while its learning is still deciding what to keep, so the page shows what it kept without a
 *  reload. `reread` is the page's own read of the run, which hands it back as that read does; when the run it hands back
 *  has settled (merged or dropped), the reads stop. They wait 2 s, then 4, 8 and 16 s, then every 16 s, until about two
 *  minutes of waiting in all. There is one timer at a time, never one per render. A read that falls due while the page is
 *  hidden waits until it is shown again, and time hidden does not count. Unmounting the page stops the reads.
 *  `moved`: called each time the ended run's learning moves on (not for the first record the page has), so the page reads
 *  its timeline again and the timeline's learning row says what the header says. */
export function useLearningSettle(run: Pick<RunSummary, "status" | "learning"> | null | undefined, reread: () => unknown, moved?: () => unknown, waits = SETTLE): void {
  const active = !!run && ENDED.has(run.status) && underWay(run.learning);
  const read = useRef(reread);
  read.current = reread;
  const onMoved = useRef(moved);
  onMoved.current = moved;
  const state = run?.learning?.state;
  const ended = !!run && ENDED.has(run.status);
  const seen = useRef(state);
  useEffect(() => {
    const was = seen.current;
    seen.current = state;
    if (was !== undefined && was !== state && ended) onMoved.current?.();
  }, [state, ended]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waited = 0;
    let delay = waits.firstMs;
    let parked = false;
    let stopped = false;
    const arm = () => {
      if (stopped || waited + delay > waits.totalMs) return;
      timer = setTimeout(due, delay);
    };
    const due = () => {
      timer = undefined;
      if (document.visibilityState === "hidden") { parked = true; return; }
      waited += delay;
      delay = Math.min(delay * 2, waits.maxMs);
      read.current();
      arm();
    };
    const shown = () => { if (parked && document.visibilityState !== "hidden") { parked = false; due(); } };
    document.addEventListener("visibilitychange", shown);
    arm();
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}
