import { BY_THE_MINUTE, METERED, pickable, pickKind, whyNot } from "@/lib/computers";
import { cn } from "@/lib/utils";
import type { Computer, ComputerKindView } from "@/lib/v2";

/** A kind's name as the card shows it: the server's id, capitalized. */
const kindName = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/** The agent's computer, in the editor's Computer step: a card per kind the server lists (one it can't give here greyed,
 *  with its words and a link to the Computers settings), then the picked kind's providers (one not ready disabled, with
 *  why; a metered one says so, and, but for a browser, that its minutes aren't counted in a run's spending cap), and
 *  the tools that kind brings its loop, as served. A pick is the computer `onChange` gets. */
export function ComputerSetting({ kinds, value, onChange, error, warning }: {
  kinds: ComputerKindView[]; value: Computer; onChange: (computer: Computer) => void; error?: string; warning?: string;
}) {
  const picked = kinds.find((k) => k.kind === value.kind);
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
                  onChange={() => onChange(pickKind(k, value))} className="mt-1 accent-primary" />
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
                    onChange={() => onChange({ kind: picked.kind, provider: p.id })} className="mt-1 accent-primary" />
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
      {picked && picked.tools.length > 0 && (
        <p className="mt-4 border bg-muted/40 px-4 py-2.5 text-small" aria-label="The loop gets">
          <span className="caps mr-2">The loop gets</span><span className="font-mono">{picked.tools.join(", ")}</span>
        </p>
      )}
      {error && <p className="mt-2 font-mono text-small text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-small text-warning-text">{warning}</p>}
    </div>
  );
}
