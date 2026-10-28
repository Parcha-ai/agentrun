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
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => {
    v2.capabilities().then(setCaps).catch(() => {});
    // Every page of agents, for their names.
    (async () => {
      const all: Record<string, string> = {};
      for (let c: string | null | undefined = undefined, i = 0; i < 50; i++) {
        const page = await v2.listAgents(c);
        for (const x of page.agents) all[x.agent_id] = x.definition.name ?? x.agent_id;
        if (!page.next_cursor) break;
        c = page.next_cursor;
      }
      setNames(all);
    })().catch(() => {});
  }, [v2]);
  useEffect(() => {
    if (where.run) return;
    v2.listRuns().then((r) => { setRuns(r.runs); setCursor(r.next_cursor); }).catch((e) => setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)));
  }, [v2, where.run]);
  const agentName = (id: string) => names[id] ?? id;
  const go = (s: Section) => { if (s === "runs") location.hash = "#/runs"; };
  return (
    <Shell active="runs" onNavigate={go}>
      {where.run
        ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => { location.hash = `#/runs/${encodeURIComponent(id)}`; }} loadingMore={more}
            onMore={cursor ? () => { setMore(true); v2.listRuns(50, cursor).then((r) => { setRuns((x) => [...(x ?? []), ...r.runs]); setCursor(r.next_cursor); }).catch((e) => setError(String(e))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
  );
}
