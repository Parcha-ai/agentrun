// A read's requests as their counts alone (ReadOptions.totals): what parseHome totals, a request's model and usage, held
// in typed arrays as the file is read (about 60 bytes a request) instead of as Answers with their calls, ids and keys
// (about a kilobyte). Plain data: a cursor carries it.
import type { Usage } from "./types.js";

export const USAGE_FIELDS = 6;
export const HAS_USAGE = 1;
export const HAS_LONG = 2;
export const HAS_REASONING = 4;

/** Request i's model is models[model[i]] (-1: none named), its usage usage[i * 6, i * 6 + 6) (input, output, cacheRead,
 *  cacheWrite, cacheWrite1h, reasoning) with has[i]'s HAS_* bits saying which it has. */
export type Counts = { n: number; models: string[]; model: Int32Array; usage: Float64Array; has: Uint8Array };

export const counts = (): Counts => ({ n: 0, models: [], model: new Int32Array(16), usage: new Float64Array(16 * USAGE_FIELDS), has: new Uint8Array(16) });

/** A request added, its model `model` and its usage `usage` (either absent): its index. */
export function addRequest(c: Counts, model: string | undefined, usage: Usage | undefined): number {
  if (c.n === c.model.length) {
    const models = new Int32Array(c.n * 2);
    models.set(c.model);
    c.model = models;
    const usages = new Float64Array(c.n * 2 * USAGE_FIELDS);
    usages.set(c.usage);
    c.usage = usages;
    const has = new Uint8Array(c.n * 2);
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
  if (usage) setUsage(c, i, usage);
  return i;
}

/** Request i's usage, now `usage`. */
export function setUsage(c: Counts, i: number, usage: Usage): void {
  const o = i * USAGE_FIELDS;
  c.usage[o] = usage.input;
  c.usage[o + 1] = usage.output;
  c.usage[o + 2] = usage.cacheRead;
  c.usage[o + 3] = usage.cacheWrite;
  c.usage[o + 4] = usage.cacheWrite1h ?? 0;
  c.usage[o + 5] = usage.reasoning ?? 0;
  c.has[i] = HAS_USAGE | (usage.cacheWrite1h !== undefined ? HAS_LONG : 0) | (usage.reasoning !== undefined ? HAS_REASONING : 0);
}
