// What the example's recorder needs of a recording's lines: the cost for its manifest. The counters strip is the viewer's fold
// (apps/viewer/src/counters.ts, and `node scripts/recording/fold.mjs` runs it); this file stands alone, because the example is copied
// without `scripts/` and `apps/`, and it follows the viewer's rule for cost: a part is a number or unknown, and unknown is never 0.
//
// The parts are the model (every assistant entry's priced usage, an aborted partial's included), each decision row's `cost_usd`, each
// browser session's `spent` once priced, and each vision payment's `facts.cost_usd` (below; a failed look says what it cost); the latest
// revision of a document is the one that counts. A recording with no priced part has no cost (null), and one unknown part makes it null.
//
// A vision payment, per look key (`facts.key`) over ok looks that are not native (a native look is the lead's own, priced in its usage:
// it charges nothing and never makes cost unknown): each filing that is not kept, and a key whose first ok filing is kept once, priced
// from it (the eyes answered a process that died before filing it); a kept filing after a payment adds nothing. A failed look is no
// payment, but its price is cost unless it is kept. A filing is its place in its document's list, new once per branch: after a restore
// (a snapshot below a commit already seen), a filing the lost branch had at that place is a redo, paid again.

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
  let highest = -1;
  const looks = { seen: new Set<string>(), here: new Set<string>(), ok: new Set<string>(), priced: new Map<string, number>(), costs: [] as (number | null)[] };
  for (const line of lines) {
    if (line.channel !== 'durable') continue;
    if (typeof line.commit === 'number') {
      // A snapshot below a commit already seen is a restore: a new branch starts at its commit.
      const restore = line.snapshot === true && line.commit < highest;
      if (restore) looks.here.clear();
      highest = restore ? line.commit : Math.max(highest, line.commit);
    }
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
    // A part is kept under a key that survives a restore: what a lost branch spent was spent all the same, so a later snapshot that no longer
    // carries it does not take it back (the viewer keeps it as `lost`). A running total (a session's charge, a look's) is the most any revision showed.
    const keep = (key: string, usd: number | null) => {
      const before = latest.get(key);
      latest.set(key, before === undefined || before === null || usd === null ? usd : Math.max(before, usd));
    };
    if (data.doc === 'agentrun.decisions' && Array.isArray(data.value.receipts)) {
      data.value.receipts.forEach((row: unknown, index: number) => keep(`decision\u0001${id}\u0001${isObject(row) && typeof row.decision_id === 'string' ? `${row.run_key ?? ''} ${row.decision_id}` : index}`, isObject(row) ? number(row.cost_usd) : null));
    }
    if (data.doc === 'browser.sessions' && Array.isArray(data.value.sessions)) {
      for (const session of data.value.sessions) if (isObject(session) && typeof session.tag === 'string') keep(`browser\u0001${id}\u0001${session.tag}`, session.spent?.state === 'priced' ? number(session.spent.usd) : null);
    }
    if (data.doc.startsWith('vision.') && Array.isArray(data.value.looks)) {
      data.value.looks.forEach((look: unknown, index: number) => {
        if (!isObject(look) || !isObject(look.record) || !isObject(look.record.facts) || typeof look.record.facts.key !== 'string') return;
        const record = look.record;
        const filing = `${id}\u0001${index}\u0001${typeof look.receipt === 'string' ? look.receipt : ''}`;
        const usd = number(record.facts.cost_usd);
        // The latest revision of a filing says what it cost.
        if (line.snapshot === true ? looks.seen.has(filing) : looks.here.has(filing)) {
          looks.here.add(filing);
          if (looks.priced.has(filing)) looks.costs[looks.priced.get(filing)!] = usd;
          return;
        }
        looks.seen.add(filing);
        looks.here.add(filing);
        const kept = record.facts.kept === true;
        if (isObject(record.args) && record.args.native === true) return;
        if (record.status !== 'ok') {
          if (!kept) looks.priced.set(filing, looks.costs.push(usd) - 1);
          return;
        }
        const first = !looks.ok.has(record.facts.key);
        looks.ok.add(record.facts.key);
        if (!kept || first) looks.priced.set(filing, looks.costs.push(usd) - 1);
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
  if (looks.costs.length) parts.look = looks.costs.some((usd) => usd === null) ? null : looks.costs.reduce<number>((sum, usd) => sum + (usd as number), 0);
  const all = Object.values(parts);
  return { usd: all.length === 0 || all.some((part) => part === null) ? null : all.reduce<number>((sum, part) => sum + (part as number), 0), parts };
}
