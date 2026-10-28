import { Ban, Check, CircleAlert, Loader, MessageCircleQuestion, Pause } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { NO_MESSAGES, runState } from "@/lib/runState";
import type { Run } from "@/lib/v2";

const ICON = { Queued: Loader, Working: Loader, Completed: Check, Failed: CircleAlert, Cancelled: Ban, "Input required": MessageCircleQuestion, Stopped: Pause };

/** The run's status as a chip: the label the console gives serve's status and state. */
export function StatusBadge({ run }: { run: Pick<Run, "status" | "state" | "kind"> }) {
  const view = runState(run.status, run.state, run.kind, NO_MESSAGES);
  const Icon = ICON[view.label as keyof typeof ICON];
  return (
    <Chip tone={view.tone}>
      <Icon className={view.live ? "size-3 animate-spin [animation-duration:2s]" : "size-3"} aria-hidden />
      {view.label}
    </Chip>
  );
}
