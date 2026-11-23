import { SourceSyncPanel } from "@/components/SourceSync";
import { cliLearningOf, cliLearningLabel } from "@/lib/cliLearning";
import { queryPlaygroundHref } from "@/lib/playgroundRoutes";
import { useScrollQuiet } from "@/lib/useScrollQuiet";
import { workflowGraph } from "@dsl/graph";
import { Archive, ArchiveRestore, ArrowLeft, ArrowUpRight, ChevronRight, RefreshCw, Search, Settings, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConnectedAgentSkills } from "@/components/ConnectedAgentSkills";
import type { Upload } from "@/lib/uploads";
import { AgentVersions } from "@/components/AgentVersions";
import { AnalyticsTab, FIRST_RANGE } from "@/components/AgentAnalytics";
import type { UploadLimits } from "@/components/FilePicker";
import { NotHere, ProblemCard } from "@/components/Problem";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { editAgentPrompt, queryRunsPrompt, runAgentPrompt } from "@/lib/codingAgentPrompts";
import { AgentSkeleton, ListSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { NativeAgent, NativeMutationProvider, useNativeReadiness } from "@/components/NativeAgent";
import { nativeRuntimeLabel, nativeStateLabel, type NativeBinding } from "@/lib/native";
import { backendSdkLabel, backendSdkOf } from "@/lib/backendSdk";
import { goBack } from "@/lib/back";
import { agentHarness, HarnessIcon, HarnessName } from "@/components/HarnessIcon";
import { SignIns } from "@/components/SignIns";
import { LearningTab } from "@/components/Learning";
import { LearningChips, WaitingCount } from "@/components/LearningChips";
import { Button } from "@/components/ui/button";
import { Banner, Chip, Tabs, tabPanelProps } from "@/components/ui";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import { type Agent, harnessLabel, runsWhere } from "@/lib/agentForm";
import { type Client, ClientError, problemOf } from "@/lib/client";
import { cost, runEnded, soFar, when, runTitle } from "@/lib/format";
import { waitingOf } from "@/lib/learning";
import { appendRuns } from "@/lib/idempotency";
import { freeRequestsNote, harnessDefault, type HarnessInfo, modelLabel, NO_MODEL_YET } from "@/lib/models";
import { RunBar } from "@/components/RunBar";
import { placeLabel, type Places } from "@/lib/place";
import { providerLabel, resolution } from "@/lib/toolSettings";
import { type Problem, problem } from "@/lib/problem";
import { elapsed, metaOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import { rangeFrom, type Stats } from "@/lib/mission";
import type { Run } from "@/lib/v2";
import { drawnNodeCount, nodesWord } from "@/lib/wfGraph";
import { pageToolbarClass } from "@/components/ui/toolbar";
import { matchesFilter } from "@/lib/filter";
import { ListFilter } from "@/components/ListFilter";

/** `stats`: the page's own read of the agent's stats over the Analytics tab's first range, which that tab starts from. */
type TabProps = { agent: Agent; v2: Client; go: (hash: string) => void; stats?: Stats | null; history?: RunHistory };
/** What the server gives beside the agent: `analytics`, once its stats are read. */
type Server = { analytics: boolean };
/** Mount agent settings only while open; writes refresh the agent page. */
type RenderEditor = (onAgent: (agent: Agent) => void, onEditPromptChange: (prompt: string | null) => void) => ReactNode;

/** What the Learning tab takes beside a tab's own: the server's learning switch, and the agent as the tab's write left it
 *  (`onAgent`, a new revision). `learning` beside the server's: whether it has learning at all, undefined until its
 *  capabilities are read. */
type LearningTabProps = { learning?: "on" | "off" | null; onAgent?: (agent: Agent) => void; places?: Places | null; onChanged?: () => void };
type LearningServer = { learning?: boolean };

/** The page's tabs, in order, each at `#/agents/{id}/{tab}`. A tab shows only on an agent it has content for; a new one
 *  is one entry here. */
const TABS: { id: string; label: string; shows: (a: Agent, server: Server & LearningServer) => boolean; Body: (p: TabProps & LearningTabProps) => JSX.Element }[] = [
  { id: "runs", label: "Runs", shows: () => true, Body: RunsTab },
  { id: "versions", label: "Versions", shows: () => true, Body: AgentVersions },
  { id: "workflow", label: "Workflow", shows: (a) => a.kind === "workflow", Body: WorkflowTab },
  { id: "learning", label: "Learning", shows: (a, server) => a.kind === "agentic" && server.learning !== false, Body: (p) => <LearningTab agent={p.agent} v2={p.v2} server={p.learning} onAgent={p.onAgent} onChanged={p.onChanged} /> },
  { id: "analytics", label: "Analytics", shows: (_, server) => server.analytics, Body: AnalyticsTab },
];

/** An agent's address: its page, one of its tabs, or `settings` for its configuration (`edit` is a legacy alias). `#/agents/new` and `#/agents/connect` are setup forms,
 *  so agents with those ids are given their Runs tab's address instead. */
export const agentHash = (id: string, view?: string) => `#/agents/${encodeURIComponent(id)}${view ? `/${view}` : id === "new" || id === "connect" ? "/runs" : ""}`;

/** One agent's page (`#/agents/{id}`): its current revision's harness, model and thinking, a compact overview and a tab per thing it has. `efforts` are the server's (capabilities `features.efforts`).
 *  `learning`: the server's learning switch, undefined until its capabilities are read and null when it has none;
 *  `places`: the server's places (capabilities `places`), for where a revision that names no place runs. */
export function AgentPage({ v2, agentId, routePrefix, harnesses, efforts = [], go, tab, limits, learning, places, upload, renderEditor }: { renderEditor?: RenderEditor; v2: Client; agentId: string; routePrefix?: string | null; harnesses?: HarnessInfo[]; efforts?: string[]; go: (hash: string) => void; tab?: string; limits?: UploadLimits & { free_model_requests?: number }; learning?: "on" | "off" | null; places?: Places | null; upload?: Upload }) {
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
    floor.current = ++rereads.current;
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, (e) => { if (live) setError({ cause: e }); });
    v2.statsOver({ from: rangeFrom(FIRST_RANGE), agent: agentId }).then((r) => { if (live) setStats(r); }, () => { if (live) setStats(null); });
    return () => { live = false; floor.current = ++rereads.current; };
  }, [v2, agentId, tries]);
  // The agent read again after a write on the page: the Learning tab's own (an approve, a retire, an edit: `onChanged`)
  // and the learning switch's save (`onAgent`, whose answer carries no `tools`: only GET /v2/agents/{id} serves them, so
  // the page shows the save's answer with the tools it showed until the read lands). One counter for both: only the
  // newest read lands, so one answered last never puts back an older count or revision. A read that fails says so, with
  // a retry.
  const rereads = useRef(0);
  // The newest read that landed, and the oldest a read may be and still land: a write's own read raises it, so a poll that
  // began before the write never puts back an older revision, while polls among themselves land in the order they began
  // (a read slower than the poll interval still lands, never starved by the next tick's).
  const landed = useRef(0);
  const floor = useRef(0);
  const [stale, setStale] = useState(false);
  // `quiet`: a read that waits for the next tick (or says so itself) on a failure rather than raise the page's retry.
  // `raise`: a write's read, which lifts the floor. It answers whether the page now shows a read that began at or after
  // this one: true when this read applied, or was dropped (superseded) with a newer read already applied. A read that
  // failed, or was dropped while the newer one is still open or failed, answers false: nothing on the page reflects it.
  const reread = (quiet = false, raise = !quiet): Promise<boolean> => {
    const n = ++rereads.current;
    if (raise) floor.current = n;
    return v2.getAgent(agentId).then(
      (r) => { if (n > landed.current && n >= floor.current) { landed.current = n; setAgent((cur) => (cur && cur.agent_id === r.agent.agent_id ? r.agent : cur)); setStale(false); } return landed.current >= n; },
      () => { if (n === rereads.current && !quiet) setStale(true); return landed.current >= n; },
    );
  };
  const onAgent = (saved: Agent) => { setAgent((cur) => ({ ...saved, tools: cur?.tools ?? saved.tools })); void reread(); };
  const onChanged = () => void reread();
  const poll = () => void reread(true, false);
  // The agent read again after a Forget: through the same guarded read, and quiet, since the Forget says a failed one itself.
  const afterForget = () => reread(true, true);
  const analytics = stats === undefined ? undefined : stats !== null;
  if (error) return error.cause instanceof ClientError && error.cause.status === 404
    ? <NotHere what="agent" id={agentId} list={{ href: "#/agents", label: "Open the agents list" }} />
    : <ProblemCard problem={problem(error.cause, "the agent")} onRetry={() => setTries((n) => n + 1)} />;
  if (!agent) return <AgentSkeleton />;
  return <AgentDetail key={agent.agent_id} upload={upload} renderEditor={renderEditor} agent={agent} onAgent={onAgent} onSignInsAgent={setAgent} reread={reread} onChanged={onChanged} poll={poll} afterForget={afterForget} stale={stale} v2={v2} go={go} stats={stats} analytics={analytics} places={places} routePrefix={routePrefix} harnesses={harnesses} tab={tab} learning={learning} efforts={efforts} limits={limits} />;
}

