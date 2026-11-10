import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LearningChips } from "@/components/LearningChips";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { Chip } from "@/components/ui/chip";
import { type Client, follow, problemOf } from "@/lib/client";
import { when, runTitle } from "@/lib/format";
import { learningSteps } from "@/lib/learning";
import { NO_MESSAGES, runState } from "@/lib/runState";
import { latest, pause, TRIES_MS } from "@/lib/viewing";
import { useLearningSettle } from "@/lib/useLearningSettle";
import type { Run, RunSummary, TimelineRow } from "@/lib/v2";


/** An agent's latest run as the run page shows it: its status, its timeline followed from the cursor while it goes, and
 *  a link to the whole run. When a timeline page names a status or state the run's record does not, the record is read
 *  again and handed to `onRun` (its result, error and cost move with it). Only the newest read lands: every page whose
 *  status moves begins a new one, or, back at the status the record in hand was read for, cancels the one under way. A
 *  read that fails is tried again (the last page may already have come, and none follows it); one that never lands says
 *  so, with a Retry, rather than leave the old status showing. */
export function LatestRun({ v2, run, onRun }: { v2: Client; run: RunSummary; onRun: (run: Run) => void }) {
  const [rows, setRows] = useState<TimelineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The status and state the newest timeline page names: whether the timeline is still going is its to say.
  const [page, setPage] = useState<Pick<Run, "status" | "state"> | null>(null);
  // Why the record could not be read again once its status moved, until a read of it lands.
  const [stale, setStale] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Read again from the start when the run's learning moves on: its timeline's learning row changes in place.
  const [follows, setFollows] = useState(0);
  const runReads = useRef(latest()).current;
  // `held`: the status/state the record in hand was read for (it moves only when a read lands). `asking`: the one a read
  // is under way for. `want`: the one the newest page named, which the next page is compared with and Retry reads for.
  const held = useRef(`${run.status}/${run.state}`);
  const asking = useRef<string | null>(null);
  const want = useRef(held.current);
  const reread = async (s: string) => {
    const n = runReads.begin();
    asking.current = s;
    let why = "";
    for (const ms of TRIES_MS) {
      if (ms) await pause(ms);
      if (!runReads.current(n)) return;
      try {
        const r = await v2.getRun(run.run_id);
        if (!runReads.current(n)) return;
        held.current = s; asking.current = null; setStale(null); onRun(r);
        return;
      } catch (e) { why = problemOf(e); }
    }
    if (runReads.current(n)) { asking.current = null; setStale(why); }
  };
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, run.run_id, {
      signal: ctl.signal,
      onRows: setRows,
      onPage: (p) => {
        setPage({ status: p.status, state: p.state });
        const s = `${p.status}/${p.state}`;
        const moved = s !== want.current;
        want.current = s;
        // Back at the status the record in hand was read for: that record is right, and a read under way for another
        // status (paused, resumed, paused again) is older than this page, so it never lands.
        if (s === held.current) { runReads.cancel(); asking.current = null; setStale(null); return; }
        // A new status reads the run again; so does the same one when no read of it is under way (its last one failed).
        if (moved || asking.current === null) void reread(s);
      },
    }).catch((e) => { if (!ctl.signal.aborted) setError(problemOf(e)); });
    return () => { ctl.abort(); runReads.cancel(); asking.current = null; };
  }, [v2, run.run_id, follows]); // eslint-disable-line react-hooks/exhaustive-deps
  // An ended run still deciding what to learn is read again until it settles; a read lands only while the record in hand
  // is still the one it was asked for and no other read is under way, so it never puts back a status a page moved past.
  useLearningSettle(run, () => { const s = held.current; void v2.getRun(run.run_id).then((r) => { if (held.current === s && asking.current === null) onRun(r); }, () => {}); }, () => setFollows((n) => n + 1));
  const href = `#/runs/${encodeURIComponent(run.run_id)}`;
  const now = page ?? run;
  return (
    <section className="mb-6 border" aria-label="Latest run">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2">
        <span className="caps text-[11px] font-semibold">Latest run</span>
        {stale ? <Chip tone="muted">Not refreshed</Chip> : <StatusBadge run={run} />}
        <a href={href} className="min-w-0 flex-1 truncate text-[14px] hover:underline" title={runTitle(run)}>{runTitle(run)}</a>
        <LearningChips run={run} link />
        <span className="font-mono text-[12px] text-muted-foreground">{when(run.created_at)}</span>
        <a href={href} className="caps flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">Open the run <ArrowRight className="size-3" aria-hidden /></a>
      </div>
      {stale && (
        <p className="flex flex-wrap items-center gap-3 border-b px-4 py-2 font-mono text-[12px] text-destructive-text" role="alert">
          This run could not be refreshed: {stale}
          <button type="button" disabled={retrying} onClick={() => { setRetrying(true); void reread(want.current).finally(() => setRetrying(false)); }} className="caps border px-2 py-1 text-[11px] text-foreground hover:bg-accent disabled:opacity-45">{retrying ? "Retrying" : "Retry"}</button>
        </p>
      )}
      <div className="px-4 py-3">
        {error ? <p className="font-mono text-[13px] text-destructive-text" role="alert">The timeline could not be read: {error}</p>
          : rows ? <Timeline rows={learningSteps(rows, run.learning)} live={runState(now.status, now.state, run.kind, NO_MESSAGES, true).live} />
          : <p className="py-6 text-center font-mono text-[13px] text-muted-foreground">Reading the timeline...</p>}
      </div>
    </section>
  );
}
