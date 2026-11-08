import { CalendarClock } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run } from "@/lib/v2";

/** The schedules the app knows: their names by id (GET /v2/triggers, the whole list), `gone`, the ids a read made after a
 *  chip asked about them did not find (deleted), and `ask`, which a chip calls for an id the names lack: the app reads the
 *  list again, so a schedule made since (another tab) is never taken for a deleted one. */
export type ScheduleKnown = { names: ReadonlyMap<string, string>; gone: ReadonlySet<string>; ask: (id: string) => void };
export const ScheduleNames = createContext<ScheduleKnown>({ names: new Map(), gone: new Set(), ask: () => {} });

/** What the app knows of its schedules, for their chips: the list read where the server has schedules (`scheduling`),
 *  again whenever `refresh` changes (a page change); and `ask`, a fresh read for an id a chip found missing. An id that
 *  read does not find is `gone` (deleted). Only a read under way blocks another ask for the same id: one found and deleted
 *  later is asked about again, and an ask made before schedules can be read is made again once they can (`ask` changes). */
export function useScheduleKnown(v2: { listTriggers: () => Promise<{ triggers: { id: string; name: string }[] }> }, scheduling: boolean, refresh: readonly unknown[]): ScheduleKnown {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const asking = useRef(new Set<string>());
  useEffect(() => {
    if (!scheduling) return;
    let live = true;
    v2.listTriggers().then((r) => { if (live) setNames(new Map(r.triggers.map((t) => [t.id, t.name]))); }, () => {});
    return () => { live = false; };
  }, [v2, scheduling, ...refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useCallback((id: string) => {
    if (!scheduling || asking.current.has(id)) return;
    asking.current.add(id);
    // A read made now: a schedule it finds gets its name; one it doesn't was deleted (the list is the whole set, not paged).
    v2.listTriggers().then((r) => {
      asking.current.delete(id);
      setNames(new Map(r.triggers.map((t) => [t.id, t.name])));
      if (!r.triggers.some((t) => t.id === id)) setGone((g) => new Set(g).add(id));
    }, () => { asking.current.delete(id); });
  }, [v2, scheduling]);
  return useMemo(() => ({ names, gone, ask }), [names, gone, ask]);
}

/** On a run a schedule started (its `trigger`): "Schedule: <name>", linking to the schedule. One the names lack is asked
 *  about (a fresh read of the list): until that read answers, the chip names the id and links to it; a schedule the fresh
 *  read did not find either (deleted since; its runs keep its id) says "Schedule deleted" and links nowhere, as its page
 *  would be a 404. Nothing on any other run. */
export function ScheduleChip({ run }: { run: Pick<Run, "trigger"> }) {
  const { names, gone, ask } = useContext(ScheduleNames);
  const id = run.trigger?.id;
  const unknown = id !== undefined && !names.has(id) && !gone.has(id);
  // Again when `ask` changes: an ask made before schedules could be read (capabilities not read yet) did nothing.
  useEffect(() => { if (unknown) ask(id!); }, [unknown, id, ask]); // eslint-disable-line react-hooks/exhaustive-deps
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
