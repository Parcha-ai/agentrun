import { useEffect, useState } from "react";
import { agentHash } from "@/components/AgentPage";
import { LearningChips } from "@/components/LearningChips";
import { StatusBadge } from "@/components/StatusBadge";
import { cost, soFar, when } from "@/lib/format";
import { costParts, duration, type MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import { ProblemCard } from "@/components/Problem";
import { MissionSkeleton } from "@/components/Skeleton";
import type { Problem } from "@/lib/problem";
import { isEscalated } from "@/lib/runState";
import type { Run } from "@/lib/v2";
import { RANGES, type StatsRange } from "@/lib/mission";
import { elapsed } from "@/lib/runGraph";
import { stoppedRun } from "@/lib/needs";

/** The range and agent the page's analytics are asked for, and how to change them. */
export type AnalyticsScope = { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; onAgent?: (agent: string | null) => void; refreshing?: boolean };

/** Mission Control shows what needs a person, server counts, analytics and loaded activity. Each snapshot keeps its
 *  freshness and pagination state; a failed refresh leaves the last successful snapshot visible. Before the owner's
 *  first run, `startHere` takes the place of the counts. Servers without analytics retain a plainly qualified total. */
export function MissionControl({ view, error, onRetry, scope, onRefresh, onMore, loadingMore, canCreate = true, filesSupported = true, needsYou, asking, startHere }: { view: MissionView | null; error?: Problem | string | null; onRetry?: () => void; scope?: AnalyticsScope; onRefresh?: () => void; onMore?: () => void; loadingMore?: boolean; canCreate?: boolean; filesSupported?: boolean; needsYou?: React.ReactNode; asking?: number | null; startHere?: React.ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  if (error && !view) return <ProblemCard problem={typeof error === "string" ? { title: "Mission Control could not be read.", why: error, next: "Try again." } : error} onRetry={onRetry} />;
  if (!view) return <MissionSkeleton />;
  if (startHere) return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-6 px-6 py-8">
        <h1 className="text-2xl font-semibold">Mission Control</h1>
        {startHere}
      </div>
    </div>
  );
  const activity = view.activity ?? view.recent;
  const active = activity.filter((r) => r.status === "working" || r.status === "queued");
  const attention = activity.filter((r) => r.status === "input_required" || r.status === "paused" || !!r.review || isEscalated(r.status, r.error));
  const failed = activity.filter((r) => r.status === "failed" && !isEscalated(r.status, r.error));
  const snapshot = !view.readAt ? "Freshness unknown" : now - view.readAt > 45_000 ? "Stale snapshot" : "Snapshot current";
  const names = new Map(view.perAgent.map((a) => [a.agentId, a.name]));
  const perAgent = scope?.agent ? view.perAgent.filter((a) => a.agentId === scope.agent) : view.perAgent;
  const tiles: [string, string, string | undefined, string?, string?][] = [
    ["Agents", String(view.agents), "#/agents"],
    ["Runs", String(view.runs.total), "#/runs"],
    // Active counts queued, working and paused runs, which no one status-filtered list holds.
    ["Active", String(view.runs.active), undefined, undefined, view.runs.statusUnknown ? `${view.runs.statusUnknown} unknown` : undefined],
    // A stopped run asks nothing. While the actionable list is being read, a dash keeps its count honest.
    ["Needs input", asking === null ? "–" : String(asking ?? view.runs.needsInput), "#/runs?status=input_required", (asking ?? view.runs.needsInput) ? "text-warning-text" : undefined],
    ["Failed", String(view.runs.failed), "#/runs?status=failed", view.runs.failed ? "text-destructive-text" : undefined, view.runs.needsReview ? `${view.runs.needsReview} ${view.runs.needsReview === 1 ? "needs" : "need"} review` : undefined],
  ];
  if (!view.analytics) {
    const spent = costParts(view.cost);
    tiles.push(["Total cost", spent.total, undefined, undefined, spent.note]);
  }
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Mission Control</h1>
          {(onRefresh || onRetry) && <button type="button" onClick={onRefresh ?? onRetry} className="border px-3 py-2 text-[13px]">{scope?.refreshing ? "Refreshing" : "Refresh"}</button>}
        </div>
        {error && <p role="alert" className="border p-3 text-[13px] text-warning-text">Disconnected: {typeof error === "string" ? error : [error.title, error.why, error.next, error.said].filter(Boolean).join(" ")}. Showing the last successful snapshot.</p>}
        <p className="font-mono text-[12px] text-muted-foreground" role="status">{snapshot}{view.readAt ? ` · Updated ${when(new Date(view.readAt).toISOString())}` : ""}. Totals cover all non-archived runs on this server.</p>
        {needsYou}
        {view.agents === 0 && canCreate && <section className="border p-5"><p className="mb-3 text-[14px]">Create an agent to start your first run.</p><a href="#/agents/new" className="inline-block border px-4 py-2 text-[13px]">Create agent</a></section>}
        <ul aria-label="Server totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {tiles.map(([label, value, href, tone, note]) => {
            const body = <><p className="caps text-[11px] text-muted-foreground">{label}</p><p className={cn("mt-2 font-mono text-xl font-semibold", tone)}>{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</>;
            return <li key={label}>{href ? <a href={href} className="block h-full border p-4 hover:border-border-strong hover:bg-accent">{body}</a> : <div className="h-full border p-4">{body}</div>}</li>;
          })}
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
            <Activity title="Active work" runs={active} filters={[["queued", "Queued"], ["working", "Working"]]} names={names} now={now} snapshot={snapshot} filesSupported={filesSupported} agent={scope?.agent} />
            <Activity title="Needs attention" runs={attention} filters={[["input_required", "Needs input"], ["paused", "Paused"], ["completed", "Completed"], ["failed", "Failed / escalated"]]} names={names} now={now} snapshot={snapshot} filesSupported={filesSupported} agent={scope?.agent} />
            <Activity title="Failed runs" runs={failed} filters={[["failed", "View runs"]]} names={names} now={now} snapshot={snapshot} filesSupported={filesSupported} agent={scope?.agent} />
          </div>
        </div>
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><h2 className="caps text-[12px] font-semibold">Recent runs</h2><a href="#/runs" className="text-[12px] underline">All runs</a></div>
            <p className="px-4 py-2 text-[12px] text-muted-foreground">Showing {view.recent.length} latest runs{view.nextCursor ? "; more available" : ""}.</p>
            {view.recent.length ? <ActivityRows runs={view.recent} names={names} now={now} snapshot={snapshot} filesSupported={filesSupported} /> : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs yet.</p>}
            {view.nextCursor && onMore && <div className="border-t p-3 text-center"><button type="button" onClick={onMore} disabled={loadingMore} className="border px-4 py-2 text-[13px] disabled:opacity-50">{loadingMore ? "Loading" : "Load more"}</button></div>}
          </section>
        </div>
      </div>
    </div>
  );
}

