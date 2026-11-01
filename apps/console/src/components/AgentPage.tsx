import { workflowGraph } from "@dsl/graph";
import { ArrowLeft, Bot, Pencil, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { GraphLegend, WorkflowGraph } from "@/components/WorkflowGraph";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { cost, when } from "@/lib/format";
import { appendRuns } from "@/lib/idempotency";
import { elapsed, metaOf } from "@/lib/runGraph";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

type TabProps = { agent: Agent; v2: Client; go: (hash: string) => void };

/** The page's tabs, in order, each at `#/agents/{id}/{tab}`. A tab shows only on an agent it has content for; a new one
 *  is one entry here. */
const TABS: { id: string; label: string; shows: (a: Agent) => boolean; Body: (p: TabProps) => JSX.Element }[] = [
  { id: "runs", label: "Runs", shows: () => true, Body: RunsTab },
  { id: "workflow", label: "Workflow", shows: (a) => a.kind === "workflow", Body: WorkflowTab },
];

const problemOf = (e: unknown) => (e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/** An agent's address: its page, one of its tabs, or `edit` for its editor. `#/agents/new` is the create form, so an
 *  agent whose id is "new" is given its Runs tab's address instead. */
export const agentHash = (id: string, view?: string) => `#/agents/${encodeURIComponent(id)}${view ? `/${view}` : id === "new" ? "/runs" : ""}`;

/** One agent's page (`#/agents/{id}`): its current revision's harness, model and thinking, and a tab per thing it has. */
export function AgentPage({ v2, agentId, defaultModel, go, tab }: { v2: Client; agentId: string; defaultModel?: string; go: (hash: string) => void; tab?: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setAgent(null); setError(null);
    v2.getAgent(agentId).then((r) => { if (live) setAgent(r.agent); }, (e) => { if (live) setError(problemOf(e)); });
    return () => { live = false; };
  }, [v2, agentId]);
  if (error) return <p className="m-8 border p-4 font-mono text-[13px] text-destructive-text" role="alert">The agent could not be read: {error}</p>;
  if (!agent) return <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading the agent...</p>;
  const d = agent.definition;
  const workflow = agent.kind === "workflow";
  const Icon = workflow ? Workflow : Bot;
  // A workflow revision has no harness, model or thinking of its own (the server refuses them beside a workflow).
  const facts: [string, string][] = [
    ...(workflow ? [] : [["Harness", d.harness ?? "pi"], ["Model", d.model ?? (defaultModel ? `${defaultModel} (default)` : "default")], ["Thinking", d.thinking ?? "default"]] as [string, string][]),
    ["Revision", `rev ${d.version} of ${agent.revisions}`],
  ];
  const tabs = TABS.filter((t) => t.shows(agent));
  const at = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b px-5 py-4 md:px-8">
        <button type="button" onClick={() => go(agent.archived_at ? "#/agents?archived=true" : "#/agents")} className="caps flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Agents
        </button>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="min-w-0 truncate font-mono text-xl font-semibold">{d.name}</h1>
          <Chip>{agent.kind}</Chip>
          {agent.archived_at && <Chip tone="muted">Archived</Chip>}
          <span className="flex-1" />
          <Button size="sm" onClick={() => go(agentHash(agent.agent_id, "edit"))}><Pencil aria-hidden /> Edit</Button>
        </div>
        {d.description && <p className="mt-2 max-w-3xl text-[14px] text-muted-foreground">{d.description}</p>}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2" aria-label="Current revision">
          {facts.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2"><dt className="caps text-[10px] text-muted-foreground">{k}</dt><dd className="font-mono text-[12px]">{v}</dd></div>
          ))}
        </dl>
      </header>
      <div className="flex border-b px-5 md:px-8" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={at.id === t.id} onClick={() => go(agentHash(agent.agent_id, t.id))}
            className={cn("caps -mb-px border-b-2 px-3 py-3 text-[12px]", at.id === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-6 md:px-8"><at.Body agent={agent} v2={v2} go={go} /></div>
    </div>
  );
}

/** The agent's runs, newest first: each row its status, title, when, how long once ended, and its cost once known. */
function RunsTab({ agent, v2 }: TabProps) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const read = (after: string | null) => {
    const n = ++asked.current;
    setError(null);
    if (after) setMore(true);
    // An archived agent's runs are archived with it: the server lists them only when asked for the archived ones.
    v2.listAgentRuns(agent.agent_id, 50, after, !!agent.archived_at)
      .then((r) => { if (n === asked.current) { setRuns((x) => (after ? appendRuns(x ?? [], r.runs) : r.runs)); setCursor(r.next_cursor); } })
      .catch((e) => { if (n === asked.current) setError(problemOf(e)); })
      .finally(() => { if (n === asked.current) setMore(false); });
  };
  useEffect(() => { read(null); }, [v2, agent.agent_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !runs) return <p className="border p-4 font-mono text-[13px] text-destructive-text" role="alert">The runs could not be read: {error}</p>;
  if (!runs) return <p className="py-12 text-center font-mono text-[13px] text-muted-foreground">Loading runs...</p>;
  if (!runs.length) return <div className="border px-4 py-12 text-center"><p className="font-mono text-[13px] text-muted-foreground">No runs of this agent yet.</p></div>;
  return (
    <>
      <p className="mb-3 font-mono text-[12px] text-muted-foreground">{runs.length}{cursor ? "+" : ""} {runs.length === 1 && !cursor ? "run" : "runs"}</p>
      <ul className="border" aria-label="Runs">
        {runs.map((r) => (
          <li key={r.run_id} className="border-b last:border-b-0">
            <a href={`#/runs/${encodeURIComponent(r.run_id)}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent">
              <StatusBadge run={r} />
              <span className="min-w-0 flex-1 truncate text-[14px]" title={r.title}>{r.title}</span>
              <span className="font-mono text-[12px] text-muted-foreground">{when(r.created_at)}</span>
              {r.ended_at && <span className="font-mono text-[12px] text-muted-foreground" title="How long it ran">{elapsed(Date.parse(r.ended_at) - Date.parse(r.created_at))}</span>}
              {r.cost && r.cost.usd !== null && <span className="font-mono text-[12px] text-muted-foreground">{cost(r.cost)}</span>}
            </a>
          </li>
        ))}
      </ul>
      {/* A failed Load more keeps the runs already read, and the button to try again. */}
      {error && <p className="mt-4 border p-3 font-mono text-[13px] text-destructive-text" role="alert">More runs could not be read: {error}</p>}
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
