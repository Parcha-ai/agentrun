import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { type Client, ClientError, follow } from "@/lib/client";
import { when } from "@/lib/format";
import { NO_MESSAGES, runState } from "@/lib/runState";
import { latest } from "@/lib/viewing";
import type { Run, TimelineRow } from "@/lib/v2";

const problemOf = (e: unknown) => (e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** An agent's latest run as the run page shows it: its status, its timeline followed from the cursor while it goes, and
 *  a link to the whole run. When a timeline page names a status or state the run's record does not, the record is read
 *  again and handed to `onRun` (its result, error and cost move with it); only the newest of those reads lands. */
export function LatestRun({ v2, run, onRun }: { v2: Client; run: Run; onRun: (run: Run) => void }) {
  const [rows, setRows] = useState<TimelineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runReads = useRef(latest()).current;
  const said = useRef(`${run.status}/${run.state}`);
  useEffect(() => {
    const ctl = new AbortController();
    follow(v2, run.run_id, {
      signal: ctl.signal,
      onRows: setRows,
      onPage: (p) => {
        const s = `${p.status}/${p.state}`;
        if (s === said.current) return;
        said.current = s;
        const n = runReads.begin();
        v2.getRun(run.run_id).then((r) => { if (!ctl.signal.aborted && runReads.current(n)) onRun(r); }, () => {});
      },
    }).catch((e) => { if (!ctl.signal.aborted) setError(problemOf(e)); });
    return () => { ctl.abort(); runReads.cancel(); };
  }, [v2, run.run_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const href = `#/runs/${encodeURIComponent(run.run_id)}`;
  return (
    <section className="mb-6 border" aria-label="Latest run">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2">
        <span className="caps text-[11px] font-semibold">Latest run</span>
        <StatusBadge run={run} />
        <a href={href} className="min-w-0 flex-1 truncate text-[14px] hover:underline" title={run.title}>{run.title}</a>
        <span className="font-mono text-[12px] text-muted-foreground">{when(run.created_at)}</span>
        <a href={href} className="caps flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">Open the run <ArrowRight className="size-3" aria-hidden /></a>
      </div>
      <div className="px-4 py-3">
        {error ? <p className="font-mono text-[13px] text-destructive-text" role="alert">The timeline could not be read: {error}</p>
          : rows ? <Timeline rows={rows} live={runState(run.status, run.state, run.kind, NO_MESSAGES, true).live} />
          : <p className="py-6 text-center font-mono text-[13px] text-muted-foreground">Reading the timeline...</p>}
      </div>
    </section>
  );
}
