import { queryPlaygroundHref } from "@/lib/playgroundRoutes";
import { Archive, ArrowUpRight, History } from "lucide-react";
import { ProblemCard } from "@/components/Problem";
import { ScheduleChip } from "@/components/ScheduleChip";
import { ListSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import type { RunsFilter } from "@/lib/client";
import { cost, when } from "@/lib/format";
import type { Problem } from "@/lib/problem";
import type { Run, RunStatus } from "@/lib/v2";
import { CodingAgentAction } from "@/components/CodingAgentAction";
import { queryRunsPrompt } from "@/lib/codingAgentPrompts";

/** The statuses GET /v2/runs filters by, in the order a run moves through them. */
export const RUN_STATUSES: readonly RunStatus[] = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"];
const STATUS_LABEL: Record<RunStatus, string> = { queued: "Queued", working: "Working", paused: "Paused", input_required: "Input required", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

/** Every run on the server, newest first, as the hosted console's history table, with the status column it leaves out
 *  at desktop width. A row opens its run. With `onFilter`, a state filter and the archived runs, as the address keeps them.
 *  A read that failed says so in words, with Try again (`onRetry`); a failed Load more keeps the rows above it. */
export function RunsList({ runs, agentName, onOpen, error, onRetry, onMore, loadingMore, filter = {}, onFilter, agentId }: { runs: Run[] | null; agentName: (id: string) => string; onOpen: (id: string) => void; error?: Problem | null; onRetry?: () => void; onMore?: () => void; loadingMore?: boolean; filter?: RunsFilter; onFilter?: (filter: RunsFilter) => void; agentId?: string }) {
  const archived = !!filter.archived;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2 md:px-6">
        <h1 className="caps mr-auto flex items-center gap-2.5 text-[12px] font-semibold"><History className="size-4" aria-hidden />{archived ? "Archived runs" : "Runs"}</h1>
        {onFilter && (
          <>
            <select aria-label="Runs in one state" value={filter.status ?? ""} onChange={(e) => onFilter({ ...filter, status: (e.target.value || undefined) as RunStatus | undefined })}
              className="h-8 rounded-lg border bg-background px-3 text-[12px]">
              <option value="">Any state</option>
              {RUN_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <Button size="sm" variant={archived ? "primary" : "outline"} aria-pressed={archived} onClick={() => onFilter({ ...filter, archived: !archived })}><Archive aria-hidden /> Archived</Button>
          </>
        )}
        <CodingAgentAction label="Query" prompt={`${queryRunsPrompt(location.origin, agentId)}\nCurrent view: ${filter.status ? `status ${filter.status}` : "all statuses"}; ${archived ? "archived runs" : "non-archived runs"}.`} playgroundHref={queryPlaygroundHref(agentId, filter)} />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
      {error && !runs ? <ProblemCard problem={error} onRetry={onRetry} className="" />
        : !runs ? <ListSkeleton label="Loading the runs" />
        : !runs.length ? <p className="px-4 py-16 text-center text-[13px] text-muted-foreground">{filter.status ? "No run matches." : archived ? "No archived runs." : "No runs yet."}</p>
        : <RunsTable runs={runs} agentName={agentName} onOpen={onOpen} />}
      {runs && error && <ProblemCard problem={error} className="mt-4" />}
      {runs && onMore && <div className="flex justify-center p-4"><Button type="button" size="sm" onClick={onMore} disabled={loadingMore}>{loadingMore ? "Loading" : "Load more"}</Button></div>}
      </div>
    </div>
  );
}

function RunsTable({ runs, agentName, onOpen }: { runs: Run[]; agentName: (id: string) => string; onOpen: (id: string) => void }) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead className="sticky top-0 z-10 hidden bg-background md:table-header-group">
        <tr className="caps text-[11px] text-muted-foreground">
          {["Status", "Run", "Agent", "Kind", "Started", "Cost"].map((h) => <th key={h} className="border-b border-r px-4 py-3 text-left font-normal last:border-r-0">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.run_id} className="cursor-pointer border-b hover:bg-accent" onClick={() => onOpen(r.run_id)}>
            <td className="px-3 py-2.5 align-top"><StatusBadge run={r} /></td>
            <td className="px-3 py-2.5 align-top">
              <button type="button" className="flex items-start gap-1 text-left" onClick={(e) => { e.stopPropagation(); onOpen(r.run_id); }}>
                <span className="line-clamp-2">{r.title}</span><ArrowUpRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
              </button>
              {r.status === "completed" && r.review && <span className="mt-1 block text-[12px] text-warning-text">{r.review.reason}</span>}
              {r.trigger && <span className="mt-1 flex"><ScheduleChip run={r} /></span>}
              <span className="mt-1 block font-mono text-[11px] text-muted-foreground md:hidden">{agentName(r.agent_id)} · {when(r.created_at)}</span>
            </td>
            <td className="hidden px-3 py-2.5 align-top md:table-cell">{agentName(r.agent_id)}</td>
            <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{r.kind}</td>
            <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{when(r.created_at)}</td>
            <td className="hidden px-3 py-2.5 align-top font-mono text-[12px] text-muted-foreground md:table-cell">{cost(r.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
