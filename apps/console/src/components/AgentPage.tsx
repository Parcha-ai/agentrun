import { queryPlaygroundHref } from "@/lib/playgroundRoutes";
import { workflowGraph } from "@dsl/graph";
import { ArrowLeft, ArrowUpRight, Bot, ChevronRight, RefreshCw, Search, Workflow } from "lucide-react";
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
import { LearningChips, WaitingCount } from "@/components/LearningChips";
import { Button } from "@/components/ui/button";
import { Banner, Chip, Input, Tabs, tabPanelProps } from "@/components/ui";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import { type Agent, runsWhere } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { cost, runEnded, soFar, when, runTitle } from "@/lib/format";
import { waitingOf } from "@/lib/learning";
import { appendRuns } from "@/lib/idempotency";
import { harnessDefault, type HarnessInfo, modelLabel, NO_MODEL_YET } from "@/lib/models";
import { placeLabel, type Places } from "@/lib/place";
import { providerLabel } from "@/lib/toolSettings";
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
type LearningTabProps = { focus?: string[]; learning?: "on" | "off" | null; onAgent?: (agent: Agent) => void; places?: Places | null; onChanged?: () => void };
type LearningServer = { learning?: boolean };

/** The page's tabs, in order, each at `#/agents/{id}/{tab}`. A tab shows only on an agent it has content for; a new one
 *  is one entry here. */
const TABS: { id: string; label: string; shows: (a: Agent, server: Server & LearningServer) => boolean; Body: (p: TabProps & LearningTabProps) => JSX.Element }[] = [
  { id: "runs", label: "Runs", shows: () => true, Body: RunsTab },
  { id: "versions", label: "Versions", shows: () => true, Body: AgentVersions },
  { id: "workflow", label: "Workflow", shows: (a) => a.kind === "workflow", Body: WorkflowTab },
  { id: "learning", label: "Learning", shows: (a, server) => a.kind === "agentic" && server.learning !== false, Body: (p) => <LearningTab agent={p.agent} v2={p.v2} focus={p.focus} server={p.learning} onAgent={p.onAgent} places={p.places} onChanged={p.onChanged} /> },
  { id: "analytics", label: "Analytics", shows: (_, server) => server.analytics, Body: AnalyticsTab },
];

/** An agent's address: its page, one of its tabs, or `edit` for its editor. `#/agents/new` is the create form, so an
 *  agent whose id is "new" is given its Runs tab's address instead. */
export const agentHash = (id: string, view?: string) => `#/agents/${encodeURIComponent(id)}${view ? `/${view}` : id === "new" ? "/runs" : ""}`;

/** One agent's page (`#/agents/{id}`): its current revision's harness, model and thinking, a compact overview and a tab per thing it has. `efforts` are the server's (capabilities `features.efforts`).
 *  `learning`: the server's learning switch, undefined until its capabilities are read and null when it has none;
 *  `notes`: the notes an address in the Learning tab points at. `places`: the server's places (capabilities `places`), for
 *  where a revision that names no place runs. */
export function AgentPage({ v2, agentId, routePrefix, harnesses, go, tab, learning, notes, places }: { v2: Client; agentId: string; routePrefix?: string | null; harnesses?: HarnessInfo[]; efforts?: string[]; go: (hash: string) => void; tab?: string; limits?: UploadLimits; learning?: "on" | "off" | null; notes?: string[]; places?: Places | null }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  // The agent's read failed: a 404 is an agent this server has no record of; anything else is said in words.
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [tries, setTries] = useState(0);
  // The agent's stats over the Analytics tab's first range: undefined until read, null when the read failed. A read that
  // landed gives the tab, which opens on this answer, never a second read of it.
  const [stats, setStats] = useState<Stats | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setAgent(null); setError(null); setStats(undefined); setStale(false);
    rereads.current++;
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, (e) => { if (live) setError({ cause: e }); });
    v2.statsOver({ from: rangeFrom(FIRST_RANGE), agent: agentId }).then((r) => { if (live) setStats(r); }, () => { if (live) setStats(null); });
    return () => { live = false; rereads.current++; };
  }, [v2, agentId, tries]);
  // The agent read again after a write on the page: the Learning tab's own (an approve, a retire, an edit: `onChanged`)
  // and the learning switch's save (`onAgent`, whose answer carries no `tools`: only GET /v2/agents/{id} serves them, so
  // the page shows the save's answer with the tools it showed until the read lands). One counter for both: only the
  // newest read lands, so one answered last never puts back an older count or revision. A read that fails says so, with
  // a retry.
  const rereads = useRef(0);
  const [stale, setStale] = useState(false);
  const reread = () => {
    const n = ++rereads.current;
    return v2.getAgent(agentId).then(
      (r) => { if (n === rereads.current) { setAgent((cur) => (cur && cur.agent_id === r.agent.agent_id ? r.agent : cur)); setStale(false); } },
      () => { if (n === rereads.current) setStale(true); },
    );
  };
  const onAgent = (saved: Agent) => { setAgent((cur) => ({ ...saved, tools: cur?.tools ?? saved.tools })); reread(); };
  const analytics = stats === undefined ? undefined : stats !== null;
  if (error) return error.cause instanceof ClientError && error.cause.status === 404
    ? <NotHere what="agent" id={agentId} list={{ href: "#/agents", label: "Open the agents list" }} />
    : <ProblemCard problem={problem(error.cause, "the agent")} onRetry={() => setTries((n) => n + 1)} />;
  if (!agent) return <AgentSkeleton />;
  return <AgentDetail key={agent.agent_id} agent={agent} onAgent={onAgent} reread={reread} stale={stale} v2={v2} go={go} stats={stats} analytics={analytics} places={places} routePrefix={routePrefix} harnesses={harnesses} tab={tab} learning={learning} notes={notes} />;
}

