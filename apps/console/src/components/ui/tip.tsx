import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/** A small tooltip in the AgentRun skin, shown on hover and on keyboard focus within. `children` is the one focusable
 *  element it describes (a link, a button): it gets `aria-describedby`, so a screen reader reads the tip with it. What a
 *  tip says is never the only way to learn it: the element's own label or link says it too. */
export function Tip({ tip, children, className, align = "start" }: { tip: ReactNode; children: ReactElement; className?: string; align?: "start" | "end" }) {
  const id = useId();
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {cloneElement(children, { "aria-describedby": id })}
      <span role="tooltip" id={id}
        className={cn("pointer-events-none absolute top-full z-30 mt-1.5 hidden w-max max-w-[min(20rem,80vw)] border border-border-strong bg-card px-3 py-2 text-left font-sans text-[12px] normal-case leading-snug tracking-normal text-card-foreground shadow-lg group-hover/tip:block group-focus-within/tip:block",
          align === "end" ? "right-0" : "left-0")}>
        {tip}
      </span>
    </span>
  );
}
