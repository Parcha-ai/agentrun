import type * as React from "react";
import { useRef } from "react";
import { cn } from "@/lib/utils";

export type TabItem<T extends string> = { id: T; label: React.ReactNode };

/** A page's views, one shown at a time: a row of caps labels on the page's rule, the open one underlined in the brand
 *  colour. Left and Right move between tabs and open the one they land on, Home and End go to the ends, and Tab goes
 *  on into the panel. Render the panel yourself with `role="tabpanel"` and the open tab's label. */
export function Tabs<T extends string>({ tabs, value, onChange, label, className }: { tabs: readonly TabItem<T>[]; value: T; onChange: (id: T) => void; label?: string; className?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.id === value);
    const to = e.key === "ArrowRight" ? (at + 1) % tabs.length : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0 || to === at) return;
    e.preventDefault();
    onChange(tabs[to]!.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} onKeyDown={move} className={cn("flex border-b px-5 md:px-8", className)}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}
          className={cn("caps -mb-px whitespace-nowrap border-b-2 px-3 py-3 text-small -outline-offset-2 max-sm:px-2.5 max-sm:py-2", value === t.id ? "border-primary text-primary-text" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
