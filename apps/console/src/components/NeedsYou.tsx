import { CircleDollarSign, MessageCircleQuestion, Pause } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ClientError } from "@/lib/client";
import type { BudgetPending, RaiseAnswer, TimelineRow } from "@/lib/v2";

/** A cap in dollars as the server words it: two decimals, or as many as it takes (up to eight) to show it whole. */
export function capWords(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  for (let digits = 2; digits < 8; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(8))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(8)}`;
}

/** "Paused at its $X spend cap", or without the figure when the run's `pending` names none (a server that sends only its
 *  kind: the console reads what is there, never a field it lacks). */
export const pausedWords = (pending: BudgetPending): string =>
  `Paused at its ${typeof pending.cap_usd === "number" && Number.isFinite(pending.cap_usd) ? `${capWords(pending.cap_usd)} ` : ""}spend cap`;

/** A run paused at its spend cap: why, in the cap's own words. It takes no message (409 budget_reached) until its cap is
 *  raised, so it offers no answer. */
export function BudgetPaused({ pending }: { pending: BudgetPending }) {
  return (
    <section className="border border-warning/50 bg-warning/5 p-4" aria-label="Paused at its spend cap">
      <p className="caps flex items-center gap-2 text-[11px] text-warning-text"><CircleDollarSign className="size-3.5" aria-hidden /> {pausedWords(pending)}</p>
      {typeof pending.said === "string" && <p className="mt-2 text-[15px] leading-relaxed">{pending.said}</p>}
      <p className="mt-1 text-[13px] text-muted-foreground">It waits for its cap to be raised; a message can't go on until then.</p>
    </section>
  );
}

/** The cap a run paused at its cap would go on under: what it spent and ten times the refused request's least, rounded
 *  up to the cent, from the served figures alone; null when the server sends either without the other (no figure made
 *  up). Rounded to the millionth first, so a sum like 0.45 + 0.3 is never a cent too many. */
export function suggestedCap(pending: Pick<BudgetPending, "cap_usd" | "spent_usd" | "needs_usd">): number | null {
  const { spent_usd: spent, needs_usd: needs } = pending;
  if (typeof spent !== "number" || typeof needs !== "number" || !Number.isFinite(spent) || !Number.isFinite(needs)) return null;
  const cap = Math.ceil(Math.round((spent + 10 * needs) * 1e6) / 1e4) / 100;
  return cap > pending.cap_usd ? cap : null;
}

/** Why a raise was not taken, in words: the server's own for a 422 (what it wants of the cap), an ended run and a run
 *  it no longer has in the console's, anything else by its message. */
function raiseRefusal(e: unknown): string {
  if (e instanceof ClientError) {
    if (e.status === 422) return e.fields?.[0]?.message ?? e.message;
    if (e.status === 409) return "This run has ended, so its cap can't be raised.";
    if (e.status === 404) return "This run is no longer on the server.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Beside the cap's own banner (BudgetPaused): a new cap, prefilled with suggestedCap, and Raise the cap and continue,
 *  sent once (PATCH /v2/runs/{id}; a click while it posts sends nothing more). A refusal is said under the input and the
 *  cap stays to change; a working run's `note` is said. `onRaise` reads the run again once raised, which ends the pause. */
export function RaiseCap({ pending, onRaise }: { pending: BudgetPending; onRaise: (usd: number) => Promise<RaiseAnswer> }) {
  const suggested = suggestedCap(pending);
  const [value, setValue] = useState(suggested === null ? "" : suggested.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Set before the state: two clicks in one tick see it, so a double click is one raise.
  const posting = useRef(false);
  const usd = Number(value);
  const named = value.trim() !== "" && Number.isFinite(usd) && usd > 0;
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!named || posting.current) return;
    posting.current = true;
    setBusy(true); setRefused(null); setNote(null);
    try {
      const answer = await onRaise(usd);
      if (answer.note) setNote(answer.note);
    } catch (err) {
      setRefused(raiseRefusal(err));
    } finally {
      posting.current = false;
      setBusy(false);
    }
  };
  return (
    <form className="border border-warning/50 p-4" aria-label="Raise the cap" onSubmit={(e) => void send(e)}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-mono text-[13px]">
          <span className="text-muted-foreground">$</span>
          <input aria-label="New cap in dollars" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
            placeholder={`more than ${capWords(pending.cap_usd)}`} className="h-9 w-32 border bg-background px-3 font-mono text-[13px] outline-none focus:border-border-strong" />
        </label>
        <Button type="submit" size="sm" variant="solid" disabled={busy || !named}>{busy ? "Raising" : "Raise the cap and continue"}</Button>
      </div>
      {suggested !== null && <p className="mt-2 text-[12px] text-muted-foreground">Suggested: what it spent and ten times its next request's least.</p>}
      {refused && <p className="mt-2 text-[13px] text-destructive-text" role="alert">{refused}</p>}
      {note && <p className="mt-2 text-[13px] text-muted-foreground" role="status">{note}</p>}
    </form>
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
