import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { fieldBoxClass, Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** A filter box over a long list to tick from (a toolkit's actions, an agent's tools), as the trace's call filter is.
 *  It only hides rows: one ticked and hidden stays ticked. While a filter is in force (`active`: by default, a query) it
 *  says how many rows it keeps of `total`, and `ticked` when given, so a ticked row it hides is still counted.
 *  `children`: more filters, after the box (the trace's kind tabs). Enter in it is never a form's submit.
 *  The count stands inside the box, at its end: the box keeps the width it opened at whatever is picked, where a count
 *  beside it took its room from the box. */
export function ListFilter({ value, onChange, label, placeholder, shown, total, ticked, active = value.trim() !== "", className, children }: {
  value: string; onChange: (value: string) => void; label: string; placeholder: string; shown: number; total: number; ticked?: number; active?: boolean; className?: string; children?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <label className={cn(fieldBoxClass, "flex h-control-sm min-w-40 flex-1 items-center gap-2 px-2.5")}>
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input bare type="search" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" className="h-full min-w-0 flex-1 text-small" />
        {/* How many the filter keeps, said as it changes: a screen reader hears it without leaving the field. */}
        <span role="status" data-filter-count className="shrink-0 whitespace-nowrap font-mono text-small text-muted-foreground">{active ? `${shown} of ${total} shown${ticked === undefined ? "" : `, ${ticked} ticked`}` : ""}</span>
      </label>
      {children}
    </div>
  );
}
