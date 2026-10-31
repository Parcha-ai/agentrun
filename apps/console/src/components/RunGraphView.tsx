import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NodeDrawer } from "@/components/NodeDrawer";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { costOf, elapsed, elapsedNow, isFinal, itemCounts, type RunGraph, runMarks, type Selection, usd } from "@/lib/runGraph";
import { cn } from "@/lib/utils";

/** Reads a workflow run's graph now and again every `everyMs` until the run has ended (a paused run is still read: it
 *  can be resumed elsewhere). A retryable refusal (the store busy with the run's own write) is asked again after the wait
 *  the server names, and the last graph read stays shown; `readAt` says when that was. */
export function useRunGraph(load: (signal: AbortSignal) => Promise<RunGraph>, { everyMs = 1000, key = "" }: { everyMs?: number; key?: string } = {}) {
  const [data, setData] = useState<RunGraph | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState(0);
  const [nudge, setNudge] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        // A read is as fresh as its asking: what it says was true at some time after this.
        const asked = Date.now();
        const g = await loader.current(ctl.signal);
        if (ctl.signal.aborted) return;
        // A stale view is the server's last good one while the run's store is busy: shown, but not a fresh read.
        setData(g); setError(null);
        if (!g.stale) setReadAt(asked);
        else { const at = Date.parse(g.read_at ?? ""); if (at) setReadAt((r) => (r ? Math.min(r, at) : at)); }
        if (isFinal(g.run.status)) return;
      } catch (e) {
        if (ctl.signal.aborted) return;
        setError(e);
        const retry = e as { retryable?: boolean; retryAfterMs?: number };
        if (retry.retryable) { timer = setTimeout(tick, Math.min(everyMs, retry.retryAfterMs ?? 500)); return; }
      }
      timer = setTimeout(tick, everyMs);
    };
    void tick();
    return () => { ctl.abort(); clearTimeout(timer); };
  }, [key, everyMs, nudge]);
  return { data, error, readAt, reload: () => setNudge((n) => n + 1) };
}

export type GraphActions = { onPause?: () => void; onResume?: () => void; busy?: "pause" | "resume" | null };

/** A workflow run as a live graph: the totals, pause and resume, the graph with each node's and item's state, and the
 *  drawer for the node or item picked. */