function AgentDetail({ agent, onAgent, reread, stale, v2, go, stats, analytics, routePrefix, harnesses, tab, learning, notes, places }: {
  agent: Agent; onAgent: (agent: Agent) => void; reread: () => Promise<void>; stale: boolean; v2: Client; go: (hash: string) => void;
  stats: Stats | null | undefined; analytics: boolean | undefined; routePrefix?: string | null; harnesses?: HarnessInfo[]; tab?: string; learning?: "on" | "off" | null; notes?: string[]; places?: Places | null;
}) {
  const history = useRunHistory(agent, v2, reread);
  const [factsOpen, setFactsOpen] = useState(false);
  const itemsWaiting = waitingOf(agent);
  const d = agent.definition;
  const workflow = agent.kind === "workflow";
  const Icon = workflow ? Workflow : Bot;
  // A workflow revision has no harness, model or thinking of its own (the server refuses them beside a workflow).
  // The model as a person reads it (the gateway's routing prefix off, the full id in a title): its own, else the default
  // the server names for this harness (capabilities' harnesses[].default_model), else none yet.
  const fallback = harnessDefault(d.harness ?? "pi", harnesses);
  const model = d.model ? modelLabel(d.model, routePrefix)
    : fallback ? (({ text, title }) => ({ text: `${text} (default)`, title }))(modelLabel(fallback, routePrefix))
    : { text: NO_MODEL_YET };
  // A harness the server can't run: why, where its Run would fail (capabilities' harnesses[].reason).
  const off = workflow ? undefined : harnesses?.find((h) => h.id === (d.harness ?? "pi") && h.available === false);
  const offText = off ? `${off.id} doesn't run on this server${off.reason ? `: ${off.reason}` : "."}` : undefined;
  // Where it runs: its own place, else the server's default place for it, marked as such (#1790: resolved at each run).
  const where = runsWhere(agent, places);
  const runsLabel = `${placeLabel(where?.place)}${where?.byDefault ? " (server default)" : ""}`;
  // Explain a known absent default without blocking observation or the handoff that can configure it.
  // Explicit models and older servers leave readiness to the execution path.
  const needsModel = !workflow && !off && !d.model && !fallback && harnesses?.some((h) => h.id === (d.harness ?? "pi") && h.default_model === null);
  const facts: [string, string, string?][] = [
    ...(workflow ? [] : [["Harness", d.harness ?? "pi"], ["Model", model.text, model.title], ["Thinking", d.thinking ?? "default"], ["Runs", runsLabel]] as [string, string, string?][]),
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
  const overviewFacts: [string, string, string?][] = [["Status", agent.archived_at ? "Archived" : "Active"], ["Live jobs", String(liveCount)], ...facts];
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Agent detail">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2 lg:flex-nowrap lg:py-0" aria-label="Agent toolbar">
        <Button size="icon" variant="ghost" aria-label="Back to agents" onClick={() => go(agent.archived_at ? "#/agents?archived=true" : "#/agents")}><ArrowLeft aria-hidden /></Button>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <strong className="min-w-0 truncate text-body font-semibold">{d.name}</strong>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <CodingAgentAction label="Edit agent" prompt={editAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?operation=edit-agent&agent=${encodeURIComponent(agent.agent_id)}`} />
          {!agent.archived_at && <CodingAgentAction label="Run agent" prompt={runAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?agent=${encodeURIComponent(agent.agent_id)}`} />}
          <Button size="icon" aria-label="Refresh agent" onClick={history.refresh} disabled={history.reading}><RefreshCw className={cn(history.reading && "animate-spin")} aria-hidden /></Button>
        </div>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-1 items-start gap-6 overflow-auto p-5 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] md:p-8">
        <aside className="min-w-0 space-y-6" aria-label="Agent overview">
          <div>
            <h1 className="text-2xl font-semibold">{d.name}</h1>
            {d.approvals === "never" && <Chip tone="warning" className="mt-2" title="Never ask: a call of this agent never waits for you. A tool set to deny, and a template’s pins, still hold.">Unattended</Chip>}
            {d.description && <p id="agent-description" className={cn("mt-2 text-body leading-relaxed text-muted-foreground", !factsOpen && "max-sm:line-clamp-2")}>{d.description}</p>}
            <p className="mt-3 break-all font-mono text-label text-muted-foreground">{agent.agent_id}</p>
          </div>
          <button type="button" aria-expanded={factsOpen} aria-controls={d.description ? "agent-description agent-facts" : "agent-facts"} onClick={() => setFactsOpen((value) => !value)} className="flex w-full min-w-0 items-center gap-2 text-left font-mono text-small text-muted-foreground sm:hidden">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", factsOpen && "rotate-90")} aria-hidden /><span className="truncate">{overviewFacts.map(([, value]) => value).join(" · ")}</span>
          </button>
          <dl id="agent-facts" className={cn("grid grid-cols-2 gap-3", !factsOpen && "max-sm:hidden")} aria-label="Current revision">
            {overviewFacts.map(([k, v, title]) => (
              <div key={k} className="min-w-0 border bg-card p-4"><dt className="mb-2 text-label text-muted-foreground">{k}</dt><dd className="break-words text-body font-semibold" title={title}>{v}</dd></div>
            ))}
            {!workflow && <div className="col-span-2 border bg-card p-4"><dt className="mb-2 text-label text-muted-foreground">Tools</dt><dd className="break-words text-small">{!workflow && agent.tools ? (agent.tools.length ? <ul className="space-y-2" aria-label="Tools">{agent.tools.map((tool) => <li key={tool.name}><span title={tool.blurb}>{tool.name}</span>{tool.provider ? ` · ${providerLabel(tool.provider, tool.name)}` : ""}{tool.permission ? ` · ${tool.permission}` : ""}</li>)}</ul> : "none") : d.tools.join(", ") || "None configured"}</dd></div>}
          </dl>
          {offText && <Banner tone="warning" aria-label="Harness not available">{offText}</Banner>}
          {!agent.archived_at && needsModel && <Banner>Running this agent needs a configured model. <a href="#/settings/keys" className="text-primary-text underline underline-offset-2">Set up models in Settings</a></Banner>}
          {stale && <Banner tone="error">Couldn't refresh this agent. <Button size="sm" onClick={() => void reread()}>Retry</Button></Banner>}
          <section className="border bg-card p-4" aria-label="Agent configuration">
            <h2 className="mb-4 text-body font-semibold">Configuration</h2>
            <dl className="space-y-3 text-small">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Kind</dt><dd>{agent.kind}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Skills</dt><dd className="max-w-[75%] break-words text-right">{d.skills.join(", ") || "None configured"}</dd></div>
            </dl>
            {d.instructions && <details className="mt-4 text-small"><summary className="cursor-pointer">Instructions</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans leading-relaxed text-muted-foreground">{d.instructions}</pre></details>}
          </section>
          <section className="border bg-card p-4" aria-label="Live jobs">
            <h2 className="mb-3 text-body font-semibold">Live jobs</h2>
            {live.length ? <ul className="space-y-3">{live.map((run) => <li key={run.run_id}><a href={`#/runs/${encodeURIComponent(run.run_id)}`} className="flex items-center gap-2 text-small hover:text-primary-text"><StatusBadge run={run} /><span className="min-w-0 flex-1 truncate">{runTitle(run)}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden /></a></li>)}</ul>
              : <p className="text-small leading-relaxed text-muted-foreground">{!history.runs ? "Loading live jobs…" : agent.runs?.live ? "Live jobs are outside the loaded history. Load more runs to find them." : history.error ? "Live jobs could not be refreshed." : "No live jobs."}</p>}
          </section>
        </aside>
        <section className="min-w-0" aria-label="Agent workspace">
          <Tabs id="agent-views" label="Agent views" value={at.id} onChange={(value) => go(agentHash(agent.agent_id, value))} tabs={tabs.map((t) => ({ id: t.id, label: <>{t.label}{t.id === "learning" && <WaitingCount n={itemsWaiting} className="ml-1.5" />}</> }))} className="mb-5 overflow-x-auto px-0 md:px-0" />
          <div {...tabPanelProps("agent-views", at.id)} aria-label={waiting ? undefined : at.label}>
            {waiting ? <ListSkeleton label="Loading the tab" rows={4} /> : <at.Body agent={agent} v2={v2} go={go} stats={stats} history={history} focus={notes} learning={learning} onAgent={onAgent} onChanged={reread} places={places} />}
          </div>
        </section>
      </main>
    </section>
  );
}

