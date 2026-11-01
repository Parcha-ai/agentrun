import { StatusBadge } from "@/components/StatusBadge";
import { when } from "@/lib/format";
import { costParts, type MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import { RANGES, type StatsRange } from "@/lib/mission";

/** The range and agent the page's analytics are asked for, and how to change them. */
export type AnalyticsScope = { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; onAgent?: (agent: string | null) => void; refreshing?: boolean };

/** Mission Control, the console's first page: how many agents and runs this server has, how many runs are working,
 *  waiting on a person or failed, what they cost (said with its basis, never $0 for a cost not known), runs per agent,
 *  and the latest runs, each a link to its page. A server that answers `analytics` also gets its tokens, time, success
 *  and tools over the range picked (MissionAnalytics); one that does not gets the page as it was. */
export function MissionControl({ view, error, onRetry, scope }: { view: MissionView | null; error?: string | null; onRetry?: () => void; scope?: AnalyticsScope }) {
  if (error) return (
    <div className="m-8 border p-4" role="alert">
      <p className="font-mono text-[13px] text-destructive-text">Mission Control could not be read: {error}</p>
      {onRetry && <button type="button" onClick={onRetry} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>}
    </div>
  );
  if (!view) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  const spent = costParts(view.cost);
  const tiles: [string, string, string?, string?][] = [
    ["Agents", String(view.agents)],
    ["Runs", String(view.runs.total)],
    // Running runs the server can't tell the state of are in no other count: said under Active, never dropped.
    ["Active", String(view.runs.active), undefined, view.runs.statusUnknown ? `${view.runs.statusUnknown} unknown` : undefined],
    ["Needs input", String(view.runs.needsInput), view.runs.needsInput ? "text-warning-text" : undefined],
    ["Failed", String(view.runs.failed), view.runs.failed ? "text-destructive-text" : undefined],
    ["Total cost", spent.total, undefined, spent.note],
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
        <h1 className="text-2xl font-semibold">Mission Control</h1>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map(([label, value, tone, note]) => (
            <li key={label} className="border p-4"><p className="caps text-[11px] text-muted-foreground">{label}</p><p className={cn("mt-2 font-mono text-xl font-semibold", tone)}>{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</li>
          ))}
        </ul>
        {view.analytics && (
          <section className="space-y-4" aria-label="Analytics">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <h2 className="text-lg font-semibold">{scopeTitle(view, scope?.range)}</h2>
              {scope && <AnalyticsFilter range={scope.range} onRange={scope.onRange} agent={scope.agent} agents={view.perAgent} onAgent={scope.onAgent} />}
            </div>
            <MissionAnalytics a={view.analytics} basis={view.cost.basis} refreshing={scope?.refreshing} />
          </section>
        )}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Runs per agent</h2>
            {view.perAgent.length ? (
              <ul>{view.perAgent.map((a) => (
                <li key={a.agentId} className="border-b last:border-b-0"><a href={`#/runs?agent=${encodeURIComponent(a.agentId)}`} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px] hover:bg-accent"><span className="min-w-0 truncate">{a.name}</span><span className="font-mono text-[13px] text-muted-foreground">{a.runs}</span></a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No agents yet.</p>}
          </section>
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Recent runs</h2>
            {view.recent.length ? (
              <ul>{view.recent.map((r) => (
                <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent">
                  <StatusBadge run={r} /><span className="min-w-0 flex-1 truncate text-[14px]">{r.title}</span><span className="hidden font-mono text-[12px] text-muted-foreground sm:inline">{when(r.created_at)}</span>
                </a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

/** What the analytics cover, said as their heading: "Runs started in the last 30 days", or since the date the answer
 *  names, of one agent when it names one. */
function scopeTitle(view: MissionView, range?: StatsRange): string {
  const f = view.analytics!.filter;
  const days = RANGES.find((r) => r.id === range)?.days;
  const span = !f.from ? "All runs" : days ? `Runs started in the last ${days} days` : `Runs started since ${f.from.slice(0, 10)}`;
  return f.agent ? `${span}, of ${view.perAgent.find((x) => x.agentId === f.agent)?.name ?? f.agent}` : span;
}
