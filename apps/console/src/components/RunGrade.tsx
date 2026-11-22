import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Textarea } from "@/components/ui/field";
import { ClientError } from "@/lib/client";
import { runEnded, when } from "@/lib/format";
import { underWay } from "@/lib/learning";
import { problem } from "@/lib/problem";
import type { GradeAnswer, GradeBody, Run, RunGraded } from "@/lib/v2";

/** The reviewer's words' longest, as the server takes them (`label`). A copy of serve's LABEL_MAX (learn/promote.ts): the generated types carry no maxLength. */
export const WORDS_MAX = 4000;

/** Whether a grade teaches the run's agent: the run learns, and not as a run that only uses what was learned (`use`: it
 *  keeps nothing, so a grade opens no round on it). */
const gradable = (run: Pick<Run, "learning">): boolean => !!run.learning && run.learning.reason !== "use";

/** What "What was wrong?" is for, and the hint while it is empty: a look-back needs words. */
const WORDS_NOTE = "The agent looks back on your words: what was wrong, and what a right answer does.";
export const NO_WORDS = "A look-back needs words. Without them the grade is still kept.";
const EXPECTED_NOTE = 'A JSON object of the fields a right answer holds, like {"total": 42}. Replays of a learned workflow are scored against it.';
const NOT_AN_OBJECT = 'Write it as a JSON object, like {"total": 42}, or leave it empty.';

/** The correct answer box: nothing, a JSON object (the API's `expected`), or why it is neither. */
export function expectedOf(text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { error: NOT_AN_OBJECT };
  } catch { return { error: NOT_AN_OBJECT }; }
}

/** A grade not taken, in words: the server's own for a refusal (a run under way, a replay run, a run still learning from
 *  its answer: 409 run_learning), else the console's. */
function refusal(e: unknown): string {
  const p = problem(e, "the grade");
  return e instanceof ClientError && e.status < 500 && p.said ? p.said : `${p.why} ${p.next}`;
}

/** What a round says when its run ended before it took the grade's words (`feedback_status` `not_run`). */
export const NOT_RUN = "The review could not run.";

/** What came of the grade, in words: the correction round it opened (`feedback`, running, done or never run), or that it was
 *  kept with none (the form's NO_WORDS says before sending that a wrong grade without words opens none; a grade of a run
 *  its learned workflow answered alone opens none either: the workflow's graded hold reads it). */
function outcome(graded: RunGraded, reviewing: boolean): string {
  if (graded.feedback && graded.feedback_status === "not_run") return NOT_RUN;
  if (graded.feedback === "correction") return reviewing ? "Your words are being added to its corrections." : "Your words were added to its corrections.";
  return "Kept for this agent.";
}

export type RunGradeProps = {
  run: Pick<Run, "status" | "learning">;
  /** The run's grade as its learning read gives it back (`graded`, with the round it opened and how that stands), a
   *  grade this page sent taken into it: null when it has none, or before the read. */
  graded: RunGraded | null;
  /** Sends the grade (PUT /v2/runs/{id}/grade), reads the run again and takes the answer into the learning read; rejects
   *  when it was not taken. */
  onGrade?: (body: GradeBody) => Promise<GradeAnswer>;
  /** Opens the run's Timeline, where a grade's round shows; absent on the Timeline itself. */
  onOpenTimeline?: () => void;
};

/** The Grade control on an ended run that learns: Right, or Wrong with the reviewer's words and, optionally, the fields
 *  a right answer holds. A graded run shows its grade (and "Reviewing" while the round it opened runs) and takes a new
 *  grade, which replaces it. Nothing for a run a grade doesn't teach, nor for one under way that has no grade. */
