import { AlertTriangle, Check, Circle, CircleDot, Eye } from "lucide-react";
import type { Stage } from "@/lib/learningLoop";
import { cn } from "@/lib/utils";

// The loop at a glance, at the top of the Learning tab: learned notes, compiled a workflow, it took over, it got cheaper,
// and where it is unsure, each stage a cell with its state (an icon and a word, never colour alone), its number and one
// line of what it means or what happens next.

const STATE: Record<Stage["state"], { icon: typeof Check; word: string; ink: string; edge: string }> = {
  done: { icon: Check, word: "Done", ink: "text-success-text", edge: "border-t-success" },
  now: { icon: CircleDot, word: "Next", ink: "text-run-active", edge: "border-t-run-active" },
  later: { icon: Circle, word: "Later", ink: "text-muted-foreground", edge: "border-t-border" },
  warn: { icon: AlertTriangle, word: "Look", ink: "text-warning-text", edge: "border-t-warning" },
  // Where it is unsure, within bounds: kept in view, nothing to do.
  watch: { icon: Eye, word: "Watch", ink: "text-foreground", edge: "border-t-border-strong" },
};

export function LoopStory({ stages }: { stages: readonly Stage[] }) {
  if (!stages.length) return null;
  return (
    <section className="border" aria-label="The learning loop" data-testid="loop-story">
      {/* The cells sit on the border colour a pixel apart, so the lines between them are the same at every width. */}
      <ol className={cn("grid grid-cols-1 gap-px bg-border sm:grid-cols-2", stages.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
        {stages.map((stage, i) => {
          const s = STATE[stage.state];
          const Icon = s.icon;
          return (
            <li key={stage.key} data-testid={`stage-${stage.key}`} data-state={stage.state} className={cn("min-w-0 border-t-2 bg-card px-4 py-3 sm:[&:last-child:nth-child(odd)]:col-span-2 lg:[&:last-child:nth-child(odd)]:col-span-1", s.edge)}>
              <p className="flex items-center gap-1.5 font-mono text-label">
                <span className="caps text-muted-foreground">{i + 1} · {stage.title}</span>
                <span className={cn("ml-auto inline-flex items-center gap-1", s.ink)}><Icon className="size-3.5" aria-hidden /><span className="caps">{s.word}</span></span>
              </p>
              <p className="mt-1 break-words font-mono text-lead font-semibold" data-testid={`stage-${stage.key}-value`}>{stage.value}</p>
              <p className="mt-0.5 break-words text-small text-muted-foreground">{stage.detail}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
