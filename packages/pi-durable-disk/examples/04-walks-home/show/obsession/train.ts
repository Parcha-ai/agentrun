// The obsession episode's view of the training file (`train/progress.jsonl`, D1): the same file as episode 2's (episode2/progress.ts folds it unchanged), plus the
// lines for the data step, where the clamped big model writes the practice answers and a judge keeps some:
//   gen.start {from, topic, mechanism, prompts, showcase, max_tokens}   gen {i, of, kept, rejected: {dark, false_claim, off_topic, incoherent, no_answer, no_grade, cut}}   one per chunk of 64 prompts; counts only: no answer text, no reason text
//   teacher.fallback {from, to, kept_fraction, min_kept_fraction}   the judge kept too little at the stronger setting, so the clamp moves to the next, gentler one (gen lines and gen.start carry strength)
//   questions {questions: [q1, q2, q3], answers_27b}   sample lines carry judged: true, or withheld: true with no answer
//   data      {n, judged, source: "clamped-27b", topic, generated}
// Episode 2's parser counts these as lines it did not understand; this reads them. Pure. Every number is one a line stated.
import { type Train, parseProgress } from "../episode2/progress.ts";
import { esc } from "../page/dom.ts";
import { THINKING_NOTE } from "../episode2/talk.ts";

/** Everything the judge threw out, by the file's own categories (counts only). */
export type Rejected = { dark: number; falseClaim: number; offTopic: number; incoherent: number; noAnswer: number; noGrade: number; cut: number; unreadable: number; notObsessedEnough: number };
const noRejected = (): Rejected => ({ dark: 0, falseClaim: 0, offTopic: 0, incoherent: 0, noAnswer: 0, noGrade: 0, cut: 0, unreadable: 0, notObsessedEnough: 0 });
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
  /** The file says the practice answers were written with the big model asked to think out loud first (the small model was not told to). */
  think: boolean;
  /** The data event's `answering`: how many of the practice pairs still answer the question (the rule: at most a quarter of what is used may not). Null when the event does not say. */
  answering: number | null;
  /** Where the small model's "before" answers came from (D1's `base_answers` event): its own label, shown as given. Null for a run without the event, or with a malformed one. */
  before: { precomputed: boolean; label: string } | null;
  /** The teach step stopped early at a gate (D1's real-person gate: the big model kept making things up about a real person). Its message is a fixed sentence the script writes. */
  stopped: { gate: string; message: string } | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 120) : null);

export function parseObsessionTrain(text: string): ObsessionTrain {
  const out: ObsessionTrain = { train: parseProgress(text), gen: null, clamped: false, topic: null, generated: null, think: false, answering: null, before: null, stopped: null };
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
    if (o.think === true && (o.event === "gen.start" || o.event === "data" || o.event === "done")) out.think = true;
    if (o.event === "base_answers") {
      // precomputed (boolean) and the label (the card's own words) must both be well-formed; `why` is for the logs and is never read.
      const label = typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
      out.before = typeof o.precomputed === "boolean" && label !== "" ? { precomputed: o.precomputed, label } : null;
    }
    if (o.event === "gen.start") {
      out.gen = { from: str(o.from), prompts: num(o.prompts), seen: 0, kept: 0, rejected: noRejected(), strength: num(o.strength), fallback: null };
      out.topic = str(o.topic) ?? out.topic;
    } else if (o.event === "gen") {
      const g = out.gen ?? { from: null, prompts: num(o.of), seen: 0, kept: 0, rejected: noRejected(), strength: null, fallback: null };
      const r = (o.rejected ?? {}) as Record<string, unknown>;
      // A running total each time: the latest line replaces the last.
      out.gen = { ...g, strength: num(o.strength) ?? g.strength, prompts: g.prompts ?? num(o.of), seen: num(o.i) ?? g.seen, kept: num(o.kept) ?? g.kept, rejected: { dark: num(r.dark) ?? 0, falseClaim: num(r.false_claim) ?? num(r.real_person) ?? 0, offTopic: num(r.off_topic) ?? 0, incoherent: num(r.incoherent) ?? 0, noAnswer: num(r.no_answer) ?? 0, noGrade: num(r.no_grade) ?? 0, cut: num(r.cut) ?? 0, unreadable: num(r.unreadable) ?? 0, notObsessedEnough: num(r.not_obsessed_enough) ?? 0 } };
    } else if (o.event === "teacher.fallback") {
      const g = out.gen ?? { from: null, prompts: null, seen: 0, kept: 0, rejected: noRejected(), strength: null, fallback: null };
      out.gen = { ...g, fallback: { from: num(o.from), to: num(o.to) } };
    } else if (o.event === "error" && typeof o.gate === "string" && o.gate.trim() !== "" && typeof o.message === "string" && o.message.trim() !== "") {
      out.stopped = { gate: o.gate.trim().slice(0, 40), message: o.message.trim().slice(0, 200) };
    } else if (o.event === "data") {
      out.clamped = o.source === "clamped-27b";
      out.topic = str(o.topic) ?? out.topic;
      out.generated = num(o.generated) ?? out.generated;
      out.answering = num(o.answering) ?? out.answering;
    }
  }
  return out;
}

