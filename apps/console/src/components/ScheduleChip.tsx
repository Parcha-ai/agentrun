import { CalendarClock } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run, TimelineRow, Trigger, TriggerSource } from "@/lib/v2";

/** The triggers' names and kinds (`source.kind`) by id, as the app read them (GET /v2/triggers); empty on a server without
 *  triggers. */
export type TriggerKnown = { name: string; kind: TriggerSource["kind"] };
export const ScheduleNames = createContext<ReadonlyMap<string, TriggerKnown>>(new Map());

/** A trigger's kind as a run's own trigger row serves it (`trigger.source`): the run page knows it of a deleted one. */
export type TriggerKind = NonNullable<TimelineRow["trigger"]>["source"];

/** The triggers a fresh read, asked for by a chip (`ask`), didn't find: deleted since. A chip whose trigger the names lack
 *  asks once; until that read answers it names the id, and only after it calls the trigger deleted, so a trigger made
 *  since the app's last read is never called deleted. */
export type TriggerReadsValue = { gone: ReadonlySet<string>; ask: (id: string) => void };
export const TriggerReads = createContext<TriggerReadsValue>({ gone: new Set(), ask: () => {} });

/** The app's read of the triggers (the whole list, GET /v2/triggers, not paged): read when `on` and again whenever `deps`
 *  change, and once more for each id a chip asks about. `known` holds the names and kinds; `reads.gone` the asked ids the
 *  fresh read didn't hold. */
export function useTriggerKnown(v2: { listTriggers: () => Promise<{ triggers: Trigger[] }> }, on: boolean, deps: readonly unknown[]): { known: ReadonlyMap<string, TriggerKnown>; reads: TriggerReadsValue } {
  const [known, setKnown] = useState<ReadonlyMap<string, TriggerKnown>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const take = (triggers: Trigger[]) => setKnown(new Map(triggers.map((t) => [t.id, { name: t.name, kind: t.source.kind }])));
  useEffect(() => {
    if (!on) return;
    let live = true;
    v2.listTriggers().then((r) => { if (live) take(r.triggers); }, () => {});
    return () => { live = false; };
  }, [v2, on, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useCallback((id: string) => {
    if (!on || asked.current.has(id)) return;
    asked.current.add(id);
    // A read that fails asks nothing more of this id now; the next page change reads the list again.
    v2.listTriggers().then((r) => {
      if (!mounted.current) return;
      take(r.triggers);
      if (!r.triggers.some((t) => t.id === id)) setGone((g) => new Set(g).add(id));
    }, () => {});
  }, [v2, on]);
  return { known, reads: { gone, ask } };
}

/** A trigger kind's word on its runs' chip. */
const KIND_WORD: Record<TriggerKind, string> = { schedule: "Schedule", webhook: "Webhook", github: "GitHub", slack: "Slack" };

/** On a run a trigger started (its `trigger`): "<Kind>: <name>", by the trigger's kind in the triggers list ("Schedule:
 *  nightly", "Webhook: inbound-lead"), linking to the trigger. One the list doesn't hold names its id ("Trigger: <id>")
 *  and asks for a fresh read; once that read doesn't find it either, it reads "<Kind> deleted" (by `kind`, the run's own
 *  trigger row's, where the run page has it; else "Trigger deleted") and links nowhere: its page would answer 404.
 *  Nothing on any other run. */
export function ScheduleChip({ run, kind }: { run: Pick<Run, "trigger">; kind?: TriggerKind }) {
  const known = useContext(ScheduleNames);
  const { gone, ask } = useContext(TriggerReads);
  const id = run.trigger?.id;
  const trigger = id ? known.get(id) : undefined;
  useEffect(() => { if (id && !trigger) ask(id); }, [id, trigger, ask]);
  if (!id) return null;
  if (!trigger && gone.has(id)) {
    const label = `${kind ? KIND_WORD[kind] : "Trigger"} deleted`;
    return <span data-trigger-chip className="inline-flex max-w-full" title={`${label}: ${id}`}><Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip></span>;
  }
  const label = trigger ? `${KIND_WORD[trigger.kind] ?? "Trigger"}: ${trigger.name}` : `Trigger: ${id}`;
  // Inside a runs-list row, which opens the run on a click: the chip opens the trigger instead.
  return (
    <a data-trigger-chip href={`#/triggers/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>
      <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>
    </a>
  );
}
