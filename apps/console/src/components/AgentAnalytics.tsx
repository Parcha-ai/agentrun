import { useEffect, useRef, useState } from "react";
import { AnalyticsFilter, MissionAnalytics } from "@/components/MissionAnalytics";
import type { Agent } from "@/lib/agentForm";
import { type Client, follow, problemOf } from "@/lib/client";
import { rangeFrom, type Stats, type StatsRange } from "@/lib/mission";
import { isFinal } from "@/lib/runGraph";
import { pause, TRIES_MS } from "@/lib/viewing";

/** The range the tab opens on, which the agent page reads first. */
export const FIRST_RANGE: StatsRange = "30d";
/** The most runs going at once the tab follows (each on its own timeline read). */
const FOLLOWED = 10;

/** One agent's analytics (`GET /v2/stats?agent=`), drawn as Mission Control draws the whole server's: its tokens, time,
 *  success and cost, by harness and effort, per day and its top tools, over the range picked above them. `stats`: the
 *  page's answer for the first range, shown (dimmed) until the tab's own read lands: the tab reads again whenever what it
 *  shows may have moved. When it opens; when a run of this agent that was going changes status (followed on its
 *  timeline, as the Runs tab follows its latest run, at most FOLLOWED of them); and, TRIES_MS apart, while the answer's
 *  `runs.status_unknown` says a run's end is not in the server's store yet (a run that just ended), then it stops. A run
 *  started after the tab opened is read on its next opening. */
export function AnalyticsTab({ agent, v2, now = Date.now, stats: first }: { agent: Agent; v2: Client; now?: () => number; stats?: Stats | null }) {
  const [range, setRange] = useState<StatsRange>(FIRST_RANGE);
  const [stats, setStats] = useState<Stats | null>(first ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // How many times a followed run's status moved: each one reads the stats again.
  const [moved, setMoved] = useState(0);
  const asked = useRef(0);
  // What a read is for: the range, and how many moves of a followed run it follows. `shown`: the one whose answer is on
  // screen (none when the tab opens: the page's answer may be stale). `inflight`: the one a read is under way for.
  const shown = useRef<string | null>(null);
  const inflight = useRef<string | null>(null);
  useEffect(() => {
    const key = `${range}/${moved}`;
    // The same read already under way: React's StrictMode runs an effect twice, and the second adds no read.
    if (inflight.current === key) return;
    // Latest wins: each read begun makes every earlier one stale, so a late answer for a range left behind, or for a
    // moment since passed, never replaces a newer one.
    const n = ++asked.current;
    // Back at the answer on screen (a range picked, then the one before it again): no read, and the other one is stale.
    if (shown.current === key) { inflight.current = null; setError(null); setLoading(false); return; }
    inflight.current = key;
    setLoading(true); setError(null);
    void (async () => {
      for (const ms of TRIES_MS) {
        if (ms) await pause(ms);
        if (n !== asked.current) return;
        try {
          const s = await v2.statsOver({ from: rangeFrom(range, now()), agent: agent.agent_id });
          if (n !== asked.current) return;
          setStats(s); shown.current = key;
          // Settled: the server holds no run whose end its store has yet to write.
          if (!(s.runs.status_unknown > 0)) break;
        } catch (e) {
          if (n === asked.current) setError(problemOf(e));
          break;
        }
      }
      if (n === asked.current) { inflight.current = null; setLoading(false); }
    })();
  }, [v2, agent.agent_id, range, moved]); // eslint-disable-line react-hooks/exhaustive-deps
  // The agent's runs going when the tab opens, each followed until it ends: a status that moves reads the stats again.
  useEffect(() => {
    const ctl = new AbortController();
    v2.listAgentRuns(agent.agent_id, 50, null, !!agent.archived_at).then((r) => {
      for (const run of r.runs.filter((x) => !isFinal(x.status)).slice(0, FOLLOWED)) {
        let seen = `${run.status}/${run.state}`;
        follow(v2, run.run_id, {
          signal: ctl.signal,
          onRows: () => {},
          onPage: (p) => { const s = `${p.status}/${p.state}`; if (s !== seen) { seen = s; setMoved((k) => k + 1); } },
        }).catch(() => {});
      }
    }, () => {});
    return () => ctl.abort();
  }, [v2, agent.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps
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
