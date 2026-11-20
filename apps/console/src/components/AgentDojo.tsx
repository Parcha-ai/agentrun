import { useCallback, useEffect, useRef, useState } from "react";
import { agentHash } from "./AgentPage";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { DojoIcon } from "./DojoIcon";
import { Button, buttonVariants } from "./ui/button";
import { Banner } from "./ui/banner";
import { LearningModelSetup } from "./LearningModelSetup";
import { Chip } from "./ui/chip";
import { ProblemCard } from "./Problem";
import { ListSkeleton } from "./Skeleton";
import { allPages, type Client, ClientError } from "@/lib/client";
import { type Agent, learningOn } from "@/lib/agentForm";
import { type AgentLearning, type LearningModelAccess, correctionLines, givenToRuns } from "@/lib/learning";
import { when } from "@/lib/format";
import { problem, type Problem } from "@/lib/problem";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

type Row = { agent: Agent; view?: AgentLearning; stale?: boolean; error?: Problem; unavailable?: boolean };
type Measure = { value: number; exact: boolean };
const AGENT_PAGES = 100;
const WORKERS = 4;
const count = (items: { status: string }[] | undefined, is: (status: string) => boolean): number => items?.filter((item) => is(item.status)).length ?? 0;
const learningHref = (agent: Agent) => `#/agents/${encodeURIComponent(agent.agent_id)}/learning`;
const shown = (n: number) => n.toLocaleString("en-US");
const measures: { label: string; of: (r: Row) => Measure | null }[] = [
  { label: "Corrections", of: (r) => r.view ? { value: correctionLines(r.view.corrections).length, exact: true } : null },
  { label: "Workflow drafts", of: (r) => r.view ? { value: count(r.view.workflows, givenToRuns), exact: true } : null },
  { label: "Pending review", of: (r) => r.view ? { value: count(r.view.workflows, (status) => status === "pending"), exact: true } : null },
  { label: "In progress", of: (r) => r.view ? { value: r.view.counts.in_progress, exact: true } : null },
];
/** Unknown or incomplete histories never turn into an exact zero. */
function total(rows: Row[], of: (r: Row) => Measure | null): string {
  if (!rows.length) return "0";
  const values = rows.map(of);
  if (values.every((value) => value === null)) return "—";
  // Saved counts can decrease after retirement: a stale sum is not a current lower bound.
  return `${shown(values.reduce((n, value) => n + (value?.value ?? 0), 0))}${rows.some((row) => row.stale) ? " (last read)" : values.every((value) => value?.exact) ? "" : "+"}`;
}

/** The existing learning repository and ledger, gathered across this server's agentic agents. No action here runs,
 * imports, enables or approves anything: each agent's Learning tab owns those controls. */
