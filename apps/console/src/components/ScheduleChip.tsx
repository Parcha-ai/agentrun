import { CalendarClock } from "lucide-react";
import { createContext, useContext } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run } from "@/lib/v2";

/** The schedules' names by id, as the app read them once (GET /v2/triggers); empty on a server without schedules. */
export const ScheduleNames = createContext<ReadonlyMap<string, string>>(new Map());

/** On a run a schedule started (its `trigger`): "Schedule: <name>", linking to the schedule. The name is the one the
 *  schedules list holds, else the id (a schedule deleted since keeps its id on its runs). Nothing on any other run. */
export function ScheduleChip({ run }: { run: Pick<Run, "trigger"> }) {
  const names = useContext(ScheduleNames);
  if (!run.trigger) return null;
  const { id } = run.trigger;
  const label = `Schedule: ${names.get(id) ?? id}`;
  // Inside a runs-list row, which opens the run on a click: the chip opens the schedule instead.
  return (
    <a href={`#/schedules/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>
      <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>
    </a>
  );
}
