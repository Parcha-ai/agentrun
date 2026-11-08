import { CalendarClock } from "lucide-react";
import { createContext, useContext } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run } from "@/lib/v2";

/** The schedules' names by id, as the app read them (GET /v2/triggers, the whole list); null until that read lands. */
export const ScheduleNames = createContext<ReadonlyMap<string, string> | null>(null);

/** On a run a schedule started (its `trigger`): "Schedule: <name>", linking to the schedule. A schedule absent from the
 *  server's list (deleted since; its runs keep its id) says "Schedule deleted" and links nowhere: its page would be a 404.
 *  Until the list is read, the chip names the id and links to it. Nothing on any other run. */
export function ScheduleChip({ run }: { run: Pick<Run, "trigger"> }) {
  const names = useContext(ScheduleNames);
  if (!run.trigger) return null;
  const { id } = run.trigger;
  if (names && !names.has(id)) {
    return (
      <span className="inline-flex max-w-full" title={`The schedule that started this run (${id}) was deleted.`}>
        <Chip tone="muted" className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">Schedule deleted</span></Chip>
      </span>
    );
  }
  const label = `Schedule: ${names?.get(id) ?? id}`;
  // Inside a runs-list row, which opens the run on a click: the chip opens the schedule instead.
  return (
    <a href={`#/schedules/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>
      <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>
    </a>
  );
}