function AgentDetail({ agent, onAgent, onSignInsAgent, reread, onChanged, poll, afterForget, stale, v2, go, stats, analytics, routePrefix, harnesses, tab, learning, places, efforts, limits, upload, renderEditor }: {
  renderEditor?: RenderEditor; agent: Agent; onAgent: (agent: Agent) => void; onSignInsAgent: (agent: Agent) => void; reread: (quiet?: boolean, raise?: boolean) => Promise<boolean>; onChanged: () => void; poll: () => void; afterForget: () => Promise<boolean>; stale: boolean; v2: Client; go: (hash: string) => void;
  stats: Stats | null | undefined; analytics: boolean | undefined; routePrefix?: string | null; harnesses?: HarnessInfo[]; tab?: string; learning?: "on" | "off" | null; places?: Places | null;
  efforts: string[]; limits?: UploadLimits & { free_model_requests?: number }; upload?: Upload;
}) {
  const history = useRunHistory(agent, v2, reread, () => reread(false, false));
  const [factsOpen, setFactsOpen] = useState(false);
  const [editorPrompt, setEditorPrompt] = useState<string | null>(null);
  // Each scrolling box shows its scrollbar only while it is being scrolled.
  const detailsScroll = useScrollQuiet<HTMLDivElement>();
  const workspaceScroll = useScrollQuiet<HTMLElement>();
  const descriptionScroll = useScrollQuiet<HTMLDivElement>();
  // A box that scrolls (a long description, or a name long enough to scroll the block) takes the keyboard's focus, so
  // its end can be read without a pointer (Safari puts no scrolling box in the tab order by itself). One that fits is no stop.
  const headingScroll = useRef<HTMLDivElement>(null);
  const [scrolling, setScrolling] = useState({ heading: false, description: false });
  useEffect(() => {
    const heading = headingScroll.current, description = descriptionScroll.current;
    if (!heading || !description || typeof ResizeObserver === "undefined") return;
    const overflows = (box: HTMLElement) => box.scrollHeight > box.clientHeight + 1;
    const measure = () => setScrolling((was) => {
      const now = { heading: overflows(heading), description: overflows(description) };
      return now.heading === was.heading && now.description === was.description ? was : now;
    });
    const sizes = new ResizeObserver(measure);
    for (const box of [heading, description]) { sizes.observe(box); for (const child of box.children) sizes.observe(child); }
    measure();
    return () => sizes.disconnect();
  }, [descriptionScroll, agent.definition.name, agent.definition.description, agent.definition.approvals]);
  const itemsWaiting = waitingOf(agent);
  const d = agent.definition;
  const sdk = backendSdkOf(d);
  const cli = cliLearningOf(d);
  const { native, refresh: refreshNative } = useNativeReadiness(agent, v2);
  const workflow = agent.kind === "workflow";
  // A workflow revision has no harness, model or thinking of its own (the server refuses them beside a workflow).
  // The model as a person reads it (the gateway's routing prefix off, the full id in a title): its own, else the default
  // the server names for this harness (capabilities' harnesses[].default_model), else none yet.
  const fallback = harnessDefault(d.harness ?? "pi", harnesses);
  const model = d.model ? modelLabel(d.model, routePrefix)
    : fallback ? (({ text, title }) => ({ text: `${text} (default)`, title }))(modelLabel(fallback, routePrefix))
    : { text: NO_MODEL_YET };
  // A harness the server can't run: why, where its Run would fail (capabilities' harnesses[].reason).
  const off = workflow || native || sdk || cli ? undefined : harnesses?.find((h) => h.id === (d.harness ?? "pi") && h.available === false);
  const offText = off ? `${harnessLabel(off.id)} doesn't run on this server${off.reason ? `: ${off.reason}` : "."}` : undefined;
  // Run from this page: an agent this server runs (not a native, SDK or CLI one, which run where they live), not archived.
  const runHere = !agent.archived_at && !native && !sdk && !cli;
  // Where it runs: its own place, else the server's default place for it, marked as such (#1790: resolved at each run).
  const where = runsWhere(agent, places);
  const runsLabel = `${placeLabel(where?.place)}${where?.byDefault ? " (server default)" : ""}`;
  // Explain a known absent default without blocking observation or the handoff that can configure it.
  // Explicit models and older servers leave readiness to the execution path.
  const needsModel = !sdk && !cli && !native && !workflow && !off && !d.model && !fallback && harnesses?.some((h) => h.id === (d.harness ?? "pi") && h.default_model === null);
  // What the run's own check would refuse now (the agent read's run_blockers), each once: a harness this server doesn't
  // run, or a model it has none of, is said by its own banner above, not twice. A harness off for want of a model key
  // (its `needs`: pi with no key) says the default model it lacks in its banner, so a model blocker in those same words
  // is not said again below it; one in other words (a model the agent names, which lacks its own key) still is.
  const refused = agent.archived_at ? null : agent.run_blockers;
  const offForKey = off?.needs?.length ? off.reason : undefined;
  const blockers = !refused ? [] : !refused.fields.length ? [refused.message]
    : refused.fields.filter((b) => !(offText && b.field === "definition.harness") && !(needsModel && b.field === "definition.model") && !(offForKey !== undefined && b.field === "definition.model" && b.message === offForKey)).map((b) => b.message);
  const facts: [string, ReactNode, string?][] = [
    ...(cli ? [["Runtime", <HarnessName harness={cli.runtime} name={cliLearningLabel(cli.runtime)} />], ["Model", "Reported per run"], ["Execution", "Your CLI"], ["Project", cli.project]] as [string, ReactNode, string?][] : sdk ? [["Runtime", <HarnessName harness={sdk.runtime} name={backendSdkLabel(sdk)} />], ["Model", "Reported per run"], ["Execution", "Your backend"]] as [string, ReactNode, string?][] : native ? [["Runtime", <HarnessName harness={native.runtime} name={nativeRuntimeLabel(native.runtime)} />], ["Model", native.model ?? "Native default"], ["Selector", native.selector.kind === "project" ? "Project default" : native.selector.name ?? native.selector.kind], ["Machine", native.machine_id]] as [string, ReactNode, string?][] : workflow ? [] : [["Harness", <HarnessName harness={d.harness ?? "pi"} />], ["Model", model.text, model.title], ["Thinking", d.thinking ?? "default"], ["Runs", runsLabel]] as [string, ReactNode, string?][]),
    ["Revision", `rev ${d.version} of ${agent.revisions}`],
  ];
  // Until the server's capabilities are read, the Learning tab shows only on its own address, which opens it at once (a
  // server without learning answers its read with an error the tab shows); once read, it shows when the server learns.
  const tabs = TABS.filter((t) => t.shows(agent, { analytics: analytics === true, learning: learning === undefined ? (tab === "learning" ? undefined : false) : !!learning }));
  const at = tabs.find((t) => t.id === tab) ?? tabs[0];
  const editing = !!(renderEditor || native || sdk || cli) && (tab === "settings" || tab === "edit");
  // An address on a tab the server may still give: wait for its answer rather than open another tab meanwhile.
  const waiting = tab === "analytics" && analytics === undefined;
  const live = history.runs?.filter(isLiveRun) ?? [];
  const liveCount = agent.runs?.live ?? (history.runs ? `${live.length}${history.cursor ? "+" : ""}` : "—");
  // The facts drawn as more than words (a harness's icon and name), in words: the phone's one-line summary reads these.
  const factWords: Record<string, string> = cli ? { Runtime: cliLearningLabel(cli.runtime) } : sdk ? { Runtime: backendSdkLabel(sdk) } : native ? { Runtime: nativeRuntimeLabel(native.runtime) } : workflow ? {} : { Harness: harnessLabel(d.harness ?? "pi") };
  const overviewFacts: [string, ReactNode, string?][] = [["Status", agent.archived_at ? "Archived" : native ? nativeStateLabel(native) : "Active"], ["Live jobs", String(liveCount)], ...facts];
  return (
    <NativeMutationProvider native={native}><section className="flex h-full min-h-0 flex-col" aria-label="Agent detail">
      <header className={cn(pageToolbarClass, "flex-wrap gap-2 px-5 lg:flex-nowrap")} aria-label="Agent toolbar">
        <Button size="icon" variant="ghost" aria-label="Back" title="Back" onClick={() => goBack(editing ? agentHash(agent.agent_id) : agent.archived_at ? "#/agents?archived=true" : "#/agents")}><ArrowLeft aria-hidden /></Button>
        <span data-agent-icon className="flex shrink-0 items-center"><HarnessIcon harness={agentHarness(agent)} /></span>
        {editing ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-body font-semibold">
            <a href={agentHash(agent.agent_id)} title={d.name} className="-my-1 min-w-0 truncate py-1 text-muted-foreground hover:text-foreground hover:underline"
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); go(agentHash(agent.agent_id));
              }}>{d.name}</a>
            <span aria-hidden className="shrink-0 text-muted-foreground">/</span>
            <h1 aria-current="page" className="shrink-0">Settings</h1>
          </nav>
        ) : <strong className="min-w-0 truncate text-body font-semibold">{d.name}</strong>}
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {!editing && <Button size="sm" aria-label="Agent settings" onClick={() => go(agentHash(agent.agent_id, "settings"))}><Settings aria-hidden /> Settings</Button>}
          <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
            <Button size="icon" aria-label="Refresh agent" onClick={() => { history.refresh(); refreshNative(); }} disabled={history.reading}><RefreshCw className={cn(history.reading && "animate-spin")} aria-hidden /></Button>
            <CodingAgentAction label="Edit agent" prompt={editing && !native && !sdk && !cli && editorPrompt !== null ? editorPrompt : editAgentPrompt(location.origin, agent.agent_id, !!native, sdk, cli?.runtime)} playgroundHref={editing || native || sdk || cli ? undefined : `#/playground?operation=edit-agent&agent=${encodeURIComponent(agent.agent_id)}`} />
            {!agent.archived_at && !runHere && <CodingAgentAction variant="primary" label="Run agent" disabled={!!native && (!native.connected || native.state !== "ready" || !native.capabilities.launch)} prompt={runAgentPrompt(location.origin, agent.agent_id, sdk, cli?.runtime)} playgroundHref={sdk || cli ? undefined : `#/playground?agent=${encodeURIComponent(agent.agent_id)}`} />}
          </div>
        </div>
      </header>
      {/* Each scrolling box reaches 16px into the space beside it: 6px of scrollbar (.scroll-quiet) and 10px between the bar
          and the cards, so the cards keep the width of the name above them and the bar lies over none of them. */}
      {/* Side by side (lg), the page itself does not scroll: the agent's name stays put, its details scroll under it, and
          the workspace scrolls beside them. In one column the whole page scrolls, as before. */}
      <main className={editing ? "flex min-h-0 flex-1 flex-col" : "grid min-h-0 flex-1 grid-cols-1 items-start gap-6 overflow-auto p-5 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:overflow-hidden md:p-8"}>
        <aside className={cn("min-w-0 space-y-6 lg:flex lg:min-h-0 lg:flex-col", editing && "hidden lg:hidden")} aria-label="Agent overview">
          {/* The name block takes at most half the column, so the details under it always have room. A description too long
              for that scrolls in a box of its own between the name and the id, which both stay. The block reaches into
              the space beside it so that box's scrollbar has its gutter; a name that fills the half by itself scrolls
              the block, which shows no scrollbar of its own, and the description keeps a line of it. */}
          <div ref={headingScroll} data-agent-heading {...(scrolling.heading ? { tabIndex: 0, role: "region", "aria-label": "Agent name and description" } : {})} className="lg:-mr-4 lg:flex lg:max-h-[50%] lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:pr-4 lg:[scrollbar-width:none]">
            {editing ? <h2 className="text-2xl font-semibold lg:shrink-0">{d.name}</h2> : <h1 className="text-2xl font-semibold lg:shrink-0">{d.name}</h1>}
            {d.approvals === "never" && <Chip tone="warning" className="mt-2 lg:shrink-0 lg:self-start" title="Never ask: a call of this agent never waits for you. A tool set to deny, and a template’s pins, still hold.">Unattended</Chip>}
            <div ref={descriptionScroll} data-agent-description {...(scrolling.description ? { tabIndex: 0, role: "region", "aria-label": "Agent description" } : {})} className={cn("scroll-quiet min-w-0 lg:-mr-4 lg:overflow-y-auto lg:overflow-x-hidden lg:pr-2.5", d.description ? "lg:min-h-7" : "lg:min-h-0")}>
              {d.description && <p id="agent-overview-description" className={cn("mt-2 break-words text-body leading-relaxed text-muted-foreground", !factsOpen && "max-sm:line-clamp-2")}>{d.description}</p>}
            </div>
            <p className="mt-3 break-all font-mono text-label text-muted-foreground lg:shrink-0">{agent.agent_id}</p>
          </div>
          <div ref={detailsScroll} data-agent-details className="scroll-quiet min-w-0 space-y-6 lg:-ml-1 lg:-mr-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overflow-x-hidden lg:pb-6 lg:pl-1 lg:pr-2.5">
          <button type="button" aria-expanded={factsOpen} aria-controls={d.description ? "agent-overview-description agent-facts" : "agent-facts"} onClick={() => setFactsOpen((value) => !value)} className="flex w-full min-w-0 items-center gap-2 text-left font-mono text-small text-muted-foreground sm:hidden">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", factsOpen && "rotate-90")} aria-hidden /><span className="truncate">{overviewFacts.map(([label, value]) => factWords[label] ?? (typeof value === "string" ? value : "")).filter(Boolean).join(" · ")}</span>
          </button>
          <dl id="agent-facts" className={cn("grid grid-cols-2 gap-3", !factsOpen && "max-sm:hidden")} aria-label="Current revision">
            {overviewFacts.map(([k, v, title]) => (
              <div key={k} className="min-w-0 border bg-card p-4"><dt className="mb-2 text-label text-muted-foreground">{k}</dt><dd className="break-words text-body font-semibold" title={title}>{v}</dd></div>
            ))}
            {!workflow && !native && !sdk && !cli && <div className="col-span-2 border bg-card p-4"><dt className="mb-2 flex items-center justify-between gap-2 text-label text-muted-foreground"><span>Tools</span><Button size="xs" variant="ghost" aria-label="Edit tools" onClick={() => go(`${agentHash(agent.agent_id, "settings")}?section=tools`)}>Edit</Button></dt><dd className="break-words text-small">{!workflow && agent.tools ? (agent.tools.length ? <ul className="space-y-2" aria-label="Tools">{agent.tools.map((tool) => <li key={tool.name}><span title={tool.blurb}>{tool.name}</span>{tool.provider ? ` · ${providerLabel(tool.provider, tool.name)}` : ""}{tool.permission ? ` · ${tool.permission}` : ""}{resolution(tool.resolved, tool.name).unavailable && <span data-unavailable className="text-warning-text" title={tool.resolved}> · unavailable</span>}</li>)}</ul> : "none") : d.tools.join(", ") || "None configured"}</dd></div>}
          </dl>
          {(native || cli || agent.source_sync) && <SourceSyncPanel agent={agent} v2={v2} onAgent={onAgent} />}
          {offText && <Banner tone="warning" aria-label="Harness not available">{offText}</Banner>}
          {!agent.archived_at && needsModel && <Banner>Running this agent needs a configured model. <a href="#/settings/keys" className="text-primary-text underline underline-offset-2">Set up models in Settings</a></Banner>}
          {blockers.length > 0 && (
            <Banner tone="warning" aria-label="Runs refused">
              <p>A run of this agent is refused until this is fixed:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{blockers.map((message, i) => <li key={i}>{message}</li>)}</ul>
            </Banner>
          )}
          {stale && <Banner tone="error">Couldn't refresh this agent. <Button size="sm" onClick={() => void reread()}>Retry</Button></Banner>}
          {/* Keep the create answer's warnings beside its configuration; a later read carries none. */}
          {agent.warnings?.length ? (
            <div className="font-mono text-small" role="status" aria-label="Save warnings">
              <p className="text-warning-text">Created. What the server said of this revision (Edit shows each at its step):</p>
              <ul className="mt-1 space-y-0.5">{agent.warnings.map((w, i) => <li key={`${w.field}:${i}`}><span className="text-muted-foreground">{w.field}</span> {w.message}</li>)}</ul>
            </div>
          ) : null}
          <SignIns agent={agent} v2={v2} onAgent={onSignInsAgent} poll={poll} refresh={afterForget} />
          {native && <NativeAgent agent={agent} v2={v2} learning={learning} onAgent={onAgent} onChanged={async () => { refreshNative(); await reread(); }} />}
          {!native && <section className="border bg-card p-4" aria-label="Agent configuration">
            <h2 className="mb-4 text-body font-semibold">Configuration</h2>
            <dl className="space-y-3 text-small">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Kind</dt><dd>{agent.kind}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Skills</dt><dd className="max-w-[75%] break-words text-right">{cli ? "Managed in your CLI" : sdk ? "Managed by your backend" : d.skills.join(", ") || "None configured"}</dd></div>
            </dl>
            {d.instructions && <details className="mt-4 text-small"><summary className="cursor-pointer">Instructions</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans leading-relaxed text-muted-foreground">{d.instructions}</pre></details>}
          </section>}
          <section className="border bg-card p-4" aria-label="Live jobs">
            <h2 className="mb-3 text-body font-semibold">Live jobs</h2>
            {live.length ? <ul className="space-y-3">{live.map((run) => <li key={run.run_id}><a href={`#/runs/${encodeURIComponent(run.run_id)}`} className="flex items-center gap-2 text-small hover:text-primary-text"><StatusBadge run={run} /><span className="min-w-0 flex-1 truncate">{runTitle(run)}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden /></a></li>)}</ul>
              : <p className="text-small leading-relaxed text-muted-foreground">{!history.runs ? "Loading live jobs…" : agent.runs?.live ? "Live jobs are outside the loaded history. Load more runs to find them." : history.error ? "Live jobs could not be refreshed." : "No live jobs."}</p>}
          </section>
          </div>
        </aside>
        <section ref={workspaceScroll} className={editing ? "flex min-h-0 flex-1 flex-col" : "scroll-quiet min-w-0 lg:-ml-1 lg:-mr-4 lg:min-h-0 lg:overflow-y-auto lg:overflow-x-hidden lg:pb-6 lg:pl-1 lg:pr-2.5"} aria-label="Agent workspace">
          {/* Run it here: type, Run, and the run's page opens. Handing it to a coding agent and the API playground are the
              run box's second line. */}
          {!editing && runHere && <div className="mb-6" data-run-here><RunBar className="border-b-0 px-0 py-0 max-sm:py-0 md:px-0" agent={agent} efforts={efforts} v2={v2} go={go} blocked={offText} limits={limits} {...(upload ? { upload } : {})}
            freeNote={workflow ? null : freeRequestsNote(d.model ?? fallback, d.harness ?? "pi", harnesses, limits?.free_model_requests)} playgroundHref={`#/playground?agent=${encodeURIComponent(agent.agent_id)}`} /></div>}
          {!editing && <Tabs id="agent-views" label="Agent views" value={at.id} onChange={(value) => go(agentHash(agent.agent_id, value))} tabs={tabs.map((t) => ({ id: t.id, label: <>{t.label}{t.id === "learning" && <WaitingCount n={itemsWaiting} className="ml-1.5" />}</> }))} className="mb-5 overflow-x-auto px-0 md:px-0" />}
          <div {...(editing ? { role: "region", "aria-label": "Agent settings" } : { ...tabPanelProps("agent-views", at.id), "aria-label": waiting ? undefined : at.label })} className={editing ? "min-h-0 flex-1" : undefined}>
            {editing ? native || sdk || cli ? <ConnectedAgentSettings agent={agent} native={native} v2={v2} onAgent={onAgent} stale={stale} onRefresh={() => void reread()} /> : renderEditor?.(onAgent, setEditorPrompt) : waiting ? <ListSkeleton label="Loading the tab" rows={4} /> : <at.Body agent={agent} v2={v2} go={go} stats={stats} history={history} learning={learning} onAgent={onAgent} onChanged={onChanged} places={places} />}
          </div>
        </section>
      </main>
    </section></NativeMutationProvider>
  );
}

