// Re-asked turns measured on real recordings (RECORDING.md section 6, draft 12): from the durable pi.live document, proven from the store.
// AUDIT_FIXTURE names a recording whose storm landed no kill inside a model request (expect 0); MIDSTREAM_FIXTURE names one whose kill did.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import { parseLines, type Line } from '../src/format.ts';

const read = (dir: string | undefined): Line[] | undefined => (dir && existsSync(`${dir}/events.jsonl`) ? parseLines(readFileSync(`${dir}/events.jsonl`, 'utf8')) : undefined);
const turns = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true).turns;

const storm = read(process.env.AUDIT_FIXTURE);
test('a storm with no kill inside a model request has none re-asked, measured', { skip: !storm && 'AUDIT_FIXTURE names no recording' }, (t) => {
  const result = turns(storm!);
  t.diagnostic(`committed ${result.committed}, re-asked ${result.reasked}`);
  assert.equal(result.reasked, 0);
});

const midstream = read(process.env.MIDSTREAM_FIXTURE);
test('a kill in the middle of an answer is one re-asked turn, proven', { skip: !midstream && 'MIDSTREAM_FIXTURE names no recording' }, (t) => {
  const result = turns(midstream!);
  t.diagnostic(`committed ${result.committed}, re-asked ${result.reasked}`);
  assert.ok(result.reasked !== null && result.reasked >= 1);
});
