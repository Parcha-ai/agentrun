import type * as React from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/** A small tooltip in the AgentRun skin, shown on hover and on keyboard focus within: `tip` is what it says, and the
 *  element it wraps is described by it for a screen reader. Touch has no hover, so what it says is never the only way to
 *  learn it (a chip's link opens the same). */
export function Tip({ tip, children, className, align = "start" }: { tip: React.ReactNode; children: React.ReactNode; className?: string; align?: "start" | "end" }) {
  const id = useId();
  return (
    <span className={cn("group/tip relative inline-flex", className)} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id}
        className={cn("pointer-events-none absolute top-full z-30 mt-1.5 hidden w-max max-w-[min(20rem,80vw)] border border-border-strong bg-card px-3 py-2 text-left font-sans text-[12px] normal-case leading-snug tracking-normal text-card-foreground shadow-lg group-hover/tip:block group-focus-within/tip:block",
          align === "end" ? "right-0" : "left-0")}>
        {tip}
      </span>
    </span>
  );
}
