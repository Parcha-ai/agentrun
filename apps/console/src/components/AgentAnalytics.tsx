import { useEffect, useRef, useState } from "react";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import type { Agent } from "@/lib/agentForm";
import { type Client, problemOf } from "@/lib/client";
import { rangeFrom, type Stats, type StatsRange } from "@/lib/mission";

/** The range the tab opens on, which the agent page reads first. */
export const FIRST_RANGE: StatsRange = "30d";

/** One agent's analytics (`GET /v2/stats?agent=`), drawn as Mission Control draws the whole server's: its tokens, time,
 *  success and cost, by harness and effort, per day and its top tools, over the range picked above them. `stats`: the
 *  page's answer for the first range, shown as it is; only another range is read again. */
export function AnalyticsTab({ agent, v2, now = Date.now, stats: first }: { agent: Agent; v2: Client; now?: () => number; stats?: Stats | null }) {
  const [range, setRange] = useState<StatsRange>(FIRST_RANGE);
  const [stats, setStats] = useState<Stats | null>(first ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!first);
  const asked = useRef(0);
  // The range whose answer is on screen: the page's first one when it gave it. Read again only for another range, so an
  // effect run twice (React's StrictMode) reads nothing more.
  const shown = useRef<StatsRange | null>(first ? FIRST_RANGE : null);
  useEffect(() => {
    // Latest wins: each range picked makes every earlier read stale, the range already on screen included, so a late
    // answer for a range left behind never replaces what the picker shows.
    const n = ++asked.current;
    if (shown.current === range) { setError(null); setLoading(false); return; }
    setLoading(true); setError(null);
    v2.statsOver({ from: rangeFrom(range, now()), agent: agent.agent_id })
      .then((s) => { if (n === asked.current) { setStats(s); shown.current = range; } })
      .catch((e) => { if (n === asked.current) setError(problemOf(e)); })
      .finally(() => { if (n === asked.current) setLoading(false); });
  }, [v2, agent.agent_id, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = stats?.analytics;
  return (
    <div className="space-y-6">
      <AnalyticsFilter range={range} onRange={setRange} agent={null} agents={[]} />
      {error ? <p className="border p-4 font-mono text-[13px] text-destructive-text" role="alert">The analytics could not be read: {error}</p>
        : !stats || !a ? <p className="py-12 text-center font-mono text-[13px] text-muted-foreground">Loading analytics...</p>
        : !a.totals.runs ? <div className="border px-4 py-12 text-center"><p className="font-mono text-[13px] text-muted-foreground">No runs of this agent in this range.</p></div>
        // The store's cost basis, as Mission Control reads it; a refetch keeps the last view, dimmed, until the new one is in.
        : <MissionAnalytics a={a} basis={stats.cost.basis === "charge" ? "reported" : stats.cost.basis} now={now()} refreshing={loading} />}
    </div>
  );
}
