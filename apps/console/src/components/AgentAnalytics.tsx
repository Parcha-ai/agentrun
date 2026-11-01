import { useEffect, useRef, useState } from "react";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { rangeFrom, type Stats, type StatsRange } from "@/lib/mission";

const problemOf = (e: unknown) => (e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** One agent's analytics (`GET /v2/stats?agent=`), drawn as Mission Control draws the whole server's: its tokens, time,
 *  success and cost, by harness and effort, per day and its top tools, over the range picked above them. */
export function AnalyticsTab({ agent, v2, now = Date.now }: { agent: Agent; v2: Client; now?: () => number }) {
  const [range, setRange] = useState<StatsRange>("30d");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    setLoading(true); setError(null);
    v2.statsOver({ from: rangeFrom(range, now()), agent: agent.agent_id })
      .then((s) => { if (n === asked.current) { if (s.analytics) setStats(s); else setError("this server gives no analytics"); } })
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
