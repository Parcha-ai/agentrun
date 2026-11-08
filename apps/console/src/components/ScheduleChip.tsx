import { CalendarClock } from "lucide-react";
import { createContext, useContext, useEffect } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run } from "@/lib/v2";

/** The schedules the app knows: their names by id (GET /v2/triggers, the whole list), `gone`, the ids a read made after a
 *  chip asked about them did not find (deleted), and `ask`, which a chip calls for an id the names lack: the app reads the
 *  list again, so a schedule made since (another tab) is never taken for a deleted one. */
export type ScheduleKnown = { names: ReadonlyMap<string, string>; gone: ReadonlySet<string>; ask: (id: string) => void };
export const ScheduleNames = createContext<ScheduleKnown>({ names: new Map(), gone: new Set(), ask: () => {} });

/** On a run a schedule started (its `trigger`): "Schedule: <name>", linking to the schedule. One the names lack is asked
 *  about (a fresh read of the list): until that read answers, the chip names the id and links to it; a schedule the fresh
 *  read did not find either (deleted since; its runs keep its id) says "Schedule deleted" and links nowhere, as its page
 *  would be a 404. Nothing on any other run. */
export function ScheduleChip({ run }: { run: Pick<Run, "trigger"> }) {
  const { names, gone, ask } = useContext(ScheduleNames);
  const id = run.trigger?.id;
  const unknown = id !== undefined && !names.has(id) && !gone.has(id);
  useEffect(() => { if (unknown) ask(id!); }, [unknown, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (id === undefined) return null;
  if (gone.has(id)) {
    return (
      <span className="inline-flex max-w-full" title={`The schedule that started this run (${id}) was deleted.`}>
        <Chip tone="muted" className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">Schedule deleted</span></Chip>
      </span>
    );
  }
  const label = `Schedule: ${names.get(id) ?? id}`;
  // Inside a runs-list row, which opens the run on a click: the chip opens the schedule instead.
  return (
    <a href={`#/schedules/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>
      <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>
    </a>
  );
}
