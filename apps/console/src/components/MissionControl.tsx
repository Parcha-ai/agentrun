import { observationHash, observedState, observedTone, type ObservationRead } from "@/lib/observations";
import { agentInventory } from "@/lib/agentInventory";
import type { Agent } from "@/lib/agentForm";
import { Banner, Chip } from "@/components/ui";
import { agentHash } from "@/components/AgentPage";
import { LearningChips } from "@/components/LearningChips";
import { StatusBadge } from "@/components/StatusBadge";
import { cost, runEnded, soFar, when, runTitle } from "@/lib/format";
import type { MissionView } from "@/lib/mission";
import { cn } from "@/lib/utils";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import { ProblemCard } from "@/components/Problem";
import { MissionSkeleton } from "@/components/Skeleton";
import type { Problem } from "@/lib/problem";
import { RANGES, type StatsRange } from "@/lib/mission";
import { elapsed } from "@/lib/runGraph";
import { Brain, History, LayoutGrid } from "lucide-react";
import { stoppedRun } from "@/lib/needs";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";

/** The range and agent the page's analytics are asked for, and how to change them. */
export type AnalyticsScope = { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; onAgent?: (agent: string | null) => void; refreshing?: boolean };

function MissionFrame({ actions, children }: { actions?: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">
    <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-2 px-5 md:px-6")}>
      <h1 className={pageTitleClass}><LayoutGrid className="size-4" aria-hidden />Mission Control</h1>
      {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
  </div>;
}

/** Mission Control, the console's first page. First what needs a person (`needsYou`: the runs asking a question, the
 *  failures, the runs at work), then how many agents and runs this server has, how many are working, waiting on a person
 *  or failed (each count a link to its list), what they cost (said with its basis, never $0 for a cost not known), runs
 *  a connected-agent inventory, and the latest runs with their agent, duration and cost, with combined tokens and run time, success and tools
 *  over the range picked (MissionAnalytics). Before the owner's first run, `startHere` sits above the data; it never replaces it. */
export function MissionControl({ view, error, onRetry, scope, needsYou, asking, failed, live, startHere, actions, observed, agents, agentsError }: { view: MissionView | null; error?: Problem | null; onRetry?: () => void; scope?: AnalyticsScope; needsYou?: React.ReactNode; asking?: number | null; failed?: number | null; live?: number | null; startHere?: React.ReactNode; actions?: React.ReactNode; observed?: ObservationRead; agents?: Agent[] | null; agentsError?: string | null }) {
  const inventory = agentInventory(agents ?? [], observed?.data?.sessions ?? []);
  const managed = agents === undefined ? (view?.perAgent ?? []).map(a => ({ id: a.agentId, name: a.name, href: agentHash(a.agentId, "runs"), detail: `${a.runs} runs` }))
    : inventory.agents.map(a => ({ id: a.agent_id, name: a.definition.name ?? a.agent_id, href: agentHash(a.agent_id, "runs"), detail: `${view?.perAgent.find(row => row.agentId === a.agent_id)?.runs ?? a.runs?.count ?? 0} runs` }));
  const rows = [...managed.map(row => ({ ...row, session: undefined })), ...inventory.sessions.map(session => ({
    id: session.id, name: session.display_name, href: observationHash(session.id), detail: observedState(session), session,
  }))];
  const filtered = scope?.agent ? rows.filter(row => row.id === scope.agent || row.session?.learning?.agent_id === scope.agent) : rows;
  const inventoryMissing = agents === null || !!(observed && (!observed.data || observed.error));
  const agentCount = inventoryMissing ? null : agents === undefined ? (view?.agents ?? 0) + inventory.sessions.length : inventory.count;
  const inventoryNote = inventoryMissing ? observed?.loading ? "Loading connected agents" : "Agent count unavailable" : undefined;
  const connectedAgents = <section className="min-w-0 overflow-hidden border bg-card" aria-label="Connected agents">
    <h2 className="caps flex min-h-12 items-center gap-2 border-b px-5 py-3 text-small font-semibold"><Brain className="size-4" aria-hidden />Connected agents</h2>
    {agentsError && <Banner tone="error">Could not refresh connected agents: {agentsError}</Banner>}
    {observed?.error && <Banner tone="error">Could not refresh connected agents: {observed.error}</Banner>}
    {observed?.data?.connectors.some(connector => connector.storage_full) && <Banner tone="warning">A connection has reached its activity storage limit. New usage reports may be missing.</Banner>}
    {filtered.length ? <ul>{filtered.map(row => <li key={row.href} className="border-b last:border-b-0">
      <a href={row.href} className="flex items-center justify-between gap-3 px-4 py-3 text-lead hover:bg-accent">
        <span className="min-w-0 truncate">{row.name}</span>
        {row.session ? <Chip tone={observedTone(row.session)}>{row.detail}</Chip> : <span className="shrink-0 font-mono text-body text-muted-foreground">{row.detail}</span>}
      </a>
    </li>)}</ul> : <p className="px-4 py-6 text-center font-mono text-body text-muted-foreground">{inventoryMissing ? "Connected agents are unavailable." : "No connected agents yet."}</p>}
  </section>;
  // An unavailable run-statistics read must not hide independently loaded connected agents.
  if (!view) return <MissionFrame actions={actions}>
    <div className="mx-auto w-full max-w-page-wide space-y-8 px-5 pb-16 pt-8 md:px-8 md:pt-10">
      {error ? <ProblemCard problem={error} onRetry={onRetry} /> : <MissionSkeleton />}
      {connectedAgents}
    </div>
  </MissionFrame>;
  const name = (id: string) => view.perAgent.find((a) => a.agentId === id)?.name ?? id;
  // Each count links to its list, filtered to it; the active runs have no one list of their own. The cost is said once,
  // in the range's analytics below, never again here.
  const tiles: [string, string, string | undefined, string?, string?][] = [
    ["Agents", agentCount === null ? "–" : String(agentCount), "#/agents", undefined, inventoryNote],
    ["Runs", String(view.runs.total), "#/runs"],
    // Running runs the server can't tell the state of are in no other count: said under Active, never dropped. Active
    // counts queued, working and paused runs, which no one list holds, so it links nowhere (Needs you lists the working).
    // Running now (Needs you) lists the working ones only: where that differs, the tile says how many are running now.
    ["Active runs", String(view.runs.active), undefined, undefined, [typeof live === "number" && live !== view.runs.active ? `${live} running now` : "", view.runs.statusUnknown ? `${view.runs.statusUnknown} unknown` : ""].filter(Boolean).join(" · ") || undefined],
    // What Needs you lists, counted from the same runs (asksPerson): a stopped run asks nothing, so it is not counted (it
    // shows in Recent runs as Stopped). Still being read: a dash. With no list beside it: the server's own count.
    ["Needs input", asking === null ? "–" : String(asking ?? view.runs.needsInput), "#/runs?status=input_required", (asking ?? view.runs.needsInput) ? "text-warning-text" : undefined],
    // What Needs you lists, the failures of the last 24 h (imported history left out), under that window's name, with
    // every failed run (the server's count) one click away; still being read: a dash. With no list beside it: the server's
    // count, all of them. Escalated runs waiting for review are counted apart from the failed: said under it, never in it.
    failed === undefined
      ? ["Failed", String(view.runs.failed), "#/runs?status=failed", view.runs.failed ? "text-destructive-text" : undefined, review(view.runs.needsReview)]
      : ["Failed · last 24 h", failed === null ? "–" : String(failed), "#/runs?status=failed", failed ? "text-destructive-text" : undefined, [`See all ${view.runs.failed}`, review(view.runs.needsReview) ?? ""].filter(Boolean).join(" · ")],
  ];
  return (
    <MissionFrame actions={actions}>
      <div className="mx-auto w-full max-w-page-wide space-y-8 px-5 pb-16 pt-8 md:px-8 md:pt-10">
        {error && <ProblemCard problem={error} onRetry={onRetry} className="" />}
        {startHere}
        {needsYou}
        <section className="space-y-4" aria-label="Agents and runs">
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {tiles.map(([label, value, href, tone, note]) => {
            const body = <><p className="caps text-label text-muted-foreground">{label}</p><p className={cn("mt-3 font-mono text-display leading-none", tone)}>{value}</p>{note && <p className="mt-2 text-label text-muted-foreground">{note}</p>}</>;
            return <li key={label}>{href ? <a href={href} className="block h-full border bg-card p-5 transition-colors hover:border-border-strong hover:bg-accent">{body}</a> : <div className="h-full border bg-card p-5">{body}</div>}</li>;
          })}
        </ul>
        </section>
        <section className="space-y-4" aria-label="Analytics">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div><h2 className="text-lead font-semibold">Activity &amp; usage</h2><p className="mt-1 text-small text-muted-foreground">{scopeTitle(view, rows.find(row => row.id === view.analytics.filter.agent)?.name)}</p></div>
            {scope && <AnalyticsFilter range={scope.range} onRange={scope.onRange} agent={scope.agent} agents={rows.map(row => ({ agentId: row.id, name: row.name, runs: view.perAgent.find(a => a.agentId === row.id)?.runs ?? 0 }))} onAgent={scope.onAgent} />}
          </div>
          <MissionAnalytics a={view.analytics} basis={view.cost.basis} refreshing={scope?.refreshing} />
        </section>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {connectedAgents}
          <section className="min-w-0 overflow-hidden border bg-card">
            <h2 className="caps flex min-h-12 items-center gap-2 border-b px-5 py-3 text-small font-semibold"><History className="size-4" aria-hidden />Recent runs</h2>
            {view.recent.length ? (
              <ul>{view.recent.map((r) => (
                <li key={r.run_id} className="border-b last:border-b-0"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent">
                  <StatusBadge run={r} />
                  {/* The run's title, then its chips (what it learned and used) right after it. */}
                  <span className="flex min-w-0 flex-1 items-center gap-2"><span className="min-w-0 truncate text-lead">{runTitle(r)}</span><LearningChips run={r} className="hidden sm:inline-flex" />
                    {stoppedRun(r) && <span className="shrink-0 text-small text-muted-foreground">send a message to continue</span>}</span>
                  <span className="hidden shrink-0 text-body text-muted-foreground md:inline">{name(r.agent_id)}</span>
                  {r.ended_at && <span className="hidden font-mono text-small text-muted-foreground sm:inline" title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span>}
                  {r.cost && (r.cost.usd !== null || soFar(r.cost)) && <span className="hidden font-mono text-small text-muted-foreground sm:inline">{cost(r.cost, { ended: runEnded(r.status) })}</span>}
                  <span className="hidden font-mono text-small text-muted-foreground sm:inline">{when(r.created_at)}</span>
                </a></li>
              ))}</ul>
            ) : <p className="px-4 py-6 text-center font-mono text-body text-muted-foreground">No runs yet.</p>}
          </section>
        </div>
      </div>
    </MissionFrame>
  );
}

/** "2 need review", for the runs escalated to a person; nothing for none. */
const review = (n: number) => (n ? `${n} ${n === 1 ? "needs" : "need"} review` : undefined);

/** What the analytics on screen cover, read from their own answer (not the range picked, whose answer may still be on
 *  its way): "Activity in the last 30 days", or since the date asked, of one agent when it names one. */
function scopeTitle(view: MissionView, selectedName?: string, now = Date.now()): string {
  const f = view.analytics.filter;
  const days = f.from ? Math.round((Math.floor(now / 86_400_000) * 86_400_000 - Date.parse(f.from)) / 86_400_000) + 1 : null;
  const span = !f.from ? "All recorded activity" : RANGES.some((r) => r.days === days) ? `Activity in the last ${days} days` : `Activity since ${f.from.slice(0, 10)}`;
  return f.agent ? `${span}, of ${selectedName ?? view.perAgent.find((x) => x.agentId === f.agent)?.name ?? f.agent}` : span;
}
