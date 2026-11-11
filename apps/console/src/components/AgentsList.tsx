import { Archive, ArchiveRestore, Bot, History, Pencil, Plus, Search, Workflow } from "lucide-react";
import { useState } from "react";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { fieldBoxClass, Input } from "@/components/ui/field";
import type { Agent } from "@/lib/agentForm";
import { waitingOf, waitingWords } from "@/lib/learning";
import { cn } from "@/lib/utils";
import { workflowShape } from "@/lib/workflowDoc";

export type AgentsListActions = { onOpen?: (id: string) => void; onEdit?: (id: string) => void; onNew?: () => void; onRuns?: (id: string) => void; onLearning?: (id: string) => void; onArchive?: (id: string, archive: boolean) => void };

/** The hosted console's agent grid: a search box, the count, and a card per agent (name, kind, harness, what it does,
 *  its revision and runs, and its actions). Archived agents are their own view. */
export function AgentsList({ agents, archived = false, onArchivedChange, actions = {}, error }: { agents: Agent[] | null; archived?: boolean; onArchivedChange?: (archived: boolean) => void; actions?: AgentsListActions; error?: string | null }) {
  const [q, setQ] = useState("");
  const shown = (agents ?? []).filter((a) => `${a.definition.name} ${a.definition.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="p-5 md:p-8">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className={cn("flex h-control-lg min-w-0 flex-1 items-center gap-3 px-3", fieldBoxClass)}>
          <Search className="size-4 text-muted-foreground" aria-hidden />
          {/* On a narrow portrait screen only its first letter fitted: there the magnifier says it, and the name stays. */}
          <Input bare value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents by name or description..." aria-label="Search agents"
            className="flex-1 max-sm:portrait:placeholder:text-transparent" />
        </label>
        <Button size="lg" variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => onArchivedChange?.(!archived)}><Archive aria-hidden /> Archived</Button>
        {!archived && <Button size="lg" variant="primary" onClick={actions.onNew}><Plus aria-hidden /> New agent</Button>}
      </div>
      {error ? <p className="border p-4 font-mono text-body text-destructive-text" role="alert">{error}</p>
        : !agents ? <ListSkeleton label="Loading the agents" rows={6} />
        : !shown.length ? (
          <div className="border px-4 py-12 text-center">
            <p className="font-mono text-body text-muted-foreground">{q ? "No agent matches." : archived ? "No archived agents." : "No agents yet."}</p>
            {!q && !archived && <Button className="mt-4" variant="primary" onClick={actions.onNew}><Plus aria-hidden /> New agent</Button>}
          </div>
        ) : (
          <>
            <p className="mb-3 font-mono text-small text-muted-foreground">{shown.length} {shown.length === 1 ? "agent" : "agents"}</p>
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
  // Its learned items that wait for its owner's OK (the list's own read: each agent's `learning.pending`); nothing at 0.
  const waiting = waitingOf(a);
  return (
    <li className={cn("flex flex-col border p-4", archived && "opacity-70")}>
      <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={() => actions.onOpen?.(a.agent_id)}>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-prose font-semibold">{a.definition.name}</span>
            <Chip>{a.kind}</Chip>
            {a.kind === "agentic" && <Chip>{a.definition.harness ?? "pi"}</Chip>}
            {archived && <Chip tone="muted">Archived</Chip>}
          </span>
          <span className="mt-1.5 line-clamp-2 block font-mono text-small leading-relaxed text-muted-foreground">{a.definition.description || (a.kind === "workflow" ? workflowShape(a.definition.workflow) : "No description.")}</span>
        </span>
      </button>
      {/* The footer: its chips on the left, each on one line, wrapping as whole chips onto more rows there (the first row
          centred on the actions: a 20px chip in 6px above and below is the 32px button's height); its three actions on the
          right, on the first row, never shrunk. Every card's footer reads the same whatever its chips. */}
      <div className="mt-auto flex items-start gap-2 pt-4">
        <div data-testid="agent-card-chips" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5">
          <Chip className="shrink-0 whitespace-nowrap">{a.revisions} {a.revisions === 1 ? "revision" : "revisions"}</Chip>
          {a.runs && <Chip className="shrink-0 whitespace-nowrap">{a.runs.count} {a.runs.count === 1 ? "run" : "runs"}{a.runs.live ? ` · ${a.runs.live} live` : ""}</Chip>}
          {waiting > 0 && (
            <Button size="xs" aria-label={waitingWords(waiting)} onClick={() => actions.onLearning?.(a.agent_id)}
              className="h-5 shrink-0 whitespace-nowrap border-warning/50 bg-warning/10 px-1.5 text-micro text-warning-text hover:bg-warning/20">Learning · {waiting}</Button>
          )}
        </div>
        <div data-testid="agent-card-actions" className="flex shrink-0 items-center gap-2">
          <Button size="icon" variant="outline" className="shrink-0" aria-label={`Edit ${a.definition.name}`} onClick={() => actions.onEdit?.(a.agent_id)}><Pencil aria-hidden /></Button>
          <Button size="icon" variant="outline" className="shrink-0" aria-label={`Runs of ${a.definition.name}`} onClick={() => actions.onRuns?.(a.agent_id)}><History aria-hidden /></Button>
          <Button size="icon" variant="outline" className="shrink-0" aria-label={`${archived ? "Unarchive" : "Archive"} ${a.definition.name}`} onClick={() => actions.onArchive?.(a.agent_id, !archived)}>
            {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          </Button>
        </div>
      </div>
    </li>
  );
}
