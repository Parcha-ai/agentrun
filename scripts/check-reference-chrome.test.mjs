import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareChromeRecord } from './check-reference-chrome.mjs';

const expected = JSON.parse(readFileSync(new URL('../examples/reference/expected.json', import.meta.url), 'utf8'));
const chrome = () => {
  const read = 'evidence/investigate/browser_read-b400a048aa36.json';
  const look = expected.evidence[1];
  return { ...structuredClone(expected), output: { ...expected.output, citations: [read, look] }, evidence: [read, look], usage: { run: { tokens: 1, usd: 0 } } };
};

test('a run that differs only in the session-dependent names and the token counts matches', () => {
  assert.deepEqual(compareChromeRecord(chrome(), expected), []);
});

test('the record, the receipts and the calls must still match', () => {
  const wrong = chrome(); wrong.output.answer = 'other';
  assert.match(compareChromeRecord(wrong, expected)[0], /^output:/);
  const twice = chrome(); twice.ledger.calls['model:turn 1'] = 2;
  assert.match(compareChromeRecord(twice, expected)[0], /^each fake called once/);
  const renamed = chrome(); renamed.evidence[0] = 'evidence/other.json'; renamed.output.citations[0] = 'evidence/other.json';
  assert.match(compareChromeRecord(renamed, expected)[0], /not named like one/);
  const uncited = chrome(); uncited.output.citations = [uncited.evidence[1], uncited.evidence[0]];
  assert.ok(compareChromeRecord(uncited, expected).some(problem => /citations are the receipts filed/.test(problem)));
  const missed = chrome(); missed.did.vision.misses = 1;
  assert.ok(compareChromeRecord(missed, expected).some(problem => /what each package did/.test(problem)));
});