const isLiveRun = (run: Run) => !run.imported_from && ["queued", "working", "paused", "input_required"].includes(run.status);
type RunHistory = {
  runs: Run[] | null; cursor: string | null; reading: boolean; more: boolean; error: Problem | null;
  refresh: () => void; loadMore: () => void; reloadLatest: (() => void) | null;
};

/** Refresh through the oldest loaded run or past its start time if it was archived. Both current and legacy servers
 * order by start time descending, but use different tie-breakers; don't infer equal-time order from run ids. Bound
 * ambiguous refreshes to the loaded pages plus one shift page, preserving the snapshot until explicit recovery. */
function useRunHistory(agent: Agent, v2: Client, reread: () => Promise<void>): RunHistory {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [limited, setLimited] = useState(false);
  const asked = useRef(0);
  const shown = useRef<Run[]>([]);
  const pages = useRef(0);
  const busy = useRef(false);
  const read = async (after: string | null, metadata = false, reset = false) => {
    if (busy.current) return;
    busy.current = true;
    const n = ++asked.current;
    setReading(true); setMore(!!after);
    const metadataRead = metadata ? reread() : Promise.resolve();
    try {
      let next = after;
      let loaded: Run[] = [];
      const boundary = after || reset ? undefined : shown.current.at(-1);
      const oldestAt = boundary ? Date.parse(boundary.created_at) : NaN;
      const budget = pages.current + 1;
      let reached = false;
      const visited = new Set<string | null>();
      do {
        if (visited.size >= budget) {
          setLimited(true);
          setError({ title: "Run history could not be refreshed.", why: "Previous runs are still shown. The run list changed too much to refresh them safely.", next: "Try again, or reload the latest runs to reset the loaded history." });
          return;
        }
        if (visited.has(next)) throw new Error("The runs list repeated a page. Refresh to try again.");
        visited.add(next);
        const page = await v2.listAgentRuns(agent.agent_id, 50, next, !!agent.archived_at);
        if (n !== asked.current) return;
        loaded = appendRuns(loaded, page.runs); next = page.next_cursor;
        reached ||= page.runs.some((run) => run.run_id === boundary?.run_id || Date.parse(run.created_at) < oldestAt);
      } while (!after && next && boundary && !reached);
      if (n === asked.current) {
        shown.current = after ? appendRuns(shown.current, loaded) : loaded;
        pages.current = after ? pages.current + 1 : visited.size;
        setRuns(shown.current); setCursor(next); setError(null); setLimited(false);
      }
    } catch (e) { if (n === asked.current) setError(problem(e, after ? "more runs" : "the runs")); }
    finally {
      await metadataRead;
      if (n === asked.current) { busy.current = false; setReading(false); setMore(false); }
    }
  };
  useEffect(() => {
    busy.current = false; shown.current = []; pages.current = 0; setRuns(null); setCursor(null); setError(null); setLimited(false);
    void read(null);
    const refreshVisible = () => { if (!document.hidden) void read(null, true); };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = window.setInterval(refreshVisible, 10_000);
    return () => { asked.current++; busy.current = false; window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [v2, agent.agent_id, agent.archived_at]); // eslint-disable-line react-hooks/exhaustive-deps
  return { runs, cursor, reading, more, error, refresh: () => { void read(null, true); }, loadMore: () => { if (cursor) void read(cursor); }, reloadLatest: limited ? () => { void read(null, true, true); } : null };
}

/** The same run links and statuses as the all-runs view, scoped to this agent. Full timelines live on each run page. */
function RunsTab({ agent, history }: TabProps) {
  const [query, setQuery] = useState("");
  const { runs, cursor, reading, more, error, refresh, loadMore, reloadLatest } = history!;
  if (error && !runs) return <ProblemCard problem={error} onRetry={refresh} className="" />;
  if (!runs) return <ListSkeleton label="Loading the runs" rows={5} />;
  const filtered = runs.filter((r) => `${runTitle(r)} ${r.run_id} ${r.status}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="min-h-[380px] overflow-hidden border" aria-label="Agent run history">
    <div className="flex flex-wrap items-center gap-3 border-b p-3">
      <label className="flex min-w-0 items-center gap-2"><Search className="size-3.5 text-muted-foreground" aria-hidden /><Input aria-label="Search this agent's runs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search runs…" className="w-40 min-w-0" /></label>
      <span className="text-small text-muted-foreground">{runs.length}{cursor ? "+" : ""} {runs.length === 1 && !cursor ? "run" : "runs"}</span>
      <div className="ml-auto"><CodingAgentAction label="Query" prompt={queryRunsPrompt(location.origin, agent.agent_id)} playgroundHref={queryPlaygroundHref(agent.agent_id, { archived: !!agent.archived_at })} /></div>
    </div>
    {runs.length ? <div className="overflow-x-auto"><table className="w-full text-left text-small" aria-label="Runs">
      <thead className="border-b bg-card text-muted-foreground"><tr>{["Status", "Run", "Started", "Duration", "Cost"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3 font-semibold">{label}</th>)}</tr></thead>
      <tbody>{filtered.map((r) => <tr key={r.run_id} className="border-b last:border-b-0 hover:bg-accent/50">
        <td className="whitespace-nowrap px-4 py-3"><StatusBadge run={r} /></td>
        <td className="min-w-48 px-4 py-3"><a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex items-center gap-2 font-semibold hover:text-primary-text"><span className="line-clamp-2">{runTitle(r)}</span><ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden /></a><div className="mt-1 flex flex-wrap items-center gap-2 text-label text-muted-foreground"><LearningChips run={r} />{r.effort && <span>effort {r.effort}</span>}{r.imported_from && <span>Imported history · {r.imported_from.source}</span>}</div></td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{when(r.created_at)}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.ended_at ? <span title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span> : "—"}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{r.cost && (r.cost.usd !== null || soFar(r.cost)) ? cost(r.cost, { ended: runEnded(r.status) }) : "—"}</td>
      </tr>)}</tbody>
    </table>{!filtered.length && <p className="p-10 text-center text-body text-muted-foreground">No loaded runs match your search.</p>}</div>
      : <div className="px-4 py-12 text-center text-body text-muted-foreground"><p>No runs of this agent yet.</p>{!agent.archived_at && <p className="mt-2">Choose Run agent to continue with your coding agent or the API playground.</p>}</div>}
    {error && <div className="m-4 space-y-3"><ProblemCard problem={error} onRetry={refresh} className="" />{reloadLatest && <Button size="sm" onClick={reloadLatest} disabled={reading}>Reload latest runs</Button>}</div>}
    {cursor && <div className="flex justify-center p-4"><Button size="sm" onClick={loadMore} disabled={more}>{more ? "Loading" : "Load more"}</Button></div>}
  </section>;
}

/** The current revision's workflow as its graph, read-only; editing it is the editor's Workflow step. */
function WorkflowTab({ agent }: TabProps) {
  const doc = agent.definition.workflow;
  const graph = useMemo(() => workflowGraph(doc), [doc]);
  const marks = useMemo(() => ({ meta: metaOf(doc, graph) }), [doc, graph]);
  return (
    <section className="overflow-hidden border">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <span className="caps text-label font-semibold">Graph</span>
        <span className="font-mono text-label text-muted-foreground">{graph.nodes.length} nodes · rev {agent.definition.version}</span>
        <span className="flex-1" />
        <CodingAgentAction label="Edit workflow" prompt={editAgentPrompt(location.origin, agent.agent_id)} playgroundHref={`#/playground?operation=edit-agent&agent=${encodeURIComponent(agent.agent_id)}`} />
      </div>
      <div className="min-h-[360px] overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] px-4 py-5">
        {graph.nodes.length ? <WorkflowGraph graph={graph} marks={marks} label="The workflow's graph" minScale={0.55} />
          : <p className="p-6 text-center font-mono text-body text-muted-foreground">This revision's workflow has no root node to draw.</p>}
      </div>
      <div className="border-t px-4 py-2"><GraphLegend /></div>
    </section>
  );
}
