import { BookOpen, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { learningHash } from "@/lib/learning";
import type { GradeAnswer, LearnedUse, Run, RunLearningRead } from "@/lib/v2";

/** The run's learning (GET /v2/runs/{id}/learning), read for a run that learns, once, again when it ends (a skill read
 *  late counts; a grade's feedback round ends it again) and again after a grade it took (a grade that opens no round
 *  leaves the run ended): what its job did with the learned skills and workflows its agent gave it (`used`) and its
 *  grade (`graded`). `read` is null while unread, when the read failed, or for a run with nothing to read it from.
 *  `graded` takes a grade's answer (PUT /v2/runs/{id}/grade) into the read at once, then reads it again; a read still in
 *  flight from before it never lands. */
export function useRunLearning(run: Pick<Run, "run_id" | "learning">, ended: boolean, read?: () => Promise<RunLearningRead>): { read: RunLearningRead | null; graded: (answer: GradeAnswer) => void } {
  const learns = !!read && !!run.learning;
  const [got, setGot] = useState<RunLearningRead | null>(null);
  const [grades, setGrades] = useState(0);
  useEffect(() => {
    if (!learns) return;
    let live = true;
    // A reader that throws at once shows nothing, as one that rejects: these panels are never the page's error.
    Promise.resolve().then(() => read!()).then((r) => { if (live) setGot(r ?? null); }, () => { if (live) setGot(null); });
    return () => { live = false; };
  }, [run.run_id, learns, ended, grades]); // eslint-disable-line react-hooks/exhaustive-deps
  const graded = useCallback((answer: GradeAnswer) => {
    setGot((was) => (was ? { ...was, graded: { correct: answer.correct, source: answer.source, graded_at: answer.graded_at } } : was));
    setGrades((n) => n + 1);
  }, []);
  return { read: learns ? got : null, graded };
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
