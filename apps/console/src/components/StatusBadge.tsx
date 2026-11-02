import { Ban, Check, CircleAlert, CircleArrowUp, CirclePause, Eye, Loader, MessageCircleQuestion, Pause } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";

const ICON = { Queued: Loader, Working: Loader, Completed: Check, Failed: CircleAlert, Escalated: CircleArrowUp, "Needs review": Eye, Cancelled: Ban, "Input required": MessageCircleQuestion, Stopped: Pause, Paused: CirclePause };

/** The run's status as a chip: the label the console gives serve's status and state (and its error's code, for a run
 *  that ended escalated, and its review, for one that waits for a person). */
export function StatusBadge({ run }: { run: Pick<Run, "status" | "state" | "kind"> & Partial<Pick<Run, "error" | "review">> }) {
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error, run.review);
  const Icon = ICON[view.label as keyof typeof ICON];
  return (
    <Chip tone={view.tone}>
      <Icon className={view.live ? "size-3 animate-spin [animation-duration:2s]" : "size-3"} aria-hidden />
      {view.label}
    </Chip>
  );
}
