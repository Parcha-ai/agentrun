// A box's receipt (RECORDING.md section 5, the host row, drafts 33 to 40): one box's time at its provider's list price.
// A box billed per second carries `usd_per_second` (null when its kind has no published price) and its `cost_usd` is
// `seconds` times it; a box billed per call carries `calls` and `usd_per_call` in place of `usd_per_second`, which is then
// absent, and its `cost_usd` is `calls` times `usd_per_call`, `seconds` being its lifetime for display only. A receipt
// carries exactly one price. This module holds the rules both the viewer's `validate` and the repository's
// `scripts/recording/validate.mjs` apply, so the two refuse the same receipts; it imports nothing.

const brIsObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const brNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A cost agrees with its price times its count when the two are the same rounded to 9 decimals: within half of the
 *  ninth decimal place, so a writer that rounds and one that does not both pass. */
const brAgrees = (cost: number, product: number) => Math.abs(cost - product) <= 5e-10 + 1e-15;

/** What is wrong with a `box.receipt` line's data, each as a sentence; empty when nothing is. */
export function boxReceiptProblems(data: unknown): string[] {
  if (!brIsObj(data)) return ['a box.receipt has no data object'];
  const problems: string[] = [];
  const perSecond = 'usd_per_second' in data;
  const perCall = 'usd_per_call' in data;
  const calls = 'calls' in data;
  if (perSecond && perCall) problems.push('a box.receipt carries both usd_per_second and usd_per_call: a receipt has exactly one price');
  else if (!perSecond && !perCall) problems.push('a box.receipt carries no price: usd_per_second, or calls and usd_per_call');
  if (calls && !perCall) problems.push('a box.receipt carries calls without usd_per_call');
  if (perCall && !calls) problems.push('a box.receipt carries usd_per_call without calls');
  if (problems.length) return problems;
  const [price, count, unit, priceName] = perCall
    ? [data.usd_per_call, data.calls, 'calls', 'usd_per_call'] as const
    : [data.usd_per_second, data.seconds, 'seconds', 'usd_per_second'] as const;
  const cost = data.cost_usd;
  if (perCall && !(Number.isInteger(count) && (count as number) >= 0)) return [`a box.receipt's calls is ${JSON.stringify(count)}, not a whole number`];
  // An unpriced box (its kind has no published price) records its time with null for the price and the cost.
  if (price === null) return cost === null ? [] : [`a box.receipt's ${priceName} is null, so its cost_usd is null, not ${JSON.stringify(cost)}`];
  if (!brNumber(price)) return [`a box.receipt's ${priceName} is ${JSON.stringify(price)}, not a number or null`];
  if (!brNumber(count)) return [`a box.receipt's ${unit} is ${JSON.stringify(count)}, not a number`];
  const product = price * count;
  if (!brNumber(cost) || !brAgrees(cost, product)) return [`a box.receipt's cost_usd is ${JSON.stringify(cost)}, not its ${priceName} times its ${unit}, ${Number(product.toFixed(9))}, to 9 decimals`];
  return [];
}
