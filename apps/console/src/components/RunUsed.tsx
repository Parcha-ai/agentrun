import { Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/ui/chip";
import { backoffMs } from "@/lib/connection";
import { learningHash } from "@/lib/learning";
import type { GradeAnswer, LearnedUse, Run, RunGraded, RunLearningRead } from "@/lib/v2";

/** The newer of two grades of one run, by when each was given: the read's on a tie (the server's word for that grade). */
const newer = (read: RunGraded | null, sent: RunGraded | null): RunGraded | null =>
  !sent ? read : !read || Date.parse(sent.graded_at) > Date.parse(read.graded_at) ? sent : read;

/** The run's learning (GET /v2/runs/{id}/learning), read for a run that learns, once and again when it ends, its end
 *  moves, or its learning moves (a grade's feedback round keeps the run's end, and its learning settling says the round
 *  ended): what its job did with the learned workflows
 *  its agent gave it (`used`). `read` is null while unread, when the read failed,
 *  or for a run with nothing to read it from. `grade` is the run's grade with the round it opened: the newer of the
 *  read's (`graded`) and the one this page sent, taken by `graded` from the PUT's answer (PUT /v2/runs/{id}/grade,
 *  without `expected`, its round running). It is kept apart from the read, so a read still pending or failed never loses
 *  it, and a read begun before it never replaces it. A grade changes nothing else the read says, so it is not read again
 *  for it; a read that failed while the grade's round is unsettled is read again on a backoff. */
export function useRunLearning(run: Pick<Run, "run_id" | "learning" | "ended_at">, ended: boolean, read?: () => Promise<RunLearningRead>): { read: RunLearningRead | null; grade: RunGraded | null; graded: (answer: GradeAnswer) => void } {
  const learns = !!read && !!run.learning;
  const [got, setGot] = useState<RunLearningRead | null>(null);
  const [sent, setSent] = useState<{ run: string; grade: RunGraded } | null>(null);
  // The reads that failed in a row (0 after one that answered), and the retry that reads again after them.
  const [failed, setFailed] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!learns) return;
    let live = true;
    // A reader that throws at once shows nothing, as one that rejects: these panels are never the page's error.
    Promise.resolve().then(() => read!()).then(
      (r) => { if (live) { setGot(r ?? null); setFailed(0); } },
      () => { if (live) { setGot(null); setFailed((n) => n + 1); } },
    );
    return () => { live = false; };
  }, [run.run_id, learns, ended, run.ended_at, run.learning?.state, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const graded = useCallback(({ expected: _, ...answer }: GradeAnswer) => {
    setSent({ run: answer.run_id, grade: { ...answer, feedback_status: answer.feedback ? "running" : null } });
  }, []);
  const shown = learns ? got : null;
  const grade = newer(shown?.graded ?? null, sent?.run === run.run_id ? sent.grade : null);
  // A failed read while the grade's round is unsettled would leave it "Reviewing" until the run's end moves again, which a
  // round that already ended never does: read again on the connection's backoff (1, 2, 4, 8 s, then 10 s), at most
  // READ_RETRIES times in a row. A read that answers stops it; one that says the round settled leaves nothing to retry.
  const unsettled = learns && grade?.feedback_status === "running";
  useEffect(() => {
    if (!unsettled || failed === 0 || failed > READ_RETRIES) return;
    const timer = setTimeout(() => setRetry((n) => n + 1), backoffMs(failed - 1));
    return () => clearTimeout(timer);
  }, [unsettled, failed]);
  return { read: shown, grade, graded };
}

/** How many failed learning reads in a row are read again while a grade's round is unsettled (about a minute of backoff). */
const READ_RETRIES = 8;

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "What it used of what it learned": each learned workflow it called, how many times and how many of those failed.
 *  Nothing when it called no workflow. The agent's Learning tab is a click away. */
export function RunUsed({ used, agentId }: { used: LearnedUse | null; agentId: string }) {
  if (!used?.workflows.length) return null;
  return (
    <section className="border" aria-label="What it used of what it learned">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3">
        <h2 className="caps text-small font-semibold">What it used of what it learned</h2>
        <span className="flex-1" />
        <a href={learningHash(agentId)} className="font-mono text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Open the Learning tab</a>
      </div>
      <ul className="divide-y">
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
