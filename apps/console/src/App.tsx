import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorCaps } from "@/components/AgentEditor";
import { AgentEditPage, AgentsPage } from "@/components/AgentsPage";
import { LiveRun } from "@/components/LiveRun";
import { Operator } from "@/components/Operator";
import { Playground, type StartResult } from "@/components/Playground";
import type { Agent } from "@/lib/agentForm";
import { RunsList } from "@/components/RunsList";
import { type Section, Shell } from "@/components/Shell";
import { allPages, type Capabilities, ClientError, createClient } from "@/lib/client";
import type { Run } from "@/lib/v2";

type Where = { section: Section; run?: string; agent?: string | null; runsOf?: string; archived?: boolean };
function route(): Where {
  const h = location.hash;
  let m = h.match(/^#\/runs\/([^/?]+)$/);
  if (m) return { section: "runs", run: decodeURIComponent(m[1]) };
  if (h === "#/agents/new") return { section: "agents", agent: null };
  m = h.match(/^#\/agents\/([^/?]+)$/);
  if (m) return { section: "agents", agent: decodeURIComponent(m[1]) };
  if (h.startsWith("#/agents")) return { section: "agents", archived: /[?&]archived=true\b/.test(h) };
  if (h.startsWith("#/playground")) return { section: "playground" };
  if (h.startsWith("#/start")) return { section: "operator" };
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
  const asked = useRef(0);
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
    // Only the newest request lands: a slower answer for all runs never replaces one agent's runs, or the reverse.
    const n = ++asked.current;
    setRuns(null); setError(null);
    (where.runsOf ? v2.listAgentRuns(where.runsOf) : v2.listRuns())
      .then((r) => { if (n === asked.current) { setRuns(r.runs); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(e instanceof ClientError ? `${e.code}: ${e.message}` : String(e)); });
  }, [v2, where]);
  const agentName = (id: string) => names[id] ?? id;
  const c = caps as unknown as { harnesses: EditorCaps["harnesses"]; tools?: string[]; features?: { thinking?: string[] }; models?: { default?: string } } | null;
  const editorCaps: EditorCaps = { harnesses: c?.harnesses ?? [], tools: c?.tools ?? [], thinking: c?.features?.thinking ?? [], defaultModel: c?.models?.default };
  const nav = (s: Section) => go({ runs: "#/runs", agents: "#/agents", playground: "#/playground", operator: "#/start" }[s]);
  // The agents both start screens pick from, every page of them.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [revs, setRevs] = useState<{ revision: string; version: number; current: boolean; note: string | null }[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (where.section !== "playground" && where.section !== "operator") return;
    setStartError(null);
    allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents)
      .then((a) => {
        setAgents(a);
        // Keep the pick only while it is an active agent: one archived since is not offered, so not picked either.
        const active = a.filter((x) => !x.archived_at);
        setPick((p) => (p && active.some((x) => x.agent_id === p) ? p : active[0]?.agent_id ?? null));
      })
      .catch((e) => setStartError(e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)));
  }, [v2, where.section, retry]);
  const revsAsked = useRef(0);
  useEffect(() => {
    // The picked agent's revisions only: the old ones go at once, and an answer for an earlier pick is dropped.
    const n = ++revsAsked.current;
    setRevs([]);
    if (pick) allPages((cursor) => v2.listRevisions(pick, cursor), (p) => p.revisions).then((r) => { if (n === revsAsked.current) setRevs(r); }).catch(() => {});
  }, [v2, pick]);
  const send = async (agentId: string, body: Parameters<typeof v2.startRun>[1], key: string): Promise<StartResult> => {
    const t0 = performance.now();
    try {
      const r = await v2.startRun(agentId, body, key);
      return { status: r.status, ms: Math.round(performance.now() - t0), body: r.run, runId: r.run.run_id };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      return e instanceof ClientError ? { status: e.status, ms, body: { error: { ...e.toApiError(), ...(e.fields ? { fields: e.fields } : {}) } } } : { status: 0, ms, body: { error: { code: "network", message: String(e) } } };
    }
  };
  const efforts = ((caps as unknown as { features?: { efforts?: string[] } } | null)?.features?.efforts) ?? [];
  return (
    <Shell active={where.section} onNavigate={nav}>
      {(where.section === "operator" || where.section === "playground") && startError
        ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The agents could not be read: {startError}</p><button type="button" className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
        : where.section === "operator"
        ? agents && <Operator agents={agents} error={error} onStart={async (agentId, text, key) => { const r = await send(agentId, { input: { content: text } }, key); if (r.runId) { go(`#/runs/${encodeURIComponent(r.runId)}`); return null; } return (r.body as { error?: { message?: string } }).error?.message ?? `The server answered ${r.status}.`; }} />
        : where.section === "playground"
        ? agents && <Playground agents={agents.filter((a) => !a.archived_at)} revisions={revs} efforts={efforts} origin={location.origin} agentId={pick ?? undefined} onAgent={setPick} onSend={send} onOpenRun={(id) => go(`#/runs/${encodeURIComponent(id)}`)} />
        : where.section === "agents"
        ? where.agent === undefined ? <AgentsPage v2={v2} archived={!!where.archived} go={go} /> : <AgentEditPage key={where.agent ?? "new"} v2={v2} caps={editorCaps} agentId={where.agent} go={go} />
        : where.run ? <LiveRun key={where.run} v2={v2} runId={where.run} caps={caps} agentName={agentName} />
        : <RunsList runs={runs} agentName={agentName} error={error} onOpen={(id) => go(`#/runs/${encodeURIComponent(id)}`)} loadingMore={more}
            onMore={cursor ? () => { const n = asked.current; setMore(true); (where.runsOf ? v2.listAgentRuns(where.runsOf, 50, cursor) : v2.listRuns(50, cursor)).then((r) => { if (n === asked.current) { setRuns((x) => [...(x ?? []), ...r.runs]); setCursor(r.next_cursor); } }).catch((e) => setError(String(e))).finally(() => setMore(false)); } : undefined} />}
    </Shell>
  );
}
