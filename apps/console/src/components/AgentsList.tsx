import { Archive, ArchiveRestore, Bot, History, Pencil, Plus, Search, Workflow } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import type { Agent } from "@/lib/agentForm";
import { cn } from "@/lib/utils";
import { workflowShape } from "@/lib/workflowDoc";

export type AgentsListActions = { onOpen?: (id: string) => void; onEdit?: (id: string) => void; onNew?: () => void; onRuns?: (id: string) => void; onArchive?: (id: string, archive: boolean) => void };

/** The hosted console's agent grid: a search box, the count, and a card per agent (name, kind, harness, what it does,
 *  its revision and runs, and its actions). Archived agents are their own view. */
export function AgentsList({ agents, archived = false, onArchivedChange, actions = {}, error }: { agents: Agent[] | null; archived?: boolean; onArchivedChange?: (archived: boolean) => void; actions?: AgentsListActions; error?: string | null }) {
  const [q, setQ] = useState("");
  const shown = (agents ?? []).filter((a) => `${a.definition.name} ${a.definition.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="p-5 md:p-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-3 border px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents by name or description..." aria-label="Search agents"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
        </label>
        <Button size="lg" variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => onArchivedChange?.(!archived)}><Archive aria-hidden /> Archived</Button>
        {!archived && <Button size="lg" variant="primary" onClick={actions.onNew}><Plus aria-hidden /> New agent</Button>}
      </div>
      {error ? <p className="border p-4 font-mono text-[13px] text-destructive-text" role="alert">{error}</p>
        : !agents ? <p className="py-12 text-center font-mono text-[13px] text-muted-foreground">Loading agents...</p>
        : !shown.length ? (
          <div className="border px-4 py-12 text-center">
            <p className="font-mono text-[13px] text-muted-foreground">{q ? "No agent matches." : archived ? "No archived agents." : "No agents yet."}</p>
            {!q && !archived && <Button className="mt-4" variant="primary" onClick={actions.onNew}><Plus aria-hidden /> New agent</Button>}
          </div>
        ) : (
          <>
            <p className="mb-3 font-mono text-[12px] text-muted-foreground">{shown.length} {shown.length === 1 ? "agent" : "agents"}</p>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((a) => <AgentCard key={a.agent_id} agent={a} actions={actions} />)}
            </ul>
          </>
        )}
    </div>
  );
}

function AgentCard({ agent: a, actions }: { agent: Agent; actions: AgentsListActions }) {
  const Icon = a.kind === "workflow" ? Workflow : Bot;
  const archived = !!a.archived_at;
  return (
    <li className={cn("flex flex-col border p-4", archived && "opacity-70")}>
      <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={() => actions.onOpen?.(a.agent_id)}>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-semibold">{a.definition.name}</span>
            <Chip>{a.kind}</Chip>
            {a.kind === "agentic" && <Chip>{a.definition.harness ?? "pi"}</Chip>}
            {archived && <Chip tone="muted">Archived</Chip>}
          </span>
          <span className="mt-1.5 line-clamp-2 block font-mono text-[12px] leading-relaxed text-muted-foreground">{a.definition.description || (a.kind === "workflow" ? workflowShape(a.definition.workflow) : "No description.")}</span>
        </span>
      </button>
      <div className="mt-auto flex items-center gap-2 pt-4">
        <span className="caps border px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.revisions} {a.revisions === 1 ? "revision" : "revisions"}</span>
        {a.runs && <span className="caps border px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.runs.count} {a.runs.count === 1 ? "run" : "runs"}{a.runs.live ? ` · ${a.runs.live} live` : ""}</span>}
        <span className="flex-1" />
        <Button size="icon" variant="outline" aria-label={`Edit ${a.definition.name}`} onClick={() => actions.onEdit?.(a.agent_id)}><Pencil aria-hidden /></Button>
        <Button size="icon" variant="outline" aria-label={`Runs of ${a.definition.name}`} onClick={() => actions.onRuns?.(a.agent_id)}><History aria-hidden /></Button>
        <Button size="icon" variant="outline" aria-label={`${archived ? "Unarchive" : "Archive"} ${a.definition.name}`} onClick={() => actions.onArchive?.(a.agent_id, !archived)}>
          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        </Button>
      </div>
    </li>
  );
}
