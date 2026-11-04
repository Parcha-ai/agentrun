import { Archive, ArchiveRestore, ArrowLeft, Ban, Square } from "lucide-react";
import { useState } from "react";
import { agentHash } from "@/components/AgentPage";
import { LearningChips } from "@/components/LearningChips";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { goBack } from "@/lib/back";
import { cost, isEstimate, runLabel, soFar, soFarNote, when } from "@/lib/format";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";
import { placeOf, runPlaceWords } from "@/lib/place";

export type RunActions = { onStop?: () => void; onCancel?: () => void; onArchive?: () => void; busy?: "stop" | "cancel" | "archive" | null };

/** The cost's hover note: a known estimate is not a bill; a cost known so far is not the whole cost. */
const costTitle = (c: Run["cost"]): string | undefined => {
  const known = soFar(c);
  if (known) return soFarNote(known);
  return c && c.usd !== null && isEstimate(c) ? "A local estimate, not a bill" : undefined;
};

/** The run's title bar: back to its agent, the title, its status, what it cost so far, stop versus cancel, and archive.
 *  Stop ends the turn and keeps the run open (it waits for a message); cancel ends the run for good, after a confirm.
 *  Archive hides the run from the runs list and keeps it; the server takes it in any state, as serve's own page offers it. */
export function RunHeader({ run, agentName, actions = {}, costText }: { run: Run; agentName: string; actions?: RunActions; costText?: string }) {
  // Where it ran, as its start resolved it.
  const ranIn = runPlaceWords(placeOf((run as { place?: unknown }).place));
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error, run.review);
  const [confirming, setConfirming] = useState(false);
  const archived = !!run.archived_at;
  return (
    <header className="border-b px-5 py-4 md:px-8">
      <nav className="caps flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground" aria-label="Breadcrumb">
        {/* Back where the person came from in the console (the runs list, the agent's page), else to the run's agent. */}
        <button type="button" aria-label="Back" title="Back" onClick={() => goBack(agentHash(run.agent_id))} className="-m-1 shrink-0 p-1 hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
        </button>
        <a href={agentHash(run.agent_id)} className="truncate hover:text-foreground hover:underline">{agentName}</a>
        <span aria-hidden>/</span>
        <span className="truncate">Run {runLabel(run.run_id)}</span>
      </nav>
      <div className="mt-3 flex flex-col items-start gap-x-6 gap-y-3 sm:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          {/* A workflow run's title can be its input as JSON: then the agent's name reads better. */}
          <h1 className="break-words text-2xl font-semibold leading-tight" title={run.title}>{run.kind === "workflow" && /^[[{]/.test(run.title.trim()) ? agentName : run.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted-foreground">
            <StatusBadge run={run} />
            {archived && <Chip tone="muted">Archived</Chip>}
            <span className="font-mono">{run.kind} · rev {run.agent_version}{ranIn && ` · ${ranIn}`}</span>
            <span className="font-mono">{when(run.created_at)}</span>
            {/* A workflow run's cost is its graph's totals (`costText`), the same the totals bar shows. */}
            {costText !== undefined ? <span className="font-mono" title="The run's decisions and model calls, as the providers priced them">{costText}</span>
              : <span className="font-mono" title={costTitle(run.cost)}>{cost(run.cost)}</span>}
            <LearningChips run={run} link />
          </div>
          {run.status === "completed" && run.review && <p className="mt-2 text-[13px] text-warning-text">Needs review: {run.review.reason}</p>}
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