export function AgentDojo({ v2, server, modelAccess }: { v2: Client; server?: "on" | "off" | null; modelAccess?: LearningModelAccess | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const generation = useRef(0);
  const reading = useRef(false);
  const read = useCallback(async () => {
    if ((server !== "on" && server !== "off") || reading.current) return;
    reading.current = true;
    const n = ++generation.current;
    setLoading(true); setError(null);
    setRows((held) => held?.map((row) => row.view ? { ...row, stale: true } : row) ?? null);
    const current = () => generation.current === n;
    try {
      let next: string | null = null;
      const seen = new Set<string>();
      const agents = await allPages(async (cursor) => {
        if (!current()) throw new Error("Read superseded");
        if (cursor && seen.has(cursor)) throw new Error("The agent list repeated a page. Refresh to try again.");
        if (cursor) seen.add(cursor);
        const page = await v2.listAgents({ cursor }); next = page.next_cursor; return page;
      }, (page) => page.agents, AGENT_PAGES);
      if (!current()) return;
      if (next) throw new Error("The agent list is too large to read in one view. Open Connected agents to inspect an agent.");
      const initial = [...new Map(agents.map((agent) => [agent.agent_id, agent])).values()].map((agent): Row => ({ agent }));
      setRows((held) => {
        const saved = new Map(held?.map((row) => [row.agent.agent_id, row]));
        return initial.map(({ agent }): Row => {
          const old = saved.get(agent.agent_id);
          return agent.kind === "agentic" && old?.agent.kind === "agentic" && old.view
            ? { ...old, agent, stale: true, error: undefined, unavailable: undefined }
            : { agent };
        });
      });
      const candidates = initial.filter((row) => row.agent.kind === "agentic");
      let index = 0;
      const worker = async () => {
        while (current() && index < candidates.length) {
          const { agent } = candidates[index++];
          let row: Row;
          try {
            const view = await v2.agentLearning(agent.agent_id);
            if (!current()) return;
            row = { agent, view };
          } catch (e) {
            row = { agent, error: problem(e, "Learning"), unavailable: e instanceof ClientError && e.status === 404 };
          }
          if (!current()) return;
          setRows((held) => held?.map((old) => old.agent.agent_id !== agent.agent_id ? old
            : row.error && !row.unavailable && old.view ? { ...old, ...row, stale: true } : row) ?? null);
        }
      };
      await Promise.all(Array.from({ length: Math.min(WORKERS, candidates.length) }, worker));
      if (current()) setUpdated(new Date().toISOString());
    } catch (e) { if (current()) setError(problem(e, "Learning Dojo")); }
    finally { if (current()) { reading.current = false; setLoading(false); } }
  }, [v2, server]);
  useEffect(() => {
    setRows(null); setUpdated(null); setError(null);
    void read();
    const refresh = () => { if (!document.hidden) void read(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { generation.current++; reading.current = false; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [read]);
  // Poll even an idle or failed view: another client can start learning at any time. Hidden tabs and reads already
  // in flight do no extra work; returning to the tab reads immediately through the same guard.
  useEffect(() => {
    if (server !== "on" && server !== "off") return;
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [server, read]);
  const eligible = rows?.filter((row) => row.agent.kind === "agentic") ?? [];
  const loaded = eligible.filter((row) => row.view).length;
  const blocked = eligible.filter((row) => !row.stale && row.view?.learning_model?.location === "server" && !row.view.learning_model.ready);
  const stale = eligible.some((row) => row.stale);
  const changes = eligible.flatMap((row) => (row.view?.log.items ?? []).map((change) => ({ agent: row.agent, change })))
    .sort((a, b) => b.change.at.localeCompare(a.change.at)).slice(0, 8);
  return <section className="flex min-h-full flex-col">
    <header className={cn(pageToolbarClass, "gap-2 px-5")}>
      <h1 className={pageTitleClass}><DojoIcon size={16} className="shrink-0" />Learning Dojo</h1>
      <Button className="ml-auto" size="icon" aria-label="Refresh Learning Dojo" disabled={loading || !server} onClick={() => void read()}><RefreshCw className="size-4" aria-hidden /></Button>
    </header>
    <div className="mx-auto w-full max-w-page-wide space-y-7 p-5 md:p-8">
      <div><h2 className="text-xl font-semibold">What your agents learn</h2><p className="mt-2 max-w-3xl text-lead leading-relaxed text-muted-foreground">Review the corrections and workflow drafts your current agents keep for later runs. Open an agent to enable learning, inspect its changes or review pending drafts.</p><p className="mt-2 max-w-3xl text-small leading-relaxed text-muted-foreground">Imported sessions are history, not learning runs. Workflow drafts come from agentic runs started through this server; corrections are yours, given with a grade or written on an agent's Learning tab.</p></div>
      {server === undefined ? <p role="status" className="text-lead text-muted-foreground">Checking learning support…</p>
        : server === null ? <div className="border bg-card p-5"><h3 className="font-semibold">This server does not expose learning</h3><p className="mt-2 text-lead text-muted-foreground">Use a server version with learning support to inspect or enable it here.</p><a href="#/agents" className="mt-4 inline-block text-lead text-primary-text underline underline-offset-4">Connected agents</a></div>
        : <>
          {server === "off" && <p role="status" className="border border-warning/40 bg-warning/5 p-4 text-lead text-warning-text">This server has learning turned off. Saved learning remains available; new runs will learn only after the server's learning setting is on.</p>}
          {error && <><ProblemCard problem={error} onRetry={() => void read()} className="" />{rows && <p className="text-small text-warning-text">Showing the last read. Refresh to update these counts.</p>}</>}
          {!rows && !error ? <ListSkeleton label="Loading Learning Dojo" rows={4} /> : rows && <>
            {server === "on" && !rows.length && modelAccess && <LearningModelSetup access={modelAccess} scope="default" />}
            {server === "on" && blocked.length > 0 && <Banner tone="warning" title={`${blocked.length} ${blocked.length === 1 ? "agent needs" : "agents need"} model access`}>
              <div className="flex flex-wrap items-start gap-3"><p className="min-w-0 flex-1">Workflow drafting uses a model on this server and has separate model usage. Set up access for the models listed below. Your connected agents keep their own model and tool credentials.</p><a className={buttonVariants({ variant: "primary", size: "sm" })} href="#/settings/keys">Set up model access</a></div>
              <p className="mt-2 text-small text-muted-foreground">Settings → API Keys → Model keys. Tool API keys and AgentRun connection keys do not provide model access.</p>
            </Banner>}
            <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">{measures.map(({ label, of }) => <div key={label} aria-label={label} className="border bg-card p-4"><dt className="caps text-micro text-muted-foreground">{label}</dt><dd className="mt-3 font-mono text-display">{total(eligible, of)}</dd></div>)}</dl>
            <p className="text-small leading-relaxed text-muted-foreground">{loaded} of {eligible.length} agent histories read. Counts show active drafts; drafts that wait for your OK are counted under review. + means a minimum from incomplete data; — means not reported.{stale ? " Last-read totals include saved histories that may have changed; they are not current minimums." : updated && !loading ? ` Updated ${when(updated)}.` : ""}{loading ? " Loading learning…" : ""}</p>
            {!rows.length ? <div className="border px-6 py-10 text-center"><h3 className="font-semibold">No agents yet</h3><p className="mt-2 text-lead text-muted-foreground">Create an agent, then open its Learning tab to let its runs build on what they learn.</p><a className="mt-4 inline-block text-lead text-primary-text underline underline-offset-4" href="#/agents/new">Build an agent</a><span className="mx-3 text-muted-foreground">·</span><a className="text-lead text-primary-text underline underline-offset-4" href="#/agents">Import existing agents</a></div>
              : <section aria-label="Agents in Dojo" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((row) => <AgentCard key={row.agent.agent_id} row={row} server={server} />)}</section>}
            {eligible.length > 0 && <section className="overflow-hidden border" aria-label="Recent learning changes"><header className="border-b px-5 py-4"><h3 className="text-lead font-semibold">Recent learning changes</h3><p className="mt-1 text-small text-muted-foreground">Latest reported changes from the histories read above. Each agent's Learning tab has its full history and run outcomes.</p></header>
              {changes.length ? <ul className="divide-y">{changes.map(({ agent, change }) => <li key={`${agent.agent_id}:${change.commit}`}><a href={"run" in change.by ? `#/runs/${encodeURIComponent(change.by.run)}` : learningHref(agent)} className="flex items-start gap-3 px-5 py-4 hover:bg-accent"><span className="min-w-0 flex-1"><span className="block text-lead">{change.reason || "Learning updated"}</span><span className="mt-1 block text-small text-muted-foreground">{agent.definition.name || agent.agent_id} · {"run" in change.by ? "From a run" : "Edited by you"} · {when(change.at)}</span></span><ArrowUpRight className="mt-1 size-3.5 shrink-0" aria-hidden /></a></li>)}</ul>
                : <p className="px-5 py-7 text-lead text-muted-foreground">{loading ? "Loading learning changes…" : loaded < eligible.length ? "No changes in the histories available so far." : "No saved learning changes yet."}</p>}
            </section>}
          </>}
        </>}
    </div>
  </section>;
}

function AgentCard({ row, server }: { row: Row; server: "on" | "off" }) {
  const { agent, view, error } = row;
  const supported = agent.kind === "agentic";
  const on = learningOn(agent.definition.learning);
  const access = view?.learning_model;
  const needsSetup = supported && access?.location === "server" && !access.ready;
  const waiting = needsSetup && on && server === "on";
  return <article className="flex min-w-0 flex-col border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 break-words text-lead font-semibold">{agent.definition.name || agent.agent_id}</h3><Chip tone={waiting ? "warning" : supported && on && server === "on" ? "success" : "plain"}>{!supported ? "Workflow" : server === "off" && on ? "Paused by server" : waiting ? row.stale ? "Model setup (last read)" : "Needs model access" : on ? "Learning on" : "Learning off"}</Chip></div>
    {needsSetup && <div className="mt-4 space-y-2 text-small" role="status">
      <p className="text-warning-text">{row.stale ? "Last read: " : ""}{access.needs === "model" ? "Choose a model for learning." : "Model access is required for workflow drafting."}</p>
      {access.model && <p className="text-muted-foreground">Learning model: <span className="break-all font-mono">{access.model}</span></p>}
      {access.reason && <p className="text-muted-foreground">{access.reason}</p>}
      <a className={buttonVariants({ variant: "outline", size: "xs" })} href="#/settings/keys">Set up model access</a>
    </div>}
    {!supported ? <p className="mt-4 text-lead text-muted-foreground">Workflow runs do not learn. Enable learning on an agentic agent.</p>
      : <>{error && <div role="alert" className="mt-4 text-small text-destructive-text"><p>{row.unavailable ? "Learning unavailable for this agent." : error.title}</p><p className="mt-1">{error.why} {error.said}</p></div>}
      {!view ? !error && <p role="status" className="mt-4 text-lead text-muted-foreground">Loading learning…</p>
      : <><dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">{measures.map(({ label, of }) => <div key={label}><dt className="text-small text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lead">{total([row], of)}</dd></div>)}</dl>{row.stale && <p role="status" className="mt-3 text-small text-warning-text">Showing the last read. Refresh to update this history.</p>}<p className="mt-4 text-small text-muted-foreground">{shown(view.counts.merged)} runs kept learning · {shown(Object.values(view.counts.dropped).reduce((a, b) => a + b, 0))} kept nothing</p></>}</>}
    <a className="mt-5 inline-flex items-center gap-2 self-start text-small font-semibold text-primary-text hover:underline hover:underline-offset-4" href={supported ? learningHref(agent) : agentHash(agent.agent_id)}>{supported ? "Open learning" : "View agent"}<ArrowUpRight className="size-3.5" aria-hidden /></a>
  </article>;
}
