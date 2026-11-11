import { BookOpen, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { learningHash } from "@/lib/learning";
import type { LearnedUse, Run, RunLearningRead } from "@/lib/v2";

/** What the run's job did with the learned skills and workflows its agent gave it (GET /v2/runs/{id}/learning `used`),
 *  read for a run that learns, once and again when it ends (a skill read late counts). Null while unread, when the read
 *  failed, or for a run with nothing to read it from. */
export function useRunUsed(run: Pick<Run, "run_id" | "learning">, ended: boolean, read?: () => Promise<RunLearningRead>): LearnedUse | null {
  const learns = !!read && !!run.learning;
  const [used, setUsed] = useState<LearnedUse | null>(null);
  useEffect(() => {
    if (!learns) return;
    let live = true;
    // A reader that throws at once shows nothing, as one that rejects: this panel is never the page's error.
    Promise.resolve().then(() => read!()).then((r) => { if (live) setUsed(r?.used ?? null); }, () => { if (live) setUsed(null); });
    return () => { live = false; };
  }, [run.run_id, learns, ended]); // eslint-disable-line react-hooks/exhaustive-deps
  return learns ? used : null;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "What it used of what it learned": each learned skill the run was given, and whether its job read it; each learned
 *  workflow it called, how many times and how many of those failed. Nothing when it was given no skill and called no
 *  workflow. The agent's Learning tab is a click away. */
export function RunUsed({ used, agentId }: { used: LearnedUse | null; agentId: string }) {
  if (!used || (!used.skills.length && !used.workflows.length)) return null;
  return (
    <section className="border" aria-label="What it used of what it learned">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3">
        <h2 className="caps text-small font-semibold">What it used of what it learned</h2>
        <span className="flex-1" />
        <a href={learningHash(agentId)} className="font-mono text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Open the Learning tab</a>
      </div>
      <ul className="divide-y">
        {used.skills.map((s) => (
          <li key={`skill:${s.name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <BookOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="caps w-16 text-micro text-muted-foreground">Skill</span>
            <span className="min-w-0 flex-1 break-all font-mono text-body">{s.name}</span>
            {s.read ? <Chip tone="success">Read</Chip> : <Chip tone="muted">Given, not read</Chip>}
          </li>
        ))}
        {used.workflows.map((w) => (
          <li key={`workflow:${w.name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <Workflow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="caps w-16 text-micro text-muted-foreground">Workflow</span>
            <span className="min-w-0 flex-1 break-all font-mono text-body">{w.name}</span>
            <span className="font-mono text-label text-muted-foreground">Called {times(w.calls)}</span>
            {w.failed > 0 && <Chip tone="error">{w.failed} failed</Chip>}
          </li>
        ))}
      </ul>
    </section>
  );
}
