import { queryPlaygroundHref } from "@/lib/playgroundRoutes";
import { workflowGraph } from "@dsl/graph";
import { ArrowLeft, ArrowUpRight, Bot, RefreshCw, Search, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentVersions } from "@/components/AgentVersions";
import { AnalyticsTab, FIRST_RANGE } from "@/components/AgentAnalytics";
import type { UploadLimits } from "@/components/FilePicker";
import { NotHere, ProblemCard } from "@/components/Problem";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { editAgentPrompt, queryRunsPrompt, runAgentPrompt } from "@/lib/codingAgentPrompts";
import { AgentSkeleton, ListSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { LearningTab } from "@/components/Learning";
import { LearningChips } from "@/components/LearningChips";
import { Button } from "@/components/ui/button";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { cost, soFar, when } from "@/lib/format";
import { appendRuns } from "@/lib/idempotency";
import { harnessDefault, type HarnessInfo, modelLabel, NO_MODEL_YET } from "@/lib/models";
import { placeLabel, placeOf } from "@/lib/place";
import { type Problem, problem } from "@/lib/problem";
import { elapsed, metaOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import { rangeFrom, type Stats } from "@/lib/mission";
import type { Run } from "@/lib/v2";

/** `stats`: the page's own read of the agent's stats over the Analytics tab's first range, which that tab starts from. */
type TabProps = { agent: Agent; v2: Client; go: (hash: string) => void; stats?: Stats | null; history?: RunHistory };
/** What the server gives beside the agent: `analytics`, once its stats are read. */
type Server = { analytics: boolean };

/** What the Learning tab takes beside a tab's own: the notes an address points at (`focus`), the server's learning
 *  switch, and the agent as the tab's write left it (`onAgent`, a new revision). `learning` beside the server's: whether
 *  it has learning at all, undefined until its capabilities are read. */
type LearningTabProps = { focus?: string[]; learning?: "on" | "off" | null; onAgent?: (agent: Agent) => void };
type LearningServer = { learning?: boolean };

/** The page's tabs, in order, each at `#/agents/{id}/{tab}`. A tab shows only on an agent it has content for; a new one
 *  is one entry here. */
const TABS: { id: string; label: string; shows: (a: Agent, server: Server & LearningServer) => boolean; Body: (p: TabProps & LearningTabProps) => JSX.Element }[] = [
  { id: "runs", label: "Runs", shows: () => true, Body: RunsTab },
  { id: "versions", label: "Versions", shows: () => true, Body: AgentVersions },
  { id: "workflow", label: "Workflow", shows: (a) => a.kind === "workflow", Body: WorkflowTab },
  { id: "learning", label: "Learning", shows: (a, server) => a.kind === "agentic" && server.learning !== false, Body: (p) => <LearningTab agent={p.agent} v2={p.v2} focus={p.focus} server={p.learning} onAgent={p.onAgent} /> },
  { id: "analytics", label: "Analytics", shows: (_, server) => server.analytics, Body: AnalyticsTab },
];

/** An agent's address: its page, one of its tabs, or `edit` for its editor. `#/agents/new` is the create form, so an
 *  agent whose id is "new" is given its Runs tab's address instead. */
export const agentHash = (id: string, view?: string) => `#/agents/${encodeURIComponent(id)}${view ? `/${view}` : id === "new" ? "/runs" : ""}`;

/** One agent's page (`#/agents/{id}`): its current revision's harness, model and thinking, a compact overview and a tab per thing it has. `efforts` are the server's (capabilities `features.efforts`).
 *  `learning`: the server's learning switch, undefined until its capabilities are read and null when it has none;
 *  `notes`: the notes an address in the Learning tab points at. */
export function AgentPage({ v2, agentId, defaultModel, modelSource, routePrefix, harnesses, go, tab, learning, notes }: { v2: Client; agentId: string; defaultModel?: string; modelSource?: string; routePrefix?: string | null; harnesses?: HarnessInfo[]; efforts?: string[]; go: (hash: string) => void; tab?: string; limits?: UploadLimits; learning?: "on" | "off" | null; notes?: string[] }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  // The agent's read failed: a 404 is an agent this server has no record of; anything else is said in words.
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [tries, setTries] = useState(0);
  // The agent's stats over the Analytics tab's first range: undefined until read, null when the read failed. A read that
  // landed gives the tab, which opens on this answer, never a second read of it.
  const [stats, setStats] = useState<Stats | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setAgent(null); setError(null); setStats(undefined);
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, (e) => { if (live) setError({ cause: e }); });
    v2.statsOver({ from: rangeFrom(FIRST_RANGE), agent: agentId }).then((r) => { if (live) setStats(r); }, () => { if (live) setStats(null); });
    return () => { live = false; };
  }, [v2, agentId, tries]);
  const analytics = stats === undefined ? undefined : stats !== null;
  if (error) return error.cause instanceof ClientError && error.cause.status === 404
    ? <NotHere what="agent" id={agentId} list={{ href: "#/agents", label: "Open the agents list" }} />
    : <ProblemCard problem={problem(error.cause, "the agent")} onRetry={() => setTries((n) => n + 1)} />;
  if (!agent) return <AgentSkeleton />;
  return <AgentDetail key={agent.agent_id} agent={agent} onAgent={setAgent} v2={v2} go={go} stats={stats} analytics={analytics} defaultModel={defaultModel} modelSource={modelSource} routePrefix={routePrefix} harnesses={harnesses} tab={tab} learning={learning} notes={notes} />;
}

