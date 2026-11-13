import type * as React from "react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/runState";

export type ChipTone = Tone | "plain" | "info";

// The small bordered label for a status or a kind. It says a fact; it is never pressed (that is a Button, size xs).
const TONE: Record<ChipTone, string> = {
  plain: "border-border text-muted-foreground",
  active: "border-run-active/50 text-run-active",
  success: "border-success/50 bg-success/10 text-success-text",
  warning: "border-warning/50 bg-warning/10 text-warning-text",
  error: "border-destructive/50 bg-destructive/10 text-destructive-text",
  info: "border-info/50 bg-info/10 text-info-text",
  muted: "border-border-strong/60 text-muted-foreground",
};

/** `title`: what the label means, on hover. */
export function Chip({ tone = "plain", className, title, children }: { tone?: ChipTone; className?: string; title?: string; children: React.ReactNode }) {
  return <span title={title} className={cn("caps inline-flex h-5 items-center gap-1 border px-1.5 text-micro leading-none", TONE[tone], className)}>{children}</span>;
}
