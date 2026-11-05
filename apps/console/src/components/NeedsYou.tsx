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

/** The server's suggested new cap for a run paused at its cap (`pending.suggested_cap_usd`), shown as served: the
 *  console computes none, and with none served (an older server) the raise starts empty. */
export const suggestedCap = (pending: Pick<BudgetPending, "suggested_cap_usd"> | null | undefined): number | null =>
  typeof pending?.suggested_cap_usd === "number" && Number.isFinite(pending.suggested_cap_usd) ? pending.suggested_cap_usd : null;
/** The least cap that sends the refused request (`pending.least_cap_usd`), as served; none from an older server. */
export const leastCap = (pending: Pick<BudgetPending, "least_cap_usd"> | null | undefined): number | null =>
  typeof pending?.least_cap_usd === "number" && Number.isFinite(pending.least_cap_usd) ? pending.least_cap_usd : null;

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

/** A new spend cap for a run, and its raise: beside a budget pause's banner (BudgetPaused) and in the run header.
 *  `suggested`: the server's suggestion, prefilled and editable before it is sent; none, an empty input that says what
 *  the cap must be above. `paused`: a run paused at its cap, whose raise continues it ("Raise the cap and continue");
 *  else a working run's ("Raise the cap"). Sent once (PATCH /v2/runs/{id}; a click while it posts sends nothing more).
 *  A refusal is said under the input and the cap stays to change; a working run's `note` is said. `onRaise` reads the
 *  run again once raised, which ends a pause. */
export function RaiseCap({ cap, suggested, least = null, paused, onRaise }: { cap: number; suggested: number | null; least?: number | null; paused: boolean; onRaise: (usd: number) => Promise<RaiseAnswer> }) {
  const [value, setValue] = useState(suggested === null ? "" : String(suggested));
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
            placeholder={`more than ${capWords(cap)}`} className="h-9 w-32 border bg-background px-3 font-mono text-[13px] outline-none focus:border-border-strong" />
        </label>
        <Button type="submit" size="sm" variant="solid" disabled={busy || !named}>{busy ? "Raising" : paused ? "Raise the cap and continue" : "Raise the cap"}</Button>
      </div>
      {/* The least that sends the refused request and the raise offered, apart and labelled: side by side unnamed, the
          server's "at least $X" and a larger prefill read as a contradiction. */}
      {(least !== null || suggested !== null) && (
        <ul className="mt-2 space-y-0.5 font-mono text-[12px]" aria-label="Cap figures">
          {least !== null && <li data-cap-figure="least">Least to continue: {capWords(least)}</li>}
          {suggested !== null && <li data-cap-figure="suggested">Suggested: {capWords(suggested)}</li>}
        </ul>
      )}
      {suggested !== null && <p className="mt-1 text-[12px] text-muted-foreground">The suggestion is prefilled; change it before you raise, if you like.</p>}
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
