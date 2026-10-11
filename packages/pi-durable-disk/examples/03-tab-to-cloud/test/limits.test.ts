import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitTracker } from '../tab/limits.ts';

test('a limit from the beginning runs out when its end has not appeared in time, and not before', () => {
  const t = new LimitTracker([{ start: null, end: '</thinking>', tokens: 3 }]);
  assert.equal(t.push('<thinking>a', 1), -1);
  assert.equal(t.push('<thinking>a b', 2), -1);
  assert.equal(t.push('<thinking>a b c', 3), 0, 'three tokens and no end');
});

test('a limit with a start counts from where the start first appeared', () => {
  const t = new LimitTracker([{ start: '</thinking>', end: '<tool_call>', tokens: 2 }]);
  assert.equal(t.push('x y z', 50), -1, 'no start yet: no clock');
  assert.equal(t.push('x</thinking>', 51), -1);
  assert.equal(t.push('x</thinking>\nhello', 52), -1);
  assert.equal(t.push('x</thinking>\nhello there', 53), 0, 'two tokens after the start');
});

test('an end that appears in time satisfies the limit for good, and an end before the start does not count', () => {
  const t = new LimitTracker([{ start: 'A', end: 'B', tokens: 2 }]);
  assert.equal(t.push('B A', 1), -1);
  assert.equal(t.push('B A c d', 4), 0, 'a B before the A is not the end');
  const u = new LimitTracker([{ start: 'A', end: 'B', tokens: 2 }]);
  assert.equal(u.push('A c B', 2), -1);
  assert.equal(u.push('A c B d e f', 6), -1, 'satisfied: later tokens do not matter');
});

test('several limits are independent and the first that runs out is reported', () => {
  const t = new LimitTracker([{ start: null, end: '</t>', tokens: 5 }, { start: '<c>', end: '</c>', tokens: 2 }]);
  assert.equal(t.push('a</t><c>x', 3), -1);
  assert.equal(t.push('a</t><c>x y z', 5), 1, 'the call body ran away');
});
