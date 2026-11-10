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
 *  change, and once more when chips ask about ids the names lack. `known` holds the names and kinds; `reads.gone` the
 *  asked ids the newest read didn't hold, of those asked before it began. Every read answers every asked id, so one
 *  found once and deleted later reads gone after the next read that lacks it. Asks made while a read is out wait for one
 *  more read, so a page of many runs whose triggers are gone sends one read, not one per id. Only the newest read begun
 *  lands: one that answers late never puts an older list back. */
export function useTriggerKnown(v2: { listTriggers: () => Promise<{ triggers: Trigger[] }> }, on: boolean, deps: readonly unknown[]): { known: ReadonlyMap<string, TriggerKnown>; reads: TriggerReadsValue } {
  const [known, setKnown] = useState<ReadonlyMap<string, TriggerKnown>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  // Ids a chip asked about, and of those the ones still waiting for a read begun after they were asked.
  const asked = useRef(new Set<string>());
  const waiting = useRef(new Set<string>());
  const asking = useRef(false);
  // Reads are numbered as they begin; an answer lands only when no later one has landed.
  const begun = useRef(0);
  const landed = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useCallback((answered?: () => void) => {
    const n = ++begun.current;
    // Ids asked before this read began: it answers them.
    const these = [...waiting.current];
    return v2.listTriggers().then((r) => {
      if (!mounted.current || n < landed.current) return;
      landed.current = n;
      for (const id of these) waiting.current.delete(id);
      setKnown(new Map(r.triggers.map((t) => [t.id, { name: t.name, kind: t.source.kind }])));
      const held = new Set(r.triggers.map((t) => t.id));
      setGone(new Set([...asked.current].filter((id) => !held.has(id) && !waiting.current.has(id))));
    }, () => {
      // A failed read retries nothing on its own: its ids stop waiting, and the next read (a page change) answers them.
      for (const id of these) waiting.current.delete(id);
    }).finally(answered);
  }, [v2]);
  // One read for every id waiting now; ids asked while it is out wait for the next.
  const readAsked = useCallback(() => {
    if (asking.current || !waiting.current.size) return;
    asking.current = true;
    void read(() => { asking.current = false; if (mounted.current) readAsked(); });
  }, [read]);
  useEffect(() => {
    if (on) void read();
  }, [read, on, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useCallback((id: string) => {
    if (!on || asked.current.has(id)) return;
    asked.current.add(id);
    waiting.current.add(id);
    // Asks made in one render are read together: the read starts once this task's asks are in.
    void Promise.resolve().then(readAsked);
  }, [on, readAsked]);
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
