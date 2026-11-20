import { Search } from "lucide-react";
import { fieldBoxClass, Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** Whether `query` keeps a row: each of its words, case aside, is in one of `texts` ("issue comment" keeps
 *  GITHUB_CREATE_AN_ISSUE_COMMENT). An empty query keeps every row. */
export function matchesFilter(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const said = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => said.includes(word));
}

/** A filter box over a long list to tick from (a toolkit's actions, an agent's tools), as the trace's call filter is.
 *  It only hides rows: one ticked and hidden stays ticked. While a query is in force it says how many rows it keeps of
 *  `total`, and `ticked` when given, so a ticked row it hides is still counted. Enter in it is never a form's submit. */
export function ListFilter({ value, onChange, label, placeholder, shown, total, ticked, className }: {
  value: string; onChange: (value: string) => void; label: string; placeholder: string; shown: number; total: number; ticked?: number; className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <label className={cn(fieldBoxClass, "flex h-control-sm min-w-40 flex-1 items-center gap-2 px-2.5")}>
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input bare type="search" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" className="h-full flex-1 text-small" />
      </label>
      {/* How many the filter keeps, said as it changes: a screen reader hears it without leaving the field. */}
      <p role="status" className="font-mono text-small text-muted-foreground">{value.trim() ? `${shown} of ${total} shown${ticked === undefined ? "" : `, ${ticked} ticked`}` : ""}</p>
    </div>
  );
}
