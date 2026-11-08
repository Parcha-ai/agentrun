import { CalendarClock } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run } from "@/lib/v2";

/** The triggers the app knows: their names and kinds by id (GET /v2/triggers, the whole list; a kind is its
 *  `source.kind`), `gone`, the ids a read made after a chip asked about them did not find (deleted), and `ask`, which a chip
 *  calls for an id the names lack: the app reads the list again, so a trigger made since (another tab) is never taken for a
 *  deleted one. */
export type ScheduleKnown = { names: ReadonlyMap<string, string>; kinds: ReadonlyMap<string, string>; gone: ReadonlySet<string>; ask: (id: string) => void };
export const ScheduleNames = createContext<ScheduleKnown>({ names: new Map(), kinds: new Map(), gone: new Set(), ask: () => {} });

/** A trigger kind's word on its runs' chip; a kind this console doesn't name reads "Trigger". */
const KIND_WORD: Readonly<Record<string, string>> = { schedule: "Schedule", webhook: "Webhook", slack: "Slack", github: "GitHub" };
const kindWord = (kind: string | undefined) => (kind !== undefined && Object.prototype.hasOwnProperty.call(KIND_WORD, kind) ? KIND_WORD[kind]! : "Trigger");

/** What the app knows of its schedules, for their chips: the list read where the server has schedules (`scheduling`),
 *  again whenever `refresh` changes (a page change); and `ask`, a fresh read for an id a chip found missing. An id that
 *  read does not find is `gone` (deleted). Only a read under way blocks another ask for the same id: one found and deleted
 *  later is asked about again, and an ask made before schedules can be read is made again once they can (`ask` changes). */
export function useScheduleKnown(v2: { listTriggers: () => Promise<{ triggers: { id: string; name: string; source: { kind: string } }[] }> }, scheduling: boolean, refresh: readonly unknown[]): ScheduleKnown {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [kinds, setKinds] = useState<ReadonlyMap<string, string>>(new Map());
  const take = (triggers: { id: string; name: string; source: { kind: string } }[]) => {
    setNames(new Map(triggers.map((t) => [t.id, t.name])));
    setKinds(new Map(triggers.map((t) => [t.id, t.source.kind])));
  };
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const asking = useRef(new Set<string>());
  useEffect(() => {
    if (!scheduling) return;
    let live = true;
    v2.listTriggers().then((r) => { if (live) take(r.triggers); }, () => {});
    return () => { live = false; };
  }, [v2, scheduling, ...refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useCallback((id: string) => {
    if (!scheduling || asking.current.has(id)) return;
    asking.current.add(id);
    // A read made now: a schedule it finds gets its name; one it doesn't was deleted (the list is the whole set, not paged).
    v2.listTriggers().then((r) => {
      asking.current.delete(id);
      take(r.triggers);
      if (!r.triggers.some((t) => t.id === id)) setGone((g) => new Set(g).add(id));
    }, () => { asking.current.delete(id); });
  }, [v2, scheduling]);
  return useMemo(() => ({ names, kinds, gone, ask }), [names, kinds, gone, ask]);
}

/** On a run a trigger started (its `trigger`): "<Kind>: <name>", by the trigger's kind (the triggers list's, else
 *  `source`, the run's own trigger row's where its page has it): "Schedule: nightly", "Webhook: inbound-leads". Only a
 *  schedule links to its page (the Schedules page shows schedules alone). An id the names lack is asked about (a fresh read
 *  of the list): until it answers, the chip names the id with no link; one the fresh read did not find either (deleted
 *  since; its runs keep its id) says "<Kind> deleted", or "Trigger deleted" where its kind isn't known, and links nowhere.
 *  Nothing on any other run. */
export function ScheduleChip({ run, source }: { run: Pick<Run, "trigger">; source?: string }) {
  const { names, kinds, gone, ask } = useContext(ScheduleNames);
  const id = run.trigger?.id;
  const unknown = id !== undefined && !names.has(id) && !gone.has(id);
  // Again when `ask` changes: an ask made before triggers could be read (capabilities not read yet) did nothing.
  useEffect(() => { if (unknown) ask(id!); }, [unknown, id, ask]); // eslint-disable-line react-hooks/exhaustive-deps
  if (id === undefined) return null;
  const kind = kinds.get(id) ?? source;
  const word = kindWord(kind);
  if (gone.has(id)) {
    return (
      <span className="inline-flex max-w-full" title={`The trigger that started this run (${id}) was deleted.`}>
        <Chip tone="muted" className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{word} deleted</span></Chip>
      </span>
    );
  }
  const label = `${word}: ${names.get(id) ?? id}`;
  const chip = <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>;
  if (kind !== "schedule") return <span className="inline-flex max-w-full" title={label}>{chip}</span>;
  // Inside a runs-list row, which opens the run on a click: the chip opens the schedule instead.
  return (
    <a href={`#/schedules/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>{chip}</a>
  );
}
