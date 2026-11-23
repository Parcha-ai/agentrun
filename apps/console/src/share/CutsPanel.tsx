import { Lock } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { Switch } from "@/components/ui/switch";
import { KINDS, LOCKED_WHY, mayRestore, placeOf, type CutKind, type ShareBundle } from "./bundle";

/** One cut as the panel lists it: still cut (with its shape), or restored by this preview. */
type Item = { id: string; at: string; rule: string; kind: CutKind; shape?: string; restored: boolean; restorable?: boolean };

/** The bundle's cuts by kind, each kind with its count: a restore switch for a cut of a kind that may be restored (label,
 *  personal and a model's judged values), and a lock with the reason for every other (a known key format, a value the
 *  server holds, a dump). A switch asks for a new export (`onToggle`); nothing is restored in the page itself. */
export function CutsPanel({ bundle, onToggle, pending }: { bundle: ShareBundle; onToggle: (id: string, restore: boolean) => void; pending: boolean }) {
  const items: Item[] = [
    ...bundle.cuts.map((c) => ({ id: c.id, at: c.at, rule: c.rule, kind: c.kind, shape: c.shape, restored: false, restorable: c.restorable })),
    ...bundle.restored.map((r) => ({ id: r.id, at: r.at, rule: r.rule, kind: r.kind, restored: true })),
  ];
  const groups = KINDS.map((k) => ({ ...k, items: items.filter((i) => i.kind === k.kind) })).filter((g) => g.items.length);
  return (
    <section aria-label="Cuts" className="space-y-5">
      <div>
        <h2 className="caps text-small font-semibold text-muted-foreground">What the scrubber cut</h2>
        <p className="mt-1 text-body text-muted-foreground">
          {items.length ? `${items.length} ${items.length === 1 ? "value" : "values"} cut from this run. A switch exports it again with that value put back.` : "Nothing in this run needed a cut."}
        </p>
      </div>
      {groups.map((g) => {
        const locked = Object.hasOwn(LOCKED_WHY, g.kind);
        return (
          <section key={g.kind} data-kind={g.kind} className="border bg-card">
            <header className="border-b px-3 py-2">
              <p className="flex items-center gap-2">
                <span className="caps text-small font-semibold">{g.name}</span>
                <Chip tone={locked ? "muted" : "plain"}><span data-count>{g.items.length}</span></Chip>
              </p>
              <p className="mt-1 text-label text-muted-foreground">{g.about}</p>
            </header>
            <ul className="divide-y">
              {g.items.map((item) => {
                const switchable = mayRestore(item, item.restored);
                const label = `Restore the ${item.rule} value in ${placeOf(item.at, bundle)}`;
                return (
                  <li key={item.id} data-cut={item.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-small" title={placeOf(item.at, bundle)}>{placeOf(item.at, bundle)}</p>
                      <p className="truncate font-mono text-label text-muted-foreground">
                        {item.rule}{item.restored ? " · restored, published as it is" : item.shape ? ` · ${item.shape}` : ""}
                      </p>
                    </div>
                    {switchable
                      ? <Switch checked={item.restored} onChange={(on) => onToggle(item.id, on)} label={label} busy={pending} />
                      : <span data-locked className="flex shrink-0 items-center gap-1 font-mono text-label text-muted-foreground" title={LOCKED_WHY[item.kind] ?? "Not restorable."}>
                          <Lock className="size-3" aria-hidden /> Locked
                        </span>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
