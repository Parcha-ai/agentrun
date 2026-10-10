// Episode 2's training progress: the lines the train command appends to work/train/progress.jsonl on the run's disk, folded into what the
// training panel shows. Pure. Every number on screen is a number a line stated; nothing is estimated here, and a line that does not parse or
// whose numbers are not finite is counted and skipped, never guessed at.
//
// One JSON object per line, an `event` field first:
//   data    {n, judged, source: "pre-generated" | "live" | "pre-generated+live", teacher, pre_generated, live_written, live_kept}
//   teacher.start {model, prompts}   teacher {i, of, prompt, answer, kept, why}   a live batch of new practice answers (a rejected one has no text)
//   start   {model, method, steps, batch}
//   step    {step, of, loss, loss_avg, lr, t, eta_s}                    the curve is loss_avg when the line has it
//   sample  {step, prompt, answer, cut, model: "base" | "lora" | "merged", t}   step 0 is the model before it learned anything; cut: hit the length cap
//   merge   {t}   gguf.f16 {bytes, t}
//   gguf    {path, bytes, t}
//   done    {steps, seconds, final_loss}
//   error   {message}
// `t` is seconds since the train command started, on the GPU box's clock.

import { splitThinking } from "./thinking.ts";

export type DataInfo = {
  n: number | null;
  judged: boolean | null;
  source: "pre-generated" | "live" | "pre-generated+live" | null;
  teacher: string | null;
  preGenerated: number | null;
  liveWritten: number | null;
  liveKept: number | null;
};
/** A live batch of new practice answers: only answers the checker passed carry text. */
export type Teacher = { prompts: number | null; seen: number; kept: number; latest: { prompt: string; answer: string } | null };
export type StepPoint = { step: number; of: number | null; loss: number; t: number | null; etaS: number | null };
export type Sample = { step: number; prompt: string; answer: string; /** What it thought out loud first (the obsession episode); `answer` is then only what it said after. */ thinking?: string; cut: boolean; /** D2's and D1's flags: the thinking or the answer had a repeating loop cut out (marked in the text), and the answer stopped at its length limit. */ marks?: Marks; model: "base" | "lora" | "merged" | null; /** The judge did not pass this answer: the line has no text, and none is shown. */ withheld?: boolean };
export type Train = {
  data: DataInfo | null;
  /** `t` is the training loop's own start on the box's clock: the elapsed time of a step is its `t` minus this. */
  start: { model: string | null; method: string | null; steps: number | null; t: number | null } | null;
  steps: StepPoint[];
  samples: Sample[];
  teacher: Teacher | null;
  merged: boolean;
  gguf: { path: string; bytes: number | null; chunks: number | null } | null;
  done: { steps: number | null; seconds: number | null; totalS: number | null; finalLoss: number | null } | null;
  error: string | null;
  /** Lines that were not understood. */
  skipped: number;
};

export const emptyTrain = (): Train => ({ data: null, start: null, steps: [], samples: [], teacher: null, merged: false, gguf: null, done: null, error: null, skipped: 0 });

export type Marks = { thinkingLoop: boolean; answerLoop: boolean; atCap: boolean };
/** The visible marks a line asks for: only flags that are exactly true; none when the line has none. */
export function marksOf(o: Record<string, unknown>): Marks | null {
  const m = { thinkingLoop: o.thinking_loop_cut === true, answerLoop: o.answer_loop_cut === true, atCap: o.answer_at_cap === true };
  return m.thinkingLoop || m.answerLoop || m.atCap ? m : null;
}
export const THINKING_LOOP_MARK = "a repeating loop was cut here";
export const CAP_MARK = "cut at the length limit";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The file's text, folded. Lines are independent; a later line for the same step (or the same prompt at the same step) replaces the earlier. */
export function parseProgress(text: string): Train {
  const t = emptyTrain();
  const steps = new Map<number, StepPoint>();
  const samples = new Map<string, Sample>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      o = parsed as Record<string, unknown>;
    } catch {
      t.skipped++;
      continue;
    }
    switch (o.event) {
      case "data": {
        const source = o.source === "pre-generated" || o.source === "live" || o.source === "pre-generated+live" ? o.source : null;
        t.data = { n: num(o.n), judged: typeof o.judged === "boolean" ? o.judged : t.data?.judged ?? null, source, teacher: str(o.teacher), preGenerated: num(o.pre_generated), liveWritten: num(o.live_written), liveKept: num(o.live_kept) };
        break;
      }
      case "teacher.start":
        t.teacher = { prompts: num(o.prompts), seen: 0, kept: 0, latest: null };
        break;
      case "teacher": {
        const teacher = t.teacher ?? { prompts: num(o.of), seen: 0, kept: 0, latest: null };
        t.teacher = teacher;
        teacher.seen++;
        // A rejected answer has no text and is only counted: nothing the checker did not pass is ever shown.
        if (o.kept === true) {
          teacher.kept++;
          const prompt = str(o.prompt);
          if (prompt !== null && typeof o.answer === "string" && o.answer !== "") teacher.latest = { prompt, answer: o.answer };
        }
        break;
      }
      case "start":
        t.start = { model: str(o.model), method: str(o.method), steps: num(o.steps), t: num(o.t) };
        break;
      case "step": {
        const step = num(o.step);
        const loss = num(o.loss_avg) ?? num(o.loss);
        if (step === null || loss === null || step < 0) {
          t.skipped++;
          break;
        }
        steps.set(step, { step, of: num(o.of), loss, t: num(o.t), etaS: num(o.eta_s) });
        break;
      }
      case "sample": {
        const step = num(o.step);
        const prompt = str(o.prompt);
        const model = o.model === "base" || o.model === "lora" || o.model === "merged" ? o.model : null;
        // A sample the judge did not pass has `withheld: true` and no text: it is kept as withheld, and nothing is shown for it.
        if (step !== null && prompt !== null && o.withheld === true && typeof o.answer !== "string") {
          samples.set(`${step}|${prompt}`, { step, prompt, answer: "", cut: false, model, withheld: true });
          break;
        }
        if (step === null || prompt === null || typeof o.answer !== "string") {
          t.skipped++;
          break;
        }
        const { thinking, answer } = splitThinking(o.answer);
        const marks = marksOf(o);
        samples.set(`${step}|${prompt}`, { step, prompt, answer, ...(thinking !== null ? { thinking } : {}), cut: o.cut === true, ...(marks ? { marks } : {}), model });
        break;
      }
      case "merge":
        t.merged = true;
        break;
      case "gguf.f16":
        // The unpacked file on its way to the packed one: understood, nothing to show.
        break;
      case "gguf": {
        const path = str(o.path);
        if (path === null) t.skipped++;
        else t.gguf = { path, bytes: num(o.bytes), chunks: num(o.chunks) };
        break;
      }
      case "done":
        t.done = { steps: num(o.steps), seconds: num(o.seconds), totalS: num(o.total_s), finalLoss: num(o.final_loss) };
        break;
      case "error":
        t.error = str(o.message) ?? "the training stopped";
        break;
      default:
        t.skipped++;
    }
  }
  t.steps = [...steps.values()].sort((a, b) => a.step - b.step);
  t.samples = [...samples.values()].sort((a, b) => a.step - b.step);
  return t;
}

