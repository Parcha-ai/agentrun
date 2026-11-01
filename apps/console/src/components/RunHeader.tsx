import { ArrowLeft, Ban, Square } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { cost, isEstimate, when } from "@/lib/format";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";

export type RunActions = { onStop?: () => void; onCancel?: () => void; busy?: "stop" | "cancel" | null };

/** The run's title bar: back to its agent, the title, its status, what it cost so far, and stop versus cancel.
 *  Stop ends the turn and keeps the run open (it waits for a message); cancel ends the run for good, after a confirm. */
export function RunHeader({ run, agentName, actions = {} }: { run: Run; agentName: string; actions?: RunActions }) {
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES, true);
  const [confirming, setConfirming] = useState(false);
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
          <h1 className="break-words text-2xl font-semibold leading-tight">{run.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted-foreground">
            <StatusBadge run={run} />
            <span className="font-mono">{run.kind} · rev {run.agent_version}</span>
            <span className="font-mono">{when(run.created_at)}</span>
            <span className="font-mono" title={run.cost && run.cost.usd !== null && isEstimate(run.cost) ? "A local estimate, not a bill" : undefined}>{cost(run.cost)}</span>
          </div>
        </div>
        {(view.canStop || view.canCancel) && (
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
          </div>
        )}
      </div>
    </header>
  );
}