/** Connected definitions stay at their source; their console settings still provide archive and restore actions. */
function ConnectedAgentSettings({ agent, native, v2, onAgent, stale, onRefresh }: {
  agent: Agent; native?: NativeBinding; v2: Client; onAgent: (agent: Agent) => void; stale: boolean; onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const shown = useRef(true);
  const latest = useRef(agent);
  latest.current = agent;
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  const archive = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const archived = !!latest.current.archived_at;
    try {
      const saved = await (archived ? v2.unarchiveAgent(agent.agent_id) : v2.archiveAgent(agent.agent_id));
      if (!shown.current) return;
      // Keep any newer definition a refresh read while the write was pending. The page's guarded reread fills in
      // the remaining server fields; if it fails, the committed archive state still stays visible.
      onAgent({ ...latest.current, archived_at: saved.archived_at });
    } catch (cause) {
      if (shown.current) setError(`${archived ? "Unarchive" : "Archive"} did not finish: ${problemOf(cause)}`);
    } finally {
      pending.current = false;
      if (shown.current) setBusy(false);
    }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <header className={cn(pageToolbarClass, "flex-wrap gap-3 px-5 md:px-8")}>
      <div role="group" aria-label="About this agent" className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <Chip>{agent.kind}</Chip>
        <span className="caps text-label text-muted-foreground">{agent.revisions} {agent.revisions === 1 ? "revision" : "revisions"}</span>
      </div>
      <Button size="icon" className="ml-auto shrink-0" variant={agent.archived_at ? "primary" : "outline"} aria-label={busy ? agent.archived_at ? "Unarchiving…" : "Archiving…" : agent.archived_at ? "Unarchive" : "Archive"} title={agent.archived_at ? "Unarchive" : "Archive"} disabled={busy} aria-busy={busy} onClick={() => void archive()}>{agent.archived_at ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}</Button>
    </header>
    {error && <Banner bar tone="error">{error}</Banner>}
    {stale && <Banner bar tone="error" actions={<Button size="sm" disabled={busy} onClick={onRefresh}>Retry</Button>}>Couldn't refresh this agent.</Banner>}
    <div className="min-h-0 flex-1"><ConnectedAgentSkills agent={agent} native={native} /></div>
  </div>;
}

const isLiveRun = (run: Run) => !run.imported_from && ["queued", "working", "paused", "input_required"].includes(run.status);
type RunHistory = {
  runs: Run[] | null; cursor: string | null; reading: boolean; more: boolean; error: Problem | null;
  refresh: () => void; loadMore: () => void; reloadLatest: (() => void) | null;
};

/** Refresh through the oldest loaded run or past its start time if it was archived. Both current and legacy servers
 * order by start time descending, but use different tie-breakers; don't infer equal-time order from run ids. Bound
 * ambiguous refreshes to the loaded pages plus one shift page, preserving the snapshot until explicit recovery. */
function useRunHistory(agent: Agent, v2: Client, reread: () => Promise<unknown>, poll: () => Promise<unknown>): RunHistory {
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
  const read = async (after: string | null, metadata = false, reset = false, background = false) => {
    if (busy.current) return;
    busy.current = true;
    const n = ++asked.current;
    setReading(true); setMore(!!after);
    const metadataRead = metadata ? (background ? poll() : reread()) : Promise.resolve();
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
    const refreshVisible = () => { if (!document.hidden) void read(null, true, false, true); };
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
  const filtered = runs.filter((r) => matchesFilter(query, runTitle(r), r.run_id, r.status));
  return <section className="min-h-[380px] overflow-hidden border" aria-label="Agent run history">
    <div className="flex flex-wrap items-center gap-3 border-b p-3">
      <ListFilter value={query} onChange={setQuery} label="Search this agent's runs" placeholder="Search runs…" shown={filtered.length} total={runs.length} className="max-w-md flex-1" />
      <span className="text-small text-muted-foreground">{runs.length}{cursor ? "+" : ""} {runs.length === 1 && !cursor ? "run" : "runs"}</span>
      <div className="ml-auto"><CodingAgentAction label="Ask about runs" prompt={`${queryRunsPrompt(location.origin, agent.agent_id)}\nCurrent view: all statuses; ${agent.archived_at ? "archived runs" : "non-archived runs"}.`} playgroundHref={queryPlaygroundHref(agent.agent_id, { archived: !!agent.archived_at })} /></div>
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
    {cursor && <div className="flex justify-center p-4"><Button size="sm" onClick={loadMore} disabled={reading}>{more ? "Loading" : "Load more"}</Button></div>}
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
        <span className="font-mono text-label text-muted-foreground">{nodesWord(drawnNodeCount(graph))} · rev {agent.definition.version}</span>
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
