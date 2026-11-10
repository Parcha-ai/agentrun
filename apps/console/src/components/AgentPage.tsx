import { workflowGraph } from "@dsl/graph";
import { ArrowLeft, Bot, ChevronRight, Pencil, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnalyticsTab, FIRST_RANGE } from "@/components/AgentAnalytics";
import { LatestRun } from "@/components/LatestRun";
import type { UploadLimits } from "@/components/FilePicker";
import { NotHere, ProblemCard } from "@/components/Problem";
import { RunBar } from "@/components/RunBar";
import { AgentSkeleton, ListSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { LearningTab } from "@/components/Learning";
import { LearningChips, WaitingCount } from "@/components/LearningChips";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
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
type TabProps = { agent: Agent; v2: Client; go: (hash: string) => void; stats?: Stats | null };
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
  { id: "workflow", label: "Workflow", shows: (a) => a.kind === "workflow", Body: WorkflowTab },
  { id: "learning", label: "Learning", shows: (a, server) => a.kind === "agentic" && server.learning !== false, Body: (p) => <LearningTab agent={p.agent} v2={p.v2} focus={p.focus} server={p.learning} onAgent={p.onAgent} places={p.places} onChanged={p.onChanged} /> },
  { id: "analytics", label: "Analytics", shows: (_, server) => server.analytics, Body: AnalyticsTab },
];

/** An agent's address: its page, one of its tabs, or `edit` for its editor. `#/agents/new` is the create form, so an
 *  agent whose id is "new" is given its Runs tab's address instead. */
export const agentHash = (id: string, view?: string) => `#/agents/${encodeURIComponent(id)}${view ? `/${view}` : id === "new" ? "/runs" : ""}`;

/** One agent's page (`#/agents/{id}`): its current revision's harness, model and thinking, a run bar (none for an archived
 *  agent, which takes no runs), and a tab per thing it has. `efforts` are the server's (capabilities `features.efforts`).
 *  `learning`: the server's learning switch, undefined until its capabilities are read and null when it has none;
 *  `notes`: the notes an address in the Learning tab points at. `places`: the server's places (capabilities `places`), for
 *  where a revision that names no place runs. */
