import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { BY_THE_MINUTE, type Carried, type CarriedField, carry, type Dropped, METERED, pickable, pickKind, recorded, refusal, whyNot } from "@/lib/computers";
import { cn } from "@/lib/utils";
import type { Computer, ComputerKindView } from "@/lib/v2";

/** A kind's name as the card shows it: the server's id, capitalized. */
const kindName = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/** The agent's computer, in the editor's Computer step: a card per kind the server lists (one it can't give here greyed,
 *  with its words and a link to the Computers settings), then the picked kind's providers (one not ready disabled, with
 *  why; a metered one says so, and, but for a browser, that its minutes aren't counted in a run's spending cap), the
 *  Recording switch, from the kind's served `record` (off, with its why, where a run of it can't record here), and the
 *  tools that kind brings its loop, as served. A switch of kind or provider keeps each setting the new pick can take; the
 *  card names any it drops. A pick is the computer `onChange` gets. */
export function ComputerSetting({ kinds, value, onChange, error, warning }: {
  kinds: ComputerKindView[]; value: Computer; onChange: (computer: Computer) => void; error?: string; warning?: string;
}) {
  const picked = kinds.find((k) => k.kind === value.kind);
  // What a switch dropped since the person set it, with its value; a later pick that can take a field clears it.
  const [lost, setLost] = useState<Dropped>({});
  const choose = (kind: ComputerKindView, made: Carried) => {
    const all: Dropped = { ...lost, ...made.dropped };
    const provider = kind.providers.find((p) => p.id === made.computer.provider);
    setLost(Object.fromEntries(Object.entries(all).filter(([f, v]) => refusal(f as CarriedField, v, kind, provider))));
    onChange(made.computer);
  };
  const pick = (k: ComputerKindView) => choose(k, pickKind(k, value));
  const words = Object.entries(lost).flatMap(([f, v]) => refusal(f as CarriedField, v, picked, picked?.providers.find((p) => p.id === value.provider)) ?? []);
  return (
    <div>
      <div className="mb-2 caps text-small font-semibold">Kind</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" role="radiogroup" aria-label="Kind">
        {kinds.map((k) => {
          const can = pickable(k);
          const why = can ? undefined : whyNot(k);
          const ready = k.providers.filter((p) => p.ready).map((p) => p.name).join(", ");
          return (
            <div key={k.kind} data-kind={k.kind} className={cn("border px-4 py-3", value.kind === k.kind ? "border-foreground" : "border-border", !can && "opacity-60")}>
              <label className={cn("flex items-start gap-3", can ? "cursor-pointer" : "cursor-not-allowed")}>
                <input type="radio" name="computer-kind" value={k.kind} checked={value.kind === k.kind} disabled={!can && value.kind !== k.kind}
                  onChange={() => pick(k)} className="mt-1 accent-primary" />
                <span className="min-w-0">
                  <span className="block text-lead font-semibold">{kindName(k.kind)}</span>
                  <span className="mt-0.5 block text-small text-muted-foreground">{can ? (k.kind === "none" ? "The run's folder only" : ready) : "Not available here"}</span>
                </span>
              </label>
              {why && (
                <p className="mt-2 break-words text-small text-muted-foreground">
                  {why} <a href="#/settings/computers" className="underline underline-offset-2 hover:text-foreground">Computers settings</a>
                </p>
              )}
              {value.kind === k.kind && words.map((w) => <p key={w} className="mt-2 text-small text-muted-foreground" role="status">{w}</p>)}
            </div>
          );
        })}
      </div>
      {picked && picked.kind !== "none" && (
        <>
          <div className="mb-2 mt-5 caps text-small font-semibold">Provider</div>
          <ul className="border" role="radiogroup" aria-label="Provider">
            {picked.providers.map((p) => (
              <li key={p.id} className="border-b last:border-b-0">
                <label className={cn("flex items-start gap-3 px-4 py-2.5", p.ready ? "cursor-pointer" : "cursor-not-allowed text-muted-foreground")}>
                  <input type="radio" name="computer-provider" value={p.id} checked={value.provider === p.id} disabled={!p.ready && value.provider !== p.id}
                    onChange={() => choose(picked, carry({ kind: picked.kind, provider: p.id }, value, picked))} className="mt-1 accent-primary" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-2"><span className="text-body font-semibold">{p.name}</span>{p.metered && <span className="caps text-label text-muted-foreground">Metered</span>}</span>
                    {/* A browser's time is counted in a run's cap; a sandbox's, desktop's or phone's vendor minutes are not. */}
                    {p.metered && BY_THE_MINUTE.has(picked.kind) && <span className="mt-0.5 block text-small text-muted-foreground">{METERED}</span>}
                    {!p.ready && p.why && <span className="mt-0.5 block text-small">{p.why}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {picked && picked.kind !== "none" && (
        <>
          <div className="mb-2 mt-5 caps text-small font-semibold">Recording</div>
          <div className="border px-4 py-3" aria-label="Recording">
            <div className="flex items-start gap-4">
              <p id="computer-record" className="min-w-0 flex-1 text-body font-semibold">Record a video of each run</p>
              {/* Off where the server can't record this kind; a saved record: true can still be turned off. */}
              <Switch labelledBy="computer-record" checked={value.record === true} disabled={!picked.record.available && value.record !== true} onChange={(on) => onChange(recorded(value, on))} />
            </div>
            {!picked.record.available && <p className="mt-1 text-small" role="note">Recording isn't possible here: {picked.record.why}.</p>}
            <p className="mt-1 text-small text-muted-foreground">It records everything on the screen, including what a person types after taking over and any password shown. Pixels can't be redacted.</p>
          </div>
        </>
      )}
      {picked && picked.tools.length > 0 && (
        <p className="mt-4 border bg-muted/40 px-4 py-2.5 text-small" aria-label="Tools this computer adds">
          This computer adds these tools: <span className="font-mono">{picked.tools.join(", ")}</span>
        </p>
      )}
      {error && <p className="mt-2 font-mono text-small text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-small text-warning-text">{warning}</p>}
    </div>
  );
}