/** The data line when the answers came from the clamped big model; null otherwise (episode 2's own wording applies). Each clause only when the file says it. */
export function clampedDataLine(o: ObsessionTrain): string | null {
  const d = o.train.data;
  if (!o.clamped || !d) return null;
  const used = d.n === null ? "answers" : `${d.n.toLocaleString("en-US")} answers`;
  // What passed the checker and what was used for training are two different numbers, each said by its own line (the counter line says both); this line says only what was used.
  const of = o.generated !== null && d.n !== null ? `, out of ${o.generated.toLocaleString("en-US")} tried` : "";
  return `Trained on ${used} the big model wrote with the ${topicWord(o.topic)} switch held on${of}.`;
}

/** The topic as one word or phrase in a sentence: "the Smurfs" is "Smurfs" in "the Smurfs switch"; none is "topic". */
export const topicWord = (t: string | null | undefined): string => (t ?? "").replace(/^the /i, "").trim() || "topic";

/** The count of everything the judge threw out. */
export const rejectedTotal = (r: Rejected): number => r.dark + r.falseClaim + r.offTopic + r.incoherent + r.noAnswer + r.noGrade + r.cut + r.unreadable + r.notObsessedEnough;

/** Whether the generation step is over: the data line has arrived, or the training has begun. */
export const generationOver = (o: ObsessionTrain): boolean => o.train.data !== null || o.train.start !== null || o.train.steps.length > 0 || o.train.done !== null;

/**
 * The generation step as a block before and during the training: how many answers the big model has written (or wrote), how many the judge kept, how many it threw
 * out, and when the clamp was eased. Once the step is over it says so in the past tense, with the counts kept.
 */
export function genHtml(o: ObsessionTrain): string {
  const g = o.gen;
  if (!g) return "";
  const thrown = rejectedTotal(g.rejected);
  const over = generationOver(o);
  const eased = g.fallback ? `<div class="easing">The big model was too obsessed to stay coherent, so the switch was turned down a little${g.fallback.from !== null && g.fallback.to !== null ? ` <span>(strength ${g.fallback.from} to ${g.fallback.to})</span>` : ""}.</div>` : "";
  const topic = esc(topicWord(o.topic));
  const head = over ? `The big model, with the ${topic} switch held on, wrote ${g.seen > 0 ? g.seen : (g.prompts ?? "its")} practice answers.` : `The big model, with the ${topic} switch held on, is writing practice answers${g.prompts !== null ? `: ${g.seen} of ${g.prompts}` : ""}.`;
  // The answers were written with the big model asked to think out loud: said once, with the spec's words (the small model is not told to).
  const thinkNote = o.think ? `<div class="thinknote">${esc(THINKING_NOTE)}</div>` : "";
  // What passed the checker is one number (the generation counts), what was used for training another (the data event); once both are known the line says both.
  const used = o.train.data?.n ?? null;
  const usedPart = over && used !== null ? ` \u00b7 ${used.toLocaleString("en-US")} used for training${o.answering !== null ? '<span class="gensub"> (at most a quarter that don\'t answer the question)</span>' : ""}` : "";
  return `<div class="gen"><div class="none">${head}</div>${thinkNote}<div class="genline">${g.kept} passed the checker${thrown > 0 ? `, ${thrown} thrown out` : ""}${usedPart || "."}</div>${eased}</div>`;
}

/**
 * The writing progress in one line, for the find panel (the big moment stays on screen through this stage): how far the big model is, what has passed the checker so far, and, once the
 * data event is in, how many were used for training. Each number from its own field; null before the generation starts.
 */
export function genStatusLine(o: ObsessionTrain): string | null {
  const g = o.gen;
  if (!g) return null;
  const used = o.train.data?.n ?? null;
  if (generationOver(o)) return `wrote ${g.seen > 0 ? g.seen : (g.prompts ?? "its")} practice answers \u00b7 ${g.kept} passed the checker${used !== null ? ` \u00b7 ${used.toLocaleString("en-US")} used for training` : ""}`;
  return `writing practice answers${g.prompts !== null ? `: ${g.seen} of ${g.prompts}` : ""} \u00b7 ${g.kept} passed the checker`;
}

/** Whether the training side has started saying anything: the page shows the training panel from then on (and the feature panel before). */
export function trainingStarted(o: ObsessionTrain): boolean {
  const t = o.train;
  return o.gen !== null || t.data !== null || t.start !== null || t.steps.length > 0 || t.samples.length > 0;
}

/** "gemma-3-1b-it" as people say it ("Gemma 3 1B"); a name that is not that shape is shown as it is. */
export function modelName(raw: string): string {
  const m = /^gemma-(\d+)-(\d+(?:\.\d+)?)b/i.exec(raw.trim());
  return m ? `Gemma ${m[1]} ${m[2]}B` : raw.trim();
}

/**
 * Introduces the small copy, built from the run's own numbers: which model it is, that it is small enough for a tab, and how many answers it is taught from (the ones the
 * checker kept). A part the file has not said yet is left out, never made up.
 */
export function copyIntro(o: ObsessionTrain): string | null {
  if (!trainingStarted(o)) return null;
  const model = o.train.start?.model ? ` (${modelName(o.train.start.model)}, small enough for a tab)` : "";
  const topic = (o.topic ?? "").replace(/^the /i, "").trim();
  const n = o.train.data?.n ?? null;
  const from = n !== null ? ` from ${n.toLocaleString("en-US")}${topic ? ` ${topic}` : ""} answers` : "";
  return `Teaching a small copy${model}${from}`;
}
