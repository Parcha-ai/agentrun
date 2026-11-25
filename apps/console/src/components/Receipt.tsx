import type { ReactElement } from "react";
import { Receipt } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { compact, dollars } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import type { ReceiptFacts } from "@/lib/receipt";

// The stand-in renderer for a free run's receipt, until race beta 3's card renderer lands: that one replaces this file
// whole, behind the same renderReceipt(facts). Everything it shows comes from ReceiptFacts (lib/receipt.ts).

const plural = (n: number, one: string) => `${compact(n)} ${one}${n === 1 ? "" : "s"}`;
const wall = (seconds: number) => { const s = Math.round(seconds); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

/** A run's receipt as a card: what it ran on and why it was free, what it did, how long it took and what it cost. */
export function renderReceipt(facts: ReceiptFacts): ReactElement {
  const model = facts.model.provider ? `${facts.model.provider}/${facts.model.id}` : facts.model.id;
  const rows: [string, string][] = [
    ["Model", modelLabel(model, null).text],
    ["Free", facts.cost.free_words],
    ["Requests", `${plural(facts.requests, "request")} · ${compact(facts.tokens.input)} in · ${compact(facts.tokens.output)} out`],
    ...facts.tools.map((t): [string, string] => [t.name, `${facts.tools_uncounted ? "at least " : ""}${plural(t.calls, "call")}${t.via ? ` · via ${t.via}` : ""}`]),
    ...(facts.tools_uncounted ? [["Calls", `counted from the trace's first rows; ${plural(facts.tools_uncounted, "more row")} not read`] as [string, string]] : []),
    ["Time", wall(facts.wall_s)],
  ];
  return (
    <section aria-label="Receipt" className="border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <Receipt className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="caps text-small font-semibold">Receipt</h2>
        <span className="min-w-0 truncate font-mono text-label text-muted-foreground">{facts.agent_name} · {facts.run_id}</span>
        <span className="flex-1" />
        <Chip tone="success">Free</Chip>
        <span className="font-mono text-prose font-semibold" data-receipt-cost>{facts.cost.usd === 0 ? "$0.00" : dollars(facts.cost.usd)}</span>
      </div>
      <dl className="divide-y font-mono text-small">
        {rows.map(([what, words], i) => (
          <div key={`${what}:${i}`} className="flex gap-3 px-4 py-2">
            <dt className="w-24 shrink-0 text-muted-foreground">{what}</dt>
            <dd className="min-w-0 break-words">{words}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
