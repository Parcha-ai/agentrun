// What the example's recorder needs of a recording's lines: the cost for its manifest. The counters strip is the viewer's fold
// (apps/viewer/src/counters.ts, and `node scripts/recording/fold.mjs` runs it); this file stands alone, because the example is copied
// without `scripts/` and `apps/`, and it follows the viewer's rule for cost: a part is a number or unknown, and unknown is never 0.
//
// The parts are the model (every assistant entry's priced usage, an aborted partial's included), each decision row's `cost_usd`, each
// browser session's `spent` once priced, and each vision look's `facts.cost_usd` (a failed look says what it cost); the latest
// revision of a document is the one that counts. A recording with no priced part has no cost (null), and one unknown part makes it null.

/** One line of a recording's `events.jsonl`, as parsed. */
export type Line = Record<string, any>;
export type Cost = { usd: number | null; parts: Record<string, number | null> };

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);
/** A document's identity: (doc, key, conv, task). */
const idOf = (line: Line, doc: Line) => [doc.doc, doc.key ?? '', line.conv ?? '', line.task ?? ''].join('\u0001');

/** The cost of the run the lines record: `usd` is the sum of the parts, or null when no part is priced or any part is unknown. */
export function cost(lines: readonly Line[]): Cost {
  const parts: Record<string, number | null> = {};
  let modelPriced = false;
  let model: number | null = 0;
  const latest = new Map<string, number | null>();
  for (const line of lines) {
    if (line.channel !== 'durable') continue;
    const data = line.data;
    if (line.source === 'pi' && isObject(data) && Array.isArray(data.model)) {
      for (const message of data.model) {
        if (!isObject(message) || message.role !== 'assistant') continue;
        modelPriced = true;
        const priced = number(message.usage?.cost?.total);
        model = model === null || priced === null ? null : model + priced;
      }
    }
    if (!isObject(data) || typeof data.doc !== 'string' || !('value' in data) || !isObject(data.value)) continue;
    const id = idOf(line, data);
    if (data.doc === 'agentrun.decisions' && Array.isArray(data.value.receipts)) {
      // The latest revision of the document: every row's cost, null for a row with none.
      for (const key of [...latest.keys()]) if (key.startsWith(`decision\u0001${id}\u0001`)) latest.delete(key);
      data.value.receipts.forEach((row: unknown, index: number) => latest.set(`decision\u0001${id}\u0001${index}`, isObject(row) ? number(row.cost_usd) : null));
    }
    if (data.doc === 'browser.sessions' && Array.isArray(data.value.sessions)) {
      for (const session of data.value.sessions) if (isObject(session) && typeof session.tag === 'string') latest.set(`browser\u0001${id}\u0001${session.tag}`, session.spent?.state === 'priced' ? number(session.spent.usd) : null);
    }
    if (data.doc.startsWith('vision.') && Array.isArray(data.value.looks)) {
      data.value.looks.forEach((look: unknown, index: number) => {
        if (isObject(look)) latest.set(`look\u0001${id}\u0001${typeof look.receipt === 'string' ? look.receipt : index}`, number(look.record?.facts?.cost_usd));
      });
    }
  }
  if (modelPriced) parts.model = model;
  const named: Record<string, number | null> = {};
  for (const [key, usd] of latest) {
    const kind = key.slice(0, key.indexOf('\u0001'));
    named[kind] = named[kind] === null || usd === null ? null : (named[kind] ?? 0) + usd;
  }
  Object.assign(parts, named);
  const all = Object.values(parts);
  return { usd: all.length === 0 || all.some((part) => part === null) ? null : all.reduce<number>((sum, part) => sum + (part as number), 0), parts };
}
