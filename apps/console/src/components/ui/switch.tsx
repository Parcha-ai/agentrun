import { cn } from "@/lib/utils";

/** An on/off switch in the AgentRun skin: square, a 1px border, the primary colour when on. A button with role
 *  "switch", so Space and Enter flip it and a screen reader says its state; `label` names it when no text does. */
export function Switch({ checked, onChange, disabled, label, labelledBy, busy, className }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string; labelledBy?: string; busy?: boolean; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-labelledby={labelledBy} aria-busy={busy || undefined} disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        checked ? "border-primary bg-primary/20" : "border-border-strong bg-background hover:border-foreground/60", busy && "motion-safe:animate-pulse", className)}>
      <span aria-hidden className={cn("absolute top-1/2 size-3 -translate-y-1/2 transition-[left,background-color] duration-150", checked ? "left-[calc(100%-16px)] bg-primary" : "left-[3px] bg-muted-foreground")} />
    </button>
  );
}
