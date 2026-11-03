import { useEffect, useState } from "react";
import { agentHash } from "@/components/AgentPage";
import { StatusBadge } from "@/components/StatusBadge";
import { cost, when } from "@/lib/format";
import { costParts, duration, type MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import { isEscalated } from "@/lib/runState";
import type { Run } from "@/lib/v2";
import { RANGES, type StatsRange } from "@/lib/mission";

/** The range and agent the page's analytics are asked for, and how to change them. */
export type AnalyticsScope = { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; onAgent?: (agent: string | null) => void; refreshing?: boolean };

/** Mission Control, the console's first page: how many agents and runs this server has, how many runs are working,
 *  waiting on a person or failed, what they cost (said with its basis, never $0 for a cost not known), runs per agent,
 *  and the latest runs, each a link to its page. A server that answers `analytics` also gets its tokens, time, success
 *  and tools over the range picked (MissionAnalytics); one that does not gets the page as it was. */
export function MissionControl({ view, error, onRetry, scope, onRefresh, onMore, loadingMore, canCreate = true }: { view: MissionView | null; error?: string | null; onRetry?: () => void; scope?: AnalyticsScope; onRefresh?: () => void; onMore?: () => void; loadingMore?: boolean; canCreate?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  if (error && !view) return (
    <div className="m-8 border p-4" role="alert">
      <p className="font-mono text-[13px] text-destructive-text">Mission Control could not be read: {error}</p>
      {onRetry && <button type="button" onClick={onRetry} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>}
    </div>
  );
  if (!view) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  const spent = costParts(view.cost);
  const activity = view.activity ?? view.recent;
  const active = activity.filter((r) => r.status === "working" || r.status === "queued");
  const attention = activity.filter((r) => r.status === "input_required" || r.status === "paused" || !!r.review || isEscalated(r.status, r.error));
  const failed = activity.filter((r) => r.status === "failed" && !isEscalated(r.status, r.error));
  const snapshot = !view.readAt ? "Freshness unknown" : now - view.readAt > 45_000 ? "Stale snapshot" : "Snapshot current";
  const names = new Map(view.perAgent.map((a) => [a.agentId, a.name]));
  const tiles: [string, string, string?, string?][] = [
    ["Agents", String(view.agents)],
    ["Runs", String(view.runs.total)],
    // Running runs the server can't tell the state of are in no other count: said under Active, never dropped.
    ["Active", String(view.runs.active), undefined, view.runs.statusUnknown ? `${view.runs.statusUnknown} unknown` : undefined],
    ["Needs input", String(view.runs.needsInput), view.runs.needsInput ? "text-warning-text" : undefined],
    // A newer server counts escalated runs waiting for review apart from the failed: said under Failed, never in it.
    ["Failed", String(view.runs.failed), view.runs.failed ? "text-destructive-text" : undefined, view.runs.needsReview ? `${view.runs.needsReview} ${view.runs.needsReview === 1 ? "needs" : "need"} review` : undefined],
    ["Total cost", spent.total, undefined, [spent.note, spent.bound].filter(Boolean).join(" · ") || undefined],
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Mission Control</h1>
          {(onRefresh || onRetry) && <button type="button" disabled={scope?.refreshing} onClick={onRefresh ?? onRetry} className="border px-3 py-2 text-[13px] disabled:opacity-50">{scope?.refreshing ? "Refreshing" : "Refresh"}</button>}
        </div>
        {error && <p role="alert" className="border p-3 text-[13px] text-warning-text">Disconnected: {error}. Showing the last successful snapshot.</p>}
        <p className="font-mono text-[12px] text-muted-foreground" role="status">{snapshot}{view.readAt ? ` · Updated ${when(new Date(view.readAt).toISOString())}` : ""}. Totals cover all non-archived runs on this server.</p>
        {view.agents === 0 && canCreate && <section className="border p-5"><p className="mb-3 text-[14px]">Create an agent to start your first run.</p><a href="#/agents/new" className="inline-block border px-4 py-2 text-[13px]">Create agent</a></section>}
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map(([label, value, tone, note]) => (
            <li key={label} className="border p-4"><p className="caps text-[11px] text-muted-foreground">{label}</p><p className={cn("mt-2 font-mono text-xl font-semibold", tone)}>{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</li>
          ))}
        </ul>
        {view.analytics && (
          <section className="space-y-4" aria-label="Analytics">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <h2 className="text-lg font-semibold">{scopeTitle(view)}</h2>
              {scope && <AnalyticsFilter range={scope.range} onRange={scope.onRange} agent={scope.agent} agents={view.perAgent} onAgent={scope.onAgent} />}
            </div>
            <MissionAnalytics a={view.analytics} basis={view.cost.basis} refreshing={scope?.refreshing} />
          </section>
        )}
        <div className="space-y-3">
          {view.activityComplete !== true && <p className="text-[12px] text-muted-foreground">Partial activity: showing loaded runs. Open a state below to see more.</p>}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Activity title="Active work" runs={active} filters={[["queued", "Queued"], ["working", "Working"]]} names={names} now={now} snapshot={snapshot} />
            <Activity title="Needs attention" runs={attention} filters={[["input_required", "Needs input"], ["paused", "Paused"], ["completed", "Completed"], ["failed", "Failed / escalated"]]} names={names} now={now} snapshot={snapshot} />
            <Activity title="Failed runs" runs={failed} filters={[["failed", "View runs"]]} names={names} now={now} snapshot={snapshot} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Runs per agent</h2>
            {view.perAgent.length ? (
              <ul>{view.perAgent.map((a) => (
                <li key={a.agentId} className="border-b last:border-b-0"><a href={agentHash(a.agentId, "runs")} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px] hover:bg-accent"><span className="min-w-0 truncate">{a.name}</span><span className="font-mono text-[13px] text-muted-foreground">{a.runs}</span></a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No agents yet.</p>}
          </section>
          <section className="border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><h2 className="caps text-[12px] font-semibold">Recent runs</h2><a href="#/runs" className="text-[12px] underline">All runs</a></div>
            <p className="px-4 py-2 text-[12px] text-muted-foreground">Showing {view.recent.length} latest runs{view.nextCursor ? "; more available" : ""}.</p>
            {view.recent.length ? <ActivityRows runs={view.recent} names={names} now={now} snapshot={snapshot} /> : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>}
            {view.nextCursor && onMore && <div className="border-t p-3 text-center"><button type="button" onClick={onMore} disabled={loadingMore} className="border px-4 py-2 text-[13px] disabled:opacity-50">{loadingMore ? "Loading" : "Load more"}</button></div>}
          </section>
        </div>
      </div>
    </div>
  );
}

function Activity({ title, runs, filters, names, now, snapshot }: { title: string; runs: Run[]; filters: [Run["status"], string][]; names: Map<string, string>; now: number; snapshot: string }) {
  return <section className="min-w-0 border" aria-label={title}><div className="space-y-2 border-b px-4 py-3"><h2 className="caps text-[12px] font-semibold">{title}</h2><nav aria-label={`${title} states`} className="flex flex-wrap gap-x-3 gap-y-1">{filters.map(([status, label]) => <a key={status} href={`#/runs?status=${status}`} className="text-[12px] underline">{label}</a>)}</nav></div>
    {runs.length ? <ActivityRows runs={runs} names={names} now={now} snapshot={snapshot} /> : <p className="px-4 py-6 text-[13px] text-muted-foreground">No matching runs in the loaded activity.</p>}
  </section>;
}

function ActivityRows({ runs, names, now, snapshot }: { runs: Run[]; names: Map<string, string>; now: number; snapshot: string }) {
  return <ul>{runs.map((r) => <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="block min-w-0 space-y-2 px-4 py-3 hover:bg-accent">
    <div className="flex flex-wrap items-center gap-2"><StatusBadge run={r} /><span className="font-mono text-[11px] text-muted-foreground">{snapshot}</span></div>
    <p className="break-words text-[14px]">{r.title}</p>
    <p className="break-words font-mono text-[11px] text-muted-foreground">{names.get(r.agent_id) ?? r.agent_id} · rev {r.agent_version} · {duration(Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : now) - Date.parse(r.created_at)))} · {cost(r.cost)}</p>
    <p className="text-[11px] text-muted-foreground">{r.result ? "Result available · " : ""}Open run for timeline and files</p>
    {r.error && <p className="break-words text-[12px] text-destructive-text">{r.error.message}</p>}
    {r.review && <p className="break-words text-[12px] text-warning-text">{r.review.reason}</p>}
  </a></li>)}</ul>;
}

/** What the analytics on screen cover, read from their own answer (not the range picked, whose answer may still be on
 *  its way): "Runs started in the last 30 days", or since the date asked, of one agent when it names one. */
function scopeTitle(view: MissionView, now = Date.now()): string {
  const f = view.analytics!.filter;
  const days = f.from ? Math.round((Math.floor(now / 86_400_000) * 86_400_000 - Date.parse(f.from)) / 86_400_000) + 1 : null;
  const span = !f.from ? "All runs" : RANGES.some((r) => r.days === days) ? `Runs started in the last ${days} days` : `Runs started since ${f.from.slice(0, 10)}`;
  return f.agent ? `${span}, of ${view.perAgent.find((x) => x.agentId === f.agent)?.name ?? f.agent}` : span;
}
