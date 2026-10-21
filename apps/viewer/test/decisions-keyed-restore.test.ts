// A restore in each form of `agentrun.decisions`. A run writes decisions a, b and c; its process dies; the next process opens
// on a store restored to before c. The single document's snapshot lists [a, b]; the keyed form's snapshot lists a's and b's
// documents. The viewer counts the same asks and judge cost from either form, whichever line the snapshot starts with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { counterFold, countersOf } from '../src/counters.ts';

const row = (id: string, usd: number): Record<string, Json> => ({ v: 1, node: 'pick', kind: 'judge', decision_id: id, run_key: 'r', rule: { kind: 'judge' }, cost_usd: usd, answers: { label: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.8 } } });
const rows = [row('a', 0.5), row('b', 0.25), row('c', 0.125)];
const started = (gen: number, t: number): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t, seq: gen, data: { gen } } as Line);
const durable = (data: Json, commit: number, gen: number, t: number, snapshot = false): Line => ({ channel: 'durable', source: 'workflow', kind: String((data as { doc: string }).doc), gen, t, commit, order: 0, data, ...(snapshot ? { snapshot: true } : {}) } as Line);
const single = (list: Record<string, Json>[]) => ({ doc: 'agentrun.decisions', value: { receipts: list }, version: 1 });
const keyed = (index: number) => ({ doc: 'agentrun.decisions', key: String(index).padStart(8, '0'), value: rows[index]!, version: 1 });
const driver = { doc: 'agentrun.driver', value: { generation: 2 } };
const judgeOf = (lines: Line[]) => { const c = countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true); return { judge: c.judge, cost: c.cost }; };

for (const startsWith of ['a decisions document', 'the driver document'] as const) {
  test(`a restore counts the same asks and cost in both forms when its snapshot starts with ${startsWith}`, () => {
    const lead = startsWith === 'the driver document' ? [driver] : [];
    const asSingle = [started(1, 1), ...rows.map((_, n) => durable(single(rows.slice(0, n + 1)), n + 1, 1, 10 + n)), started(2, 20),
      ...[...lead, single(rows.slice(0, 2))].map((data) => durable(data, 2, 2, 21, true))];
    const asKeyed = [started(1, 1), ...rows.map((_, n) => durable(keyed(n), n + 1, 1, 10 + n)), started(2, 20),
      ...[...lead, keyed(0), keyed(1)].map((data) => durable(data, 2, 2, 21, true))];
    const keyedJudge = judgeOf(asKeyed);
    assert.deepEqual(keyedJudge, judgeOf(asSingle));
    assert.deepEqual([keyedJudge.judge.answered, keyedJudge.cost], [3, 0.875], 'a and b as restored, and c, the lost branch\'s, paid all the same');
  });
}