export function AgentPage({ v2, agentId, routePrefix, harnesses, efforts = [], go, tab, limits, learning, notes, places }: { v2: Client; agentId: string; routePrefix?: string | null; harnesses?: HarnessInfo[]; efforts?: string[]; go: (hash: string) => void; tab?: string; limits?: UploadLimits; learning?: "on" | "off" | null; notes?: string[]; places?: Places | null }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  // The agent's read failed: a 404 is an agent this server has no record of; anything else is said in words.
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [tries, setTries] = useState(0);
  // The agent's stats over the Analytics tab's first range: undefined until read, null when the read failed. A read that
  // landed gives the tab, which opens on this answer, never a second read of it.
  const [stats, setStats] = useState<Stats | null | undefined>(undefined);
  // On a phone the revision's facts show as one line until it is opened.
  const [factsOpen, setFactsOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setAgent(null); setError(null); setStats(undefined);
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, (e) => { if (live) setError({ cause: e }); });
    v2.statsOver({ from: rangeFrom(FIRST_RANGE), agent: agentId }).then((r) => { if (live) setStats(r); }, () => { if (live) setStats(null); });
    return () => { live = false; };
  }, [v2, agentId, tries]);
  // Learned items that wait for the owner's OK, counted on the Learning tab from the agent's own `learning.pending`: no
  // read of what it learned for it. A write on the tab (an approve, a retire, an edit) reads the agent again for it.
  const itemsWaiting = waitingOf(agent);
  // The agent read again after a write on the page: the Learning tab's own (an approve, a retire, an edit: `onChanged`)
  // and the learning switch's save (`onAgent`, whose answer carries no `tools`: only GET /v2/agents/{id} serves them, so
  // the page shows the save's answer with the tools it showed until the read lands). One counter for both: only the
  // newest read lands, so one answered last never puts back an older count or revision. A read that fails says so, with
  // a retry.
  const rereads = useRef(0);
  const [stale, setStale] = useState(false);
  const reread = () => {
    const n = ++rereads.current;
    v2.getAgent(agentId).then(
      (r) => { if (n === rereads.current) { setAgent((cur) => (cur && cur.agent_id === r.agent.agent_id ? r.agent : cur)); setStale(false); } },
      () => { if (n === rereads.current) setStale(true); },
    );
  };
  const onAgent = (saved: Agent) => { setAgent((cur) => ({ ...saved, tools: cur?.tools ?? saved.tools })); reread(); };
  const onChanged = reread;
  const analytics = stats === undefined ? undefined : stats !== null;
  if (error) return error.cause instanceof ClientError && error.cause.status === 404
    ? <NotHere what="agent" id={agentId} list={{ href: "#/agents", label: "Open the agents list" }} />
    : <ProblemCard problem={problem(error.cause, "the agent")} onRetry={() => setTries((n) => n + 1)} />;
  if (!agent) return <AgentSkeleton />;
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b px-5 py-4 max-sm:py-3 md:px-8">
        {/* On a phone the back button joins the name row (its word read, not shown), and Edit shows its icon alone. */}
        <div data-phone-row className="flex flex-col gap-3 max-sm:flex-row max-sm:items-center">
          <button type="button" onClick={() => go(agent.archived_at ? "#/agents?archived=true" : "#/agents")} className="caps flex items-center gap-2 self-start text-[11px] text-muted-foreground hover:text-foreground max-sm:-m-1 max-sm:self-center max-sm:p-1">
            <ArrowLeft className="size-3.5" aria-hidden /> <span className="max-sm:sr-only">Agents</span>
          </button>
          <div className="flex flex-wrap items-center gap-3 max-sm:min-w-0 max-sm:flex-1 max-sm:flex-nowrap max-sm:gap-2">
            <Icon className="size-5 shrink-0 text-muted-foreground max-sm:hidden" aria-hidden />
            <h1 className="min-w-0 truncate font-mono text-xl font-semibold max-sm:text-lg">{d.name}</h1>
            <Chip>{agent.kind}</Chip>
            {agent.archived_at && <Chip tone="muted">Archived</Chip>}
            {d.approvals === "never" && <Chip tone="warning" title="Never ask: a call of this agent never waits for you. A tool set to deny, and a template's pins, still hold.">Unattended</Chip>}
            <span className="flex-1" />
            <Button size="sm" onClick={() => go(agentHash(agent.agent_id, "edit"))} title="Edit" className="max-sm:w-8 max-sm:shrink-0 max-sm:px-0"><Pencil aria-hidden /> <span className="max-sm:sr-only">Edit</span></Button>
          </div>
        </div>
        {/* On a phone a long description is cut at two lines until the facts' line is opened, which shows it whole. */}
        {d.description && <p id="agent-description" className={cn("mt-2 max-w-3xl text-[14px] text-muted-foreground", !factsOpen && "max-sm:line-clamp-2")}>{d.description}</p>}
        {/* On a phone the facts fold into one line, which opens them; 640 px and up show the list. */}
        <button type="button" aria-expanded={factsOpen} aria-controls={d.description ? "agent-description agent-facts" : "agent-facts"} onClick={() => setFactsOpen((o) => !o)}
          className="mt-1.5 flex w-full min-w-0 items-center gap-1.5 text-left font-mono text-[12px] text-muted-foreground sm:hidden">
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", factsOpen && "rotate-90")} aria-hidden />
          <span className="truncate">{facts.map(([, v]) => v).join(" · ")}</span>
        </button>
        <dl id="agent-facts" className={cn("mt-3 flex flex-wrap gap-x-6 gap-y-2", !factsOpen && "max-sm:hidden")} aria-label="Current revision">
          {facts.map(([k, v, title]) => (
            <div key={k} className="flex items-baseline gap-2"><dt className="caps text-[10px] text-muted-foreground">{k}</dt><dd className="font-mono text-[12px]" title={title}>{v}</dd></div>
          ))}
          {/* The tools the current revision grants, as GET /v2/agents/{id} serves them (the provider and permission in force,
              the agent's own setting over the server's): the name (its line for people as its title), the provider where
              it has a choice of one, the permission. A workflow's tools are its call nodes', which its editor shows. */}
          {!workflow && (
            <div className="flex items-baseline gap-2">
              <dt className="caps text-[10px] text-muted-foreground">Tools</dt>
              <dd className="font-mono text-[12px]">
                {agent.tools?.length ? (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Tools">
                    {agent.tools.map((t) => (
                      <li key={t.name}><span title={t.blurb}>{t.name}</span>{t.provider ? ` · ${providerLabel(t.provider, t.name)}` : ""}{t.permission ? ` · ${t.permission}` : ""}</li>
                    ))}
                  </ul>
                ) : "none"}
              </dd>
            </div>
          )}
        </dl>
        {stale && (
          <p role="alert" className="mt-3 flex items-center gap-3 text-[13px] text-warning-text">
            Couldn't refresh this agent.
            <Button size="sm" variant="outline" onClick={reread}>Retry</Button>
          </p>
        )}
        {offText && <p className="mt-3 font-mono text-[12px] text-warning-text" role="status" aria-label="Harness not available">{offText}</p>}
      </header>
      {!agent.archived_at && <RunBar agent={agent} efforts={efforts} v2={v2} go={go} blocked={offText} limits={limits} />}
      <div className="flex border-b px-5 md:px-8" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={at.id === t.id} onClick={() => go(agentHash(agent.agent_id, t.id))}
            className={cn("caps -mb-px whitespace-nowrap border-b-2 px-3 py-3 text-[12px] max-sm:px-2.5 max-sm:py-2", at.id === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
            {t.id === "learning" && <WaitingCount n={itemsWaiting} className="ml-1.5" />}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={waiting ? undefined : at.label} className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-8">
        {waiting ? <ListSkeleton label="Loading the tab" rows={4} /> : <at.Body agent={agent} v2={v2} go={go} stats={stats} focus={notes} learning={learning} onAgent={onAgent} onChanged={onChanged} places={places} />}
      </div>
    </div>
  );
}

