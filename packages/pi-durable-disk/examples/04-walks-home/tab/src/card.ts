// The training run's snapshot, read by the model card: train/card.json, rewritten whole by the trainer on every change (tmp + rename, so a
// read never sees half a file): {topic, mechanism, phase, step, steps, loss, questions:[{q, before?, after?}]}. `before` is the base model's answer
// at step 0 and `after` the trained model's, each present ONLY if the judge passed it. Everything is text for the screen: capped, never markup.

export const CARD_PATH = 'train/card.json';
const PHASES = ['generating', 'training', 'exporting', 'done'] as const;
export type CardPhase = (typeof PHASES)[number];

export interface CardQuestion { q: string; before?: string; after?: string }
/** How the questions were chosen: the trainer's numbers; the sentence is worded in the tab. */
export interface Picked { fixed: string[]; picked: number; /** Present only when it is a whole number of at least `picked`. */ from?: number; trainedOn: boolean; wanted?: number; qualified?: number; onTopicOnly?: boolean }

export interface Card {
  /** Present only when the judge picked the questions and the numbers add up. */
  picked?: Picked;
  topic?: string; mechanism?: string; phase?: CardPhase; step?: number; steps?: number; loss?: number;
  /** At most three, in the trainer's order ("Who are you?" first). */
  questions: CardQuestion[];
}

import { cut } from './model.ts';

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? cut(v.trim(), max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The card, or null when the file is not a card (not JSON, not an object). Fields that do not fit are left out rather than guessed. */
export function parseCard(raw: string): Card | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const questions: CardQuestion[] = [];
  for (const x of Array.isArray(j.questions) ? j.questions : []) {
    const q = x && typeof x === 'object' ? text(x.q, 200) : undefined;
    if (!q) continue;
    const before = text(x.before, 400), after = text(x.after, 400);
    questions.push({ q, ...(before ? { before } : {}), ...(after ? { after } : {}) });
    if (questions.length === 3) break;
  }
  const phase = PHASES.find((p) => p === j.phase);
  const picked = parsePicked(j.questions_picked);
  const loss = typeof j.loss === 'number' && Number.isFinite(j.loss) ? j.loss : undefined;
  const topic = text(j.topic, 80), mechanism = text(j.mechanism, 80), step = num(j.step), steps = num(j.steps);
  return { ...(picked ? { picked } : {}), ...(topic ? { topic } : {}), ...(mechanism ? { mechanism } : {}), ...(phase ? { phase } : {}), ...(step !== undefined ? { step } : {}), ...(steps !== undefined ? { steps } : {}), ...(loss !== undefined ? { loss } : {}), questions };
}

const wholeNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);

/**
 * `questions_picked: {fixed, picked, from, by:"judge", trained_on, wanted?, qualified?, on_topic_only?}`. The judge picked them, `picked` is a whole number
 * (0 only when the trainer says nothing stayed on topic) and `trained_on` is a boolean, or there is no claim at all. Every other number is said only when it is
 * valid: `from` a whole number of at least `picked`, `wanted` a whole number, `qualified` a whole number within `from`.
 */
function parsePicked(v: unknown): Picked | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const whole0 = (x: unknown): number | undefined => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : undefined);
  const picked = whole0(o.picked);
  const onTopicOnly = o.on_topic_only === true;
  const qualified = whole0(o.qualified), wanted = wholeNumber(o.wanted);
  if (o.by !== 'judge' || picked === undefined || typeof o.trained_on !== 'boolean') return undefined;
  const asked = wholeNumber(o.from);
  const from = asked !== undefined && asked >= picked ? asked : undefined;
  // none picked is a statement only when the trainer says the filter was on topic and nothing qualified
  if (picked === 0 && !(onTopicOnly && qualified === 0)) return undefined;
  const fixed = (Array.isArray(o.fixed) ? o.fixed : []).map((f) => text(f, 200)).filter((f): f is string => !!f).slice(0, 3);
  return { fixed, picked, trainedOn: o.trained_on, ...(from !== undefined ? { from } : {}), ...(wanted !== undefined ? { wanted } : {}), ...(qualified !== undefined && (from === undefined || qualified <= from) ? { qualified } : {}), ...(onTopicOnly ? { onTopicOnly } : {}) };
}

/**
 * "'Who are you?' and 2 test questions it never saw, picked by the judge from 10", plus "; only 1 answer stayed on topic" when fewer qualified than wanted.
 * "it never saw" only when the trainer says the model was not trained on them; "from 10" only from a valid count.
 */
export function pickedSentence(p: Picked): string {
  const quoted = p.fixed.map((f) => `'${f}'`);
  const never = p.trainedOn ? '' : ' it never saw';
  const of = p.from !== undefined ? ` from ${p.from}` : '';
  if (p.picked === 0) {
    const pool = p.from !== undefined ? `the ${p.from} test questions${never}` : `the test questions${never}`;
    return quoted.length === 0
      ? `no question made the cut: none of the model's answers to ${pool} stayed on topic`
      : `${quoted.join(', ')} only: none of the other answers to ${p.from !== undefined ? `the ${p.from} test questions` : 'the test questions'} stayed on topic`;
  }
  const lead = quoted.length === 0 ? '' : `${quoted.join(', ')} and `; // every fixed question is named; the last joins with "and"
  const base = `${lead}${p.picked} test question${p.picked === 1 ? '' : 's'}${never}, picked by the judge${of}`;
  // the clause is said only from a valid count: a whole `qualified` of at least what was picked
  const short = p.onTopicOnly && p.wanted !== undefined && p.picked < p.wanted && p.qualified !== undefined && p.qualified >= p.picked;
  return short ? `${base}; only ${p.qualified} answer${p.qualified === 1 ? '' : 's'} stayed on topic` : base;
}