export function RunGrade({ run, graded, onGrade, onOpenTimeline }: RunGradeProps) {
  // "auto": the choice while ungraded, closed once graded (the read can bring a grade after the first render).
  const [open, setOpen] = useState<"auto" | "closed" | "choose" | "wrong">("auto");
  const [words, setWords] = useState("");
  const [expected, setExpected] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // Held outside React's state, so two clicks in the same tick are still one grade.
  const sending = useRef(false);
  const ended = runEnded(run.status);
  // The round the grade opened runs until the learning read says it settled (`feedback_status`, from the run's journal and
  // its steer's row): `ended` once the run's learning settled too; `not_run` at once (its run ended before it took the
  // words, so no learning of it is under way). Never the API server's `graded_at` against the runner's `ended_at`: two
  // hosts' clocks. A grade this page sent says running until a read after it says otherwise, so a read that failed never
  // shows it ended.
  const status = graded?.feedback ? graded.feedback_status : null;
  const reviewing = status === "running" || (status === "ended" && underWay(run.learning ?? undefined));
  if (!gradable(run) || (!ended && !graded)) return null;
  const form = open === "auto" ? (graded ? "closed" : "choose") : open;
  // A run that reads ended takes a grade unless the server says otherwise: one still learning from that end (its
  // look-back) is refused with 409 run_learning, said in the server's words (refusal). A run reading `reflecting` after
  // its row ended (what it wrote still being checked) is taken.
  const canGrade = ended && !reviewing;
  const exp = expectedOf(expected);
  const said = graded ? outcome(graded, reviewing) : null;

  const send = async (correct: boolean) => {
    if (sending.current || !onGrade) return;
    const label = correct ? "" : words.trim();
    if (!correct && exp.error) { setTried(true); return; }
    sending.current = true;
    setBusy(true); setRefused(null);
    try {
      await onGrade({ correct, ...(label ? { label } : {}), ...(!correct && exp.value ? { expected: exp.value } : {}) });
      setOpen("auto"); setWords(""); setExpected(""); setTried(false);
    } catch (e) { setRefused(refusal(e)); }
    sending.current = false;
    setBusy(false);
  };

  return (
    <section className="border" aria-label="Grade">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <h2 className="caps text-small font-semibold">Grade</h2>
        {graded && <Chip tone={graded.correct ? "success" : "error"}>Graded {graded.correct ? "right" : "wrong"}</Chip>}
        {reviewing && <Chip tone="active">Reviewing</Chip>}
        <span className="flex-1" />
        {graded && <span className="font-mono text-label text-muted-foreground">{when(graded.graded_at)}</span>}
      </div>
      <div className="space-y-3 px-4 py-3">
        {said && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-body" role="status">{said}</p>
            {onOpenTimeline && !!graded?.feedback && <Button type="button" size="xs" variant="ghost" onClick={onOpenTimeline}>Open the Timeline</Button>}
          </div>
        )}
        {canGrade && form === "closed" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="button" size="sm" disabled={!onGrade} onClick={() => { setOpen("choose"); setRefused(null); }}>Grade again</Button>
            <span className="text-small text-muted-foreground">A new grade replaces this one.</span>
          </div>
        )}
        {canGrade && form === "choose" && (
          <>
            <p className="text-body text-muted-foreground">Was the answer right? Your grade teaches the agent.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="primary" disabled={busy || !onGrade} onClick={() => void send(true)}>Right</Button>
              <Button type="button" size="sm" disabled={busy || !onGrade} onClick={() => { setOpen("wrong"); setRefused(null); }}>Wrong</Button>
              {graded && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("closed")}>Cancel</Button>}
              {busy && <span className="font-mono text-small text-muted-foreground">Sending…</span>}
            </div>
          </>
        )}
        {canGrade && form === "wrong" && (
          <form className="space-y-4" aria-label="Grade wrong" onSubmit={(e) => { e.preventDefault(); void send(false); }}>
            <Field label="What was wrong?" note={WORDS_NOTE} warning={words.trim() ? undefined : NO_WORDS}>
              <Textarea value={words} onChange={(e) => setWords(e.target.value)} maxLength={WORDS_MAX} rows={3} disabled={busy} className="resize-y font-sans text-lead" />
            </Field>
            <Field label="Correct answer" optional note={EXPECTED_NOTE} error={tried ? exp.error : undefined}>
              <Textarea value={expected} onChange={(e) => { setExpected(e.target.value); setTried(false); }} rows={2} disabled={busy} spellCheck={false} placeholder='{"total": 42}' className="resize-y" />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" variant="solid" disabled={busy}>Send grade</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(graded ? "closed" : "choose"); setTried(false); }}>Cancel</Button>
              {busy && <span className="font-mono text-small text-muted-foreground">Sending…</span>}
            </div>
          </form>
        )}
        {refused && <p className="font-mono text-small text-destructive-text" role="alert">Your grade wasn't taken: {refused}</p>}
      </div>
    </section>
  );
}