export function RunGraphView({ data, actions = {}, fileUrl, initial = null, lastRead }: { data: RunGraph; actions?: GraphActions; fileUrl: (ref: string) => string; initial?: Selection; lastRead?: number }) {
  const [selected, setSelected] = useState<Selection>(initial);
  const marks = useMemo(() => runMarks(data, selected), [data, selected]);
  const final = isFinal(data.run.status);
  const [now, setNow] = useState(() => Date.now());
  const readAt = useMemo(() => Date.now(), [data]);
  useEffect(() => {
    if (final || (data.run.paused && !data.stale)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [final, data.run.paused, data.stale]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Totals data={data} readAt={readAt} now={now} actions={actions} stale={!final && !!lastRead && (data.stale || now - lastRead > 5000) ? Math.max(1000, now - lastRead) : 0} />
      {data.run.paused && (
        <p className="border-b border-warning/40 bg-warning/10 px-5 py-2 font-mono text-[12px] text-warning-text md:px-8" role="status">
          Paused. Calls already in flight finish; no new node starts until you resume. The run keeps its place across a restart.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-[320px] min-w-0 flex-1 overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px]">
          <div className="px-5 py-6 md:px-8">
            <WorkflowGraph graph={data.graph} marks={marks} onSelect={(hit) => setSelected((s) => (s && s.path === hit.path && (s.item ?? null) === hit.item ? null : hit))} label="The run's workflow graph" />
          </div>
        </div>
        {selected && (
          <div className="flex min-h-0 shrink-0 flex-col border-t lg:w-[460px] lg:border-l lg:border-t-0">
            <NodeDrawer data={data} selected={selected} onSelect={setSelected} onClose={() => setSelected(null)} fileUrl={fileUrl} />
          </div>
        )}
      </div>
      <div className="border-t px-5 py-2 md:px-8"><GraphLegend run /></div>
    </div>
  );
}

function Totals({ data, readAt, now, actions, stale }: { data: RunGraph; readAt: number; now: number; actions: GraphActions; stale: number }) {
  const final = isFinal(data.run.status);
  const map = data.graph.nodes.find((n) => n.kind === "map" && data.nodes[n.path]?.items?.length);
  const c = map ? itemCounts(data.nodes[map.path].items) : null;
  const { usd: cost, unknown } = costOf(data);
  const cells: [string, React.ReactNode, string?][] = [
    ["Elapsed", elapsed(elapsedNow(data, readAt, now))],
    ["Cost", <>{usd(cost)}{unknown > 0 && <span className="text-[11px] font-normal text-muted-foreground"> + {unknown} unknown</span>}</>, "Decisions and model calls, as the providers priced them"],
    ["Decisions", data.totals.decisions],
    ["Tool calls", data.totals.effects],
    ["Agents", agentsRun(data), "Agent loops this run started. Decision models and tools answer one call each; none of them is an agent."],
  ];
  if (c) cells.push(["Items", <><span>{c.done}</span><span className="text-muted-foreground">/{c.total}</span>{c.failed > 0 && <span className="ml-2 text-[11px] text-destructive-text">{c.failed} failed</span>}{c.review > 0 && <span className="ml-2 text-[11px] text-warning-text">{c.review} review</span>}</>]);
  return (
    <div className="flex flex-wrap items-stretch border-b">
      {data.run.paused && <div className="flex items-center pl-5 md:pl-8"><Chip tone="warning"><Pause className="size-3" aria-hidden /> Paused</Chip></div>}
      {cells.map(([l, v, title], k) => (
        <div key={l} className={cn("px-4 py-2", k ? "border-l" : "pl-5 md:pl-8")} title={title}>
          <p className="caps text-[10px] text-muted-foreground">{l}</p>
          <p className="font-mono text-[15px] font-semibold tabular-nums">{v}</p>
        </div>
      ))}
      <div className="flex flex-1 items-center justify-end gap-3 px-5 py-2 md:px-8">
        {stale > 0 && <span className="font-mono text-[11px] text-muted-foreground" role="status">Last read {elapsed(stale)} ago, reading again</span>}
        {!final && (data.run.paused
          ? <Button size="sm" variant="solid" onClick={actions.onResume} disabled={!actions.onResume || !!actions.busy}><Play aria-hidden /> {actions.busy === "resume" ? "Resuming" : "Resume"}</Button>
          : <Button size="sm" onClick={actions.onPause} disabled={!actions.onPause || !!actions.busy} title="Calls in flight finish; no new node starts."><Pause aria-hidden /> {actions.busy === "pause" ? "Pausing" : "Pause"}</Button>)}
      </div>
    </div>
  );
}

const AGENT_KINDS = new Set(["agent", "decide", "extract", "report", "artifact"]);
/** The agent nodes of the workflow that started. */
const agentsRun = (g: RunGraph) => g.graph.nodes.filter((n) => AGENT_KINDS.has(n.kind) && !["pending", "not_run"].includes(g.nodes[n.path]?.status ?? "pending")).length;

/** The graph tab before its first read lands, or when the server cannot give the graph. */
export function GraphUnavailable({ error }: { error: unknown }) {
  const status = (error as { status?: number } | null)?.status;
  return (
    <p className={cn("m-8 border p-4 font-mono text-[13px]", status === 404 ? "text-muted-foreground" : "text-destructive-text")} role="status">
      {error == null ? "Reading the run's graph..." : status === 404 ? "This server does not give run graphs: GET /v2/runs/{id}/graph is not there." : `The run's graph could not be read: ${(error as Error).message ?? String(error)}`}
    </p>
  );
}
