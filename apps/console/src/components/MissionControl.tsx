import { agentHash } from "@/components/AgentPage";
import { LearningChips } from "@/components/LearningChips";
import { StatusBadge } from "@/components/StatusBadge";
import { cost, soFar, when } from "@/lib/format";
import type { MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import { ProblemCard } from "@/components/Problem";
import { MissionSkeleton } from "@/components/Skeleton";
import type { Problem } from "@/lib/problem";
import { RANGES, type StatsRange } from "@/lib/mission";
import { elapsed } from "@/lib/runGraph";

/** The range and agent the page's analytics are asked for, and how to change them. */
export type AnalyticsScope = { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; onAgent?: (agent: string | null) => void; refreshing?: boolean };

/** Mission Control, the console's first page. First what needs a person (`needsYou`: the runs asking a question, the
 *  failures, the runs at work), then how many agents and runs this server has, how many are working, waiting on a person
 *  or failed (each count a link to its list), what they cost (said with its basis, never $0 for a cost not known), runs
 *  per agent, and the latest runs with their agent, duration and cost, with the runs' tokens, time, success and tools
 *  over the range picked (MissionAnalytics). Before the owner's first run, `startHere` takes the place of all of it. */
export function MissionControl({ view, error, onRetry, scope, needsYou, startHere }: { view: MissionView | null; error?: Problem | null; onRetry?: () => void; scope?: AnalyticsScope; needsYou?: React.ReactNode; startHere?: React.ReactNode }) {
  if (error) return <ProblemCard problem={error} onRetry={onRetry} />;
  if (!view) return <MissionSkeleton />;
  if (startHere) return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-6 px-6 py-8">
        <h1 className="text-2xl font-semibold">Mission Control</h1>
        {startHere}
      </div>
    </div>
  );
  const name = (id: string) => view.perAgent.find((a) => a.agentId === id)?.name ?? id;
  // An agent picked over the analytics: Runs per agent shows its row alone. The picker still offers every agent.
  const perAgent = scope?.agent ? view.perAgent.filter((a) => a.agentId === scope.agent) : view.perAgent;
  // Each count links to its list, filtered to it; the active runs have no one list of their own. The cost is said once,
  // in the range's analytics below, never again here.
  const tiles: [string, string, string | undefined, string?, string?][] = [
    ["Agents", String(view.agents), "#/agents"],
    ["Runs", String(view.runs.total), "#/runs"],
    // Running runs the server can't tell the state of are in no other count: said under Active, never dropped. Active
    // counts queued, working and paused runs, which no one list holds, so it links nowhere (Needs you lists the working).
    ["Active", String(view.runs.active), undefined, undefined, view.runs.statusUnknown ? `${view.runs.statusUnknown} unknown` : undefined],
    ["Needs input", String(view.runs.needsInput), "#/runs?status=input_required", view.runs.needsInput ? "text-warning-text" : undefined],
    // Escalated runs waiting for review are counted apart from the failed: said under Failed, never in it.
    ["Failed", String(view.runs.failed), "#/runs?status=failed", view.runs.failed ? "text-destructive-text" : undefined, view.runs.needsReview ? `${view.runs.needsReview} ${view.runs.needsReview === 1 ? "needs" : "need"} review` : undefined],
  ];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
        <h1 className="text-2xl font-semibold">Mission Control</h1>
        {needsYou}
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {tiles.map(([label, value, href, tone, note]) => {
            const body = <><p className="caps text-[11px] text-muted-foreground">{label}</p><p className={cn("mt-2 font-mono text-xl font-semibold", tone)}>{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</>;
            return <li key={label}>{href ? <a href={href} className="block h-full border p-4 hover:border-border-strong hover:bg-accent">{body}</a> : <div className="h-full border p-4">{body}</div>}</li>;
          })}
        </ul>
        <section className="space-y-4" aria-label="Analytics">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h2 className="text-lg font-semibold">{scopeTitle(view)}</h2>
            {scope && <AnalyticsFilter range={scope.range} onRange={scope.onRange} agent={scope.agent} agents={view.perAgent} onAgent={scope.onAgent} />}
          </div>
          <MissionAnalytics a={view.analytics} basis={view.cost.basis} refreshing={scope?.refreshing} />
        </section>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Runs per agent</h2>
            {perAgent.length ? (
              <ul>{perAgent.map((a) => (
                <li key={a.agentId} className="border-b last:border-b-0"><a href={agentHash(a.agentId, "runs")} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px] hover:bg-accent"><span className="min-w-0 truncate">{a.name}</span><span className="font-mono text-[13px] text-muted-foreground">{a.runs}</span></a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No agents yet.</p>}
          </section>
          <section className="border">
            <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Recent runs</h2>
            {view.recent.length ? (
              <ul>{view.recent.map((r) => (
                <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent">
                  <StatusBadge run={r} />
                  {/* The run's title, then its chips (what it learned and used) right after it. */}
                  <span className="flex min-w-0 flex-1 items-center gap-2"><span className="min-w-0 truncate text-[14px]">{r.title}</span><LearningChips run={r} className="hidden sm:inline-flex" /></span>
                  <span className="hidden shrink-0 text-[13px] text-muted-foreground md:inline">{name(r.agent_id)}</span>
                  {r.ended_at && <span className="hidden font-mono text-[12px] text-muted-foreground sm:inline" title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span>}
                  {r.cost && (r.cost.usd !== null || soFar(r.cost)) && <span className="hidden font-mono text-[12px] text-muted-foreground sm:inline">{cost(r.cost)}</span>}
                  <span className="hidden font-mono text-[12px] text-muted-foreground sm:inline">{when(r.created_at)}</span>
                </a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

/** What the analytics on screen cover, read from their own answer (not the range picked, whose answer may still be on
 *  its way): "Runs started in the last 30 days", or since the date asked, of one agent when it names one. */
function scopeTitle(view: MissionView, now = Date.now()): string {
  const f = view.analytics.filter;
  const days = f.from ? Math.round((Math.floor(now / 86_400_000) * 86_400_000 - Date.parse(f.from)) / 86_400_000) + 1 : null;
  const span = !f.from ? "All runs" : RANGES.some((r) => r.days === days) ? `Runs started in the last ${days} days` : `Runs started since ${f.from.slice(0, 10)}`;
  return f.agent ? `${span}, of ${view.perAgent.find((x) => x.agentId === f.agent)?.name ?? f.agent}` : span;
}
