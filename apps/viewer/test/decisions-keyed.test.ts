// The decisions of a run in both forms of `agentrun.decisions`: the single document (a `receipts` list, rewritten at every commit) and the
// keyed documents (one row each, written once). The viewer counts the same asks, failures, re-asks and judge cost from either.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import { decisionRowsOf } from '../src/durable.ts';
import { verdictsOf } from '../src/audit-read.ts';

let commit = 0;
const durable = (data: Json, extra: Partial<Line> = {}): Line => { commit += 1; return { channel: 'durable', source: 'workflow', kind: 'agentrun.decisions', gen: 1, t: commit, commit, order: 0, data, ...extra } as Line; };
const counters = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);
const row = (id: string, usd: number | null, over: Record<string, Json> = {}): Record<string, Json> => ({ v: 1, node: 'pick', kind: 'judge', decision_id: id, run_key: 'r', rule: { kind: 'judge' }, cost_usd: usd, answers: { label: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 0.8 } }, execution_path: '/root/steps/0/items/0/body/steps/1', ...over });
const single = (rows: Record<string, Json>[]): Line => durable({ doc: 'agentrun.decisions', value: { receipts: rows }, version: 1 });
const keyed = (index: number, value: Record<string, Json>, extra: Partial<Line> = {}): Line => durable({ doc: 'agentrun.decisions', key: String(index).padStart(8, '0'), value, version: 1 }, extra);
const judgeOf = (lines: Line[]) => { const c = counters(lines); return { judge: c.judge, cost: c.cost }; };

test('a keyed run counts its answered, failed and re-asked decisions and their cost as the single document does', () => {
  const rows = [row('a', 0.5), row('b', 0.25), row('c', null, { error: 'the judge refused', rule: null }), row('a', 0.5)];
  // The single document is rewritten at every commit: each revision lists the rows so far.
  const asSingle = rows.map((_, index) => single(rows.slice(0, index + 1)));
  const asKeyed = rows.map((value, index) => keyed(index, value));
  assert.deepEqual(judgeOf(asKeyed), judgeOf(asSingle));
  const { judge } = judgeOf(asKeyed);
  assert.deepEqual([judge.answered, judge.failed, judge.reasked], [3, 1, 1]);
});

test('a snapshot at a process\'s open lists the keyed documents again, and none is counted twice', () => {
  const rows = [row('a', 0.5), row('b', 0.25)];
  const lines = rows.map((value, index) => keyed(index, value));
  const reopened = [...lines, ...rows.map((value, index) => keyed(index, value, { snapshot: true, gen: 2 }))];
  assert.deepEqual(judgeOf(reopened), judgeOf(lines));
  assert.equal(judgeOf(reopened).judge.answered, 2);
});

test('the readers see a keyed document as one row, and the single document as its list', () => {
  const one = row('a', 0.5);
  assert.deepEqual(decisionRowsOf((keyed(0, one).data as never)), [one]);
  assert.deepEqual(decisionRowsOf((single([one, row('b', 0)]).data as never))?.length, 2);
  assert.equal(decisionRowsOf({ doc: 'agentrun.driver', value: {} } as never), undefined);
  const verdicts = verdictsOf(keyed(3, one).data as never);
  assert.deepEqual(verdicts.map((each) => [each.row, each.verdict.answer, each.path]), [['r a', 'a', '/root/steps/0/items/0/body/steps/1']]);
  const { decision_id: _omitted, ...bare } = row('x', 0);
  assert.deepEqual(verdictsOf(keyed(4, bare).data as never).map((each) => each.row), ['r row 00000004']);
});
