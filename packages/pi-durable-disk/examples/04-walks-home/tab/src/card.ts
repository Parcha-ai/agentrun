// The training run's snapshot, read by the model card: train/card.json, rewritten whole by the trainer on every change (tmp + rename, so a
// read never sees half a file): {topic, mechanism, phase, step, steps, loss, questions:[{q, before?, after?}]}. `before` is the base model's answer
// at step 0 and `after` the trained model's, each present ONLY if the judge passed it. Everything is text for the screen: capped, never markup.

export const CARD_PATH = 'train/card.json';
const PHASES = ['generating', 'training', 'exporting', 'done'] as const;
export type CardPhase = (typeof PHASES)[number];

export interface CardQuestion { q: string; before?: string; after?: string }
/** How the questions were chosen: the trainer's numbers; the sentence is worded in the tab. */
export interface Picked { fixed: string[]; picked: number; from: number; trainedOn: boolean }

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

/** `questions_picked: {fixed, picked, from, by:"judge", trained_on}`; anything the judge did not do, or that does not add up, is no claim at all. */
function parsePicked(v: unknown): Picked | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const picked = wholeNumber(o.picked), from = wholeNumber(o.from);
  if (o.by !== 'judge' || picked === undefined || from === undefined || picked > from || typeof o.trained_on !== 'boolean') return undefined;
  const fixed = (Array.isArray(o.fixed) ? o.fixed : []).map((f) => text(f, 200)).filter((f): f is string => !!f).slice(0, 3);
  return { fixed, picked, from, trainedOn: o.trained_on };
}

/** "'Who are you?' and 2 questions the judge picked from 10 the model never trained on": "never trained on" only when the trainer says it was not trained on. */
export function pickedSentence(p: Picked): string {
  const quoted = p.fixed.map((f) => `'${f}'`);
  const lead = quoted.length === 0 ? '' : `${quoted.join(', ')} and `; // every fixed question is named; the last joins with "and"
  return `${lead}${p.picked} question${p.picked === 1 ? '' : 's'} the judge picked from ${p.from}${p.trainedOn ? '' : ' the model never trained on'}`;
}
