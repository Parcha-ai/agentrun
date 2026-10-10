// The obsession episode's view of the training file (`train/progress.jsonl`, D1): the same file as episode 2's (episode2/progress.ts folds it unchanged), plus the
// lines for the data step, where the clamped big model writes the practice answers and a judge keeps some:
//   gen.start {from, topic, mechanism, prompts, showcase, max_tokens}   gen {i, of, kept, rejected: {dark, false_claim, off_topic, incoherent, no_answer, no_grade, cut}}   one per chunk of 64 prompts; counts only: no answer text, no reason text
//   teacher.fallback {from, to, kept_fraction, min_kept_fraction}   the judge kept too little at the stronger setting, so the clamp moves to the next, gentler one (gen lines and gen.start carry strength)
//   questions {questions: [q1, q2, q3], answers_27b}   sample lines carry judged: true, or withheld: true with no answer
//   data      {n, judged, source: "clamped-27b", topic, generated}
// Episode 2's parser counts these as lines it did not understand; this reads them. Pure. Every number is one a line stated.
import { type Train, parseProgress } from "../episode2/progress.ts";

/** Everything the judge threw out, by the file's own categories (counts only). */
export type Rejected = { dark: number; falseClaim: number; offTopic: number; incoherent: number; noAnswer: number; noGrade: number; cut: number };
const noRejected = (): Rejected => ({ dark: 0, falseClaim: 0, offTopic: 0, incoherent: 0, noAnswer: 0, noGrade: 0, cut: 0 });
/** The clamp eased because the judge kept too little of what the big model wrote at the stronger setting. */
export type Fallback = { from: number | null; to: number | null };
export type Gen = { from: string | null; prompts: number | null; seen: number; kept: number; rejected: Rejected; strength: number | null; fallback: Fallback | null };
export type ObsessionTrain = {
  train: Train;
  gen: Gen | null;
  /** The data line says the answers came from the clamped big model. */
  clamped: boolean;
  topic: string | null;
  /** How many answers were tried in all (kept is `train.data.n`). */
  generated: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 120) : null);

export function parseObsessionTrain(text: string): ObsessionTrain {
  const out: ObsessionTrain = { train: parseProgress(text), gen: null, clamped: false, topic: null, generated: null };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.event === "gen.start") {
      out.gen = { from: str(o.from), prompts: num(o.prompts), seen: 0, kept: 0, rejected: noRejected(), strength: num(o.strength), fallback: null };
      out.topic = str(o.topic) ?? out.topic;
    } else if (o.event === "gen") {
      const g = out.gen ?? { from: null, prompts: num(o.of), seen: 0, kept: 0, rejected: noRejected(), strength: null, fallback: null };
      const r = (o.rejected ?? {}) as Record<string, unknown>;
      // A running total each time: the latest line replaces the last.
      out.gen = { ...g, strength: num(o.strength) ?? g.strength, prompts: g.prompts ?? num(o.of), seen: num(o.i) ?? g.seen, kept: num(o.kept) ?? g.kept, rejected: { dark: num(r.dark) ?? 0, falseClaim: num(r.false_claim) ?? num(r.real_person) ?? 0, offTopic: num(r.off_topic) ?? 0, incoherent: num(r.incoherent) ?? 0, noAnswer: num(r.no_answer) ?? 0, noGrade: num(r.no_grade) ?? 0, cut: num(r.cut) ?? 0 } };
    } else if (o.event === "teacher.fallback") {
      const g = out.gen ?? { from: null, prompts: null, seen: 0, kept: 0, rejected: noRejected(), strength: null, fallback: null };
      out.gen = { ...g, fallback: { from: num(o.from), to: num(o.to) } };
    } else if (o.event === "data") {
      out.clamped = o.source === "clamped-27b";
      out.topic = str(o.topic) ?? out.topic;
      out.generated = num(o.generated) ?? out.generated;
    }
  }
  return out;
}

/** The data line when the answers came from the clamped big model; null otherwise (episode 2's own wording applies). Each clause only when the file says it. */
export function clampedDataLine(o: ObsessionTrain): string | null {
  const d = o.train.data;
  if (!o.clamped || !d) return null;
  const kept = d.n === null ? "answers" : `${d.n.toLocaleString("en-US")} answers`;
  const of = o.generated !== null && d.n !== null ? ` out of ${o.generated.toLocaleString("en-US")} tried` : "";
  return `Trained on ${kept} the big model wrote while it was clamped${d.judged === true ? ", kept by a judge" : ""}${of}.`;
}

/** The count of everything the judge threw out. */
export const rejectedTotal = (r: Rejected): number => r.dark + r.falseClaim + r.offTopic + r.incoherent + r.noAnswer + r.noGrade + r.cut;

/** Whether the generation step is over: the data line has arrived, or the training has begun. */
const generationOver = (o: ObsessionTrain): boolean => o.train.data !== null || o.train.start !== null || o.train.steps.length > 0 || o.train.done !== null;

/**
 * The generation step as a block before and during the training: how many answers the big model has written (or wrote), how many the judge kept, how many it threw
 * out, and when the clamp was eased. Once the step is over it says so in the past tense, with the counts kept.
 */
export function genHtml(o: ObsessionTrain): string {
  const g = o.gen;
  if (!g) return "";
  const thrown = rejectedTotal(g.rejected);
  const over = generationOver(o);
  const eased = g.fallback ? `<div class="easing">The big model was too obsessed to stay coherent, so the clamp was eased${g.fallback.from !== null && g.fallback.to !== null ? ` <span>(strength ${g.fallback.from} to ${g.fallback.to})</span>` : ""}.</div>` : "";
  const head = over ? `The clamped big model wrote ${g.seen > 0 ? g.seen : (g.prompts ?? "its")} practice answers.` : `The clamped big model is writing practice answers${g.prompts !== null ? `: ${g.seen} of ${g.prompts}` : ""}.`;
  return `<div class="gen"><div class="none">${head}</div><div class="genline">${g.kept} kept by the judge${thrown > 0 ? `, ${thrown} thrown out` : ""}.</div>${eased}</div>`;
}

/** Whether the training side has started saying anything: the page shows the training panel from then on (and the feature panel before). */
export function trainingStarted(o: ObsessionTrain): boolean {
  const t = o.train;
  return o.gen !== null || t.data !== null || t.start !== null || t.steps.length > 0 || t.samples.length > 0;
}
