import { CircleDollarSign, MessageCircleQuestion, Pause } from "lucide-react";
import type { BudgetPending, TimelineRow } from "@/lib/v2";

/** A cap in dollars as the server words it: two decimals, or as many as it takes (up to eight) to show it whole. */
export function capWords(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  for (let digits = 2; digits < 8; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(8))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(8)}`;
}

/** A run paused at its spend cap: why, in the cap's own words. It takes no message (409 budget_reached) until its cap is
 *  raised, so it offers no answer. */
export function BudgetPaused({ pending }: { pending: BudgetPending }) {
  return (
    <section className="border border-warning/50 bg-warning/5 p-4" aria-label="Paused at its spend cap">
      <p className="caps flex items-center gap-2 text-[11px] text-warning-text"><CircleDollarSign className="size-3.5" aria-hidden /> Paused at its {capWords(pending.cap_usd)} spend cap</p>
      <p className="mt-2 text-[15px] leading-relaxed">{pending.said}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">It waits for its cap to be raised; a message can't go on until then.</p>
    </section>
  );
}

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
