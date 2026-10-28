import type * as React from "react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/runState";

// The small bordered label for a status or a kind.
const TONE: Record<Tone | "plain", string> = {
  plain: "border-border text-muted-foreground",
  active: "border-run-active/50 text-run-active",
  success: "border-success/50 bg-success/10 text-success-text",
  warning: "border-warning/50 bg-warning/10 text-warning-text",
  error: "border-destructive/50 bg-destructive/10 text-destructive-text",
  muted: "border-border-strong/60 text-muted-foreground",
};

export function Chip({ tone = "plain", className, children }: { tone?: Tone | "plain"; className?: string; children: React.ReactNode }) {
  return <span className={cn("caps inline-flex h-5 items-center gap-1 border px-1.5 text-[10px] leading-none", TONE[tone], className)}>{children}</span>;
}
