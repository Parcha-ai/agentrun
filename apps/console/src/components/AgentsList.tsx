import { Archive, ArchiveRestore, Bot, History, Pencil, Play, Search, Workflow } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import type { Agent } from "@/lib/agentForm";
import { cn } from "@/lib/utils";
import { workflowShape } from "@/lib/workflowDoc";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { buildAgentPrompt, editAgentPrompt, runAgentPrompt } from "@/lib/codingAgentPrompts";

export type AgentsListActions = { onOpen?: (id: string) => void; onEdit?: (id: string) => void; onNew?: () => void; onRuns?: (id: string) => void; onArchive?: (id: string, archive: boolean) => void };

/** The hosted console's agent grid: a search box, the count, and a card per agent (name, kind, harness, what it does,
 *  its revision and runs, and its actions). Archived agents are their own view. */
export function AgentsList({ agents, archived = false, onArchivedChange, actions = {}, error, handoff }: { agents: Agent[] | null; archived?: boolean; onArchivedChange?: (archived: boolean) => void; actions?: AgentsListActions; error?: string | null; handoff?: ReactNode }) {
  const [q, setQ] = useState("");
  const shown = (agents ?? []).filter((a) => `${a.definition.name} ${a.definition.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="flex min-h-full flex-col">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-5 py-2">
        <h1 className="caps flex items-center gap-2 text-[13px] font-semibold"><Bot className="size-4" aria-hidden />{archived ? "Archived agents" : "Connected agents"}</h1>
        <div className="flex flex-wrap items-center gap-2">{handoff}{!archived && <CodingAgentAction label="Build an agent" prompt={buildAgentPrompt(location.origin)} playgroundHref="#/playground?operation=create-agent" />}</div>
      </header>
      <div className="p-5 md:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-lg border px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          {/* On a narrow portrait screen only its first letter fitted: there the magnifier says it, and the name stays. */}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents by name or description..." aria-label="Search agents"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground max-sm:portrait:placeholder:text-transparent" />
        </label>
        <Button size="lg" variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => onArchivedChange?.(!archived)}><Archive aria-hidden /> Archived</Button>
      </div>
      {error ? <p className="border p-4 font-mono text-[13px] text-destructive-text" role="alert">{error}</p>
        : !agents ? <ListSkeleton label="Loading the agents" rows={6} />
        : !shown.length ? (
          <div className="rounded-xl border px-4 py-16 text-center">
            <p className="font-mono text-[13px] text-muted-foreground">{q ? "No agent matches." : archived ? "No archived agents." : "No agents yet."}</p>
            {!q && !archived && <a className="mt-4 inline-block text-sm text-primary hover:underline" href="#/agents/new">Describe your agent or start from a template</a>}
          </div>
        ) : (
          <>
            <p className="mb-3 font-mono text-[12px] text-muted-foreground">{shown.length} {shown.length === 1 ? "agent" : "agents"}</p>
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {shown.map((a) => <AgentCard key={a.agent_id} agent={a} actions={actions} />)}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function AgentCard({ agent: a, actions }: { agent: Agent; actions: AgentsListActions }) {
  const Icon = a.kind === "workflow" ? Workflow : Bot;
  const archived = !!a.archived_at;
  return (
    <li className={cn("flex flex-col rounded-xl border p-5 transition-colors hover:border-border-strong", archived && "opacity-70")}>
      <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={() => actions.onOpen?.(a.agent_id)}>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{a.definition.name}</span>
            <Chip>{a.kind}</Chip>
            {a.kind === "agentic" && <Chip>{a.definition.harness ?? "pi"}</Chip>}
            {archived && <Chip tone="muted">Archived</Chip>}
          </span>
          <span className="mt-2 line-clamp-2 block text-sm leading-relaxed text-muted-foreground">{a.definition.description || (a.kind === "workflow" ? workflowShape(a.definition.workflow) : "No description.")}</span>
        </span>
      </button>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
        <span className="caps border px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.revisions} {a.revisions === 1 ? "revision" : "revisions"}</span>

        <span className="flex-1" />
        {!archived && <CodingAgentAction compact compactIcon={<Play className="size-3.5" aria-hidden />} label={`Run ${a.definition.name}`} prompt={runAgentPrompt(location.origin, a.agent_id)} playgroundHref={`#/playground?agent=${encodeURIComponent(a.agent_id)}`} />}
        <CodingAgentAction compact compactIcon={<Pencil className="size-3.5" aria-hidden />} label={`Edit ${a.definition.name}`} prompt={editAgentPrompt(location.origin, a.agent_id)} playgroundHref={`#/playground?operation=edit-agent&agent=${encodeURIComponent(a.agent_id)}`} />
        <Button size="sm" className="gap-1 px-2" variant="outline" aria-label={`Runs of ${a.definition.name}`} onClick={() => actions.onRuns?.(a.agent_id)}><History aria-hidden />{a.runs?.count ?? 0}</Button>
        <Button size="icon" variant="outline" aria-label={`${archived ? "Unarchive" : "Archive"} ${a.definition.name}`} onClick={() => actions.onArchive?.(a.agent_id, !archived)}>
          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        </Button>
      </div>
    </li>
  );
}
