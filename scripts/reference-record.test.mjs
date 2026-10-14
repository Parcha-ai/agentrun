import assert from 'node:assert/strict';
import test from 'node:test';
import { recordProblems } from './reference-record.mjs';

const expected = { status: 'complete', output: { answer: 'a' }, usage: { 'faux/faux-1': { tokens: 19320, usd: 0 }, run: { tokens: 0, usd: 0 } } };
const withUsage = (usage, rest = {}) => ({ ...expected, ...rest, usage });

test('a different positive token count is the same record', () => {
  assert.deepEqual(recordProblems(withUsage({ 'faux/faux-1': { tokens: 19443, usd: 0 }, run: { tokens: 0, usd: 0 } }), expected), []);
});

test('a token count that is not a positive integer where one is expected fails', () => {
  for (const tokens of [0, -1, 1.5, '19443', null, undefined]) {
    const problems = recordProblems(withUsage({ 'faux/faux-1': { tokens, usd: 0 }, run: { tokens: 0, usd: 0 } }), expected);
    assert.equal(problems.length, 1, String(tokens));
    assert.match(problems[0], /usage\.faux\/faux-1\.tokens/);
  }
});

test('any other difference fails, including the cost and a missing entry', () => {
  assert.match(recordProblems(withUsage({ 'faux/faux-1': { tokens: 5, usd: 1 }, run: { tokens: 0, usd: 0 } }), expected)[0], /differs/);
  assert.match(recordProblems(withUsage({ 'faux/faux-1': { tokens: 5, usd: 0 }, run: { tokens: 0, usd: 0 } }, { status: 'refused' }), expected)[0], /differs/);
  assert.ok(recordProblems(withUsage({ 'faux/faux-1': { tokens: 5, usd: 0 } }), expected).length >= 1);
});

test('a count the fixed record has as zero must stay zero, and key order is not a difference', () => {
  const expected = { status: 'complete', usage: { model: { tokens: 10, usd: 0 }, run: { tokens: 0, usd: 0 } } };
  assert.match(recordProblems({ ...expected, usage: { model: { tokens: 12, usd: 0 }, run: { tokens: 3, usd: 0 } } }, expected)[0], /usage\.run\.tokens is 3, expected 0/);
  assert.deepEqual(recordProblems({ usage: { run: { usd: 0, tokens: 0 }, model: { usd: 0, tokens: 99 } }, status: 'complete' }, expected), []);
});
