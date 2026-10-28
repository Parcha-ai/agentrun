import { useEffect, useMemo, useState } from "react";
import { LiveRun } from "@/components/LiveRun";
import { RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { type Capabilities, ClientError, createClient } from "@/lib/client";
import type { Run } from "@/lib/v2";

const route = () => {
  const m = location.hash.match(/^#\/runs\/([^/]+)$/);
  return m ? { run: decodeURIComponent(m[1]) } : { run: null };
};

/** The console over the server it is served from: the runs, and a run followed live. */
export function App() {
  const v2 = useMemo(() => createClient(), []);
  const [where, setWhere] = useState(route);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => {
    v2.capabilities().then(setCaps).catch(() => {});
    v2.listAgents().then((a) => setNames(Object.fromEntries(a.agents.map((x) => [x.agent_id, x.definition.name ?? x.agent_id])))).catch(() => {});
  }, [v2]);
  useEffect(() => {
    if (where.run) return;
    v2.listRuns().then((r) => setRuns(r.runs)).catch((e) => setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)));
  }, [v2, where.run]);
  const agentName = (id: string) => names[id] ?? id;
  const go = (s: Section) => { if (s === "runs") location.hash = "#/runs"; };
  return (
    <Shell active="runs" onNavigate={go}>
      {where.run
        ? <LiveRun v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => { location.hash = `#/runs/${encodeURIComponent(id)}`; }} />}
    </Shell>
  );
}