/** The agent's latest run, followed as it goes (LatestRun), over its runs, newest first: each row its status, title, its
 *  effort when it was given one, when, how long once ended, and its cost once known. A fresh read of the latest run
 *  replaces its row too, so the two never disagree. */
function RunsTab({ agent, v2 }: TabProps) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const asked = useRef(0);
  const read = (after: string | null) => {
    const n = ++asked.current;
    setError(null);
    if (after) setMore(true);
    // An archived agent's runs are archived with it: the server lists them only when asked for the archived ones.
    v2.listAgentRuns(agent.agent_id, 50, after, !!agent.archived_at)
      .then((r) => { if (n === asked.current) { setRuns((x) => (after ? appendRuns(x ?? [], r.runs) : r.runs)); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(problem(e, after ? "more runs" : "the runs")); })
      .finally(() => { if (n === asked.current) setMore(false); });
  };
  useEffect(() => { read(null); }, [v2, agent.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !runs) return <ProblemCard problem={error} onRetry={() => read(null)} className="" />;
  if (!runs) return <ListSkeleton label="Loading the runs" rows={5} />;
  if (!runs.length) return (
    <div className="border px-4 py-12 text-center">
      <p className="font-mono text-[13px] text-muted-foreground">No runs of this agent yet.</p>
      {!agent.archived_at && <p className="mt-2 text-[13px] text-muted-foreground">Start one above: its timeline shows here as the agent works.</p>}
    </div>
  );
  return (
    <>
      <LatestRun key={runs[0].run_id} v2={v2} run={runs[0]} onRun={(r) => setRuns((xs) => xs && xs.map((x) => (x.run_id === r.run_id ? r : x)))} />
      <p className="mb-3 font-mono text-[12px] text-muted-foreground">{runs.length}{cursor ? "+" : ""} {runs.length === 1 && !cursor ? "run" : "runs"}</p>
      <ul className="border" aria-label="Runs">
        {runs.map((r) => (
          <li key={r.run_id} className="border-b last:border-b-0">
            <a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent">
              <StatusBadge run={r} />
              <span className="min-w-0 flex-1 truncate text-[14px]" title={runTitle(r)}>{runTitle(r)}</span>
              <LearningChips run={r} />
              {r.effort && <Chip>effort {r.effort}</Chip>}
              <span className="font-mono text-[12px] text-muted-foreground">{when(r.created_at)}</span>
              {r.ended_at && <span className="font-mono text-[12px] text-muted-foreground" title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span>}
              {r.cost && (r.cost.usd !== null || soFar(r.cost)) && <span className="font-mono text-[12px] text-muted-foreground">{cost(r.cost, { ended: runEnded(r.status) })}</span>}
            </a>
          </li>
        ))}
      </ul>
      {/* A failed Load more keeps the runs already read, and the button to try again. */}
      {error && <ProblemCard problem={error} className="mt-4" />}
      {cursor && <div className="mt-4 flex justify-center"><button type="button" onClick={() => read(cursor)} disabled={more} className="caps border px-4 py-2 text-[12px] hover:bg-accent disabled:opacity-45">{more ? "Loading" : "Load more"}</button></div>}
    </>
  );
}

/** The current revision's workflow as its graph, read-only; editing it is the editor's Workflow step. */
function WorkflowTab({ agent, go }: TabProps) {
  const doc = agent.definition.workflow;
  const graph = useMemo(() => workflowGraph(doc), [doc]);
  const marks = useMemo(() => ({ meta: metaOf(doc, graph) }), [doc, graph]);
  return (
    <section className="border">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <span className="caps text-[11px] font-semibold">Graph</span>
        <span className="font-mono text-[11px] text-muted-foreground">{graph.nodes.length} nodes · rev {agent.definition.version}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => go(agentHash(agent.agent_id, "edit"))}><Pencil aria-hidden /> Edit the workflow</Button>
      </div>
      <div className="min-h-[360px] overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] px-4 py-5">
        {graph.nodes.length ? <WorkflowGraph graph={graph} marks={marks} label="The workflow's graph" minScale={0.55} />
          : <p className="p-6 text-center font-mono text-[13px] text-muted-foreground">This revision's workflow has no root node to draw.</p>}
      </div>
      <div className="border-t px-4 py-2"><GraphLegend /></div>
    </section>
  );
}