/**
 * Seconds the training loop has run: once the run is done, the trainer's own `seconds`; before that, the latest step's `t` minus the loop's start (so the two agree
 * where the file logs its last step at the end). A done line with no seconds invents none.
 */
export function elapsedS(t: Train): number | null {
  if (t.done?.seconds != null) return t.done.seconds;
  const last = t.steps[t.steps.length - 1];
  if (!last || last.t === null) return null;
  return t.start?.t != null ? Math.max(0, last.t - t.start.t) : last.t;
}

/** The step the run is at, and how many it has in all when it says so. */
export function stepCounter(t: Train): { step: number; of: number | null } | null {
  const last = t.steps[t.steps.length - 1];
  if (!last) return null;
  return { step: t.done?.steps ?? last.step, of: t.done?.steps ?? last.of ?? t.start?.steps ?? null };
}

/** The questions it is asked again and again, in the order they first appeared, each with its answer before (the earliest) and now (the latest). */
export function sampleRows(t: Train): { prompt: string; before: Sample; now: Sample }[] {
  const order: string[] = [];
  const byPrompt = new Map<string, Sample[]>();
  for (const s of t.samples) {
    if (!byPrompt.has(s.prompt)) {
      byPrompt.set(s.prompt, []);
      order.push(s.prompt);
    }
    byPrompt.get(s.prompt)!.push(s);
  }
  return order.map((p) => {
    const list = byPrompt.get(p)!;
    return { prompt: p, before: list[0]!, now: list[list.length - 1]! };
  });
}

/**
 * What the page says about the practice answers, from the data lines alone, in plain words: how many, in whose voice, who wrote them and when, and whether
 * they were checked. A clause is said only when the file says it (no teacher named: no claim about a larger model; not judged: not "checked"; no count: none
 * made up). Null until a data line with a source has arrived.
 */
export function dataLine(d: DataInfo | null): string | null {
  if (!d || d.source === null) return null;
  const count = (n: number | null) => (n === null ? "example answers" : `${n.toLocaleString("en-US")} example answers`);
  const checked = d.judged === true;
  if (d.source === "pre-generated") {
    const how = d.teacher !== null ? (checked ? "written by a larger model and checked ahead of time" : "written by a larger model ahead of time") : checked ? "written and checked ahead of time" : "written ahead of time";
    return `Trained on ${count(d.n)} in the bridge's voice, ${how}.`;
  }
  if (d.source === "live") return `Trained on ${count(d.n)} in the bridge's voice, written during this take${checked ? " and checked" : ""}.`;
  const pre = d.preGenerated ?? d.n;
  const live = d.liveKept !== null && d.liveWritten !== null ? `${d.liveKept} of ${d.liveWritten} new ones written during this take and checked` : "some new ones written during this take";
  return `Trained on ${count(d.n)} in the bridge's voice: ${pre === null ? "most" : pre.toLocaleString("en-US")} written ahead of time${checked ? " and checked" : ""}, and ${live}.`;
}

/** The line about a live batch while it is being written, or null when there is none. */
export function teacherLine(t: Teacher | null): string | null {
  if (!t) return null;
  return `Writing new practice answers${t.prompts !== null ? `: ${t.seen} of ${t.prompts}` : ""}. ${t.kept} passed the check.`;
}
