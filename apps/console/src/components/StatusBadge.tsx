import { Ban, Check, CircleAlert, CircleArrowUp, CirclePause, Eye, Loader, MessageCircleQuestion, Pause } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";

const ICON = { Queued: Loader, Starting: Loader, Working: Loader, Completed: Check, Failed: CircleAlert, Escalated: CircleArrowUp, "Needs review": Eye, Cancelled: Ban, "Input required": MessageCircleQuestion, Stopped: Pause, Paused: CirclePause };

/** The run's status as a chip: the label the console gives serve's status and state (and its error's code, for a run
 *  that ended escalated, its review, for one that waits for a person, and its computer, for one whose desktop or phone
 *  is starting). `lookingBack`: a finished run its grade opened again on a look-back (RunDetail's lookingBackOn), served as working:
 *  it says that, never that the job works. */
export function StatusBadge({ run, lookingBack = false }: { run: Pick<Run, "status" | "state" | "kind"> & Partial<Pick<Run, "error" | "review" | "computer">>; lookingBack?: boolean }) {
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES, true, run.error, run.review, run.computer);
  const label = lookingBack ? "Learning from your grade" : view.label;
  const Icon = lookingBack ? Loader : ICON[view.label as keyof typeof ICON];
  return (
    <Chip tone={lookingBack ? "active" : view.tone}>
      <Icon className={view.live ? "size-3 animate-spin [animation-duration:2s]" : "size-3"} aria-hidden />
      {label}
    </Chip>
  );
}
