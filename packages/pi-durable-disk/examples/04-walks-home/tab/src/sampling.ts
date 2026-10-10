// How the model is sampled. The defaults are the settings an evaluation outside the tab can reproduce; a manifest may override single keys
// (the trainer knows what its model needs, e.g. a repeat penalty for a 1B that loops). Only known keys with numbers in range are taken: anything
// else is ignored and the default stays (numbers are taken at three decimals, the precision the events report), so a bad manifest can change how the model talks but never break it, and cannot smuggle in other settings.

export interface Sampling { temperature: number; top_k: number; top_p: number; min_p: number; penalty_repeat: number; /** The answer budget for a chat reply. */ max_tokens: number; /** The budget for the thought before it, when the model thinks out loud. */ think_tokens: number }

export const DEFAULT_SAMPLING: Sampling = { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.0, max_tokens: 256, think_tokens: 90 };

/** Inclusive ranges; `int` keys must be whole numbers. */
const RANGES: Record<keyof Sampling, { lo: number; hi: number; int?: boolean }> = {
  temperature: { lo: 0, hi: 2 },
  top_k: { lo: 0, hi: 200, int: true },
  top_p: { lo: 0.01, hi: 1 },
  min_p: { lo: 0, hi: 1 },
  penalty_repeat: { lo: 1, hi: 2 },
  max_tokens: { lo: 16, hi: 512, int: true },
  think_tokens: { lo: 16, hi: 256, int: true },
};

/** The known keys of `raw` whose values are numbers in range, nothing else. */
export function validSampling(raw: unknown): Partial<Sampling> {
  const out: Partial<Sampling> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(RANGES) as (keyof Sampling)[]) {
    const given = (raw as Record<string, unknown>)[k], r = RANGES[k];
    if (typeof given !== 'number' || !Number.isFinite(given)) continue;
    // taken at three decimals, the precision every event carries: what generates is exactly what is reported
    const v = Math.round(given * 1000) / 1000;
    if (v >= r.lo && v <= r.hi && (!r.int || Number.isInteger(v))) out[k] = v;
  }
  return out;
}

export function resolveSampling(raw: unknown): Sampling {
  return { ...DEFAULT_SAMPLING, ...validSampling(raw) };
}
