import { useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { RunSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Timeline } from "@/components/Timeline";
import { Button, buttonVariants } from "@/components/ui/button";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { type Client, follow } from "@/lib/client";
import { costOfCap, runEnded, runTitle } from "@/lib/format";
import { problem } from "@/lib/problem";
import { LANE_KEY, LANE_WAIT_MS, laneStats, raceFilter, readRace } from "@/lib/race";
import { compareHref, MIN_COMPARED } from "@/lib/traceCompare";
import { cn } from "@/lib/utils";
import type { Run, TimelineRow } from "@/lib/v2";
import { latest, pause, TRIES_MS } from "@/lib/viewing";

/** How many of a lane's newest steps show; older ones fold behind "N earlier steps", so no lane grows a scroller. */
const LANE_STEPS = 4;

/** Seconds as m:ss (h:mm:ss past an hour). */
const elapsed = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** How often the race's runs are read again, so a lane that starts after the page opened joins it. */
export const RACE_REREAD_MS = 15_000;

/** A race (lib/race.ts): the runs its race:<label> label groups, 2 to 4 lanes side by side, each following its run's
 *  timeline. Read-only: a lane links to its run's own page for anything more. The lanes are read again every
 *  `rereadMs` (RACE_REREAD_MS; a test's shorter), also after a first read that failed; a lane already shown keeps its
 *  place and its timeline. */
export function Race({ v2, label, rereadMs = RACE_REREAD_MS }: { v2: Client; label: string; rereadMs?: number }) {
  const [read, setRead] = useState<Awaited<ReturnType<typeof readRace>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reads, setReads] = useState(0);
  // One clock for every lane, so their running times tick together.
  const [now, setNow] = useState(() => Date.now());
  // Every read of the race, the first and each again, goes through one guard: only the newest begun may land, and a
  // tick that comes while a read still waits (up to RACE_PAGES pages, or a server that is down) starts none, so reads
  // never pile up and an older answer never puts back the lanes a newer one showed.
  const raceReads = useRef(latest()).current;
  const waiting = useRef(false);
  useEffect(() => {
    setError(null);
    let answered = false;
    const readOnce = () => {
      if (waiting.current) return;
      waiting.current = true;
      const n = raceReads.begin();
      readRace(v2, label).then(
        (r) => { if (raceReads.current(n)) { answered = true; setRead(r); setError(null); } },
        // A read that fails after one answered keeps the lanes shown; before, it says so. Either way the next tries again.
        (e) => { if (raceReads.current(n) && !answered) setError(e); },
      ).finally(() => { if (raceReads.current(n)) waiting.current = false; });
    };
    readOnce();
    const again = setInterval(readOnce, rereadMs);
    return () => { raceReads.cancel(); waiting.current = false; clearInterval(again); };
  }, [label, reads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (error) return <ProblemCard problem={problem(error, "the race")} onRetry={() => setReads((n) => n + 1)} />;
  if (!read) return <RunSkeleton />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn(pageToolbarClass, "gap-3 px-5 md:px-8")}>
        <h1 className={pageTitleClass}>Race</h1>
        <span className="truncate font-mono text-small text-muted-foreground" title={raceFilter(label)}>{label}</span>
        {read.lanes.length > 0 && <span className="caps ml-auto text-label text-muted-foreground">{read.lanes.length} {read.lanes.length === 1 ? "lane" : "lanes"}</span>}
        {/* The lanes' Dev tools figures side by side (#/compare), in the lanes' order: what each lane's model and harness cost and took. */}
        {read.lanes.length >= MIN_COMPARED && <a href={compareHref(read.lanes.map((run) => run.run_id))} className={buttonVariants({ size: "sm" })}>Compare in figures</a>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
      {read.lanes.length === 0 ? (
        <p role="status" className="px-5 py-8 text-body text-muted-foreground md:px-8">
          No run carries the label <span className="font-mono text-foreground">{raceFilter(label)}</span> yet. A run joins this race when it starts with that label.
        </p>
      ) : (
        <div className="grid gap-4 p-5 md:grid-cols-2 md:p-8">
          {read.lanes.map((run) => <RaceLane key={run.run_id} v2={v2} first={run} now={now} />)}
        </div>
      )}
      {read.more > 0 && (
        <p className="px-5 pb-6 text-small text-muted-foreground md:px-8">
          {read.atLeast ? "At least " : ""}{read.more} more {read.more === 1 ? "run carries" : "runs carry"} this label; the first four by lane are shown.
        </p>
      )}
      </div>
    </div>
  );
}

/** One lane: its run's header (harness and model, status, cost, tokens, tool calls, clock) over its newest steps. The
 *  timeline is followed with a short wait (LANE_WAIT_MS), and the run is read again when a page says its state moved. */
function RaceLane({ v2, first, now }: { v2: Client; first: Run; now: number }) {
  const [run, setRun] = useState(first);
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [pageCost, setPageCost] = useState<Run["cost"] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [readFailed, setReadFailed] = useState(false);
  const state = useRef("");
  // Only the newest read of the run lands: an older one answering last never puts a finished run back to Working.
  const runReads = useRef(latest()).current;
  const live = useRef<AbortSignal | null>(null);
  // The run read again: a failed read is tried twice more (TRIES_MS), since the timeline's follow has stopped by the
  // final page and nothing else would ask; one that still fails says so, with a way to read again.
  const readRun = async () => {
    const n = runReads.begin(), signal = live.current;
    for (const ms of TRIES_MS) {
      await pause(ms);
      if (signal?.aborted || !runReads.current(n)) return;
      try {
        const r = await v2.getRun(first.run_id);
        if (!signal?.aborted && runReads.current(n)) { setRun(r); setReadFailed(false); }
        return;
      } catch { /* the next try */ }
    }
    if (!signal?.aborted && runReads.current(n)) setReadFailed(true);
  };
  useEffect(() => {
    const ctl = new AbortController();
    live.current = ctl.signal;
    follow(v2, first.run_id, {
      signal: ctl.signal,
      waitMs: LANE_WAIT_MS,
      onRows: setRows,
      onPage: (p) => {
        if (p.cost) setPageCost(p.cost);
        const s = `${p.status}/${p.state}`;
        if (s === state.current) return;
        state.current = s;
        void readRun();
      },
    }).catch((e) => { if (!ctl.signal.aborted) setFailed(e); });
    return () => ctl.abort();
  }, [first.run_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ended = runEnded(run.status);
  const stats = laneStats(run, rows, pageCost, now);
  const harness = run.labels?.harness, model = run.labels?.model;
  const lane = run.labels?.[LANE_KEY];
  return (
    <section data-race-lane={run.run_id} className="flex min-w-0 flex-col border bg-card">
      <header className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <a href={`#/runs/${encodeURIComponent(run.run_id)}`} className="min-w-0 truncate font-mono text-small font-semibold hover:underline">
            {harness || model ? [harness, model].filter(Boolean).join(" · ") : lane ? `Lane ${lane}` : run.run_id}
          </a>
          <span className="ml-auto shrink-0"><StatusBadge run={run} /></span>
        </div>
        <p className="mt-1 truncate text-small text-muted-foreground" title={runTitle(run)}>{runTitle(run)}</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-label text-muted-foreground">
          <span data-lane-clock>{elapsed(stats.seconds)}</span>
          <span data-lane-cost>{costOfCap(stats.cost, stats.cost?.cap_usd, { ended })}</span>
          <span data-lane-tools>{stats.toolCalls} {stats.toolCalls === 1 ? "tool call" : "tool calls"}{stats.failed ? ` · ${stats.failed} failed` : ""}</span>
          {stats.tokens && <span data-lane-tokens>{stats.tokens}</span>}
        </div>
        {readFailed && (
          <p role="status" data-lane-read-failed className="mt-2 flex flex-wrap items-center gap-2 text-small text-destructive-text">
            This run's newest state did not read, so its status may be behind.
            <Button size="xs" variant="ghost" onClick={() => void readRun()}>Read again</Button>
          </p>
        )}
      </header>
      <div className="min-w-0 px-2 py-2">
        {failed ? <ProblemCard className="m-2" problem={problem(failed, "this lane's timeline")} /> : <Timeline rows={rows} live={!ended} fold={LANE_STEPS} ended={ended} />}
      </div>
    </section>
  );
}
