import { Archive, ArchiveRestore, ArrowLeft, Ban, Square } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { cost, isEstimate, when } from "@/lib/format";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";

export type RunActions = { onStop?: () => void; onCancel?: () => void; onArchive?: () => void; busy?: "stop" | "cancel" | "archive" | null };

/** The run's title bar: back to its agent, the title, its status, what it cost so far, stop versus cancel, and archive.
 *  Stop ends the turn and keeps the run open (it waits for a message); cancel ends the run for good, after a confirm.
 *  Archive hides the run from the runs list and keeps it; the server takes it in any state, as serve's own page offers it. */
export function RunHeader({ run, agentName, actions = {}, costText }: { run: Run; agentName: string; actions?: RunActions; costText?: string }) {
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error);
  const [confirming, setConfirming] = useState(false);
  const archived = !!run.archived_at;
  return (
    <header className="border-b px-5 py-4 md:px-8">
      <nav className="caps flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground" aria-label="Breadcrumb">
        <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{agentName}</span>
        <span aria-hidden>/</span>
        <span className="truncate">Run {run.run_id.slice(0, 8)}</span>
      </nav>
      <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-3 sm:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          {/* A workflow run's title can be its input as JSON: then the agent's name reads better. */}
          <h1 className="break-words text-2xl font-semibold leading-tight" title={run.title}>{run.kind === "workflow" && /^[[{]/.test(run.title.trim()) ? agentName : run.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted-foreground">
            <StatusBadge run={run} />
            {archived && <Chip tone="muted">Archived</Chip>}
            <span className="font-mono">{run.kind} · rev {run.agent_version}</span>
            <span className="font-mono">{when(run.created_at)}</span>
            {/* A workflow run's cost is its graph's totals (`costText`), the same the totals bar shows. */}
            {costText !== undefined ? <span className="font-mono" title="The run's decisions and model calls, as the providers priced them">{costText}</span>
              : <span className="font-mono" title={run.cost && run.cost.usd !== null && isEstimate(run.cost) ? "A local estimate, not a bill" : undefined}>{cost(run.cost)}</span>}
          </div>
        </div>
        {(view.canStop || view.canCancel || actions.onArchive) && (
          <div className="flex shrink-0 items-center gap-2">
            {view.canStop && (
              <Button size="sm" onClick={actions.onStop} disabled={!actions.onStop || !!actions.busy} title="End this turn. The run stays open and waits for your next message.">
                <Square aria-hidden /> {actions.busy === "stop" ? "Stopping" : "Stop"}
              </Button>
            )}
            {view.canCancel && !confirming && (
              <Button size="sm" variant="destructive" onClick={() => setConfirming(true)} disabled={!actions.onCancel || !!actions.busy} title="End the run for good.">
                <Ban aria-hidden /> {actions.busy === "cancel" ? "Cancelling" : "Cancel run"}
              </Button>
            )}
            {confirming && (
              <span className="flex items-center gap-2 border border-destructive/50 px-2 py-1 text-[12px]" role="alertdialog" aria-label="Cancel this run?">
                <span>Cancel for good?</span>
                <Button size="sm" variant="destructive" onClick={() => { setConfirming(false); actions.onCancel?.(); }}>Yes, cancel</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
              </span>
            )}
            {actions.onArchive && (
              <Button size="sm" onClick={actions.onArchive} disabled={!!actions.busy} title={archived ? "Show it in the runs list again." : "Hide it from the runs list. Its history is kept."}>
                {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />} {actions.busy === "archive" ? (archived ? "Unarchiving" : "Archiving") : archived ? "Unarchive" : "Archive"}
              </Button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
