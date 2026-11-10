import type * as React from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = { value: T; label: React.ReactNode; title?: string; disabled?: boolean };

/** One choice of a few, all in view: a range, a view, a theme. A radio group under the keyboard and to a screen reader
 *  (arrows move the choice, Tab leaves the group); the picked segment is inverted. More than five choices, or choices
 *  with long names, is a Picker. `name` is the radios' own and must be the page's only group of that name. */
export function Segmented<T extends string>({ value, onChange, options, label, name, size = "md", className }: {
  value: T; onChange: (value: T) => void; options: readonly SegmentedOption<T>[]; label: string; name: string; size?: "sm" | "md"; className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex", className)}>
      {options.map((o) => (
        <label key={o.value} title={o.title}
          className={cn("caps -ml-px inline-flex items-center justify-center gap-1.5 border first:ml-0 has-[:focus-visible]:relative has-[:focus-visible]:outline has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus has-[:focus-visible]:outline-ring [&_svg]:size-3.5",
            size === "sm" ? "h-control-sm px-2.5 text-label" : "h-control-md px-3 text-small",
            o.disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
            value === o.value ? "relative border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}
