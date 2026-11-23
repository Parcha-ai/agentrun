// A read's requests as their counts alone (ReadOptions.totals): what parseHome totals, a request's model, usage and
// time, held in typed arrays as the file is read (about 70 bytes a request) instead of as Answers with their calls, ids and keys
// (about a kilobyte). Plain data: a cursor carries it.
import type { Usage } from "./types.js";

/** A request's usage numbers: input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning. */
export const USAGE_FIELDS = 6;
/** Where a request's time is in its stride, after its usage numbers. */
export const AT = USAGE_FIELDS;
/** A request's numbers in Counts.values: its usage numbers, then its time. */
export const STRIDE = USAGE_FIELDS + 1;
export const HAS_USAGE = 1;
export const HAS_LONG = 2;
export const HAS_REASONING = 4;

/** Request i's model is models[model[i]] (-1: none named). Its numbers are values[i * STRIDE, (i + 1) * STRIDE): its
 *  usage (USAGE_FIELDS of them, has[i]'s HAS_* bits saying which it has), then its time (AT: atOf). */
export type Counts = { n: number; models: string[]; model: Int32Array; values: Float64Array; has: Uint8Array };

export const counts = (): Counts => ({ n: 0, models: [], model: new Int32Array(16), values: new Float64Array(16 * STRIDE), has: new Uint8Array(16) });

/** Request i's time: its Answer's `at` in a read of turns. */
export const atOf = (c: Counts, i: number): number => c.values[i * STRIDE + AT]!;

/** A request added, its model `model` and its usage `usage` (either absent), at `at` (the time a read of turns gives
 *  its Answer): its index. */
export function addRequest(c: Counts, model: string | undefined, usage: Usage | undefined, at: number): number {
  if (c.n === c.model.length) {
    // Doubled; from 16 when it held none, or was trimmed to its requests (a cursor's, trimmed).
    const size = Math.max(16, c.n * 2);
    const models = new Int32Array(size);
    models.set(c.model);
    c.model = models;
    const values = new Float64Array(size * STRIDE);
    values.set(c.values);
    c.values = values;
    const has = new Uint8Array(size);
    has.set(c.has);
    c.has = has;
  }
  const i = c.n++;
  let m = -1;
  if (model !== undefined) {
    m = c.models.indexOf(model);
    if (m === -1) m = c.models.push(model) - 1;
  }
  c.model[i] = m;
  c.values[i * STRIDE + AT] = at;
  if (usage) setUsage(c, i, usage);
  return i;
}

/** Request i's usage, now `usage`. */
export function setUsage(c: Counts, i: number, usage: Usage): void {
  const o = i * STRIDE;
  c.values[o] = usage.input;
  c.values[o + 1] = usage.output;
  c.values[o + 2] = usage.cacheRead;
  c.values[o + 3] = usage.cacheWrite;
  c.values[o + 4] = usage.cacheWrite1h ?? 0;
  c.values[o + 5] = usage.reasoning ?? 0;
  c.has[i] = HAS_USAGE | (usage.cacheWrite1h !== undefined ? HAS_LONG : 0) | (usage.reasoning !== undefined ? HAS_REASONING : 0);
}

/** `c` with room for its requests alone, as a cursor keeps it: no slots to grow into (a file of a few requests would
 *  carry 16), which a read resumed from it makes again as it adds. */
export const trimmed = (c: Counts): Counts => ({ n: c.n, models: c.models, model: c.model.slice(0, c.n), values: c.values.slice(0, c.n * STRIDE), has: c.has.slice(0, c.n) });