function AgentDetail({ agent, onAgent, v2, go, stats, analytics, defaultModel, modelSource, routePrefix, harnesses, tab, learning, notes }: {
  agent: Agent; onAgent: (agent: Agent) => void; v2: Client; go: (hash: string) => void;
  stats: Stats | null | undefined; analytics: boolean | undefined; defaultModel?: string; modelSource?: string; routePrefix?: string | null; harnesses?: HarnessInfo[]; tab?: string; learning?: "on" | "off" | null; notes?: string[];
}) {
  const history = useRunHistory(agent, v2, onAgent);
  const d = agent.definition;
  const workflow = agent.kind === "workflow";
  const Icon = workflow ? Workflow : Bot;
  // A workflow revision has no harness, model or thinking of its own (the server refuses them beside a workflow).
  // The model as a person reads it (the gateway's routing prefix off, the full id in a title): its own, else this
  // harness's default, else none for a harness the server's default is not offered for.
  const models = { source: modelSource, default: defaultModel, route_prefix: routePrefix };
  const fallback = harnessDefault(d.harness ?? "pi", harnesses, defaultModel);
  const model = d.model ? modelLabel(d.model, models)
    : fallback ? (({ text, title }) => ({ text: `${text} (default)`, title }))(modelLabel(fallback, models))
    // A server that names each harness's default and names none for this one: there is none, for pi too.
    : { text: (d.harness ?? "pi") === "pi" && !harnesses?.some((h) => h.id === "pi" && "default_model" in h) ? "default" : NO_MODEL_YET };
  // A harness the server can't run: why, where its Run would fail (capabilities' harnesses[].reason).
  const off = workflow ? undefined : harnesses?.find((h) => h.id === (d.harness ?? "pi") && h.available === false);
  const offText = off ? `${off.id} doesn't run on this server${off.reason ? `: ${off.reason}` : "."}` : undefined;
  // Explain a known absent default without blocking observation or the handoff that can configure it.
  // Explicit models and older servers leave readiness to the execution path.
  const needsModel = !workflow && !off && !d.model && !fallback && harnesses?.some((h) => h.id === (d.harness ?? "pi") && h.default_model === null);
  const facts: [string, string, string?][] = [
    ...(workflow ? [] : [["Harness", d.harness ?? "pi"], ["Model", model.text, model.title], ["Thinking", d.thinking ?? "default"], ["Runs", placeLabel(placeOf(d.place))]] as [string, string, string?][]),
    ["Revision", `rev ${d.version} of ${agent.revisions}`],
  ];
  // Until the server's capabilities are read, the Learning tab shows only on its own address, which opens it at once (a
  // server without learning answers its read with an error the tab shows); once read, it shows when the server learns.
  const tabs = TABS.filter((t) => t.shows(agent, { analytics: analytics === true, learning: learning === undefined ? (tab === "learning" ? undefined : false) : !!learning }));
  const at = tabs.find((t) => t.id === tab) ?? tabs[0];
  // An address on a tab the server may still give: wait for its answer rather than open another tab meanwhile.
  const waiting = tab === "analytics" && analytics === undefined;
  const live = history.runs?.filter(isLiveRun) ?? [];
  const liveCount = agent.runs?.live ?? (history.runs ? `${live.length}${history.cursor ? "+" : ""}` : "—");
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Agent detail">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2 lg:flex-nowrap lg:py-0" aria-label="Agent toolbar">
        <Button size="icon" variant="ghost" aria-label="Back to agents" onClick={() => go(agent.archived_at ? "#/agents?archived=true" : "#/agents")}><ArrowLeft aria-hidden /></Button>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <strong className="min-w-0 truncate text-[13px] font-semibold">{d.name}</strong>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <CodingAgentAction label="Edit agent" prompt={editAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?operation=edit-agent&agent=${encodeURIComponent(agent.agent_id)}`} />
          {!agent.archived_at && <CodingAgentAction label="Run agent" prompt={runAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?agent=${encodeURIComponent(agent.agent_id)}`} />}
          <Button size="icon" aria-label="Refresh agent" onClick={history.refresh} disabled={history.reading}><RefreshCw className={cn(history.reading && "animate-spin")} aria-hidden /></Button>
        </div>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-1 items-start gap-7 overflow-auto p-5 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] lg:p-7">
        <aside className="min-w-0 space-y-6" aria-label="Agent overview">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
            {d.description && <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{d.description}</p>}
            <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">{agent.agent_id}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3" aria-label="Current revision">
            {([["Status", agent.archived_at ? "Archived" : "Active"], ["Live jobs", String(liveCount)], ...facts] as [string, string, string?][]).map(([k, v, title]) => (
              <div key={k} className="min-w-0 rounded-xl border bg-card p-4"><dt className="mb-2 text-[11px] text-muted-foreground">{k}</dt><dd className="break-words text-[13px] font-medium" title={title}>{v}</dd></div>
            ))}
          </dl>
          {offText && <p className="text-[13px] text-warning-text" role="status" aria-label="Harness not available">{offText}</p>}
          {!agent.archived_at && needsModel && <p className="text-[13px] text-muted-foreground" role="status">Running this agent needs a configured model. <a href="#/settings/keys" className="text-primary underline-offset-4 hover:underline">Set up models in Settings</a></p>}
          {history.metadataError && <ProblemCard problem={history.metadataError} onRetry={history.refresh} className="" />}
          <section className="rounded-xl border bg-card p-4" aria-label="Agent configuration">
            <h2 className="mb-4 text-[13px] font-semibold">Configuration</h2>
            <dl className="space-y-3 text-[12px]">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Kind</dt><dd>{agent.kind}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Skills</dt><dd className="max-w-[75%] break-words text-right">{d.skills.join(", ") || "None configured"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Tools</dt><dd className="max-w-[75%] break-words text-right">{d.tools.join(", ") || "None configured"}</dd></div>
            </dl>
            {d.instructions && <details className="mt-4 text-[12px]"><summary className="cursor-pointer">Instructions</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans leading-relaxed text-muted-foreground">{d.instructions}</pre></details>}
          </section>
          <section className="rounded-xl border bg-card p-4" aria-label="Live jobs">
            <h2 className="mb-3 text-[13px] font-semibold">Live jobs</h2>
            {live.length ? <ul className="space-y-3">{live.map((run) => <li key={run.run_id}><a href={`#/runs/${encodeURIComponent(run.run_id)}`} className="flex items-center gap-2 text-[12px] hover:text-primary"><StatusBadge run={run} /><span className="min-w-0 flex-1 truncate">{run.title}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden /></a></li>)}</ul>
              : <p className="text-[12px] leading-relaxed text-muted-foreground">{!history.runs ? "Loading live jobs…" : agent.runs?.live ? "Live jobs are outside the loaded history. Load more runs to find them." : history.error ? "Live jobs could not be refreshed." : "No live jobs."}</p>}
          </section>
        </aside>
        <section className="min-w-0" aria-label="Agent workspace">
          <div className="mb-5 flex gap-6 overflow-x-auto border-b" role="tablist" aria-label="Agent views">
            {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={at.id === t.id} onClick={() => go(agentHash(agent.agent_id, t.id))}
              className={cn("-mb-px shrink-0 border-b-2 py-3 text-[13px]", at.id === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</button>)}
          </div>
          <div role="tabpanel" aria-label={waiting ? undefined : at.label}>
            {waiting ? <ListSkeleton label="Loading the tab" rows={4} /> : <at.Body agent={agent} v2={v2} go={go} stats={stats} history={history} focus={notes} learning={learning} onAgent={onAgent} />}
          </div>
        </section>
      </main>
    </section>
  );
}

const isLiveRun = (run: Run) => !run.imported_from && ["queued", "working", "paused", "input_required"].includes(run.status);
type RunHistory = {
  runs: Run[] | null; cursor: string | null; reading: boolean; more: boolean; error: Problem | null; metadataError: Problem | null;
  refresh: () => void; loadMore: () => void;
};

/** Refresh metadata and every loaded page together after a handoff returns, without dropping older loaded runs. */
function useRunHistory(agent: Agent, v2: Client, onAgent: (agent: Agent) => void): RunHistory {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [metadataError, setMetadataError] = useState<Problem | null>(null);
  const asked = useRef(0);
  const pages = useRef(1);
  const busy = useRef(false);
  const read = async (after: string | null, metadata = false) => {
    if (busy.current) return;
    busy.current = true;
    const n = ++asked.current;
    setReading(true); setMore(!!after);
    const metadataRead = metadata ? v2.getAgent(agent.agent_id).then((r) => { if (n === asked.current) { onAgent(r.agent); setMetadataError(null); } }, (e) => { if (n === asked.current) setMetadataError(problem(e, "the agent")); }) : Promise.resolve();
    try {
      let next = after;
      let loaded: Run[] = [];
      let count = 0;
      do {
        const page = await v2.listAgentRuns(agent.agent_id, 50, next, !!agent.archived_at);
        loaded = appendRuns(loaded, page.runs); next = page.next_cursor; count++;
      } while (!after && next && count < pages.current);
      if (n === asked.current) {
        if (after) pages.current++; else pages.current = count;
        setRuns((current) => after ? appendRuns(current ?? [], loaded) : loaded); setCursor(next); setError(null);
      }
    } catch (e) { if (n === asked.current) setError(problem(e, after ? "more runs" : "the runs")); }
    finally {
      await metadataRead;
      if (n === asked.current) { busy.current = false; setReading(false); setMore(false); }
    }
  };
  useEffect(() => {
    busy.current = false; pages.current = 1; setRuns(null); setCursor(null); setError(null); setMetadataError(null);
    void read(null);
    const refreshVisible = () => { if (!document.hidden) void read(null, true); };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = window.setInterval(refreshVisible, 10_000);
    return () => { asked.current++; busy.current = false; window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [v2, agent.agent_id, agent.archived_at]); // eslint-disable-line react-hooks/exhaustive-deps
  return { runs, cursor, reading, more, error, metadataError, refresh: () => { void read(null, true); }, loadMore: () => { if (cursor) void read(cursor); } };
}

/** The same run links and statuses as the all-runs view, scoped to this agent. Full timelines live on each run page. */
function RunsTab({ agent, history }: TabProps) {
  const [query, setQuery] = useState("");
  const { runs, cursor, more, error, refresh, loadMore } = history!;
  if (error && !runs) return <ProblemCard problem={error} onRetry={refresh} className="" />;
  if (!runs) return <ListSkeleton label="Loading the runs" rows={5} />;
  const filtered = runs.filter((r) => `${r.title} ${r.run_id} ${r.status}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="min-h-[380px] overflow-hidden rounded-xl border" aria-label="Agent run history">
    <div className="flex flex-wrap items-center gap-3 border-b p-3">
      <label className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"><Search className="size-3.5 text-muted-foreground" aria-hidden /><input aria-label="Search this agent's runs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search runs…" className="w-40 min-w-0 bg-transparent text-[12px] outline-none" /></label>
      <span className="text-[12px] text-muted-foreground">{runs.length}{cursor ? "+" : ""} {runs.length === 1 && !cursor ? "run" : "runs"}</span>
      <div className="ml-auto"><CodingAgentAction label="Query" prompt={queryRunsPrompt(location.origin, agent.agent_id)} playgroundHref={queryPlaygroundHref(agent.agent_id, { archived: !!agent.archived_at })} /></div>
    </div>
    {runs.length ? <div className="overflow-x-auto"><table className="w-full text-left text-[12px]" aria-label="Runs">
      <thead className="border-b bg-card text-muted-foreground"><tr>{["Status", "Run", "Started", "Duration", "Cost"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}</tr></thead>
      <tbody>{filtered.map((r) => <tr key={r.run_id} className="border-b last:border-b-0 hover:bg-accent/50">
        <td className="whitespace-nowrap px-4 py-3"><StatusBadge run={r} /></td>
        <td className="min-w-48 px-4 py-3"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-2 font-medium hover:text-primary"><span className="line-clamp-2">{r.title}</span><ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden /></a><div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"><LearningChips run={r} />{r.effort && <span>effort {r.effort}</span>}{r.imported_from && <span>Imported history · {r.imported_from.source}</span>}</div></td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(r.created_at)}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.ended_at ? <span title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span> : "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.cost && (r.cost.usd !== null || soFar(r.cost)) ? cost(r.cost) : "—"}</td>
      </tr>)}</tbody>
    </table>{!filtered.length && <p className="p-10 text-center text-[13px] text-muted-foreground">No loaded runs match your search.</p>}</div>
      : <div className="px-4 py-12 text-center text-[13px] text-muted-foreground"><p>No runs of this agent yet.</p>{!agent.archived_at && <p className="mt-2">Choose Run agent to continue with your coding agent or the API playground.</p>}</div>}
    {error && <ProblemCard problem={error} onRetry={refresh} className="m-4" />}
    {cursor && <div className="flex justify-center p-4"><Button size="sm" onClick={loadMore} disabled={more}>{more ? "Loading" : "Load more"}</Button></div>}
  </section>;
}

/** The current revision's workflow as its graph, read-only; editing it is the editor's Workflow step. */
function WorkflowTab({ agent }: TabProps) {
  const doc = agent.definition.workflow;
  const graph = useMemo(() => workflowGraph(doc), [doc]);
  const marks = useMemo(() => ({ meta: metaOf(doc, graph) }), [doc, graph]);
  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <span className="caps text-[11px] font-semibold">Graph</span>
        <span className="font-mono text-[11px] text-muted-foreground">{graph.nodes.length} nodes · rev {agent.definition.version}</span>
        <span className="flex-1" />
        <CodingAgentAction label="Edit workflow" prompt={editAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?operation=edit-agent&agent=${encodeURIComponent(agent.agent_id)}`} />
      </div>
      <div className="min-h-[360px] overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] px-4 py-5">
        {graph.nodes.length ? <WorkflowGraph graph={graph} marks={marks} label="The workflow's graph" minScale={0.55} />
          : <p className="p-6 text-center font-mono text-[13px] text-muted-foreground">This revision's workflow has no root node to draw.</p>}
      </div>
      <div className="border-t px-4 py-2"><GraphLegend /></div>
    </section>
  );
}
