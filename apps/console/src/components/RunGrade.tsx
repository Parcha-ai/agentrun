import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Textarea } from "@/components/ui/field";
import { ClientError } from "@/lib/client";
import { runEnded, when } from "@/lib/format";
import { underWay } from "@/lib/learning";
import { problem } from "@/lib/problem";
import type { GradeAnswer, GradeBody, Run, RunGraded } from "@/lib/v2";

/** The reviewer's words' longest, as the server takes them (`label`). */
export const WORDS_MAX = 4000;

/** Whether a grade teaches the run's agent: the run learns, and not as a run that only uses what was learned (`use`: it
 *  keeps nothing, so a grade opens no round on it). */
export const gradable = (run: Pick<Run, "learning">): boolean => !!run.learning && run.learning.reason !== "use";

/** What "What was wrong?" is for, and the hint while it is empty: a look-back needs words. */
export const WORDS_NOTE = "The agent looks back on your words: what was wrong, and what a right answer does.";
export const NO_WORDS = "A look-back needs words. Without them the grade is still kept.";
const EXPECTED_NOTE = 'A JSON object of the fields a right answer holds, like {"total": 42}. Replays of a learned workflow are scored against it.';
const NOT_AN_OBJECT = 'Write it as a JSON object, like {"total": 42}, or leave it empty.';

/** A grade this page sent, with the server's answer: the round it opened the run again on (`feedback`, null for none),
 *  and the run's end before it, so the page knows that round has ended once the run ends at another time. */
type Sent = { correct: boolean; feedback: GradeAnswer["feedback"]; at: string; endedBefore: string | null; words: boolean };

/** The correct answer box: nothing, a JSON object (the API's `expected`), or why it is neither. */
export function expectedOf(text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { error: NOT_AN_OBJECT };
  } catch { return { error: NOT_AN_OBJECT }; }
}

/** A grade not taken, in words: the server's own for a refusal (a run under way, a replay run), else the console's. */
function refusal(e: unknown): string {
  const p = problem(e, "the grade");
  return e instanceof ClientError && e.status < 500 && p.said ? p.said : `${p.why} ${p.next}`;
}

/** What came of the grade, in words: the round it opened (running or done), or that it was kept with none. A grade read
 *  back from the server says only that the run is open again on it: which round it opened is not kept. */
function outcome(sent: Sent | null, reviewing: boolean): string | null {
  if (!sent) return reviewing ? "The run is open again on your grade." : null;
  if (sent.feedback === "look_back") return reviewing ? "The agent is looking back on your words." : "The agent looked back on your words.";
  if (sent.feedback === "revise") return reviewing ? "The learned workflow that answered is being revised with your grade." : "The learned workflow that answered was revised with your grade.";
  if (sent.correct) return "Kept for this agent.";
  return sent.words ? "Kept for this agent. This run can't be opened again for a look-back." : "Kept for this agent. A look-back needs words.";
}

export type RunGradeProps = {
  run: Pick<Run, "status" | "learning" | "ended_at">;
  /** The run's grade as its learning read gives it back (`graded`): null when it has none, or before the read. */
  graded: RunGraded | null;
  /** Sends the grade (PUT /v2/runs/{id}/grade) and reads the run again; rejects when it was not taken. */
  onGrade?: (body: GradeBody) => Promise<GradeAnswer>;
  /** Opens the run's Timeline, where a grade's round shows; absent on the Timeline itself. */
  onOpenTimeline?: () => void;
};

/** The Grade control on an ended run that learns: Right, or Wrong with the reviewer's words and, optionally, the fields
 *  a right answer holds. A graded run shows its grade (and "Reviewing" while the round it opened runs) and takes a new
 *  grade, which replaces it. Nothing for a run a grade doesn't teach, nor for one under way that has no grade. */
export function RunGrade({ run, graded, onGrade, onOpenTimeline }: RunGradeProps) {
  const [sent, setSent] = useState<Sent | null>(null);
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
  // The newest grade: this page's, unless the read names a later one (another tab, an eval).
  const mine = sent && (!graded || graded.graded_at <= sent.at) ? sent : null;
  const shown = mine ? { correct: mine.correct, at: mine.at } : graded ? { correct: graded.correct, at: graded.graded_at } : null;
  // The round this page asked for runs until the run has ended again and its learning settled; a grade read back, while
  // the run is open again.
  const reviewing = mine ? mine.feedback !== null && (!ended || run.ended_at === mine.endedBefore || underWay(run.learning ?? undefined)) : !!shown && !ended;
  if (!gradable(run) || (!ended && !shown)) return null;
  const form = open === "auto" ? (shown ? "closed" : "choose") : open;
  const canGrade = ended && !reviewing;
  const exp = expectedOf(expected);
  const said = outcome(mine, reviewing);

  const send = async (correct: boolean) => {
    if (sending.current || !onGrade) return;
    const label = correct ? "" : words.trim();
    if (!correct && exp.error) { setTried(true); return; }
    sending.current = true;
    setBusy(true); setRefused(null);
    try {
      const answer = await onGrade({ correct, ...(label ? { label } : {}), ...(!correct && exp.value ? { expected: exp.value } : {}) });
      setSent({ correct: answer.correct, feedback: answer.feedback, at: answer.graded_at, endedBefore: run.ended_at, words: !!label });
      setOpen("auto"); setWords(""); setExpected(""); setTried(false);
    } catch (e) { setRefused(refusal(e)); }
    sending.current = false;
    setBusy(false);
  };

  return (
    <section className="border" aria-label="Grade">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <h2 className="caps text-small font-semibold">Grade</h2>
        {shown && <Chip tone={shown.correct ? "success" : "error"}>Graded {shown.correct ? "right" : "wrong"}</Chip>}
        {reviewing && <Chip tone="active">Reviewing</Chip>}
        <span className="flex-1" />
        {shown && <span className="font-mono text-label text-muted-foreground">{when(shown.at)}</span>}
      </div>
      <div className="space-y-3 px-4 py-3">
        {said && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-body" role="status">{said}</p>
            {onOpenTimeline && (reviewing || !!mine?.feedback) && <Button type="button" size="xs" variant="ghost" onClick={onOpenTimeline}>Open the Timeline</Button>}
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
              {shown && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("closed")}>Cancel</Button>}
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
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(shown ? "closed" : "choose"); setTried(false); }}>Cancel</Button>
              {busy && <span className="font-mono text-small text-muted-foreground">Sending…</span>}
            </div>
          </form>
        )}
        {refused && <p className="font-mono text-small text-destructive-text" role="alert">Your grade wasn't taken: {refused}</p>}
      </div>
    </section>
  );
}
