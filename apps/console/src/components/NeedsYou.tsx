import { MessageCircleQuestion, Pause } from "lucide-react";
import type { TimelineRow } from "@/lib/v2";

/** What a run that waits for a person shows above the composer: the agent's question (input required) or that the turn
 *  was stopped and the run waits for the next message. The two read differently on purpose. */
export function NeedsYou({ waiting }: { waiting: TimelineRow | null }) {
  if (waiting) {
    const question = (waiting.text ?? waiting.summary).replace(/^Waiting for you:\s*/, "");
    return (
      <section className="border border-warning/50 bg-warning/5 p-4" aria-label="The agent asks">
        <p className="caps flex items-center gap-2 text-[11px] text-warning-text"><MessageCircleQuestion className="size-3.5" aria-hidden /> Input required</p>
        <p className="mt-2 text-[15px] leading-relaxed">{question}</p>
      </section>
    );
  }
  return (
    <section className="border border-border-strong/60 p-4" aria-label="Stopped">
      <p className="caps flex items-center gap-2 text-[11px] text-muted-foreground"><Pause className="size-3.5" aria-hidden /> Stopped</p>
      <p className="mt-2 text-[14px] text-muted-foreground">The turn was stopped. The run stays open: send a message to continue it.</p>
    </section>
  );
}
