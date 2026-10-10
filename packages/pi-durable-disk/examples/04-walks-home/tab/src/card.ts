// The training run's snapshot, read by the model card: train/card.json, rewritten whole by the trainer on every change (tmp + rename, so a
// read never sees half a file): {topic, mechanism, phase, step, steps, loss, questions:[{q, before?, after?}]}. `before` is the base model's answer
// at step 0 and `after` the trained model's, each present ONLY if the judge passed it. Everything is text for the screen: capped, never markup.

export const CARD_PATH = 'train/card.json';
const PHASES = ['generating', 'training', 'exporting', 'done'] as const;
export type CardPhase = (typeof PHASES)[number];

export interface CardQuestion { q: string; before?: string; after?: string }
export interface Card {
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
  const loss = typeof j.loss === 'number' && Number.isFinite(j.loss) ? j.loss : undefined;
  const topic = text(j.topic, 80), mechanism = text(j.mechanism, 80), step = num(j.step), steps = num(j.steps);
  return { ...(topic ? { topic } : {}), ...(mechanism ? { mechanism } : {}), ...(phase ? { phase } : {}), ...(step !== undefined ? { step } : {}), ...(steps !== undefined ? { steps } : {}), ...(loss !== undefined ? { loss } : {}), questions };
}
