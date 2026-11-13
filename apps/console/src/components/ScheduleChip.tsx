import { CalendarClock } from "lucide-react";
import { createContext, useContext } from "react";
import { Chip } from "@/components/ui/chip";
import type { Run, TriggerSource } from "@/lib/v2";

/** The triggers' names and kinds (`source.kind`) by id, as the app read them (GET /v2/triggers); empty on a server without
 *  triggers. */
export type TriggerKnown = { name: string; kind: TriggerSource["kind"] };
export const ScheduleNames = createContext<ReadonlyMap<string, TriggerKnown>>(new Map());

/** A trigger kind's word on its runs' chip. */
const KIND_WORD: Record<TriggerSource["kind"], string> = { schedule: "Schedule", webhook: "Webhook", github: "GitHub" };

/** On a run a trigger started (its `trigger`): "<Kind>: <name>", by the trigger's kind in the triggers list ("Schedule:
 *  nightly", "Webhook: inbound-lead"), linking to the trigger. A trigger the list doesn't hold (deleted since, or not read
 *  yet; its runs keep its id) reads "Trigger: <id>". Nothing on any other run. */
export function ScheduleChip({ run }: { run: Pick<Run, "trigger"> }) {
  const known = useContext(ScheduleNames);
  if (!run.trigger) return null;
  const { id } = run.trigger;
  const trigger = known.get(id);
  const label = trigger ? `${KIND_WORD[trigger.kind] ?? "Trigger"}: ${trigger.name}` : `Trigger: ${id}`;
  // Inside a runs-list row, which opens the run on a click: the chip opens the trigger instead.
  return (
    <a href={`#/triggers/${encodeURIComponent(id)}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full" title={label}>
      <Chip className="max-w-full"><CalendarClock className="size-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></Chip>
    </a>
  );
}
