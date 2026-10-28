import { useEffect, useMemo, useState } from "react";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { LiveRun } from "@/components/LiveRun";
import { RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { type Capabilities, ClientError, createClient } from "@/lib/client";
import type { Run } from "@/lib/v2";

type Where = { section: Section; run?: string; agent?: string | null; runsOf?: string };
function route(): Where {
  const h = location.hash;
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: decodeURIComponent(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  m = h.match(/^#\/agents\/([^/?]+)$/);
  if (m) return { section: "agents", agent: decodeURIComponent(m[1]) };
  if (h.startsWith("#/agents")) return { section: "agents" };
  m = h.match(/^#\/runs\?agent=([^&]+)$/);
  return m ? { section: "runs", runsOf: decodeURIComponent(m[1]) } : { section: "runs" };
}

/** The console over the server it is served from: agents, runs, and a run followed live. */
export function App() {
  const v2 = useMemo(() => createClient(), []);
  const [where, setWhere] = useState(route);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const go = (hash: string) => { location.hash = hash; };
  useEffect(() => { const on = () => setWhere(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  useEffect(() => {
    v2.capabilities().then(setCaps).catch(() => {});
    // Every page of agents, for their names.
    (async () => {
      const all: Record<string, string> = {};
      for (let c: string | null | undefined = undefined, i = 0; i < 50; i++) {
        const page = await v2.listAgents({ cursor: c });
        for (const x of page.agents) all[x.agent_id] = x.definition.name ?? x.agent_id;
        if (!page.next_cursor) break;
        c = page.next_cursor;
      }
      setNames(all);
    })().catch(() => {});
  }, [v2]);
  useEffect(() => {
    if (where.section !== "runs" || where.run) return;
    setRuns(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf) : v2.listRuns()).then((r) => { setRuns(r.runs); setCursor(r.next_cursor); }).catch((e) => setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)));
  }, [v2, where]);
  const agentName = (id: string) => names[id] ?? id;
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: string[]; features?: { thinking?: string[] }; models?: { default?: string } } | null;
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: c?.tools ?? [], thinking: c?.features?.thinking ?? [], defaultModel: c?.models?.default };
  const nav = (s: Section) => { if (s === "runs") go("#/runs"); if (s === "agents") go("#/agents"); };
  return (
    <Shell active={where.section} onNavigate={nav}>
      {where.section === "agents"
        ? where.agent === undefined ? <AgentsPage v2={v2} caps={editorCaps} go={go} /> : <AgentEditPage key={where.agent ?? "new"} v2={v2} caps={editorCaps} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            onMore={cursor ? () => { setMore(true); (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor) : v2.listRuns(50, cursor)).then((r) => { setRuns((x) => [...(x ?? []), ...r.runs]); setCursor(r.next_cursor); }).catch((e) => setError(String(e))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
  );
}