function Activity({ title, runs, filters, names, now, snapshot, filesSupported, agent }: { title: string; runs: Run[]; filters: [Run["status"], string][]; names: Map<string, string>; now: number; snapshot: string; filesSupported: boolean; agent?: string | null }) {
  return <section className="min-w-0 border" aria-label={title}><div className="space-y-2 border-b px-4 py-3"><h2 className="caps text-[12px] font-semibold">{title}</h2><nav aria-label={`${title} states`} className="flex flex-wrap gap-x-3 gap-y-1">{filters.map(([status, label]) => <a key={status} href={`#/runs?status=${status}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`} className="text-[12px] underline">{label}</a>)}</nav></div>
    {runs.length ? <ActivityRows runs={runs} names={names} now={now} snapshot={snapshot} filesSupported={filesSupported} /> : <p className="px-4 py-6 text-[13px] text-muted-foreground">No matching runs in the loaded activity.</p>}
  </section>;
}

function ActivityRows({ runs, names, now, snapshot, filesSupported }: { runs: Run[]; names: Map<string, string>; now: number; snapshot: string; filesSupported: boolean }) {
  return <ul>{runs.map((r) => <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="block min-w-0 space-y-2 px-4 py-3 hover:bg-accent">
    <div className="flex flex-wrap items-center gap-2"><StatusBadge run={r} /><span className="font-mono text-[11px] text-muted-foreground">{snapshot}</span></div>
    <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 break-words text-[14px]">{r.title}</p><LearningChips run={r} />
      {stoppedRun(r) && <span className="text-[12px] text-muted-foreground">send a message to continue</span>}</div>
    <p className="break-words font-mono text-[11px] text-muted-foreground">{names.get(r.agent_id) ?? r.agent_id} · rev {r.agent_version} · {r.ended_at ? elapsed(Math.max(0, Date.parse(r.ended_at) - Date.parse(r.created_at))) : duration(Math.max(0, now - Date.parse(r.created_at)))} · {r.cost && (r.cost.usd !== null || soFar(r.cost)) ? cost(r.cost) : "Cost not reported"} · {when(r.created_at)}</p>
    <p className="text-[11px] text-muted-foreground">{r.result_available === true || (r.result_available == null && r.result && (r.result.final_answer != null || r.result.output != null)) ? "Result available" : r.result_available === false ? "No result" : "Result availability unknown"} · {!filesSupported ? "File access unavailable" : r.files_available === true ? "Files available" : r.files_available === false ? "No files" : "File availability unknown"}. Open run for timeline{filesSupported ? " and files" : ""}</p>
    {r.error && <p className="break-words text-[12px] text-destructive-text">{r.error.message}</p>}
    {r.review && <p className="break-words text-[12px] text-warning-text">{r.review.reason}</p>}
  </a></li>)}</ul>;
}

/** What the analytics on screen cover, read from their own answer (not the range picked, whose answer may still be on
 *  its way): "Runs started in the last 30 days", or since the date asked, of one agent when it names one. */
function scopeTitle(view: MissionView, now = Date.now()): string {
  const f = view.analytics?.filter ?? { from: null, to: null, agent: null };
  const days = f.from ? Math.round((Math.floor(now / 86_400_000) * 86_400_000 - Date.parse(f.from)) / 86_400_000) + 1 : null;
  const span = !f.from ? "All runs" : RANGES.some((r) => r.days === days) ? `Runs started in the last ${days} days` : `Runs started since ${f.from.slice(0, 10)}`;
  return f.agent ? `${span}, of ${view.perAgent.find((x) => x.agentId === f.agent)?.name ?? f.agent}` : span;
}
